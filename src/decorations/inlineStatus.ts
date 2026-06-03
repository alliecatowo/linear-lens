/**
 * Linear Lens — inline status decorator.
 *
 * Renders a small colored status indicator (a dot or a labeled "pill") immediately
 * after each recognized Linear issue reference, reflecting the issue's live
 * workflow-state color (`state.color`). It is a separate decorator from
 * {@link IssueDecorator} (the dotted-underline highlight): this one is live,
 * auth-gated, cache-backed, and debounced so it never blocks typing and never
 * spams the API.
 *
 * Design (spec V1.1 §9):
 *  - VS Code requires a distinct {@link vscode.TextEditorDecorationType} per
 *    visual style, so we maintain a lazily-built `Map<typeKey, type>` keyed by
 *    `style + ":" + colorHex + ":" + text`. The map is LRU-capped and fully
 *    disposed/rebuilt on {@link InlineStatusDecorator.refresh} and
 *    {@link InlineStatusDecorator.dispose}.
 *  - For each visible editor we `scanText` the document, then resolve each ref's
 *    color via the client's synchronous cache peek (`peekIssue`). On a miss we
 *    queue the id for a bounded, visible-ranges-first background fetch (≤4 in
 *    flight); when those resolve we debounce a cheap re-apply of the visible
 *    editors.
 *  - Decorations are grouped by type so each type gets exactly one
 *    `setDecorations` call. Types that had ranges in a previous pass but none in
 *    the current one are cleared to avoid ghost dots.
 *  - When disabled, signed out, or for non-`file`/`untitled` schemes, nothing is
 *    rendered (we never show a neutral dot that would imply a state).
 *
 * This module never throws.
 */

import * as vscode from "vscode";
import { scanText } from "../parser";
import type {
  IssueId,
  IssueMetadata,
  LinearClient,
  LinearLensConfig,
} from "../types";

/** Glyph used for the "dot" style indicator. */
const DOT_GLYPH = "●"; // ●

/** Left margin applied so the indicator does not touch the id text. */
const INDICATOR_MARGIN = "0 0 0 0.25em";

/** Debounce window (ms) for re-applying after background fetches resolve. */
const REFRESH_DEBOUNCE_MS = 250;

/** Maximum number of in-flight `fetchIssue` calls at any one time. */
const MAX_CONCURRENT_FETCHES = 4;

/**
 * Upper bound on the number of cached decoration types. Pill types vary by both
 * color and state text, so a file with many distinct states could otherwise
 * create unbounded types. We evict least-recently-used entries past this cap.
 */
const MAX_DECORATION_TYPES = 64;

/** Document schemes the decorator operates on; mirrors {@link IssueDecorator}. */
const SUPPORTED_SCHEMES = new Set(["file", "untitled"]);

/**
 * A {@link LinearClient} that may expose the optional synchronous cache peek
 * added in spec V1.1 §9. We feature-detect it so the decorator degrades
 * gracefully if it is ever handed a client without the method.
 */
type PeekableClient = LinearClient & {
  /** Synchronous cache peek for inline rendering; null when absent/expired. */
  peekIssue?: (id: IssueId) => IssueMetadata | null;
};

/**
 * Read cached metadata for an id without ever throwing or hitting the network.
 *
 * Prefers the client's synchronous `peekIssue` when present (the cheap path used
 * on every keystroke); returns `null` when the method is unavailable so callers
 * fall back to a background fetch.
 */
function peek(client: PeekableClient, id: IssueId): IssueMetadata | null {
  try {
    return client.peekIssue ? client.peekIssue(id) : null;
  } catch {
    return null;
  }
}

/**
 * Renders an inline status indicator (colored dot or state pill) immediately
 * after each recognized issue reference, reflecting the issue's live
 * workflow-state color.
 *
 * Lifecycle: construct once during activation, call `applyToVisible()` on the
 * same events as {@link IssueDecorator} (document open/change, active-editor and
 * visible-editors changes, config changes), call `refresh()` after sign-in/out
 * or a cache clear, and `dispose()` on deactivation.
 */
export class InlineStatusDecorator {
  /** Live configuration accessor; read on every apply so settings take effect. */
  private readonly _getCfg: () => LinearLensConfig;

  /** Cache-backed Linear client; may expose the optional `peekIssue`. */
  private readonly _client: PeekableClient;

