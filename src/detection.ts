/**
 * Auth-aware detection service.
 *
 * Owns the recognition allowlist (team keys) + workspace slug that EVERY scan
 * consumer reads. It blends explicit configuration with the signed-in
 * workspace's real org slug + team keys (fetched via
 * {@link LinearClient.fetchWorkspaceInfo}) and persists the detected info so the
 * allowlist is warm on the next session before the network responds.
 *
 * All getters are SYNCHRONOUS and never throw; {@link DetectionService.refresh}
 * does the async network work. This module is a thin host-tier service: it does
 * not import `vscode` directly, instead taking an injected {@link MetadataStore}
 * adapter (over `context.workspaceState`) so it stays trivially testable.
 *
 * The pure merge/precedence logic is factored into the exported helpers
 * {@link resolveEffectiveTeamKeys} / {@link resolveEffectiveSlug} so it can be
 * unit-tested without constructing the service.
 */

import {
  LinearClient,
  LinearLensConfig,
  MetadataStore,
  WorkspaceInfo,
} from "./types";

/**
 * The persistent {@link MetadataStore} key under which the last-detected
 * {@link WorkspaceInfo} is cached. Versioned so a future shape change can bump
 * the key and ignore stale-shaped entries without a migration.
 */
export const WORKSPACE_STORE_KEY = "linearLens.workspace.v1";

/**
 * Resolve the effective team-key allowlist from config + detected workspace info.
 *
 * Pure precedence (no I/O, never throws):
 *  1. configured `teamKeys` when NON-EMPTY (an explicit user override wins),
 *  2. detected org team keys when loaded (the auth-aware allowlist),
 *  3. `[]` → zero-config: any `ABC-123`-shaped token is treated as a ref
 *     (unauthenticated / not-yet-loaded).
 *
 * Returns `undefined` when the result would be empty so it matches `scanText`'s
 * "no allowlist → match any" contract EXACTLY (callers pass the value straight
 * into `ScanOptions.teamKeys`). Returning `[]` would instead match NOTHING.
 *
 * @param configuredTeamKeys - The `linearLens.teamKeys` config value.
 * @param detected - The last-loaded workspace info, or `null` when none.
 * @returns The allowlist to scan with, or `undefined` for "match any".
 */
export function resolveEffectiveTeamKeys(
  configuredTeamKeys: string[],
  detected: WorkspaceInfo | null,
): string[] | undefined {
  if (configuredTeamKeys.length > 0) {
    return configuredTeamKeys;
  }
  if (detected && detected.teamKeys.length > 0) {
    return detected.teamKeys;
  }
  return undefined;
}

/**
 * Resolve the effective workspace slug from config + detected workspace info.
 *
 * Pure precedence (no I/O, never throws): configured `workspaceSlug` when
 * non-empty (trimmed), else the detected `organization.urlKey`, else `""`.
 *
 * @param configuredSlug - The `linearLens.workspaceSlug` config value.
 * @param detected - The last-loaded workspace info, or `null` when none.
 * @returns The slug used to build issue URLs (`""` when neither is available).
 */
export function resolveEffectiveSlug(
  configuredSlug: string,
  detected: WorkspaceInfo | null,
): string {
  const configured = configuredSlug.trim();
  if (configured) {
    return configured;
  }
  return detected?.slug ?? "";
}

/**
 * Narrow an arbitrary persisted value to a {@link WorkspaceInfo}, defending
 * against a corrupt or schema-drifted entry. Returns `null` when the shape is
 * not a valid workspace-info object. Never throws.
 *
 * @param value - The raw value read back from the {@link MetadataStore}.
 * @returns A validated {@link WorkspaceInfo}, or `null`.
 */
export function parseStoredWorkspaceInfo(value: unknown): WorkspaceInfo | null {
  if (typeof value !== "object" || value === null) {
    return null;
  }
  const candidate = value as Partial<WorkspaceInfo>;
  if (typeof candidate.slug !== "string") {
    return null;
  }
  if (!Array.isArray(candidate.teamKeys)) {
    return null;
  }
  if (!Array.isArray(candidate.teams)) {
    return null;
  }
  // Keep only well-typed members so a partially-corrupt entry cannot leak
  // garbage into the allowlist.
  const teamKeys = candidate.teamKeys.filter(
    (k): k is string => typeof k === "string",
  );
  const teams = candidate.teams.filter(
    (t): t is WorkspaceInfo["teams"][number] =>
      typeof t === "object" &&
      t !== null &&
      typeof (t as Record<string, unknown>).id === "string" &&
      typeof (t as Record<string, unknown>).key === "string" &&
      typeof (t as Record<string, unknown>).name === "string",
  );
  return { slug: candidate.slug, teamKeys, teams };
}

/** True when two workspace-info snapshots resolve to the same slug + key set. */
function sameDetection(a: WorkspaceInfo | null, b: WorkspaceInfo | null): boolean {
  if (a === b) {
    return true;
  }
  if (!a || !b) {
    return false;
  }
  if (a.slug !== b.slug) {
    return false;
  }
  if (a.teamKeys.length !== b.teamKeys.length) {
    return false;
  }
  for (let i = 0; i < a.teamKeys.length; i++) {
    if (a.teamKeys[i] !== b.teamKeys[i]) {
      return false;
    }
  }
  return true;
}

