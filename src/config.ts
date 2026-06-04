/**
 * Linear Lens — configuration reader.
 *
 * Reads and validates every `linearLens.*` VS Code setting into a strongly
 * typed {@link LinearLensConfig}. All reads are defensive: malformed or missing
 * values are coerced to safe defaults and this module NEVER throws.
 */

import * as vscode from "vscode";
import {
  DiagnosticSeverityName,
  IssueId,
  LinearLensConfig,
  TODO_MARKERS,
} from "./types";
import {
  normalizeGroupBy,
  normalizeOpenInTool,
  normalizeRailInline,
  normalizeSortBy,
  normalizeWorktreeFilter,
} from "./configNormalizers";

// Re-export the pure enum normalizers so existing `./config` importers (and the
// pure unit tests) keep a single, stable surface. The implementations live in
// `./configNormalizers` (no `vscode` import) so they stay unit-testable.
export {
  normalizeGroupBy,
  normalizeOpenInTool,
  normalizeRailInline,
  normalizeSortBy,
  normalizeWorktreeFilter,
} from "./configNormalizers";

/** The configuration section name used by every `linearLens.*` setting. */
export const CONFIG_SECTION = "linearLens";

/** Default metadata cache TTL, in seconds, when the setting is invalid. */
const DEFAULT_CACHE_TTL_SECONDS = 300;

/** Default diagnostic severity when the setting is missing/invalid. */
const DEFAULT_DIAGNOSTIC_SEVERITY: DiagnosticSeverityName = "information";

/** The valid `linearLens.diagnostics.severity` enum values. */
const DIAGNOSTIC_SEVERITIES: readonly DiagnosticSeverityName[] = [
  "error",
  "warning",
  "information",
  "hint",
];

/** Coerce an unknown value to a string, returning `fallback` for non-strings. */
function toStringOr(value: unknown, fallback: string): string {
  return typeof value === "string" ? value : fallback;
}

/** Coerce an unknown value to a boolean, returning `fallback` for non-booleans. */
function toBooleanOr(value: unknown, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback;
}

/**
 * Normalize an unknown value into an array of trimmed, uppercased, non-empty,
 * de-duplicated strings. Non-arrays and non-string entries are dropped. When
 * the result is empty and `fallback` is provided, `fallback` is returned.
 */
function normalizeKeyList(value: unknown, fallback: string[] = []): string[] {
  if (!Array.isArray(value)) {
    return [...fallback];
  }
  const seen = new Set<string>();
  const result: string[] = [];
  for (const entry of value) {
    if (typeof entry !== "string") {
      continue;
    }
    const key = entry.trim().toUpperCase();
    if (key.length === 0 || seen.has(key)) {
      continue;
    }
    seen.add(key);
    result.push(key);
  }
  return result.length > 0 ? result : [...fallback];
}

/** The valid `linearLens.inlineStatus.style` enum values. */
const INLINE_STATUS_STYLES: readonly ["dot", "pill"] = ["dot", "pill"];

/** Default inline status style when the setting is missing/invalid. */
const DEFAULT_INLINE_STATUS_STYLE: "dot" | "pill" = "dot";

/**
 * Validate an unknown value against the inline-status style enum, defaulting to
 * {@link DEFAULT_INLINE_STATUS_STYLE} ("dot") for anything unrecognized.
 */
function normalizeInlineStyle(value: unknown): "dot" | "pill" {
  if (
    typeof value === "string" &&
    (INLINE_STATUS_STYLES as readonly string[]).includes(value)
  ) {
    return value as "dot" | "pill";
  }
  return DEFAULT_INLINE_STATUS_STYLE;
}

/** Validate an unknown value against the diagnostic-severity enum. */
function normalizeSeverity(value: unknown): DiagnosticSeverityName {
  if (
    typeof value === "string" &&
    (DIAGNOSTIC_SEVERITIES as readonly string[]).includes(value)
  ) {
    return value as DiagnosticSeverityName;
  }
  return DEFAULT_DIAGNOSTIC_SEVERITY;
}

/** Coerce an unknown value to a finite, non-negative number, with a fallback. */
function normalizeNonNegativeNumber(value: unknown, fallback: number): number {
  if (typeof value === "number" && Number.isFinite(value) && value >= 0) {
    return value;
  }
  return fallback;
}

/** Default list limit for the views when `views.recent.limit` is unset/invalid. */
const DEFAULT_VIEWS_RECENT_LIMIT = 25;

/** Lowest / highest list limit accepted for `views.recent.limit`. */
const MIN_VIEWS_RECENT_LIMIT = 1;
const MAX_VIEWS_RECENT_LIMIT = 100;

/**
 * Coerce an unknown value into an integer clamped to `[1, 100]`, defaulting to
 * {@link DEFAULT_VIEWS_RECENT_LIMIT} when missing or invalid. Never throws.
 */