  /**
   * Lazily-built decoration types keyed by `style + ":" + colorHex + ":" + text`.
   * Insertion order is used as the LRU ordering (Map preserves it); re-touching a
   * key moves it to the end via delete+set.
   */
  private readonly _types = new Map<string, vscode.TextEditorDecorationType>();

  /** Per-document debounce timers for post-fetch re-applies, keyed by URI. */
  private readonly _refreshTimers = new Map<string, ReturnType<typeof setTimeout>>();

  /**
   * Per-document monotonically increasing render token. Bumped on every `apply`
   * so a stale background fetch that resolves after a newer edit does not trigger
   * an out-of-date re-render.
   */
  private readonly _renderTokens = new Map<string, number>();

  /** Ids currently being fetched (de-dupe across editors/passes). */
  private readonly _inFlight = new Set<string>();

  /** Number of fetches currently in progress (bounded by {@link MAX_CONCURRENT_FETCHES}). */
  private _activeFetches = 0;

  /** FIFO queue of distinct ids awaiting a background fetch. */
  private readonly _fetchQueue: IssueId[] = [];

  /** Whether {@link dispose} has run; guards against post-dispose work. */
  private _disposed = false;

  /**
   * Create an `InlineStatusDecorator`.
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
   * (Re)apply inline status decorations to one editor (defaults to the active
   * editor).
   *
   * No-ops (after clearing any prior decorations) when the feature is disabled,
   * the API is off / there is no auth, or the document scheme is unsupported. On
   * a cache miss for a visible ref, a bounded background fetch is queued and a
   * cheap re-apply is scheduled when it resolves.
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
      // Bump the per-document render token so any in-flight fetch resolving for
      // an older document state cannot trigger a stale re-render.
      const token = (this._renderTokens.get(key) ?? 0) + 1;
      this._renderTokens.set(key, token);

      if (!SUPPORTED_SCHEMES.has(target.document.uri.scheme)) {
        return;
      }

      const cfg = this._getCfg();

      // Auth-gated + feature-gated: when off, clear everything so no stale or
      // misleading neutral indicator is left behind.
      if (!cfg.enableInlineStatus || !this._client.hasAuth()) {
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

      const style = cfg.inlineStatusStyle;

      // Group ranges by decoration type so each type gets ONE setDecorations call.
      const rangesByType = new Map<string, vscode.Range[]>();
      // De-duped ids that missed the cache, in document order, so we can resolve
      // visible ones first.
      const missing = new Map<string, { id: IssueId; visible: boolean }>();

      for (const ref of refs) {
        const meta = peek(this._client, ref.issue);
        const hex = normalizeHex(meta?.stateColor);

        if (!meta || !hex) {
          const existing = missing.get(ref.issue.normalized);
          const visible = this._isRangeVisible(target, ref.start, ref.end);
          if (existing) {
            existing.visible = existing.visible || visible;
          } else {
            missing.set(ref.issue.normalized, { id: ref.issue, visible });
          }
          continue;
        }

        // The indicator is attached AFTER the id, so anchor the range at the
        // id's end position with a zero-width range.
        const end = target.document.positionAt(ref.end);
        const range = new vscode.Range(end, end);

        const text = style === "pill" ? this._pillText(meta) : DOT_GLYPH;
        const typeKey = this._typeKey(style, hex, text);
        const bucket = rangesByType.get(typeKey);
        if (bucket) {
          bucket.push(range);
        } else {
          rangesByType.set(typeKey, [range]);
        }
      }

      // Apply: one setDecorations per type that has ranges this pass, and clear
      // every other still-registered type so shrinking ref sets leave no ghosts.
      for (const [typeKey, type] of this._types) {
        const ranges = rangesByType.get(typeKey);
        target.setDecorations(type, ranges ?? []);
      }
      // Types newly needed this pass (not yet in _types) are created + applied.
      for (const [typeKey, ranges] of rangesByType) {
        if (this._types.has(typeKey)) {
          continue;
        }
        const type = this._ensureType(typeKey);
        target.setDecorations(type, ranges);
      }

      // Kick bounded background fetches for cache misses (visible first).
      this._queueMissing(missing);
    } catch {
      // Never throw out of a decorator pass.
    }
  }

  /**
   * Apply inline status decorations to every currently visible editor.
   *
   * Intended for the same events as {@link IssueDecorator.applyToVisible}
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
   * Invalidate all cached decoration types and re-render the visible editors.
   *
   * Call after sign-in/out or a metadata cache clear: state colors may have
   * changed, so existing per-color types are disposed and the visible editors are
   * re-applied (which lazily rebuilds the types it still needs).
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

  /** Build the LRU/grouping key for a decoration type. */
  private _typeKey(style: string, hex: string, text: string): string {
    return `${style}:${hex}:${text}`;
  }