/**
 * Auth-aware detection: resolves the effective team-key allowlist + workspace
 * slug from configuration first, falling back to the signed-in workspace's real
 * org slug + team keys (fetched via {@link LinearClient.fetchWorkspaceInfo},
 * cached persistently). All getters are SYNCHRONOUS and never throw;
 * {@link DetectionService.refresh} does the async work.
 */
export class DetectionService {
  private readonly getCfg: () => LinearLensConfig;
  private readonly client: Pick<LinearClient, "fetchWorkspaceInfo">;
  private readonly store: MetadataStore;
  private readonly onChange?: () => void;

  /** The last-loaded workspace info (rehydrated on construction), or `null`. */
  private detected: WorkspaceInfo | null = null;
  /** Whether detected info has been loaded at least once (cache or network). */
  private loaded = false;
  /** Guards against overlapping `refresh()` calls (last write wins). */
  private inFlight: Promise<void> | undefined;
  /** Set on `dispose()` so a late-resolving refresh becomes a no-op. */
  private disposed = false;

  /**
   * @param getCfg - Accessor returning the current resolved configuration.
   * @param client - The Linear client (only `fetchWorkspaceInfo` is used).
   * @param store - Persistence adapter over `context.workspaceState`.
   * @param onChange - Optional callback invoked when the effective keys/slug
   *   change so the host can re-scan + repaint every surface.
   */
  constructor(
    getCfg: () => LinearLensConfig,
    client: Pick<LinearClient, "fetchWorkspaceInfo">,
    store: MetadataStore,
    onChange?: () => void,
  ) {
    this.getCfg = getCfg;
    this.client = client;
    this.store = store;
    this.onChange = onChange;

    // Rehydrate from the persistent store so getters are warm immediately —
    // before the first network refresh resolves. A corrupt entry is ignored.
    try {
      const stored = store.get<unknown>(WORKSPACE_STORE_KEY);
      const parsed = parseStoredWorkspaceInfo(stored);
      if (parsed) {
        this.detected = parsed;
        this.loaded = true;
      }
    } catch {
      // Never let a bad store read break activation.
      this.detected = null;
    }
  }

  /**
   * The team-key allowlist used by EVERY scan. See
   * {@link resolveEffectiveTeamKeys} for the precedence. Returns `undefined`
   * (not `[]`) when empty so it matches `scanText`'s "no allowlist" contract.
   *
   * @returns The allowlist, or `undefined` for zero-config "match any".
   */
  effectiveTeamKeys(): string[] | undefined {
    return resolveEffectiveTeamKeys(this.getCfg().teamKeys, this.detected);
  }

  /**
   * The effective workspace slug: configured `workspaceSlug` when non-empty,
   * else the detected `organization.urlKey`, else `""`. Drives `issueUrl` and
   * drops the "slug not set up" nag whenever this is non-empty.
   *
   * @returns The slug, or `""` when neither configured nor detected.
   */
  effectiveSlug(): string {
    return resolveEffectiveSlug(this.getCfg().workspaceSlug, this.detected);
  }

  /**
   * Whether detected workspace info has been loaded at least once (from cache or
   * the network) — used to tailor user-facing messaging.
   *
   * @returns `true` once any workspace info is available.
   */
  isLoaded(): boolean {
    return this.loaded;
  }

  /**
   * (Re)fetch workspace info. Call on activation, sign-in/out, key set, and
   * config change. Never throws. On failure (api disabled / no auth / network)
   * the last cached info is KEPT — stale detection still helps and team keys do
   * not leak anything sensitive. On a successful fetch the result is persisted
   * and `onChange` fires only when the effective keys/slug actually changed.
   */
  async refresh(): Promise<void> {
    // Collapse concurrent refreshes onto one in-flight request.
    if (this.inFlight) {
      return this.inFlight;
    }
    const run = this.doRefresh().finally(() => {
      this.inFlight = undefined;
    });
    this.inFlight = run;
    return run;
  }

  /** The actual refresh body; isolated so {@link refresh} can dedupe it. */
  private async doRefresh(): Promise<void> {
    let info: WorkspaceInfo | null = null;
    try {
      info = await this.client.fetchWorkspaceInfo();
    } catch {
      // The client should never throw, but guard anyway: keep the cache.
      info = null;
    }

    if (this.disposed) {
      return;
    }

    // No info (api off / no auth / failure) → keep the last good cache.
    if (!info) {
      this.loaded = this.loaded || this.detected !== null;
      return;
    }

    const previous = this.detected;
    this.detected = info;
    this.loaded = true;

    // Persist fire-and-forget; never await on this path and never throw.
    try {
      void this.store.set(WORKSPACE_STORE_KEY, info);
    } catch {
      // Persistence is best-effort; a failure does not affect live getters.
    }

    if (!sameDetection(previous, info)) {
      this.onChange?.();
    }
  }

  /** Stop reacting to in-flight refreshes. Idempotent. */
  dispose(): void {
    this.disposed = true;
  }
}
