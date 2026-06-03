/**
 * Linear Lens — shared contracts.
 *
 * This file is the single source of truth that every module compiles against.
 * It MUST NOT import `vscode` so that pure modules (parser, config helpers)
 * remain unit-testable in plain Node via vitest.
 */

// ---------------------------------------------------------------------------
// Issue identity
// ---------------------------------------------------------------------------

/** A parsed Linear issue identifier, e.g. "ENG-123". */
export interface IssueId {
  /** Team key, normalized to uppercase, e.g. "ENG". */
  team: string;
  /** Numeric portion, e.g. 123. */
  number: number;
  /** Canonical form, always uppercase team + "-" + number, e.g. "ENG-123". */
  normalized: string;
}

// ---------------------------------------------------------------------------
// References found in text
// ---------------------------------------------------------------------------

/**
 * How an issue reference was found. This is the crux of the product rule:
 * only `"todo"` refs ever become Problems diagnostics. Everything else
 * links + hovers but is never reported as a diagnostic.
 */
export type RefKind =
  /** Bound to a TODO/FIXME/BUG/HACK marker — actionable, eligible for diagnostics. */
  | "todo"
  /** A bare reference in prose, e.g. "Fixed in ENG-123" — link/hover only. */
  | "raw"
  /** A full linear.app issue URL — link/hover only. */
  | "url";

/** The actionable comment markers that bind a reference into a TODO ref. */
export type TodoMarker = "TODO" | "FIXME" | "BUG" | "HACK";

/** All recognized TODO-family markers, in priority order. */
export const TODO_MARKERS: readonly TodoMarker[] = ["TODO", "FIXME", "BUG", "HACK"];

/**
 * A single detected reference within scanned text. Offsets are absolute,
 * zero-based character indexes into the exact string passed to `scanText`,
 * so providers can map them with `document.positionAt(offset)`.
 */
export interface IssueRef {
  /** The resolved issue identity. */
  issue: IssueId;
  /** How the reference was found — drives diagnostics eligibility. */
  kind: RefKind;
  /** The bound marker keyword, present only when `kind === "todo"`. */
  marker?: TodoMarker;
  /** Start offset of the highlighted token (the ID, or the full URL for url refs). */
  start: number;
  /** End offset (exclusive) of the highlighted token. */
  end: number;
  /** The exact matched substring, preserving original casing. */
  raw: string;
  /** For `kind === "url"`, the full matched URL. */
  url?: string;
}

/** Options controlling how text is scanned for references. */
export interface ScanOptions {
  /**
   * If non-empty, only these team keys (compared case-insensitively) are
   * recognized as issue IDs. When empty/undefined, any `ABC-123`-shaped token
   * with a 2–7 letter uppercase-able key is recognized.
   */
  teamKeys?: string[];
}

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

/** Diagnostic severities mirroring the `linearLens.diagnostics.severity` enum. */
export type DiagnosticSeverityName = "error" | "warning" | "information" | "hint";

/** Resolved, validated extension configuration. */
export interface LinearLensConfig {
  /** `linearLens.workspaceSlug` — used to build issue URLs. May be "". */
  workspaceSlug: string;
  /** `linearLens.teamKeys` — optional allowlist of recognized team keys. */
  teamKeys: string[];
  /** `linearLens.diagnostics.enable`. */
  enableDiagnostics: boolean;
  /** `linearLens.diagnostics.severity`. */
  diagnosticSeverity: DiagnosticSeverityName;
  /** `linearLens.api.enable` — opt-in to live metadata fetches. */
  enableApi: boolean;
  /** `linearLens.cache.ttlSeconds` — metadata cache TTL. */
  cacheTtlSeconds: number;
}

// ---------------------------------------------------------------------------
// Linear API (optional, V1.5)
// ---------------------------------------------------------------------------

/** Live issue metadata fetched from the Linear API for rich hovers. */
export interface IssueMetadata {
  /** Normalized identifier, e.g. "ENG-123". */
  id: string;
  title: string;
  /** Workflow state name, e.g. "In Progress". */
  state: string;
  /** Workflow state type, e.g. "started" | "completed" | "canceled". */
  stateType?: string;
  /** Assignee display name, if any. */
  assignee?: string;
  /** Human priority label, e.g. "Urgent" | "High" | "No priority". */
  priority?: string;
  /** Project name, if any. */
  project?: string;
  /** Canonical Linear URL. */
  url: string;
  /** Whether the issue is archived. */
  archived: boolean;
}

/**
 * Optional Linear API client. ALL methods degrade gracefully and NEVER throw:
 * when auth/API is unavailable, `fetchIssue` resolves to `null` so callers fall
 * back to basic link/hover behavior.
 */
export interface LinearClient {
  /** Fetch metadata for an issue, or `null` if unavailable. Never throws. */
  fetchIssue(id: IssueId): Promise<IssueMetadata | null>;
  /** Drop all cached metadata. */
  clearCache(): void;
  /** Whether an API key is currently present and the API is enabled. */
  hasAuth(): boolean;
  /** Re-read auth state (e.g. after a key is set/cleared). */
  refreshAuth(): Promise<void>;
}