  /** The pill label for an issue: its state name (or a short fallback). */
  private _pillText(meta: IssueMetadata): string {
    const name = meta.state.trim();
    // Surround with thin spaces so the colored background reads as a chip.
    return ` ${name || "?"} `;
  }

  /**
   * Look up (touching LRU order) or lazily create the decoration type for a key.
   * Evicts the least-recently-used type when the cap is exceeded.
   */
  private _ensureType(typeKey: string): vscode.TextEditorDecorationType {
    const existing = this._types.get(typeKey);
    if (existing) {
      // Touch: move to most-recently-used position.
      this._types.delete(typeKey);
      this._types.set(typeKey, existing);
      return existing;
    }

    const [style, hex, ...rest] = typeKey.split(":");
    const text = rest.join(":");
    const type = this._createType(style, hex, text);
    this._types.set(typeKey, type);
    this._evictIfNeeded();
    return type;
  }

  /** Create a decoration type rendering the indicator via an `after` attachment. */
  private _createType(
    style: string,
    hex: string,
    text: string,
  ): vscode.TextEditorDecorationType {
    if (style === "pill") {
      // A faux chip: colored background, contrasting text, rounded via border.
      return vscode.window.createTextEditorDecorationType({
        rangeBehavior: vscode.DecorationRangeBehavior.ClosedClosed,
        after: {
          contentText: text,
          color: contrastForeground(hex),
          backgroundColor: hex,
          margin: INDICATOR_MARGIN,
          border: "1px solid transparent",
          fontWeight: "600",
        },
      });
    }
    // Dot style: a single glyph tinted with the state color.
    return vscode.window.createTextEditorDecorationType({
      rangeBehavior: vscode.DecorationRangeBehavior.ClosedClosed,
      after: {
        contentText: text,
        color: hex,
        margin: INDICATOR_MARGIN,
      },
    });
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

  /** Whether `[start,end)` overlaps any of the editor's visible ranges. */
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
   * skipping ids already in-flight or queued. Pumps the fetch loop afterwards.
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
   * debounced, cheap re-apply of the visible editors so newly-known colors render.
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
          // Only schedule a re-render when something resolvable came back, to
          // avoid churn on negative lookups.
          if (meta && normalizeHex(meta.stateColor)) {
            this._scheduleRefresh();
          }
          this._pumpFetches();
        });
    }
  }

  /**
   * Debounce a cheap re-apply of the visible editors. Coalesces a burst of
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
// Local color helpers
// ---------------------------------------------------------------------------
//
// Spec §3 introduces `src/format/color.ts` with `normalizeHex` / `contrastForeground`.
// That module is owned by a different build step; to keep this file self-contained
// and never-throwing (and to avoid a cross-step import that may not exist yet), we
// inline tiny, defensive equivalents here. They share the same contract:
// `normalizeHex` returns "#rrggbb" lowercase or undefined; `contrastForeground`
// returns "#000000" / "#ffffff".

/**
 * Normalize a hex color to "#rrggbb" (lowercase), expanding shorthand "#rgb".
 * Returns `undefined` when the input is missing or not a valid hex color.
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
 * Choose a readable foreground ("#000000" or "#ffffff") for a background hex
 * using the W3C relative-luminance threshold. Falls back to white for invalid
 * input.
 */
function contrastForeground(hex: string): string {
  const normalized = normalizeHex(hex);
  if (!normalized) {
    return "#ffffff";
  }
  const r = parseInt(normalized.slice(1, 3), 16) / 255;
  const g = parseInt(normalized.slice(3, 5), 16) / 255;
  const b = parseInt(normalized.slice(5, 7), 16) / 255;
  const toLinear = (c: number): number =>
    c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
  const luminance =
    0.2126 * toLinear(r) + 0.7152 * toLinear(g) + 0.0722 * toLinear(b);
  return luminance > 0.179 ? "#000000" : "#ffffff";
}
