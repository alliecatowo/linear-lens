/**
 * Linear Lens — pure mutation + picker GraphQL layer (no `vscode` import).
 *
 * Mirrors how {@link file://./ticketDetail.ts} isolates the read path: this
 * module owns the WRITE mutations (`issueCreate`/`issueUpdate`/relation
 * create+delete) and the picker READ queries (teams/states/labels/users/
 * cycles/projects + the single-issue edit-context). It is `vscode`-free so it
 * is unit-testable in plain Node with an injected `fetch`.
 *
 * Like the rest of the client surface, NOTHING here throws:
 *  - mutations resolve to a discriminated {@link LinearWriteResult} (the host
 *    turns the error kind into a precise toast),
 *  - picker reads resolve to `[]` (or `null` for the single edit-context).
 *
 * ### GraphQL field-correctness notes (verified against Linear's schema)
 * - Mutation payloads expose `success: Boolean!`; `success === false` with no
 *   GraphQL `errors` is treated as a `"validation"` failure.
 * - `IssueRelationType` has EXACTLY `{ blocks, duplicate, related, similar }` —
 *   there is NO `blocked_by`. "A is blocked by B" is modeled as B `blocks` A.
 * - On READ, `IssueRelation.type` is a plain `String!` — compare to `"blocks"`.
 * - Every connection `first` arg is typed `Int` (default 50): picker queries
 *   declare `$first: Int!` (do NOT change to `Float!`). The single-issue
 *   edit-context uses `number: Float!` because `NumberComparator.eq` is `Float`.
 */

import {
  AuthHeader,
  IssueEditContext,
  IssueId,
  IssueMutationResult,
  IssueRelation,
  LabelOption,
  LinearLensConfig,
  LinearPriority,
  LinearWriteError,
  LinearWriteErrorKind,
  LinearWriteResult,
  ProjectOption,
  RelationMutationResult,
  TeamOption,
  UserOption,
  WorkflowStateOption,
  CycleOption,
} from "./types";

/** Linear GraphQL endpoint. */
const LINEAR_GRAPHQL_ENDPOINT = "https://api.linear.app/graphql";

/**
 * Upper bound on each picker connection. Pickers (teams/labels/states/users/
 * etc.) are small and stable; 250 comfortably covers any real workspace.
 * Cursor pagination is intentionally out of scope — the cap is documented.
 */
export const PICKER_LIMIT = 250;

// ---------------------------------------------------------------------------
// GraphQL MUTATIONS (exact, field-validated; echo-only selection sets)
// ---------------------------------------------------------------------------

/** Create an issue. Variables: `{ input: IssueCreateInput! }`. */
export const ISSUE_CREATE_MUTATION: string = `
mutation IssueCreate($input: IssueCreateInput!) {
  issueCreate(input: $input) {
    success
    issue { id identifier url }
  }
}`.trim();

/** Update an issue. Variables: `{ id: String!, input: IssueUpdateInput! }`. */
export const ISSUE_UPDATE_MUTATION: string = `
mutation IssueUpdate($id: String!, $input: IssueUpdateInput!) {
  issueUpdate(id: $id, input: $input) {
    success
    issue { id identifier url }
  }
}`.trim();

/** Create a relation (blocks). Variables: `{ input: IssueRelationCreateInput! }`. */
export const ISSUE_RELATION_CREATE_MUTATION: string = `
mutation IssueRelationCreate($input: IssueRelationCreateInput!) {
  issueRelationCreate(input: $input) {
    success
    issueRelation { id }
  }
}`.trim();

/** Delete a relation. Variables: `{ id: String! }`. */
export const ISSUE_RELATION_DELETE_MUTATION: string = `
mutation IssueRelationDelete($id: String!) {
  issueRelationDelete(id: $id) { success }
}`.trim();

// ---------------------------------------------------------------------------
// GraphQL PICKER read queries (exact; `$first: Int!`)
// ---------------------------------------------------------------------------

/** Teams the viewer can see. Variables: `{ first: Int! }`. */
export const TEAMS_QUERY: string = `
query Teams($first: Int!) {
  teams(first: $first) {
    nodes { id key name }
  }
}`.trim();

/** Teams the VIEWER is a member of. Variables: `{ first: Int! }`. */
export const VIEWER_TEAMS_QUERY: string = `
query ViewerTeams($first: Int!) {
  viewer {
    teamMemberships(first: $first) {
      nodes { team { id key name } }
    }
  }
}`.trim();

