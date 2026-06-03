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
  /** Bound to an actionable marker (TODO/FIXME/…) — eligible for diagnostics. */
  | "todo"
  /** A bare reference in prose, e.g. "Fixed in ENG-123" — link/hover only. */
  | "raw"
  /** A full linear.app issue URL — link/hover only. */
  | "url";

/** The default actionable comment markers that bind a reference into a TODO ref. */
export type TodoMarker = "TODO" | "FIXME" | "BUG" | "HACK";

/** The default recognized TODO-family markers, in priority order. */
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
  /**
   * The bound marker keyword (uppercased), present only when `kind === "todo"`
   * and a keyword marker matched. Left undefined for checkbox-derived todos.
   * Typed as a string to support user-configured custom markers.
   */
  marker?: string;
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
  /**
   * Actionable marker keywords that make a line's refs `kind: "todo"`. Compared
   * case-insensitively with word boundaries. Defaults to {@link TODO_MARKERS}
   * when empty/undefined.
   */
  markers?: string[];
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
  /** `linearLens.markers` — actionable markers; defaults to {@link TODO_MARKERS}. */
  markers: string[];
  /** `linearLens.diagnostics.enable`. */
  enableDiagnostics: boolean;
  /** `linearLens.diagnostics.severity`. */
  diagnosticSeverity: DiagnosticSeverityName;
  /** `linearLens.links.enable` — toggle DocumentLinks. */
  enableLinks: boolean;
  /** `linearLens.hover.enable` — toggle hovers. */
  enableHover: boolean;
  /** `linearLens.hover.showAvatars` — show assignee/subscriber avatars in rich hovers. */
  hoverShowAvatars: boolean;
  /** `linearLens.hover.showLabels` — show colored label chips in rich hovers. */
  hoverShowLabels: boolean;
  /** `linearLens.hover.showBranchActions` — show the branch name + Checkout/View diff links. */
  hoverShowBranchActions: boolean;
  /** `linearLens.decorations.enable` — toggle the in-editor highlight. */
  enableDecorations: boolean;
  /** `linearLens.statusBar.enable` — toggle the branch status bar item. */
  enableStatusBar: boolean;
  /** `linearLens.api.enable` — master switch for live metadata fetches. */
  enableApi: boolean;
  /** `linearLens.cache.ttlSeconds` — metadata cache TTL. */
  cacheTtlSeconds: number;
  /** `linearLens.inlineStatus.enable` — toggle the inline state dot/pill after each ref. */
  enableInlineStatus: boolean;
  /** `linearLens.inlineStatus.style` — inline status indicator style ("dot" | "pill"). */
  inlineStatusStyle: "dot" | "pill";
  /** `linearLens.views.enable` — show the Linear Activity Bar tree views. */
  enableViews: boolean;
  /** `linearLens.views.recent.limit` — how many issues to load in the list/search views. */
  viewsRecentLimit: number;
}

// ---------------------------------------------------------------------------
// Authentication
// ---------------------------------------------------------------------------

/** A ready-to-send `Authorization` header value plus which mechanism produced it. */
export interface AuthHeader {
  /**
   * The full header value. For OAuth this is `"Bearer <accessToken>"`; for a
   * personal API key it is the raw key (Linear personal keys carry no prefix).
   */
  value: string;
  /** Which credential produced the header, for diagnostics. */
  kind: "oauth" | "apiKey";
}

// ---------------------------------------------------------------------------
// Linear API (optional)
// ---------------------------------------------------------------------------

/** A person reference with an optional avatar, used for assignee/creator/subscribers. */
export interface Person {
  /** Internal name (login-ish), may be empty. */
  name: string;
  /** Preferred display name; falls back to `name` when empty. */
  displayName: string;
  /** Absolute avatar image URL, if Linear has one. */
  avatarUrl?: string;
}

/** A Linear label with its hex color (e.g. "#5E6AD2"). */
export interface IssueLabel {
  /** Label name. */
  name: string;
  /** Hex color string like "#RRGGBB", or undefined if unknown. */
  color?: string;
}

/** A single comment on an issue. */
export interface IssueComment {
  /** Stable comment id. */
  id: string;
  /** Raw markdown body. */
  body: string;
  /** ISO-8601 creation timestamp. */
  createdAt: string;
  /** Comment author, if available. */
  author?: Person;
}

/** An attachment/link/image on an issue. */
export interface IssueAttachment {
  /** Human-readable title for the attachment. */
  title: string;
  /** Absolute URL the attachment points to. */
  url: string;
}

/** Live issue metadata fetched from the Linear API for rich hovers + the detail view. */
export interface IssueMetadata {
  /** Normalized identifier, e.g. "ENG-123". */
  id: string;
  title: string;
  /** Workflow state name, e.g. "In Progress". */
  state: string;
  /** Workflow state type, e.g. "started" | "completed" | "canceled". */
  stateType?: string;
  /** Workflow state hex color (good for pills/dots), e.g. "#4CB782". */
  stateColor?: string;
  /** Assignee (preferred), if any. */
  assignee?: Person;
  /** Issue creator, if available. */
  creator?: Person;
  /** Human priority label, e.g. "Urgent" | "High" | "No priority". */
  priority?: string;
  /** Project name, if any. */
  project?: string;
  /** Labels with colors (empty array when none). */
  labels: IssueLabel[];
  /** Subscribers / collaborators with avatars (empty array when none). */
  subscribers: Person[];
  /** Markdown description body (may be empty). */
  description?: string;
  /** Linear's suggested git branch name for the issue, if any. */
  branchName?: string;
  /** Comments, newest-last as Linear returns them (empty array when none). */
  comments: IssueComment[];
  /** Attachments/images (empty array when none). */
  attachments: IssueAttachment[];
  /** Canonical Linear URL. */
  url: string;
  /** Whether the issue is archived. */
  archived: boolean;
}

