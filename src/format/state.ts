/**
 * Linear Lens — shared workflow-state visuals (pure, no `vscode` import).
 *
 * A single source of truth mapping a Linear workflow-state TYPE
 * (`"backlog" | "unstarted" | "started" | "completed" | "canceled" | "triage"`,
 * or any unknown/missing value) to:
 *  - a reliable unicode/emoji circle glyph ({@link stateEmoji}) that renders in
 *    BOTH a VS Code hover `MarkdownString` (where `data:` SVG images do NOT
 *    render) and the webview, and
 *  - a stable fallback hex color ({@link stateColor}) for tinting dots/pills when
 *    Linear's own `state.color` is missing or unparseable.
 *
 * It also exposes {@link stateLabel}, a tiny helper that prefers the live state
 * NAME (e.g. "In Progress") and falls back to a human label derived from the
 * type, so callers never render an empty status.
 *
 * This module is intentionally `vscode`-free and dependency-free so it can be
 * imported by the hover provider, the inline-status decorator, the tree views,
 * and the webview-facing code alike, and unit-tested in plain Node (vitest).
 */

/**
 * The canonical Linear workflow-state categories. Linear returns these verbatim
 * as `state.type`. `"triage"` exists on workspaces with triage enabled.
 */
export type StateType =
  | "backlog"
  | "unstarted"
  | "started"
  | "completed"
  | "canceled"
  | "triage";

/** The full set of recognized {@link StateType} values, for validation/tests. */
export const STATE_TYPES: readonly StateType[] = [
  "backlog",
  "unstarted",
  "started",
  "completed",
  "canceled",
  "triage",
];

/**
 * A minimal structural view of the fields these helpers read. Both
 * {@link IssueMetadata} and {@link IssueListItem} satisfy it, so callers can pass
 * either without an adapter.
 */
export interface StateLike {
  /** Live workflow-state NAME, e.g. "In Progress" (may be empty/undefined). */
  state?: string;
  /** Workflow-state TYPE, e.g. "started" (may be empty/undefined). */
  stateType?: string;
}

/**
 * Reliable circle glyphs per state type. These are plain unicode/emoji code
 * points (NOT `data:` SVG images), so they render in a VS Code hover
 * `MarkdownString` — where image markdown with `data:image/svg+xml` URIs does
 * NOT render — as well as in the webview and the tree.
 *
 * Chosen for at-a-glance legibility in both light and dark themes:
 *  - backlog / unstarted → ⚪ (hollow/neutral, "not started")
 *  - started            → 🔵 (active, "in progress")
 *  - completed          → 🟢 (done)
 *  - canceled           → ⚫ (closed without completion)
 *  - triage             → 🟠 (needs attention)
 */
const STATE_EMOJI: Record<StateType, string> = {
  backlog: "⚪",
  unstarted: "⚪",
  started: "🔵",
  completed: "🟢",
  canceled: "⚫",
  triage: "🟠",
};

/** Fallback emoji for an unknown/missing state type. */
const UNKNOWN_EMOJI = "⚪";

/**
 * Stable fallback hex colors per state type (lowercase `#rrggbb`), aligned with
 * Linear's default palette. Used only when the live `state.color` is missing or
 * unparseable, so a dot/pill always has a sensible tint.
 */
const STATE_COLOR: Record<StateType, string> = {
  backlog: "#bec2c8",
  unstarted: "#e2e2e2",
  started: "#f2c94c",
  completed: "#5e6ad2",
  canceled: "#95a2b3",
  triage: "#f2994a",
};

/** Fallback color for an unknown/missing state type (neutral gray). */
const UNKNOWN_COLOR = "#bec2c8";

/** Human-readable labels derived from the state type, used when no name exists. */
const STATE_TYPE_LABEL: Record<StateType, string> = {
  backlog: "Backlog",
  unstarted: "Todo",
  started: "In Progress",
  completed: "Done",
  canceled: "Canceled",
  triage: "Triage",
};

/**
 * Narrow an arbitrary string to a known {@link StateType}, case-insensitively.
 * Returns `undefined` for missing or unrecognized values.
 *
 * @param type - A raw `state.type` string (or anything).
 * @returns The matching {@link StateType}, or `undefined`.
 */
export function normalizeStateType(type: string | undefined): StateType | undefined {
  if (typeof type !== "string") {
    return undefined;
  }
  const lower = type.trim().toLowerCase();
  return (STATE_TYPES as readonly string[]).includes(lower)
    ? (lower as StateType)
    : undefined;
}

/**
 * The reliable circle glyph for a workflow-state type. Falls back to a neutral
 * hollow circle for unknown/missing types so the caller always has a glyph.
 *
 * @param type - The workflow-state type (any string; unknowns map to the default).
 * @returns A single unicode/emoji circle that renders in hovers and the webview.
 */
export function stateEmoji(type: string | undefined): string {
  const t = normalizeStateType(type);
  return t ? STATE_EMOJI[t] : UNKNOWN_EMOJI;
}

/**
 * The stable fallback hex color (`#rrggbb`, lowercase) for a workflow-state
 * type. Intended as a backstop when Linear's live `state.color` is absent or
 * invalid; prefer the live color when you have a valid one.
 *
 * @param type - The workflow-state type (any string; unknowns map to gray).
 * @returns A lowercase `#rrggbb` hex color string.
 */
export function stateColor(type: string | undefined): string {
  const t = normalizeStateType(type);
  return t ? STATE_COLOR[t] : UNKNOWN_COLOR;
}

/**
 * The best display label for an issue's state: the live state NAME when present
 * (e.g. "In Progress"), else a human label derived from the TYPE (e.g. "Done"),
 * else an empty string when neither is available.
 *
 * @param meta - Anything carrying a `state` name and/or `stateType`.
 * @returns A non-`undefined` display label (possibly "").
 */
export function stateLabel(meta: StateLike | undefined): string {
  const name = meta?.state?.trim();
  if (name) {
    return name;
  }
  const t = normalizeStateType(meta?.stateType);
  return t ? STATE_TYPE_LABEL[t] : "";
}