/** Workflow states for a team, ordered. Variables: `{ teamId: String!, first: Int! }`. */
export const WORKFLOW_STATES_QUERY: string = `
query WorkflowStates($teamId: String!, $first: Int!) {
  workflowStates(filter: { team: { id: { eq: $teamId } } }, first: $first) {
    nodes { id name type color position }
  }
}`.trim();

/** Labels for a team (team-scoped + workspace). Variables: `{ teamId: String!, first: Int! }`. */
export const LABELS_QUERY: string = `
query Labels($teamId: String!, $first: Int!) {
  issueLabels(filter: { team: { id: { eq: $teamId } } }, first: $first) {
    nodes { id name color }
  }
}`.trim();

/** Active users (for assignee). Variables: `{ first: Int! }`. */
export const USERS_QUERY: string = `
query Users($first: Int!) {
  users(first: $first, filter: { active: { eq: true } }) {
    nodes { id name displayName avatarUrl active }
  }
}`.trim();

/** Cycles for a team. Variables: `{ teamId: String!, first: Int! }`. */
export const CYCLES_QUERY: string = `
query Cycles($teamId: String!, $first: Int!) {
  cycles(filter: { team: { id: { eq: $teamId } } }, first: $first) {
    nodes { id name number startsAt endsAt }
  }
}`.trim();

/** Workspace projects. Variables: `{ first: Int! }`. */
export const PROJECTS_QUERY: string = `
query Projects($first: Int!) {
  projects(first: $first) {
    nodes { id name state }
  }
}`.trim();

/**
 * A single issue's UUID + CURRENT field values + labels + relations, for
 * resolving update targets and showing current values in the edit dispatcher.
 * Variables: `{ team: String!, number: Float! }`.
 *
 * `number: { eq: $number }` correctly uses `Float!` (`NumberComparator.eq` is
 * `Float`). The nested connection `first:` args are integer LITERALS (100),
 * which is fine; only declared VARIABLE types matter for Int-vs-Float.
 */
export const ISSUE_EDIT_CONTEXT_QUERY: string = `
query IssueEditContext($team: String!, $number: Float!) {
  issues(filter: { team: { key: { eq: $team } }, number: { eq: $number } }, first: 1) {
    nodes {
      id
      identifier
      team { id key name }
      state { id name type color position }
      assignee { id displayName name }
      project { id name }
      cycle { id number }
      priority
      labels(first: 100) { nodes { id name color } }
      relations(first: 100) {
        nodes {
          id
          type
          relatedIssue { id identifier title url }
        }
      }
      inverseRelations(first: 100) {
        nodes {
          id
          type
          issue { id identifier title url }
        }
      }
    }
  }
}`.trim();

// ---------------------------------------------------------------------------
// Raw GraphQL node shapes (all fields nullable)
// ---------------------------------------------------------------------------

/** Raw team node (from teams / viewer.teamMemberships.team). */
export interface RawTeamNode {
  id?: string | null;
  key?: string | null;
  name?: string | null;
}

/** Raw workflow-state node. */
export interface RawStateNode {
  id?: string | null;
  name?: string | null;
  type?: string | null;
  color?: string | null;
  position?: number | null;
}

/** Raw user node. */
export interface RawUserNode {
  id?: string | null;
  name?: string | null;
  displayName?: string | null;
  avatarUrl?: string | null;
  active?: boolean | null;
}

/** Raw label node. */
export interface RawLabelNode {
  id?: string | null;
  name?: string | null;
  color?: string | null;
}

/** Raw project node. */
export interface RawProjectNode {
  id?: string | null;
  name?: string | null;
  state?: string | null;
}

/** Raw cycle node. */
export interface RawCycleNode {
  id?: string | null;
  name?: string | null;
  number?: number | null;
  startsAt?: string | null;
  endsAt?: string | null;
}

/** Raw issue echo returned by create/update mutations. */
export interface RawIssueEcho {
  id?: string | null;
  identifier?: string | null;
  url?: string | null;
}

/** Raw related-issue node (the OTHER end of a relation). */
interface RawRelatedIssue {
  id?: string | null;
  identifier?: string | null;
  title?: string | null;
  url?: string | null;
}

/** Raw relation node where THIS issue is the source. */
interface RawRelationNode {
  id?: string | null;
  type?: string | null;
  relatedIssue?: RawRelatedIssue | null;
}

/** Raw inverse-relation node where THIS issue is the target. */
interface RawInverseRelationNode {
  id?: string | null;
  type?: string | null;
  issue?: RawRelatedIssue | null;
}