// ---------------------------------------------------------------------------
// Ticket detail (V3 webview — heavier, on-demand fetch)
// ---------------------------------------------------------------------------

/**
 * The FULL, normalized detail payload for a single issue, used by the on-demand
 * webview detail panel (V3). It is a strict superset of the fields the rich
 * hover needs: rendered-ready markdown {@link TicketDetail.description}, the
 * complete {@link TicketDetail.comments} thread (each with author + avatar),
 * colored {@link TicketDetail.labels}, {@link TicketDetail.attachments}, the
 * {@link TicketDetail.assignee} and the {@link TicketDetail.collaborators} list.
 *
 * It deliberately mirrors {@link IssueMetadata} (so a panel can render either)
 * but renames `subscribers` to the webview-facing `collaborators` and is
 * produced by the heavier {@link LinearClient.fetchTicketDetail} call rather
 * than the lightweight hover {@link LinearClient.fetchIssue}.
 *
 * Every field is null-tolerant at the source; the mapper fills sensible
 * defaults (`""`, `[]`, `undefined`) so the webview never sees `null`.
 */
export interface TicketDetail {
  /** Normalized identifier, e.g. "ENG-123". */
  id: string;
  /** Issue title (may be empty). */
  title: string;
  /** Canonical Linear URL. */
  url: string;
  /** Linear's suggested git branch name for the issue, if any. */
  branchName?: string;
  /** Whether the issue is archived. */
  archived: boolean;
  /** Human priority label, e.g. "Urgent" | "High" | "No priority". */
  priority?: string;
  /** Project name, if any. */
  project?: string;
  /** Workflow state name, e.g. "In Progress". */
  state: string;
  /** Workflow state type, e.g. "started" | "completed" | "canceled". */
  stateType?: string;
  /** Workflow state hex color (good for pills/dots), e.g. "#4CB782". */
  stateColor?: string;
  /** Markdown description body (empty string when none). */
  description: string;
  /** Issue assignee, if any. */
  assignee?: Person;
  /** Issue creator, if available. */
  creator?: Person;
  /** Collaborators / subscribers with avatars (empty array when none). */
  collaborators: Person[];
  /** Labels with colors (empty array when none). */
  labels: IssueLabel[];
  /** The full comment thread, oldest-first as Linear returns it (empty when none). */
  comments: IssueComment[];
  /** Attachments / links / images (empty array when none). */
  attachments: IssueAttachment[];
}

// ---------------------------------------------------------------------------
// Issue list / search shapes (V2)
// ---------------------------------------------------------------------------

/** A lightweight issue summary used by tree views and the search quick-pick. */
export interface IssueListItem {
  /** Normalized identifier, e.g. "ENG-123". */
  id: string;
  title: string;
  /** Workflow state name. */
  state: string;
  /** Workflow state hex color, for the tree icon/dot. */
  stateColor?: string;
  stateType?: string;
  /** Assignee display name, if any. */
  assignee?: string;
  /** Canonical Linear URL. */
  url: string;
  /** ISO-8601 last-updated timestamp, for sorting "recent". */
  updatedAt?: string;
}

/** Which working set a list query targets. */
export type IssueListScope = "mine" | "recent";

/**
 * Optional Linear API client. ALL methods degrade gracefully and NEVER throw:
 * when auth/API is unavailable, `fetchIssue` resolves to `null` so callers fall
 * back to basic link/hover behavior.
 */
export interface LinearClient {
  /**
   * Lightweight fetch used by hovers / inline status: returns {@link IssueMetadata}
   * (with capped nested connections) or `null` if unavailable. Never throws.
   */
  fetchIssue(id: IssueId): Promise<IssueMetadata | null>;
  /**
   * Heavier, on-demand fetch used by the detail webview: returns the full
   * {@link TicketDetail} (the full comment thread plus all labels, attachments,
   * and collaborators, each generously capped) or `null` if unavailable. Cached
   * separately from {@link LinearClient.fetchIssue} so a hover never pulls the
   * heavy payload. Never throws.
   */
  fetchTicketDetail(id: IssueId): Promise<TicketDetail | null>;
  /** Drop all cached metadata (hover + detail). */
  clearCache(): void;
  /** Whether a credential is currently present and the API is enabled. */
  hasAuth(): boolean;
  /** Re-read auth state (e.g. after sign-in/out or a key change). */
  refreshAuth(): Promise<void>;
  /** Fetch a working set of issues for the signed-in viewer. Empty array on any failure. */
  listIssues(scope: IssueListScope, limit: number): Promise<IssueListItem[]>;
  /** Search issues by free text (Linear `searchIssues`). Empty array on any failure. */
  searchIssues(query: string, limit: number): Promise<IssueListItem[]>;
}
