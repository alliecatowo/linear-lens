/**
 * Linear Lens — gutter status decorator.
 *
 * Renders a small state-colored circle in the editor gutter beside each line
 * that contains a recognized Linear issue reference. The circle color reflects
 * the issue's live workflow-state color (`state.color`) when available; it falls
 * back to {@link stateColor} from the shared `format/state` helper, ensuring a
 * sensible tint is always shown for known state types.
 *
 * Design mirrors {@link InlineStatusDecorator} (same lifecycle, same bounded
 * background-fetch pump, same LRU decoration-type cache) but operates on gutter
 * decorations rather than inline `after`-text decorations:
 *  - One {@link vscode.TextEditorDecorationType} per distinct color hex, keyed by
 *    the hex string, LRU-capped at {@link MAX_DECORATION_TYPES}.
 *  - Each type's `gutterIconPath` is a `data:image/svg+xml` URI containing a
 *    filled circle of the appropriate color. `data:` URIs are valid for gutter
 *    icons (unlike hover `MarkdownString`s).
 *  - Only one decoration range per line is emitted (first ref wins) so multiple
 *    refs on the same line do not stack icons.
 *  - Tooltip text: `"<ID> · <title> · <status>"` when metadata is known.
 *  - Gate: `linearLens.gutter.enable` (default `true`). Auth-gated the same way
 *    as the inline decorator.
 *
 * This module never throws.
 */

