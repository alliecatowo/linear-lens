/**
 * Linear Lens — rail decorator (end-of-line annotation + overview-ruler ticks).
 *
 * Two GitLens / Error-Lens-style surfaces, both reading the SHARED warm cache
 * (stale-while-revalidate via {@link LinearClient.peekIssue}) so they never block
 * typing and never trigger their own per-keystroke fetches:
 *
 *  1. **Inline rail** — a muted, italic end-of-line annotation rendered AFTER a
 *     reference's line in the form `<ID> · <state> · <title>`. Governed by
 *     `linearLens.rail.inline`:
 *       - `"off"`        — never render.
 *       - `"activeLine"` — only the line the primary cursor is on (default).
 *       - `"allLines"`   — every line that contains a reference.
 *     A single base {@link vscode.TextEditorDecorationType} carries the dim/italic
 *     `after` style; the per-ref TEXT lives on each range's
 *     {@link vscode.DecorationOptions.renderOptions} so one `setDecorations` call
 *     paints the whole pass.
 *  2. **Overview-ruler ticks** — status-colored ticks on the scrollbar overview
 *     ruler at ref lines. Governed by `linearLens.rail.overviewRuler` (default
 *     `true`). One decoration type PER color hex (LRU-capped), placed on
 *     {@link vscode.OverviewRulerLane.Center} so it does NOT stack with
 *     {@link IssueDecorator}'s existing Right-lane tick (spec §2.5 (a)).
 *
 * Design mirrors {@link InlineStatusDecorator}'s lifecycle and internals: a
 * lazily-built LRU decoration-type cache (for the per-color ruler types), a
 * per-document render token (so a stale background fetch cannot trigger an
 * out-of-date repaint), a bounded visible-first background-fetch pump for cache
 * misses, and a debounced re-apply when those resolve. The active-line scope
 * additionally caches the last full document scan per `uri + version`, so cursor
 * moves only re-pick the active line's ref WITHOUT re-scanning the document.
 *
 * The rail is auth-gated like the inline pill: with no live state there is
 * nothing to annotate, so when signed out (or with both surfaces off) everything
 * is cleared. Renders nothing when metadata is absent for a ref.
 *
 * Clickability: VS Code `after` decorations cannot carry markdown command links,
 * so the inline rail is non-clickable text; discoverability of "Open details"
 * comes from the existing rich hover provider (spec §5.1 (a)).
 *
 * This module never throws out of a public method or async callback.
 */

import * as vscode from "vscode";
import { scanText } from "../parser";
import { stateColor, stateLabel } from "../format/state";
import type {
  IssueId,
  IssueMetadata,
  IssueRef,
  LinearClient,
  LinearLensConfig,
} from "../types";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Debounce window (ms) for re-applying after background fetches resolve. */
const REFRESH_DEBOUNCE_MS = 250;

/** Maximum number of in-flight `fetchIssue` calls at any one time. */
const MAX_CONCURRENT_FETCHES = 4;

/**
 * Upper bound on the number of cached overview-ruler decoration types (one per
 * distinct color hex). LRU-evict entries past this cap to bound memory.
 */
const MAX_RULER_TYPES = 32;

/** Maximum length of the title shown in the inline rail before it is clamped. */
const MAX_TITLE_LENGTH = 80;

/** Left margin applied so the rail annotation does not touch the code. */
const RAIL_MARGIN = "0 0 0 2em";

/** Document schemes the decorator operates on; mirrors {@link InlineStatusDecorator}. */
const SUPPORTED_SCHEMES = new Set(["file", "untitled"]);

// ---------------------------------------------------------------------------
// Config view (forward-compatible)
// ---------------------------------------------------------------------------

/** The end-of-line rail annotation scope. */
type RailInlineMode = "off" | "activeLine" | "allLines";

/**
 * The rail-specific slice of {@link LinearLensConfig}. These fields are added to
 * the shared config by the integrate step; this local intersection lets the rail
 * read them defensively whether or not the shared type has caught up yet, while
 * still type-checking against the canonical config for every other field.
 */
type RailConfig = LinearLensConfig & {
  /** `linearLens.rail.inline` — end-of-line rail annotation scope. */
  readonly railInline?: RailInlineMode;
  /** `linearLens.rail.overviewRuler` — show overview-ruler status ticks at ref lines. */
  readonly railOverviewRuler?: boolean;
};