/** Raw single-issue node returned by {@link ISSUE_EDIT_CONTEXT_QUERY}. */
export interface RawEditContextNode {
  id?: string | null;
  identifier?: string | null;
  team?: RawTeamNode | null;
  state?: { id?: string | null } | null;
  assignee?: { id?: string | null } | null;
  project?: { id?: string | null } | null;
  cycle?: { id?: string | null } | null;
  priority?: number | null;
  labels?: { nodes?: Array<RawLabelNode | null> | null } | null;
  relations?: { nodes?: Array<RawRelationNode | null> | null } | null;
  inverseRelations?: { nodes?: Array<RawInverseRelationNode | null> | null } | null;
}

// ---------------------------------------------------------------------------
// Pure mappers (null-tolerant; never throw)
// ---------------------------------------------------------------------------

/** Map a raw team node onto {@link TeamOption}. */
export function mapTeamNode(node: RawTeamNode): TeamOption {
  return {
    id: node.id ?? "",
    key: node.key ?? "",
    name: node.name ?? "",
  };
}

/** Map a raw workflow-state node onto {@link WorkflowStateOption}. */
export function mapWorkflowStateNode(node: RawStateNode): WorkflowStateOption {
  return {
    id: node.id ?? "",
    name: node.name ?? "",
    type: node.type ?? undefined,
    color: node.color ?? undefined,
    position: node.position ?? undefined,
  };
}

/** Map a raw user node onto {@link UserOption}. `displayName` falls back to `name`. */
export function mapUserNode(node: RawUserNode): UserOption {
  return {
    id: node.id ?? "",
    name: node.name ?? "",
    displayName: node.displayName || node.name || "",
    avatarUrl: node.avatarUrl ?? undefined,
    active: node.active ?? undefined,
  };
}

/** Map a raw label node onto {@link LabelOption}. */
export function mapLabelNode(node: RawLabelNode): LabelOption {
  return {
    id: node.id ?? "",
    name: node.name ?? "",
    color: node.color ?? undefined,
  };
}

/** Map a raw project node onto {@link ProjectOption}. */
export function mapProjectNode(node: RawProjectNode): ProjectOption {
  return {
    id: node.id ?? "",
    name: node.name ?? "",
    state: node.state ?? undefined,
  };
}

/**
 * Map a raw cycle node onto {@link CycleOption}. `name` is left undefined when
 * Linear has none (the caller derives "Cycle <number>"); `number` carries the
 * raw cycle number for that fallback.
 */
export function mapCycleNode(node: RawCycleNode): CycleOption {
  return {
    id: node.id ?? "",
    name: node.name ?? undefined,
    number: node.number ?? undefined,
    startsAt: node.startsAt ?? undefined,
    endsAt: node.endsAt ?? undefined,
  };
}

/**
 * Map a raw create/update issue echo onto {@link IssueMutationResult}. Tolerates
 * a null/undefined node (collapses to empty id/identifier). Never throws.
 */
export function mapIssueMutationResult(
  node: RawIssueEcho | null | undefined,
): IssueMutationResult {
  return {
    id: node?.id ?? "",
    identifier: node?.identifier ?? "",
    url: node?.url ?? undefined,
  };
}

/**
 * Coerce Linear's read `priority` (a `Float`/number on read) into the canonical
 * {@link LinearPriority} 0–4 int, or `undefined` when out of range / absent.
 */
function coercePriority(raw: number | null | undefined): LinearPriority | undefined {
  if (raw == null) {
    return undefined;
  }
  const n = Math.round(raw);
  return n >= 0 && n <= 4 ? (n as LinearPriority) : undefined;
}

/** Map one raw relation node (this → other) into an {@link IssueRelation}. */
function mapRelation(node: RawRelationNode): IssueRelation {
  const other = node.relatedIssue ?? {};
  return {
    id: node.id ?? "",
    type: node.type ?? "",
    relatedIssue: {
      id: other.id ?? "",
      identifier: other.identifier ?? "",
      title: other.title ?? "",
      url: other.url ?? undefined,
    },
  };
}

/** Map one raw inverse-relation node (other → this) into an {@link IssueRelation}. */
function mapInverseRelation(node: RawInverseRelationNode): IssueRelation {
  const other = node.issue ?? {};
  return {
    id: node.id ?? "",
    type: node.type ?? "",
    relatedIssue: {
      id: other.id ?? "",
      identifier: other.identifier ?? "",
      title: other.title ?? "",
      url: other.url ?? undefined,
    },
  };
}