function normalizeListLimit(value: unknown): number {
  if (typeof value === "number" && Number.isFinite(value)) {
    return Math.min(
      MAX_VIEWS_RECENT_LIMIT,
      Math.max(MIN_VIEWS_RECENT_LIMIT, Math.floor(value)),
    );
  }
  return DEFAULT_VIEWS_RECENT_LIMIT;
}

/**
 * Read and validate all `linearLens.*` settings into a {@link LinearLensConfig}.
 *
 * Every field is coerced to a safe default if missing or malformed; this
 * function never throws.
 */
export function getConfig(): LinearLensConfig {
  const cfg = vscode.workspace.getConfiguration(CONFIG_SECTION);
  return {
    workspaceSlug: toStringOr(cfg.get("workspaceSlug"), "").trim(),
    teamKeys: normalizeKeyList(cfg.get("teamKeys")),
    markers: normalizeKeyList(cfg.get("markers"), [...TODO_MARKERS]),
    enableDiagnostics: toBooleanOr(cfg.get("diagnostics.enable"), true),
    diagnosticSeverity: normalizeSeverity(cfg.get("diagnostics.severity")),
    enableLinks: toBooleanOr(cfg.get("links.enable"), true),
    enableHover: toBooleanOr(cfg.get("hover.enable"), true),
    hoverShowAvatars: toBooleanOr(cfg.get("hover.showAvatars"), true),
    hoverShowLabels: toBooleanOr(cfg.get("hover.showLabels"), true),
    hoverShowBranchActions: toBooleanOr(cfg.get("hover.showBranchActions"), true),
    enableDecorations: toBooleanOr(cfg.get("decorations.enable"), true),
    enableStatusBar: toBooleanOr(cfg.get("statusBar.enable"), true),
    enableApi: toBooleanOr(cfg.get("api.enable"), true),
    cacheTtlSeconds: normalizeNonNegativeNumber(
      cfg.get("cache.ttlSeconds"),
      DEFAULT_CACHE_TTL_SECONDS,
    ),
    cachePersist: toBooleanOr(cfg.get("cache.persist"), true),
    enableInlineStatus: toBooleanOr(cfg.get("inlineStatus.enable"), false),
    inlineStatusStyle: normalizeInlineStyle(cfg.get("inlineStatus.style")),
    railInline: normalizeRailInline(cfg.get("rail.inline")),
    railOverviewRuler: toBooleanOr(cfg.get("rail.overviewRuler"), true),
    enableBlameHover: toBooleanOr(cfg.get("blameHover.enable"), true),
    enableViews: toBooleanOr(cfg.get("views.enable"), true),
    viewsRecentLimit: normalizeListLimit(cfg.get("views.recent.limit")),
    copyMarkdownIncludeComments: toBooleanOr(
      cfg.get("copyMarkdown.includeComments"),
      false,
    ),
    enableEdit: toBooleanOr(cfg.get("edit.enable"), true),
    enableCreate: toBooleanOr(cfg.get("create.enable"), true),
    teamsEnable: toBooleanOr(cfg.get("teams.enable"), true),
    // `teams.show` is a team-KEY allowlist; reuse the key normalizer (trims,
    // uppercases, de-dups). Empty ⇒ show all teams (or just the viewer's).
    teamsShow: normalizeKeyList(cfg.get("teams.show")),
    teamsViewerOnly: toBooleanOr(cfg.get("teams.viewerOnly"), true),
    teamsAutoDetect: toBooleanOr(cfg.get("teams.autoDetect"), true),
    boardEnable: toBooleanOr(cfg.get("board.enable"), true),
    viewDefaultGroupBy: normalizeGroupBy(cfg.get("view.defaultGroupBy")),
    viewDefaultSortBy: normalizeSortBy(cfg.get("view.defaultSortBy")),
    debug: toBooleanOr(cfg.get("debug"), false),
    worktreeFilter: normalizeWorktreeFilter(cfg.get("worktree.filter")),
    openInTool: normalizeOpenInTool(cfg.get("openIn.tool")),
    openInCustomCommand: toStringOr(cfg.get("openIn.customCommand"), "").trim(),
    confirmDestructive: toBooleanOr(cfg.get("write.confirmDestructive"), true),
  };
}

/**
 * Build the canonical Linear URL for an issue:
 * `https://linear.app/<slug>/issue/<NORMALIZED-ID>`.
 *
 * @example
 * issueUrl({ team: "ENG", number: 123, normalized: "ENG-123" }, "acme")
 * // => "https://linear.app/acme/issue/ENG-123"
 *
 * If `slug` is empty, still returns a best-effort URL using `""` — callers are
 * expected to guard against an empty slug before opening the link.
 */
export function issueUrl(issue: IssueId, slug: string): string {
  return `https://linear.app/${slug}/issue/${issue.normalized}`;
}