/**
 * Read the effective inline-rail mode from config, defaulting to `"activeLine"`
 * for any missing or unrecognized value (defensive — never throws).
 */
function railInlineMode(cfg: RailConfig): RailInlineMode {
  const value = cfg.railInline;
  return value === "off" || value === "activeLine" || value === "allLines"
    ? value
    : "activeLine";
}

/** Read the effective overview-ruler toggle from config, defaulting to `true`. */
function railOverviewRuler(cfg: RailConfig): boolean {
  return typeof cfg.railOverviewRuler === "boolean" ? cfg.railOverviewRuler : true;
}

// ---------------------------------------------------------------------------
// Peekable-client feature detection
// ---------------------------------------------------------------------------

/**
 * A {@link LinearClient} that may expose the optional synchronous cache peek.
 * We feature-detect it so the decorator degrades gracefully if handed a client
 * without the method (e.g. during tests).
 */
type PeekableClient = LinearClient & {
  /** Synchronous cache peek for inline rendering; null when absent/expired. */
  peekIssue?: (id: IssueId) => IssueMetadata | null;
};

/**
 * Read cached metadata for an id without ever throwing or hitting the network.
 * Returns `null` when the method is unavailable so callers fall back to a
 * background fetch.
 */
function peek(client: PeekableClient, id: IssueId): IssueMetadata | null {
  try {
    return client.peekIssue ? client.peekIssue(id) : null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Pure helpers (testable)
// ---------------------------------------------------------------------------

/**
 * Clamp a title to {@link MAX_TITLE_LENGTH} characters, appending an ellipsis
 * when truncated. Collapses internal whitespace/newlines to single spaces so a
 * multi-line title renders cleanly on one rail line.
 *
 * @param title - The raw issue title (may be empty/multi-line).
 * @returns A single-line, length-bounded title (possibly `""`).
 */
export function clampTitle(title: string): string {
  const flattened = title.replace(/\s+/g, " ").trim();
  if (flattened.length <= MAX_TITLE_LENGTH) {
    return flattened;
  }
  return `${flattened.slice(0, MAX_TITLE_LENGTH).trimEnd()}…`;
}

/**
 * Build the inline rail annotation text for a reference in the form
 * `"<ID> · <state> · <title>"`, dropping any empty trailing segments so the rail
 * is never padded with stray separators. Pure + testable.
 *
 * @param id   - The normalized issue identifier, e.g. `"ENG-123"`.
 * @param meta - The cached issue metadata supplying state + title.
 * @returns The rail label, e.g. `"ENG-123 · In Progress · Fix the parser"`.
 */
export function railText(id: string, meta: IssueMetadata): string {
  const parts: string[] = [id];
  const label = stateLabel(meta);
  if (label) {
    parts.push(label);
  }
  const title = clampTitle(meta.title ?? "");
  if (title) {
    parts.push(title);
  }
  return parts.join(" · ");
}

// ---------------------------------------------------------------------------
// Local color helper
// ---------------------------------------------------------------------------

/**
 * Normalize a hex color string to lowercase `#rrggbb`, expanding shorthand
 * `#rgb`. Returns `undefined` when the input is missing or not a valid hex color.
 * Inlined (mirrors {@link InlineStatusDecorator}) to keep this module
 * self-contained and never-throwing.
 */
function normalizeHex(color: string | undefined): string | undefined {
  if (!color) {
    return undefined;
  }
  const trimmed = color.trim().replace(/^#/, "").toLowerCase();
  if (/^[0-9a-f]{6}$/.test(trimmed)) {
    return `#${trimmed}`;
  }
  if (/^[0-9a-f]{3}$/.test(trimmed)) {
    const [r, g, b] = trimmed;
    return `#${r}${r}${g}${g}${b}${b}`;
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Cached document scan (active-line fast path)
// ---------------------------------------------------------------------------

/** A document scan cached per `uri + version` for cheap active-line re-picks. */
interface CachedScan {
  /** The `document.version` this scan was produced for. */
  readonly version: number;
  /** The references found in document order. */
  readonly refs: IssueRef[];
}

// ---------------------------------------------------------------------------
// RailDecorator
// ---------------------------------------------------------------------------

/**
 * Renders the configurable rail: a muted end-of-line annotation and/or
 * status-colored overview-ruler ticks for each recognized Linear issue reference.
 *
 * Lifecycle: construct once during activation, call `applyToVisible()` on the
 * same events as {@link InlineStatusDecorator} (document open/change,
 * active-editor and visible-editors changes, config changes), call
 * `onSelectionChanged(editor)` from `onDidChangeTextEditorSelection` so the
 * `activeLine` scope follows the cursor, call `refresh()` after sign-in/out or a
 * metadata cache clear, and `dispose()` on deactivation.
 */
export class RailDecorator {
  /** Live configuration accessor; re-read on every apply so settings take effect. */
  private readonly _getCfg: () => RailConfig;

  /** Cache-backed Linear client; may expose the optional `peekIssue`. */
  private readonly _client: PeekableClient;

  /**
   * Live accessor for the effective team-key allowlist (auth-aware detection).
   * Returns `undefined` for zero-config "match any".
   */
  private readonly _getTeamKeys: () => string[] | undefined;

  /**
   * The single base decoration type for the inline `after` annotation (dim +
   * italic). The per-ref text is supplied per-range via `renderOptions`, so one
   * type serves every annotation. Created lazily; disposed/rebuilt on
   * {@link refresh} / {@link dispose}.
   */
  private _inlineType: vscode.TextEditorDecorationType | undefined;

  /**
   * Lazily-built overview-ruler decoration types keyed by the color hex string
   * (`#rrggbb`). Insertion order is the LRU ordering (Map preserves it);
   * re-touching a key moves it to the end via delete+set.
   */
  private readonly _rulerTypes = new Map<string, vscode.TextEditorDecorationType>();

  /** Per-document debounce timers for post-fetch re-applies, keyed by URI string. */
  private readonly _refreshTimers = new Map<string, ReturnType<typeof setTimeout>>();

  /**
   * Per-document monotonically increasing render token. Bumped on every `apply`
   * call so a stale background-fetch resolution cannot trigger an out-of-date
   * re-render.
   */
  private readonly _renderTokens = new Map<string, number>();

  /**
   * Per-document cached full scan, keyed by URI string. Lets `onSelectionChanged`
   * re-pick the active line WITHOUT re-scanning when the document is unchanged.
   */
  private readonly _scanCache = new Map<string, CachedScan>();

  /** Normalized ids currently being fetched (de-dupe across editors/passes). */
  private readonly _inFlight = new Set<string>();

  /** Number of fetches currently in progress (bounded by {@link MAX_CONCURRENT_FETCHES}). */
  private _activeFetches = 0;

  /** FIFO queue of distinct ids awaiting a background fetch. */
  private readonly _fetchQueue: IssueId[] = [];

  /** Whether {@link dispose} has run; guards against post-dispose work. */
  private _disposed = false;

  /**
   * Create a `RailDecorator`.
   *
   * @param getCfg Accessor returning the current resolved configuration. Called
   *               on every apply so the decorator reacts to setting changes
   *               without being recreated.
   * @param client The cache-backed Linear client used to resolve state + colors
   *               via the synchronous `peekIssue` (SWR) and `fetchIssue` misses.
   * @param getTeamKeys Accessor for the effective team-key allowlist (from the
   *               auth-aware `DetectionService`). Defaults to `() => undefined`
   *               (zero-config "match any").
   */
  constructor(
    getCfg: () => LinearLensConfig,
    client: LinearClient,
    getTeamKeys: () => string[] | undefined = () => undefined,
  ) {
    this._getCfg = getCfg as () => RailConfig;
    this._client = client as PeekableClient;
    this._getTeamKeys = getTeamKeys;
  }

  /**
   * (Re)apply the rail to one editor (defaults to the active editor).
   *
   * No-ops (after clearing any prior decorations) when both rail surfaces are
   * off, there is no auth, or the document scheme is unsupported. On a cache miss
   * for a ref, a bounded background fetch is queued (visible first) and a cheap
   * re-apply is scheduled when it resolves. Never throws.
   *
   * @param editor The editor to decorate; defaults to the active editor.
   */
  apply(editor?: vscode.TextEditor): void {
    if (this._disposed) {
      return;
    }
    const target = editor ?? vscode.window.activeTextEditor;
    if (!target) {
      return;
    }

    try {
      const key = target.document.uri.toString();
      // Bump the per-document render token so a background fetch resolving for an
      // older document state cannot trigger an out-of-date re-render.
      const token = (this._renderTokens.get(key) ?? 0) + 1;
      this._renderTokens.set(key, token);

      if (!SUPPORTED_SCHEMES.has(target.document.uri.scheme)) {
        return;
      }

      const cfg = this._getCfg();
      const inlineMode = railInlineMode(cfg);
      const wantInline = inlineMode !== "off";
      const wantRuler = railOverviewRuler(cfg);

      // Auth-gated + feature-gated: with no live state there is nothing to
      // annotate, so clear everything to avoid stale decorations.
      if ((!wantInline && !wantRuler) || !this._client.hasAuth()) {
        this._clearAll(target);
        this._scanCache.delete(key);
        return;
      }

      const refs = this._scan(target.document);
      if (refs.length === 0) {
        this._clearAll(target);
        return;
      }

      // The active line is computed once per pass; in `activeLine` scope only the
      // ref(s) on this line are annotated inline (ruler ticks still cover all).
      const activeLine = target.selection.active.line;

      // Inline annotation options (one base type, per-range text).
      const inlineOpts: vscode.DecorationOptions[] = [];
      // Overview-ruler options grouped by color hex (first ref per line wins).
      const rulerByHex = new Map<string, vscode.DecorationOptions[]>();
      // Lines that already claimed a ruler tick this pass (no stacking).
      const ruledLines = new Set<number>();
      // De-duped ids that missed the cache, in document order (visible first).
      const missing = new Map<string, { id: IssueId; visible: boolean }>();

      for (const ref of refs) {
        const meta = peek(this._client, ref.issue);

        // A true cache miss (no metadata at all) → queue a background fetch and
        // render nothing for this ref this pass.
        if (!meta) {
          const existing = missing.get(ref.issue.normalized);
          const visible = this._isRangeVisible(target, ref.start, ref.end);
          if (existing) {
            existing.visible = existing.visible || visible;
          } else {
            missing.set(ref.issue.normalized, { id: ref.issue, visible });
          }
          continue;
        }

        const refLine = target.document.positionAt(ref.start).line;

        // Inline rail: end-of-line `after` text on the ref's line. In
        // `activeLine` scope, only the cursor's line; in `allLines`, every line.
        if (wantInline && (inlineMode === "allLines" || refLine === activeLine)) {
          const eol = target.document.lineAt(refLine).range.end;
          inlineOpts.push({
            range: new vscode.Range(eol, eol),
            renderOptions: {
              after: { contentText: railText(ref.issue.normalized, meta) },
            },
          });
        }

        // Overview-ruler tick: one per line (first ref wins), colored by state.
        if (wantRuler && !ruledLines.has(refLine)) {
          const hex = normalizeHex(meta.stateColor) ?? stateColor(meta.stateType);
          ruledLines.add(refLine);
          const lineStart = new vscode.Position(refLine, 0);
          const opts: vscode.DecorationOptions = {
            range: new vscode.Range(lineStart, lineStart),
          };
          const bucket = rulerByHex.get(hex);
          if (bucket) {
            bucket.push(opts);
          } else {
            rulerByHex.set(hex, [opts]);
          }
        }
      }

      this._applyInline(target, wantInline ? inlineOpts : []);
      this._applyRuler(target, wantRuler ? rulerByHex : new Map());

      // Kick bounded background fetches for cache misses (visible first).
      this._queueMissing(missing);
    } catch {
      // Never throw out of a decorator pass.
    }
  }

  /**
   * Apply the rail to every currently visible editor.
   *
   * Intended for the same events as {@link InlineStatusDecorator.applyToVisible}
   * (config change, visible-editor change) and as the cheap post-fetch re-apply.
   */
  applyToVisible(): void {
    if (this._disposed) {
      return;
    }
    for (const editor of vscode.window.visibleTextEditors) {
      this.apply(editor);
    }
  }

  /**
   * Re-render the active-line rail when the cursor moves.
   *
   * In `activeLine` scope this is the event that makes the rail follow the
   * cursor. It is cheap: the document scan is reused from the per-version cache
   * (no re-scan when the document is unchanged), so only the active line's
   * annotation is recomputed. In `allLines` / `off` scope, or when the ruler is
   * the only active surface, a cursor move changes nothing, so we skip the work.
   *
   * @param editor The editor whose selection changed.
   */
  onSelectionChanged(editor: vscode.TextEditor): void {
    if (this._disposed) {
      return;
    }
    try {
      const cfg = this._getCfg();
      // Only `activeLine` inline rendering depends on the cursor position; for any
      // other scope a selection change does not alter what the rail shows.
      if (railInlineMode(cfg) !== "activeLine") {
        return;
      }
      // `apply` reuses the cached scan for the unchanged document version, so this
      // is just an active-line re-pick + a single `setDecorations`.
      this.apply(editor);
    } catch {
      // Never throw out of an event callback.
    }
  }

  /**
   * Drop + rebuild decoration types and re-apply the visible editors.
   *
   * Call after sign-in/out, a metadata cache clear, or a config change: state
   * colors and the inline style may have changed, so existing types are disposed
   * and the cached scans are dropped, then the visible editors are re-applied
   * (lazily rebuilding the types they still need).
   */
  refresh(): void {
    if (this._disposed) {
      return;
    }
    this._disposeTypes();
    this._scanCache.clear();
    this.applyToVisible();
  }

  /**
   * Release every decoration type, cancel pending timers, and stop all work.
   *
   * After disposal VS Code automatically removes the decorations from editors.
   * No further `apply` / `applyToVisible` / `onSelectionChanged` / `refresh`
   * calls do anything.
   */
  dispose(): void {
    this._disposed = true;
    for (const timer of this._refreshTimers.values()) {
      clearTimeout(timer);
    }
    this._refreshTimers.clear();
    this._renderTokens.clear();
    this._scanCache.clear();
    this._fetchQueue.length = 0;
    this._inFlight.clear();
    this._disposeTypes();
  }

  // -------------------------------------------------------------------------
  // Internal helpers
  // -------------------------------------------------------------------------

  /**
   * Return the references for a document, reusing the cached scan when the
   * document version is unchanged so cursor moves do not re-scan.
   */
  private _scan(document: vscode.TextDocument): IssueRef[] {
    const key = document.uri.toString();
    const cached = this._scanCache.get(key);
    if (cached && cached.version === document.version) {
      return cached.refs;
    }
    const refs = scanText(document.getText(), {
      teamKeys: this._getTeamKeys(),
      markers: this._getCfg().markers,
    });
    this._scanCache.set(key, { version: document.version, refs });
    return refs;
  }

  /** Lazily create (once) the shared dim/italic inline `after` decoration type. */
  private _ensureInlineType(): vscode.TextEditorDecorationType {
    if (!this._inlineType) {
      this._inlineType = vscode.window.createTextEditorDecorationType({
        isWholeLine: false,
        rangeBehavior: vscode.DecorationRangeBehavior.ClosedClosed,
        after: {
          margin: RAIL_MARGIN,
          // Muted, theme-aware foreground matching CodeLens.
          color: new vscode.ThemeColor("editorCodeLens.foreground"),
          fontStyle: "italic",
        },
      });
    }
    return this._inlineType;
  }

  /** Apply the inline `after` annotations (one base type, many per-range texts). */
  private _applyInline(
    editor: vscode.TextEditor,
    opts: vscode.DecorationOptions[],
  ): void {
    // Only materialize the base type when there is something to draw; once
    // created it is reused, and an empty array clears any prior annotations.
    if (opts.length === 0 && !this._inlineType) {
      return;
    }
    editor.setDecorations(this._ensureInlineType(), opts);
  }

  /**
   * Apply the overview-ruler ticks: one `setDecorations` per color type that has
   * ranges this pass, clearing every other still-registered color type so a
   * shrinking ref set leaves no ghost ticks.
   */
  private _applyRuler(
    editor: vscode.TextEditor,
    byHex: Map<string, vscode.DecorationOptions[]>,
  ): void {
    for (const [hex, type] of this._rulerTypes) {
      editor.setDecorations(type, byHex.get(hex) ?? []);
    }
    for (const [hex, opts] of byHex) {
      if (!this._rulerTypes.has(hex)) {
        editor.setDecorations(this._ensureRulerType(hex), opts);
      }
    }
  }

  /**
   * Look up (touching LRU order) or lazily create the overview-ruler decoration
   * type for a color hex. Placed on the Center lane so it does not stack with
   * {@link IssueDecorator}'s Right-lane tick. Evicts the least-recently-used type
   * when the cap is exceeded.
   */
  private _ensureRulerType(hex: string): vscode.TextEditorDecorationType {
    const existing = this._rulerTypes.get(hex);
    if (existing) {
      // Touch: move to most-recently-used position.
      this._rulerTypes.delete(hex);
      this._rulerTypes.set(hex, existing);
      return existing;
    }
    const type = vscode.window.createTextEditorDecorationType({
      overviewRulerColor: hex,
      overviewRulerLane: vscode.OverviewRulerLane.Center,
      isWholeLine: true,
    });
    this._rulerTypes.set(hex, type);
    this._evictRulerTypes();
    return type;
  }

  /** Evict least-recently-used ruler types until under {@link MAX_RULER_TYPES}. */
  private _evictRulerTypes(): void {
    while (this._rulerTypes.size > MAX_RULER_TYPES) {
      const oldestKey = this._rulerTypes.keys().next().value as string | undefined;
      if (oldestKey === undefined) {
        return;
      }
      const oldest = this._rulerTypes.get(oldestKey);
      this._rulerTypes.delete(oldestKey);
      oldest?.dispose();
    }
  }

  /** Dispose and forget the inline base type + every ruler color type. */
  private _disposeTypes(): void {
    this._inlineType?.dispose();
    this._inlineType = undefined;
    for (const type of this._rulerTypes.values()) {
      type.dispose();
    }
    this._rulerTypes.clear();
  }

  /** Clear this decorator's decorations from a single editor (all types). */
  private _clearAll(editor: vscode.TextEditor): void {
    if (this._inlineType) {
      editor.setDecorations(this._inlineType, []);
    }
    for (const type of this._rulerTypes.values()) {
      editor.setDecorations(type, []);
    }
  }

  /** Whether the character range `[start, end)` overlaps any visible range. */
  private _isRangeVisible(
    editor: vscode.TextEditor,
    start: number,
    end: number,
  ): boolean {
    const range = new vscode.Range(
      editor.document.positionAt(start),
      editor.document.positionAt(end),
    );
    for (const visible of editor.visibleRanges) {
      if (visible.intersection(range)) {
        return true;
      }
    }
    return false;
  }

  /**
   * Enqueue cache-missing ids for a bounded background fetch, visible refs first,
   * skipping ids already in-flight or already queued. Pumps the fetch loop.
   */
  private _queueMissing(
    missing: Map<string, { id: IssueId; visible: boolean }>,
  ): void {
    if (missing.size === 0) {
      return;
    }
    const queuedKeys = new Set(this._fetchQueue.map((id) => id.normalized));
    const entries = [...missing.values()].sort(
      (a, b) => Number(b.visible) - Number(a.visible),
    );
    for (const { id } of entries) {
      if (this._inFlight.has(id.normalized) || queuedKeys.has(id.normalized)) {
        continue;
      }
      this._fetchQueue.push(id);
      queuedKeys.add(id.normalized);
    }
    this._pumpFetches();
  }

  /**
   * Start fetches up to the concurrency cap. Each resolution schedules a
   * debounced re-apply of the visible editors so newly-cached metadata renders.
   */
  private _pumpFetches(): void {
    while (
      !this._disposed &&
      this._activeFetches < MAX_CONCURRENT_FETCHES &&
      this._fetchQueue.length > 0
    ) {
      const id = this._fetchQueue.shift();
      if (!id) {
        break;
      }
      if (this._inFlight.has(id.normalized)) {
        continue;
      }
      this._inFlight.add(id.normalized);
      this._activeFetches += 1;

      void this._client
        .fetchIssue(id)
        .catch(() => null)
        .then((meta) => {
          this._inFlight.delete(id.normalized);
          this._activeFetches -= 1;
          // Only schedule a re-render when metadata resolved so we avoid churn on
          // negative (404/auth-fail) lookups.
          if (meta) {
            this._scheduleRefresh();
          }
          this._pumpFetches();
        });
    }
  }

  /**
   * Debounce a cheap re-apply of all visible editors. Coalesces a burst of
   * resolving fetches into a single render. Keyed globally (the apply itself is
   * per-editor and guarded by per-document render tokens).
   */
  private _scheduleRefresh(): void {
    if (this._disposed) {
      return;
    }
    const KEY = "*";
    const existing = this._refreshTimers.get(KEY);
    if (existing) {
      clearTimeout(existing);
    }
    this._refreshTimers.set(
      KEY,
      setTimeout(() => {
        this._refreshTimers.delete(KEY);
        this.applyToVisible();
      }, REFRESH_DEBOUNCE_MS),
    );
  }
}