import * as path from "path";
import * as vscode from "vscode";
import { scanText } from "../parser";
import { stateColor, stateLabel } from "../format/state";
import type {
  IssueId,
  IssueMetadata,
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
 * Upper bound on the number of cached decoration types (one per distinct color).
 * LRU-evict entries past this cap to bound memory.
 */
const MAX_DECORATION_TYPES = 32;

/** Document schemes the decorator operates on; mirrors {@link InlineStatusDecorator}. */
const SUPPORTED_SCHEMES = new Set(["file", "untitled"]);

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
// SVG gutter icon generation
// ---------------------------------------------------------------------------

/**
 * Normalize a hex color string to lowercase `#rrggbb`, expanding shorthand
 * `#rgb`. Returns `undefined` when the input is missing or not a valid hex color.
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

/**
 * Build a `vscode.Uri` for a gutter icon SVG using a `data:` URI containing a
 * filled circle of the given color. `data:` URIs are valid for gutter icons.
 *
 * @param hex - A normalized `#rrggbb` color.
 * @returns A `vscode.Uri` suitable for `gutterIconPath`.
 */
function gutterIconUri(hex: string): vscode.Uri {
  // A minimal 16×16 filled circle — same dimensions as VS Code's built-in gutter
  // icons. The SVG is short enough that base64 is not needed; percent-encoding is
  // sufficient and produces a shorter URI.
  const svg = `<svg width="16" height="16" viewBox="0 0 16 16" xmlns="http://www.w3.org/2000/svg"><circle cx="8" cy="8" r="5" fill="${hex}"/></svg>`;
  return vscode.Uri.parse(
    `data:image/svg+xml,${encodeURIComponent(svg)}`,
    true,
  );
}

// ---------------------------------------------------------------------------
// Shipped per-type SVG fallback paths
// ---------------------------------------------------------------------------

/**
 * Map a state type to the shipped static SVG under `media/`. Used as an
 * alternative icon source when a live color is unavailable AND we want a static
 * asset (kept for reference; gutter icons use the `data:` approach for tinting).
 *
 * @param mediaRoot - Absolute path to the extension's `media/` directory.
 * @param stateType - A normalized state type string, or undefined.
 * @returns Absolute path to the matching SVG file, or the neutral fallback.
 */
export function staticGutterIconPath(
  mediaRoot: string,
  stateType: string | undefined,
): string {
  const KNOWN_TYPES = new Set([
    "backlog",
    "unstarted",
    "started",
    "completed",
    "canceled",
    "triage",
  ]);
  const type =
    typeof stateType === "string" && KNOWN_TYPES.has(stateType.toLowerCase())
      ? stateType.toLowerCase()
      : "neutral";
  return path.join(mediaRoot, `gutter-${type}.svg`);
}

// ---------------------------------------------------------------------------
// GutterDecorator
// ---------------------------------------------------------------------------

/**
 * Renders a colored state circle in the editor gutter beside each line that
 * contains a Linear issue reference.
 *
 * Lifecycle: construct once during activation, call `applyToVisible()` on the
 * same events as the inline decorator (document open/change, active-editor and
 * visible-editors changes, config changes), call `refresh()` after sign-in/out
 * or a cache clear, and `dispose()` on deactivation.
 */
export class GutterDecorator {
  /** Live configuration accessor; re-read on every apply. */
  private readonly _getCfg: () => LinearLensConfig;

  /** Cache-backed Linear client; may expose the optional `peekIssue`. */
  private readonly _client: PeekableClient;

  /**
   * Lazily-built decoration types keyed by the color hex string (`#rrggbb`).
   * Insertion order is used as the LRU ordering (Map preserves it); re-touching a
   * key moves it to the end via delete+set.
   */
  private readonly _types = new Map<string, vscode.TextEditorDecorationType>();

  /** Per-document debounce timers for post-fetch re-applies, keyed by URI string. */
  private readonly _refreshTimers = new Map<string, ReturnType<typeof setTimeout>>();

  /**
   * Per-document monotonically increasing render token. Bumped on every `apply`
   * call so a stale background-fetch resolution cannot trigger an out-of-date
   * re-render.
   */
  private readonly _renderTokens = new Map<string, number>();

  /** Normalized ids currently being fetched (de-duplication across editors/passes). */
  private readonly _inFlight = new Set<string>();

  /** Number of fetches currently in progress (bounded by {@link MAX_CONCURRENT_FETCHES}). */
  private _activeFetches = 0;

  /** FIFO queue of distinct ids awaiting a background fetch. */
  private readonly _fetchQueue: IssueId[] = [];

  /** Whether {@link dispose} has run; guards against post-dispose work. */
  private _disposed = false;

  /**
   * Create a `GutterDecorator`.
   *
   * @param getCfg Accessor returning the current resolved configuration. Called
   *               on every apply so the decorator reacts to setting changes
   *               without being recreated.
   * @param client The cache-backed Linear client used to resolve state colors.
   */
  constructor(getCfg: () => LinearLensConfig, client: LinearClient) {
    this._getCfg = getCfg;
    this._client = client as PeekableClient;
  }

  /**
   * (Re)apply gutter decorations to one editor (defaults to the active editor).
   *
   * No-ops (after clearing any prior decorations) when the feature is disabled,
   * the API is off / there is no auth, or the document scheme is unsupported. On
   * a cache miss for a ref, a bounded background fetch is queued and a cheap
   * re-apply is scheduled when it resolves.
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
      // Bump the per-document render token so stale background-fetch resolutions
      // cannot trigger an out-of-date re-render.
      const token = (this._renderTokens.get(key) ?? 0) + 1;
      this._renderTokens.set(key, token);

      if (!SUPPORTED_SCHEMES.has(target.document.uri.scheme)) {
        return;
      }

      const cfg = this._getCfg();

      // Auth-gated + feature-gated: when off, clear everything so no stale or
      // misleading indicator is left behind.
      if (!cfg.enableGutter || !this._client.hasAuth()) {
        this._clearAll(target);
        return;
      }

      const refs = scanText(target.document.getText(), {
        teamKeys: cfg.teamKeys,
        markers: cfg.markers,
      });
      if (refs.length === 0) {
        this._clearAll(target);
        return;
      }

      // Group decoration options by color hex. Only one icon per line (first ref
      // wins) — stacking multiple icons on the same line is not meaningful.
      //
      // We use `DecorationOptions` (with `hoverMessage`) rather than bare `Range`
      // values so we can attach a tooltip to each individual ref range.
      const byHex = new Map<string, vscode.DecorationOptions[]>();
      // De-duped ids that missed the cache, in document order (visible first).
      const missing = new Map<string, { id: IssueId; visible: boolean }>();
      // Lines already decorated this pass (prevent stacking).
      const decoratedLines = new Set<number>();

      for (const ref of refs) {
        const meta = peek(this._client, ref.issue);

        // Resolve the best available color: live hex → stateColor fallback.
        const liveHex = normalizeHex(meta?.stateColor);
        const fallbackHex = stateColor(meta?.stateType);
        const hex = liveHex ?? (meta ? fallbackHex : undefined);

        if (!hex) {
          // No metadata yet — queue a background fetch if not already in flight.
          const existing = missing.get(ref.issue.normalized);
          const visible = this._isRangeVisible(target, ref.start, ref.end);
          if (existing) {
            existing.visible = existing.visible || visible;
          } else {
            missing.set(ref.issue.normalized, { id: ref.issue, visible });
          }
          continue;
        }

        // Anchor the gutter decoration to the start of the line containing the ref.
        const refPos = target.document.positionAt(ref.start);
        const lineNumber = refPos.line;

        if (decoratedLines.has(lineNumber)) {
          // Another ref on this line already claimed the gutter slot.
          continue;
        }
        decoratedLines.add(lineNumber);

        const lineStart = new vscode.Position(lineNumber, 0);
        const range = new vscode.Range(lineStart, lineStart);

        // Build tooltip: "<ID> · <title> · <status>" when metadata is known.
        const tooltip = meta
          ? buildTooltip(ref.issue.normalized, meta)
          : ref.issue.normalized;

        const opts: vscode.DecorationOptions = {
          range,
          hoverMessage: new vscode.MarkdownString(tooltip),
        };

        const bucket = byHex.get(hex);
        if (bucket) {
          bucket.push(opts);
        } else {
          byHex.set(hex, [opts]);
        }
      }

      // Apply: one `setDecorations` per type that has ranges this pass, and clear
      // every other registered type so shrinking ref sets leave no ghost icons.
      for (const [hex, type] of this._types) {
        const opts = byHex.get(hex);
        target.setDecorations(type, opts ?? []);
      }
      // Types newly needed this pass (not yet in _types) are created + applied.
      for (const [hex, opts] of byHex) {
        if (!this._types.has(hex)) {
          const type = this._ensureType(hex);
          target.setDecorations(type, opts);
        }
      }

      // Kick bounded background fetches for cache misses (visible first).
      this._queueMissing(missing);
    } catch {
      // Never throw out of a decorator pass.
    }
  }

  /**
   * Apply gutter decorations to every currently visible editor.
   *
   * Intended for the same events as the inline decorator (config change,
   * visible-editor change) and as the cheap post-fetch re-apply.
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
   * Invalidate all cached decoration types and re-render the visible editors.
   *
   * Call after sign-in/out or a metadata cache clear: state colors may have
   * changed, so existing per-color types are disposed and the visible editors are
   * re-applied (which lazily rebuilds the types they still need).
   */
  refresh(): void {
    if (this._disposed) {
      return;
    }
    this._disposeTypes();
    this.applyToVisible();
  }

  /**
   * Release every decoration type, cancel pending timers, and stop all work.
   *
   * After disposal VS Code automatically removes the decorations from editors.
   * No further `apply` / `applyToVisible` / `refresh` calls do anything.
   */
  dispose(): void {
    this._disposed = true;
    for (const timer of this._refreshTimers.values()) {
      clearTimeout(timer);
    }
    this._refreshTimers.clear();
    this._renderTokens.clear();
    this._fetchQueue.length = 0;
    this._inFlight.clear();
    this._disposeTypes();
  }

  // -------------------------------------------------------------------------
  // Internal helpers
  // -------------------------------------------------------------------------

  /**
   * Look up (touching LRU order) or lazily create the gutter decoration type for
   * a color hex. Evicts the least-recently-used type when the cap is exceeded.
   */
  private _ensureType(hex: string): vscode.TextEditorDecorationType {
    const existing = this._types.get(hex);
    if (existing) {
      // Touch: move to most-recently-used position.
      this._types.delete(hex);
      this._types.set(hex, existing);
      return existing;
    }

    const iconUri = gutterIconUri(hex);
    const type = vscode.window.createTextEditorDecorationType({
      gutterIconPath: iconUri,
      gutterIconSize: "contain",
    });
    this._types.set(hex, type);
    this._evictIfNeeded();
    return type;
  }

  /** Evict least-recently-used types until under {@link MAX_DECORATION_TYPES}. */
  private _evictIfNeeded(): void {
    while (this._types.size > MAX_DECORATION_TYPES) {
      const oldestKey = this._types.keys().next().value as string | undefined;
      if (oldestKey === undefined) {
        return;
      }
      const oldest = this._types.get(oldestKey);
      this._types.delete(oldestKey);
      oldest?.dispose();
    }
  }

  /** Dispose and forget every cached decoration type. */
  private _disposeTypes(): void {
    for (const type of this._types.values()) {
      type.dispose();
    }
    this._types.clear();
  }

  /** Clear this decorator's decorations from a single editor (all types). */
  private _clearAll(editor: vscode.TextEditor): void {
    for (const type of this._types.values()) {
      editor.setDecorations(type, []);
    }
  }

  /** Whether the character range `[start, end)` overlaps any visible range of the editor. */
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
   * debounced re-apply of the visible editors so newly-cached colors render.
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
          // Only schedule a re-render when a color can be resolved so we avoid
          // churn on negative (404/auth-fail) lookups.
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

// ---------------------------------------------------------------------------
// Tooltip builder
// ---------------------------------------------------------------------------

/**
 * Build the hover tooltip text for a gutter icon in the form
 * `"<ID> · <title> · <status>"`.
 *
 * @param normalizedId - The normalized issue identifier, e.g. `"ENG-123"`.
 * @param meta         - The cached issue metadata.
 * @returns A markdown-escaped tooltip string.
 */
function buildTooltip(normalizedId: string, meta: IssueMetadata): string {
  const parts: string[] = [normalizedId];
  if (meta.title.trim()) {
    parts.push(escapeMd(meta.title.trim()));
  }
  const label = stateLabel(meta);
  if (label) {
    parts.push(escapeMd(label));
  }
  return parts.join(" · ");
}

/**
 * Escape the minimal set of Markdown characters that would break inline text in
 * a `MarkdownString` tooltip. Only escapes characters meaningful in inline
 * context, leaving the string human-readable.
 */
function escapeMd(text: string): string {
  return text.replace(/[\\`*_[\]]/g, "\\$&");
}