/**
 * Normalize a raw edit-context node into a flat, directional {@link IssueEditContext}
 * and surface the issue's CURRENT field values so the edit dispatcher can show
 * them inline and pre-select picks without a second fetch. Pure; null-tolerant.
 *
 * - `blocks`: relations of type `"blocks"` where THIS issue is the source
 *   (this issue blocks those).
 * - `blockedBy`: inverse-relations of type `"blocks"` where THIS issue is the
 *   target (those issues block this one).
 *
 * @param node - A raw issue node from {@link ISSUE_EDIT_CONTEXT_QUERY}.
 * @returns The normalized edit context.
 */
export function buildBlockerView(node: RawEditContextNode): IssueEditContext {
  const rawTeam = node.team;
  const labels = (node.labels?.nodes ?? []).flatMap((l) =>
    l ? [mapLabelNode(l)] : [],
  );
  const blocks = (node.relations?.nodes ?? []).flatMap((r) =>
    r && (r.type ?? "") === "blocks" ? [mapRelation(r)] : [],
  );
  const blockedBy = (node.inverseRelations?.nodes ?? []).flatMap((r) =>
    r && (r.type ?? "") === "blocks" ? [mapInverseRelation(r)] : [],
  );
  return {
    issueUuid: node.id ?? "",
    identifier: node.identifier ?? "",
    team: rawTeam ? mapTeamNode(rawTeam) : undefined,
    labels,
    blocks,
    blockedBy,
    currentStateId: node.state?.id ?? undefined,
    currentAssigneeId: node.assignee?.id ?? undefined,
    currentProjectId: node.project?.id ?? undefined,
    currentCycleId: node.cycle?.id ?? undefined,
    currentPriority: coercePriority(node.priority),
  };
}

// ---------------------------------------------------------------------------
// Error classification (pure)
// ---------------------------------------------------------------------------

/** The subset of a GraphQL error object we inspect. */
interface RawGraphqlError {
  message?: unknown;
  extensions?: { code?: unknown; type?: unknown } | null;
}

/** Lower-cased haystack of an error's message + extension codes, for matching. */
function errorHaystack(err: RawGraphqlError): string {
  const parts: string[] = [];
  if (typeof err.message === "string") {
    parts.push(err.message);
  }
  const ext = err.extensions;
  if (ext) {
    if (typeof ext.code === "string") {
      parts.push(ext.code);
    }
    if (typeof ext.type === "string") {
      parts.push(ext.type);
    }
  }
  return parts.join(" ").toLowerCase();
}

/**
 * Classify a Linear GraphQL `errors` array into a {@link LinearWriteErrorKind}
 * plus a sanitized, toast-safe message. Pure; never throws, never leaks tokens
 * (only Linear's own `message` text is surfaced).
 *
 * Mapping precedence (first match wins across all errors):
 *  - authentication / authorization / "access denied" / forbidden → `permission`
 *  - "not found" / entity-not-found                                → `notFound`
 *  - argument / validation / invalid / required                    → `validation`
 *  - else                                                          → `unknown`
 *
 * @param errors - The GraphQL `errors` array (unknown shape; defensively read).
 * @returns The classified kind and a human-readable message.
 */
export function classifyGraphqlError(errors: unknown): {
  kind: LinearWriteErrorKind;
  message: string;
} {
  const list: RawGraphqlError[] = Array.isArray(errors)
    ? (errors as RawGraphqlError[])
    : [];

  const firstMessage =
    list
      .map((e) => (typeof e?.message === "string" ? e.message : ""))
      .find((m) => m.length > 0) ?? "Linear rejected the request.";

  const haystacks = list.map(errorHaystack);
  const some = (re: RegExp): boolean => haystacks.some((h) => re.test(h));

  if (some(/authentication|authoriz|access denied|forbidden|permission|unauthenticated/)) {
    return { kind: "permission", message: firstMessage };
  }
  if (some(/not\s*found|does not exist|entity_?not_?found|no such/)) {
    return { kind: "notFound", message: firstMessage };
  }
  if (some(/argument|validation|invalid|required|must be|bad request|malformed/)) {
    return { kind: "validation", message: firstMessage };
  }
  return { kind: "unknown", message: firstMessage };
}

// ---------------------------------------------------------------------------
// Dependency bags
// ---------------------------------------------------------------------------

/**
 * Dependencies the mutation/picker execution helpers need. Mirrors
 * {@link file://./ticketDetail.ts}'s `TicketDetailDeps`. `logDebug` is an
 * optional sink (the host wires the real `linearLens.debug` output channel;
 * tests pass nothing) so this module stays `vscode`-free.
 */
export interface MutationDeps {
  readonly getCfg: () => LinearLensConfig;
  /** Resolves a WRITE-capable header (personal key preferred). May be undefined. */
  readonly resolveWriteAuth: () => Promise<AuthHeader | undefined>;
  /** Optional `fetch` override (injected in tests). Defaults to global `fetch`. */
  readonly fetchImpl?: typeof fetch;
  /** Optional debug sink: receives `"<operationName>: <message>"` (never tokens). */
  readonly logDebug?: (line: string) => void;
}

/** Dependencies the picker READ queries need (read auth is fine). */
export interface PickerDeps {
  readonly getCfg: () => LinearLensConfig;
  readonly resolveAuth: () => Promise<AuthHeader | undefined>;
  /** Optional `fetch` override (injected in tests). Defaults to global `fetch`. */
  readonly fetchImpl?: typeof fetch;
  /** Optional debug sink: receives `"<operationName>: <message>"` (never tokens). */
  readonly logDebug?: (line: string) => void;
}

/** Build a `LinearWriteError`, logging the sanitized message to the debug sink. */
function writeError(
  operationName: string,
  kind: LinearWriteErrorKind,
  message: string,
  logDebug?: (line: string) => void,
): LinearWriteError {
  logDebug?.(operationName + ": " + message);
  return { ok: false, kind, message };
}

// ---------------------------------------------------------------------------
// Mutation execution (pure, injected fetch; NEVER throws)
// ---------------------------------------------------------------------------

/**
 * POST a GraphQL mutation and return a typed {@link LinearWriteResult}. NEVER
 * throws. Classifies failures so the host can render a precise toast:
 *  - api disabled            → `{ ok:false, kind:"apiDisabled" }`
 *  - no auth                 → `{ ok:false, kind:"noAuth" }`
 *  - fetch throws / non-OK   → `{ ok:false, kind:"network" }`
 *  - GraphQL `errors[]`      → {@link classifyGraphqlError} (permission/validation/notFound/unknown)
 *  - `payload.success===false` → `{ ok:false, kind:"validation" }`
 *  - else                    → `{ ok:true, value: select(data) }`
 *
 * Logs `operationName + ": " + message` to the optional debug sink — NEVER the
 * variables or the token.
 *
 * @param operationName - Stable name for logging (e.g. "IssueUpdate").
 * @param query         - The GraphQL mutation string.
 * @param variables     - The operation variables (never logged).
 * @param deps          - Injected config/write-auth/fetch (see {@link MutationDeps}).
 * @param select        - Maps the raw `data` payload to the success value `T`.
 * @returns A discriminated {@link LinearWriteResult}.
 */
export async function runMutation<T>(
  operationName: string,
  query: string,
  variables: Record<string, unknown>,
  deps: MutationDeps,
  select: (data: unknown) => { value: T; success: boolean },
): Promise<LinearWriteResult<T>> {
  try {
    if (!deps.getCfg().enableApi) {
      return writeError(
        operationName,
        "apiDisabled",
        "The Linear API is disabled (linearLens.api.enable).",
        deps.logDebug,
      );
    }

    const auth = await deps.resolveWriteAuth();
    if (!auth) {
      return writeError(
        operationName,
        "noAuth",
        "No write credential is available.",
        deps.logDebug,
      );
    }

    const doFetch = deps.fetchImpl ?? fetch;

    let response: Response;
    try {
      response = await doFetch(LINEAR_GRAPHQL_ENDPOINT, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          // Use auth.value verbatim — already correctly formatted.
          Authorization: auth.value,
        },
        body: JSON.stringify({ query, variables }),
      });
    } catch {
      return writeError(
        operationName,
        "network",
        "Could not reach Linear.",
        deps.logDebug,
      );
    }

    if (!response.ok) {
      return writeError(
        operationName,
        "network",
        "Linear returned HTTP " + response.status + ".",
        deps.logDebug,
      );
    }

    let json: { data?: unknown; errors?: unknown };
    try {
      json = (await response.json()) as { data?: unknown; errors?: unknown };
    } catch {
      return writeError(
        operationName,
        "network",
        "Could not parse Linear's response.",
        deps.logDebug,
      );
    }

    if (json.errors) {
      const { kind, message } = classifyGraphqlError(json.errors);
      return writeError(operationName, kind, message, deps.logDebug);
    }

    const { value, success } = select(json.data);
    if (!success) {
      return writeError(
        operationName,
        "validation",
        "Linear did not apply the change.",
        deps.logDebug,
      );
    }

    return { ok: true, value };
  } catch {
    // Absolute backstop: never throw out of runMutation.
    return writeError(
      operationName,
      "unknown",
      "An unexpected error occurred.",
      deps.logDebug,
    );
  }
}

// ---------------------------------------------------------------------------
// Picker execution (pure, injected fetch; NEVER throws; returns [] on failure)
// ---------------------------------------------------------------------------

/**
 * POST a GraphQL picker READ query and map its node list. NEVER throws; returns
 * `[]` on any failure (api disabled, no auth, network, GraphQL errors, malformed
 * response) so a transient failure self-heals on the next open (and is not
 * cached by the client). Logs the operation + sanitized message to the debug
 * sink — NEVER the variables or token.
 *
 * @param operationName - Stable name for logging.
 * @param query         - The GraphQL query string.
 * @param variables     - The operation variables (never logged).
 * @param deps          - Injected config/read-auth/fetch (see {@link PickerDeps}).
 * @param extractNodes  - Pulls the raw node array out of the `data` payload.
 * @param mapNode       - Pure per-node mapper.
 * @returns The mapped option list, or `[]`.
 */
export async function runPickerQuery<TRaw, TOut>(
  operationName: string,
  query: string,
  variables: Record<string, unknown>,
  deps: PickerDeps,
  extractNodes: (data: unknown) => Array<TRaw | null> | null | undefined,
  mapNode: (node: TRaw) => TOut,
): Promise<TOut[]> {
  try {
    if (!deps.getCfg().enableApi) {
      return [];
    }

    const auth = await deps.resolveAuth();
    if (!auth) {
      return [];
    }

    const doFetch = deps.fetchImpl ?? fetch;

    let response: Response;
    try {
      response = await doFetch(LINEAR_GRAPHQL_ENDPOINT, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: auth.value,
        },
        body: JSON.stringify({ query, variables }),
      });
    } catch {
      deps.logDebug?.(operationName + ": network error");
      return [];
    }

    if (!response.ok) {
      deps.logDebug?.(operationName + ": HTTP " + response.status);
      return [];
    }

    let json: { data?: unknown; errors?: unknown };
    try {
      json = (await response.json()) as { data?: unknown; errors?: unknown };
    } catch {
      deps.logDebug?.(operationName + ": parse error");
      return [];
    }

    if (json.errors) {
      const { message } = classifyGraphqlError(json.errors);
      deps.logDebug?.(operationName + ": " + message);
      return [];
    }

    const nodes = extractNodes(json.data) ?? [];
    return nodes.flatMap((node) => (node ? [mapNode(node)] : []));
  } catch {
    deps.logDebug?.(operationName + ": unexpected error");
    return [];
  }
}

/**
 * Resolve the single-issue edit context (UUID + current values + relations) for
 * an issue, or `null` on any failure. NEVER throws. Read-auth is sufficient.
 *
 * @param id   - The normalized issue identity (team key + number).
 * @param deps - Injected config/read-auth/fetch (see {@link PickerDeps}).
 * @returns The normalized {@link IssueEditContext}, or `null`.
 */
export async function fetchEditContext(
  id: IssueId,
  deps: PickerDeps,
): Promise<IssueEditContext | null> {
  try {
    if (!deps.getCfg().enableApi) {
      return null;
    }
    const auth = await deps.resolveAuth();
    if (!auth) {
      return null;
    }

    const doFetch = deps.fetchImpl ?? fetch;

    let response: Response;
    try {
      response = await doFetch(LINEAR_GRAPHQL_ENDPOINT, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: auth.value,
        },
        body: JSON.stringify({
          query: ISSUE_EDIT_CONTEXT_QUERY,
          variables: { team: id.team, number: id.number },
        }),
      });
    } catch {
      deps.logDebug?.("IssueEditContext: network error");
      return null;
    }

    if (!response.ok) {
      deps.logDebug?.("IssueEditContext: HTTP " + response.status);
      return null;
    }

    let json: {
      data?: { issues?: { nodes?: Array<RawEditContextNode | null> | null } | null } | null;
      errors?: unknown;
    };
    try {
      json = (await response.json()) as typeof json;
    } catch {
      deps.logDebug?.("IssueEditContext: parse error");
      return null;
    }

    if (json.errors) {
      const { message } = classifyGraphqlError(json.errors);
      deps.logDebug?.("IssueEditContext: " + message);
      return null;
    }

    const node = json.data?.issues?.nodes?.[0];
    if (!node) {
      return null;
    }
    return buildBlockerView(node);
  } catch {
    deps.logDebug?.("IssueEditContext: unexpected error");
    return null;
  }
}

// ---------------------------------------------------------------------------
// Variable builders (pure) — drop `undefined` keys; keep explicit `null`s so a
// caller can CLEAR assignee/project/cycle, while never sending a field they
// didn't set.
// ---------------------------------------------------------------------------

/** Strip `undefined`-valued keys from an input bag, preserving explicit `null`. */
function pruneUndefined(input: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(input)) {
    if (value !== undefined) {
      out[key] = value;
    }
  }
  return out;
}

/** Build the `IssueCreateInput` variables object from typed create fields. */
export function buildCreateInput(input: {
  title: string;
  description?: string;
  teamId: string;
  projectId?: string | null;
  priority?: LinearPriority;
  labelIds?: string[];
  assigneeId?: string | null;
  cycleId?: string | null;
}): Record<string, unknown> {
  return pruneUndefined({
    title: input.title,
    description: input.description,
    teamId: input.teamId,
    projectId: input.projectId,
    priority: input.priority,
    labelIds: input.labelIds,
    assigneeId: input.assigneeId,
    cycleId: input.cycleId,
  });
}

/** Build the `IssueUpdateInput` variables object from typed update fields. */
export function buildUpdateInput(input: {
  stateId?: string;
  assigneeId?: string | null;
  labelIds?: string[];
  teamId?: string;
  projectId?: string | null;
  priority?: LinearPriority;
  cycleId?: string | null;
}): Record<string, unknown> {
  return pruneUndefined({
    stateId: input.stateId,
    assigneeId: input.assigneeId,
    labelIds: input.labelIds,
    teamId: input.teamId,
    projectId: input.projectId,
    priority: input.priority,
    cycleId: input.cycleId,
  });
}

// ---------------------------------------------------------------------------
// Mutation entry points (thin wrappers over runMutation; NEVER throw)
// ---------------------------------------------------------------------------

/** Shape of the `data` payload for create/update issue mutations. */
interface IssueMutationData {
  issueCreate?: { success?: boolean | null; issue?: RawIssueEcho | null } | null;
  issueUpdate?: { success?: boolean | null; issue?: RawIssueEcho | null } | null;
}

/** Execute the create-issue mutation. NEVER throws; returns a typed result. */
export function createIssueMutation(
  variables: Record<string, unknown>,
  deps: MutationDeps,
): Promise<LinearWriteResult<IssueMutationResult>> {
  return runMutation(
    "IssueCreate",
    ISSUE_CREATE_MUTATION,
    { input: variables },
    deps,
    (data) => {
      const payload = (data as IssueMutationData | null | undefined)?.issueCreate;
      return {
        value: mapIssueMutationResult(payload?.issue),
        success: payload?.success === true,
      };
    },
  );
}

/** Execute the update-issue mutation. NEVER throws; returns a typed result. */
export function updateIssueMutation(
  issueUuid: string,
  variables: Record<string, unknown>,
  deps: MutationDeps,
): Promise<LinearWriteResult<IssueMutationResult>> {
  return runMutation(
    "IssueUpdate",
    ISSUE_UPDATE_MUTATION,
    { id: issueUuid, input: variables },
    deps,
    (data) => {
      const payload = (data as IssueMutationData | null | undefined)?.issueUpdate;
      return {
        value: mapIssueMutationResult(payload?.issue),
        success: payload?.success === true,
      };
    },
  );
}

/** Shape of the `data` payload for the relation-create mutation. */
interface RelationCreateData {
  issueRelationCreate?:
    | { success?: boolean | null; issueRelation?: { id?: string | null } | null }
    | null;
}

/** Shape of the `data` payload for the relation-delete mutation. */
interface RelationDeleteData {
  issueRelationDelete?: { success?: boolean | null } | null;
}

/**
 * Execute the relation-create mutation: `issueId` blocks `relatedIssueId`.
 * NEVER throws; returns a typed result.
 */
export function addRelationMutation(
  input: { issueId: string; relatedIssueId: string; type: "blocks" },
  deps: MutationDeps,
): Promise<LinearWriteResult<RelationMutationResult>> {
  return runMutation(
    "IssueRelationCreate",
    ISSUE_RELATION_CREATE_MUTATION,
    { input },
    deps,
    (data) => {
      const payload = (data as RelationCreateData | null | undefined)?.issueRelationCreate;
      return {
        value: { id: payload?.issueRelation?.id ?? "" },
        success: payload?.success === true,
      };
    },
  );
}

/** Execute the relation-delete mutation. NEVER throws; returns a typed result. */
export function removeRelationMutation(
  relationId: string,
  deps: MutationDeps,
): Promise<LinearWriteResult<RelationMutationResult>> {
  return runMutation(
    "IssueRelationDelete",
    ISSUE_RELATION_DELETE_MUTATION,
    { id: relationId },
    deps,
    (data) => {
      const payload = (data as RelationDeleteData | null | undefined)?.issueRelationDelete;
      // Delete echoes no id; RelationMutationResult.id is "" for delete.
      return { value: { id: "" }, success: payload?.success === true };
    },
  );
}

// ---------------------------------------------------------------------------
// Picker entry points (thin wrappers over runPickerQuery; NEVER throw)
// ---------------------------------------------------------------------------

/** Response-data node extractors for each picker query. */
interface TeamsData {
  teams?: { nodes?: Array<RawTeamNode | null> | null } | null;
}
interface ViewerTeamsData {
  viewer?: {
    teamMemberships?: {
      nodes?: Array<{ team?: RawTeamNode | null } | null> | null;
    } | null;
  } | null;
}
interface StatesData {
  workflowStates?: { nodes?: Array<RawStateNode | null> | null } | null;
}
interface LabelsData {
  issueLabels?: { nodes?: Array<RawLabelNode | null> | null } | null;
}
interface UsersData {
  users?: { nodes?: Array<RawUserNode | null> | null } | null;
}
interface CyclesData {
  cycles?: { nodes?: Array<RawCycleNode | null> | null } | null;
}
interface ProjectsData {
  projects?: { nodes?: Array<RawProjectNode | null> | null } | null;
}

/** Fetch teams the viewer can see. NEVER throws; `[]` on failure. */
export function fetchTeams(deps: PickerDeps): Promise<TeamOption[]> {
  return runPickerQuery(
    "Teams",
    TEAMS_QUERY,
    { first: PICKER_LIMIT },
    deps,
    (data) => (data as TeamsData | null | undefined)?.teams?.nodes,
    mapTeamNode,
  );
}

/** Fetch teams the viewer is a member of. NEVER throws; `[]` on failure. */
export async function fetchViewerTeams(deps: PickerDeps): Promise<TeamOption[]> {
  const memberships = await runPickerQuery(
    "ViewerTeams",
    VIEWER_TEAMS_QUERY,
    { first: PICKER_LIMIT },
    deps,
    (data) =>
      (data as ViewerTeamsData | null | undefined)?.viewer?.teamMemberships?.nodes,
    (node: { team?: RawTeamNode | null }) => node.team ?? null,
  );
  // Drop memberships whose team came back null.
  return memberships.flatMap((team) => (team ? [mapTeamNode(team)] : []));
}

/** Fetch a team's workflow states. NEVER throws; `[]` on failure. */
export function fetchWorkflowStates(
  teamId: string,
  deps: PickerDeps,
): Promise<WorkflowStateOption[]> {
  return runPickerQuery(
    "WorkflowStates",
    WORKFLOW_STATES_QUERY,
    { teamId, first: PICKER_LIMIT },
    deps,
    (data) => (data as StatesData | null | undefined)?.workflowStates?.nodes,
    mapWorkflowStateNode,
  );
}

/** Fetch a team's labels. NEVER throws; `[]` on failure. */
export function fetchLabels(teamId: string, deps: PickerDeps): Promise<LabelOption[]> {
  return runPickerQuery(
    "Labels",
    LABELS_QUERY,
    { teamId, first: PICKER_LIMIT },
    deps,
    (data) => (data as LabelsData | null | undefined)?.issueLabels?.nodes,
    mapLabelNode,
  );
}

/** Fetch active users. NEVER throws; `[]` on failure. */
export function fetchUsers(deps: PickerDeps): Promise<UserOption[]> {
  return runPickerQuery(
    "Users",
    USERS_QUERY,
    { first: PICKER_LIMIT },
    deps,
    (data) => (data as UsersData | null | undefined)?.users?.nodes,
    mapUserNode,
  );
}

/** Fetch a team's cycles. NEVER throws; `[]` on failure. */
export function fetchCycles(teamId: string, deps: PickerDeps): Promise<CycleOption[]> {
  return runPickerQuery(
    "Cycles",
    CYCLES_QUERY,
    { teamId, first: PICKER_LIMIT },
    deps,
    (data) => (data as CyclesData | null | undefined)?.cycles?.nodes,
    mapCycleNode,
  );
}

/** Fetch workspace projects. NEVER throws; `[]` on failure. */
export function fetchProjects(deps: PickerDeps): Promise<ProjectOption[]> {
  return runPickerQuery(
    "Projects",
    PROJECTS_QUERY,
    { first: PICKER_LIMIT },
    deps,
    (data) => (data as ProjectsData | null | undefined)?.projects?.nodes,
    mapProjectNode,
  );
}
