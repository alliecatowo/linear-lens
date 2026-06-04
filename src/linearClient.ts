import {
  AuthHeader,
  CycleOption,
  IssueAttachment,
  IssueComment,
  IssueCreateFields,
  IssueEditContext,
  IssueId,
  IssueLabel,
  IssueListItem,
  IssueListScope,
  IssueMetadata,
  IssueMutationResult,
  IssueUpdateFields,
  LabelOption,
  LinearClient,
  LinearLensConfig,
  LinearWriteResult,
  MetadataStore,
  CachedEntry,
  Person,
  ProjectOption,
  RelationMutationResult,
  TeamOption,
  TicketDetail,
  UserOption,
  WorkflowStateOption,
} from "./types";
import {
  MY_ISSUES_QUERY,
  RECENT_ISSUES_QUERY,
  ISSUE_SEARCH_QUERY,
  mapListNode,
  RawListNode,
} from "./linear/issueMapper";
import {
  mapWorkspaceInfo,
  WorkspaceInfo,
  WORKSPACE_INFO_QUERY,
  WORKSPACE_INFO_TEAM_LIMIT,
} from "./linear/workspaceQuery";
import {
  createTicketDetailCache,
  fetchTicketDetail,
  TicketDetailCache,
} from "./ticketDetail";
import {
  addRelationMutation,
  buildCreateInput,
  buildUpdateInput,
  createIssueMutation,
  fetchCycles,
  fetchEditContext,
  fetchLabels,
  fetchProjects,
  fetchTeams,
  fetchUsers,
  fetchViewerTeams,
  fetchWorkflowStates,
  MutationDeps,
  PickerDeps,
  removeRelationMutation,
  updateIssueMutation,
} from "./linearMutations";

/** SecretStorage key under which the Linear API key is stored. */
export const API_KEY_SECRET = "linearLens.apiKey";

/** Linear GraphQL endpoint. */
const LINEAR_GRAPHQL_ENDPOINT = "https://api.linear.app/graphql";

/**
 * Maximum number of ids fetched in a single batch `issues(filter:{or:[…]})`
 * request. A prefetch of a huge file fans out into a few bounded requests rather
 * than one enormous query. `first` per request never exceeds this.
 */
export const MAX_BATCH = 50;

/**
 * Short TTL (ms) for NEGATIVE lookups (an id the API does not resolve). Kept far
 * below `cacheTtlSeconds` so a typo like `XYZ-9999` is not hammered yet self-heals
 * quickly, and so a transient miss is not cached for the full positive TTL.
 */
export const NEGATIVE_TTL_MS = 30_000;

/**
 * Versioned namespace prefix for persisted metadata entries in the injected
 * {@link MetadataStore}. Bumping the version (`…v1.` → `…v2.`) lets a future field
 * change ignore stale-shaped old entries without a migration.
 */
export const STORE_PREFIX = "linearLens.meta.v1.";

/**
 * Upper bound on the number of POSITIVE entries persisted to the store. On write,
 * the oldest-expiring entries beyond this cap are pruned so `workspaceState` cannot
 * grow without bound across long sessions. In-memory cache is unaffected.
 */
const MAX_PERSISTED_KEYS = 500;

/**
 * The shared GraphQL selection set for a single issue node, reused VERBATIM by the
 * single-issue {@link ISSUE_QUERY} and the {@link buildBatchIssuesQuery} batch
 * query so the two can never drift (a drifted field would null the whole response
 * — a silent regression). Nested connections are capped (`first: N`) so a
 * heavily-commented issue cannot return a huge payload.
 */
export const ISSUE_NODE_FIELDS = `identifier
      title
      url
      branchName
      archivedAt
      priorityLabel
      description
      state { name type color }
      assignee { name displayName avatarUrl }
      creator { name displayName avatarUrl }
      project { name }
      labels(first: 20) { nodes { name color } }
      subscribers(first: 20) { nodes { name displayName avatarUrl } }
      comments(first: 25) { nodes { id body createdAt user { name displayName avatarUrl } } }
      attachments(first: 20) { nodes { title url } }`;

/**
 * GraphQL query that looks up a single issue by its team key + number, returning
 * the full metadata used by rich hovers. Variables: `{ team: String!, number: Float! }`.
 *
 * Every selected field is nullable-tolerant; {@link toMetadata} defends against
 * missing nodes and fields. The selection body is the shared {@link ISSUE_NODE_FIELDS}
 * so the hover path and the batch path can never diverge.
 *
 * Retained for the single-issue case + as the canonical reference for the shared
 * field set; the live metadata read path now batches via {@link buildBatchIssuesQuery}
 * (a 1-id batch is functionally equivalent), so this is exported rather than used
 * internally.
 */
export const ISSUE_QUERY = `query Issue($team: String!, $number: Float!) {
  issues(filter: { team: { key: { eq: $team } }, number: { eq: $number } }, first: 1) {
    nodes {
      ${ISSUE_NODE_FIELDS}
    }
  }
}`;

/** Raw shape of a person node (assignee/creator/subscriber/comment author). */
export interface RawPerson {
  name?: string | null;
  displayName?: string | null;
  avatarUrl?: string | null;
}

/** Raw shape of a single comment node from the query. */
export interface RawComment {
  id?: string | null;
  body?: string | null;
  createdAt?: string | null;
  /** Linear's field is `user`; we expose it as {@link IssueComment.author}. */
  user?: RawPerson | null;
}

/**
 * Shape of a single issue node returned by either {@link ISSUE_QUERY} or the
 * batch {@link buildBatchIssuesQuery} (both select {@link ISSUE_NODE_FIELDS}, so
 * one shape serves both). Every field is nullable; {@link toMetadata} defends.
 */
export interface IssueNode {
  identifier?: string | null;
  title?: string | null;
  url?: string | null;
  branchName?: string | null;
  archivedAt?: string | null;
  priorityLabel?: string | null;
  description?: string | null;
  state?: { name?: string | null; type?: string | null; color?: string | null } | null;
  assignee?: RawPerson | null;
  creator?: RawPerson | null;
  project?: { name?: string | null } | null;
  labels?: { nodes?: Array<{ name?: string | null; color?: string | null } | null> | null } | null;
  subscribers?: { nodes?: Array<RawPerson | null> | null } | null;
  comments?: { nodes?: Array<RawComment | null> | null } | null;
  attachments?: { nodes?: Array<{ title?: string | null; url?: string | null } | null> | null } | null;
}

/** Alias: a node from the BATCH `issues(filter:{or:[…]})` response. Same shape. */
export type RawBatchNode = IssueNode;

/** Raw batch response envelope (defensive; all nullable). */
export interface BatchIssuesResponse {
  data?: { issues?: { nodes?: RawBatchNode[] | null } | null } | null;
  errors?: unknown;
}

/** Shape of the MY_ISSUES_QUERY response. */
interface MyIssuesResponse {
  data?: {
    viewer?: {
      assignedIssues?: { nodes?: RawListNode[] | null } | null;
    } | null;
  } | null;
  errors?: unknown;
}

/** Shape of the RECENT_ISSUES_QUERY response. */
interface RecentIssuesResponse {
  data?: {
    issues?: { nodes?: RawListNode[] | null } | null;
  } | null;
  errors?: unknown;
}

/** Shape of the ISSUE_SEARCH_QUERY response. */
interface SearchIssuesResponse {
  data?: {
    searchIssues?: { nodes?: RawListNode[] | null } | null;
  } | null;
  errors?: unknown;
}

// ---------------------------------------------------------------------------
// Pure raw→IssueMetadata mappers (no `vscode`, no closure state) — shared by the
// single-issue path, the batch path, and the unit tests.
// ---------------------------------------------------------------------------

/**
 * Map a raw person node onto {@link Person}, or `undefined` when the node is
 * null/empty. `displayName` falls back to `name`, then to "".
 */
function mapPerson(raw: RawPerson | null | undefined): Person | undefined {
  if (!raw) {
    return undefined;
  }
  const name = raw.name ?? "";
  const displayName = raw.displayName || raw.name || "";
  if (!name && !displayName && !raw.avatarUrl) {
    return undefined;
  }
  return {
    name,
    displayName,
    avatarUrl: raw.avatarUrl ?? undefined,
  };
}

/** Map the labels connection to {@link IssueLabel}[], dropping null entries. */
function mapLabels(node: IssueNode): IssueLabel[] {
  return (node.labels?.nodes ?? []).flatMap((label) =>
    label ? [{ name: label.name ?? "", color: label.color ?? undefined }] : [],
  );
}

/** Map the subscribers connection to {@link Person}[], dropping null entries. */
function mapSubscribers(node: IssueNode): Person[] {
  return (node.subscribers?.nodes ?? []).flatMap((raw) => {
    const person = mapPerson(raw);
    return person ? [person] : [];
  });
}

/** Map the comments connection to {@link IssueComment}[], dropping null entries. */
function mapComments(node: IssueNode): IssueComment[] {
  return (node.comments?.nodes ?? []).flatMap((comment) =>
    comment
      ? [
          {
            id: comment.id ?? "",
            body: comment.body ?? "",
            createdAt: comment.createdAt ?? "",
            author: mapPerson(comment.user),
          },
        ]
      : [],
  );
}

/** Map the attachments connection to {@link IssueAttachment}[], dropping null entries. */
function mapAttachments(node: IssueNode): IssueAttachment[] {
  return (node.attachments?.nodes ?? []).flatMap((attachment) =>
    attachment ? [{ title: attachment.title ?? "", url: attachment.url ?? "" }] : [],
  );
}

/**
 * Map a raw GraphQL issue node onto our {@link IssueMetadata} shape. Pure and
 * fully null-tolerant; shared by the single-issue fetch and the batch mapper so
 * the two paths produce byte-identical metadata. Never throws.
 *
 * @param node - A raw issue node selecting {@link ISSUE_NODE_FIELDS}.
 * @returns The normalized {@link IssueMetadata}.
 */
export function toMetadata(node: IssueNode): IssueMetadata {
  return {
    id: node.identifier ?? "",
    title: node.title ?? "",
    state: node.state?.name ?? "",
    stateType: node.state?.type ?? undefined,
    stateColor: node.state?.color ?? undefined,
    assignee: mapPerson(node.assignee),
    creator: mapPerson(node.creator),
    priority: node.priorityLabel ?? undefined,
    project: node.project?.name ?? undefined,
    labels: mapLabels(node),
    subscribers: mapSubscribers(node),
    description: node.description ?? undefined,
    branchName: node.branchName ?? undefined,
    comments: mapComments(node),
    attachments: mapAttachments(node),
    url: node.url ?? "",
    archived: node.archivedAt != null,
  };
}

// ---------------------------------------------------------------------------
// Pure BATCH query builder + response mapper (no `vscode`) — testable in Node.
// ---------------------------------------------------------------------------

/**
 * Build a single GraphQL request that fetches every requested issue by team key +
 * number using one `issues(filter:{ or:[…] })` query, returning the query string
 * plus a variables map. Each clause is `{ team:{ key:{ eq:$tN } }, number:{ eq:$nN } }`
 * so team keys + numbers are PARAMETERIZED (never string-interpolated), and `first`
 * is capped at `ids.length` so the connection cannot over-return.
 *
 * `ids` MUST be pre-deduped by `normalized` and non-empty (the caller guarantees
 * both; it chunks into batches of ≤ {@link MAX_BATCH} before calling). The selection
 * body is the shared {@link ISSUE_NODE_FIELDS} so the batch and hover paths cannot
 * drift. Pure; never throws.
 *
 * @param ids - The pre-deduped, non-empty list of issue ids to fetch.
 * @returns The GraphQL `query` string and its parameterized `variables`.
 */
export function buildBatchIssuesQuery(ids: IssueId[]): {
  query: string;
  variables: Record<string, string | number>;
} {
  const varDecls: string[] = [];
  const clauses: string[] = [];
  const variables: Record<string, string | number> = {};
  ids.forEach((id, i) => {
    varDecls.push(`$t${i}: String!`, `$n${i}: Float!`);
    clauses.push(`{ team: { key: { eq: $t${i} } }, number: { eq: $n${i} } }`);
    variables[`t${i}`] = id.team;
    variables[`n${i}`] = id.number;
  });
  const query = `query BatchIssues(${varDecls.join(", ")}) {
  issues(
    filter: { or: [
      ${clauses.join(",\n      ")}
    ] }
    first: ${ids.length}
  ) {
    nodes {
      ${ISSUE_NODE_FIELDS}
    }
  }
}`;
  return { query, variables };
}

/**
 * Map a batch response to a `Map<normalized, IssueMetadata>`, reusing the shared
 * {@link toMetadata} mapper. Each node is keyed by its uppercased `identifier`
 * (already `TEAM-NUMBER`); nodes missing an `identifier` are skipped (they cannot
 * be keyed). When `errors` are present or `data` is absent, returns an empty map.
 * Issues NOT present in the response are simply absent (the client records those
 * as negative lookups). Never throws.
 *
 * @param json - The raw, defensively-typed batch response envelope.
 * @returns A map from normalized id to its mapped {@link IssueMetadata}.
 */
export function mapBatchResponse(json: BatchIssuesResponse): Map<string, IssueMetadata> {
  const out = new Map<string, IssueMetadata>();
  if (!json || json.errors) {
    return out;
  }
  const nodes = json.data?.issues?.nodes;
  if (!nodes) {
    return out;
  }
  for (const node of nodes) {
    const identifier = node?.identifier;
    if (!identifier) {
      continue;
    }
    out.set(identifier.toUpperCase(), toMetadata(node));
  }
  return out;
}

/**
 * Split `ids` into chunks of at most {@link MAX_BATCH}. Pure; tolerates empty input
 * (returns `[]`). Used by the batch fetch so one prefetch of a huge file fans out
 * into a few bounded requests instead of one enormous query.
 *
 * @param ids - The (already deduped) ids to chunk.
 * @param size - Max chunk size; defaults to {@link MAX_BATCH}.
 * @returns An array of non-empty id chunks.
 */
export function chunkIds(ids: IssueId[], size: number = MAX_BATCH): IssueId[][] {
  const chunkSize = Math.max(1, size);
  const out: IssueId[][] = [];
  for (let i = 0; i < ids.length; i += chunkSize) {
    out.push(ids.slice(i, i + chunkSize));
  }
  return out;
}

/**
 * A cache-read decision under stale-while-revalidate. `fresh` ids are served from
 * cache with no network; `stale` ids are served from cache AND queued for a
 * background refresh; `missing` ids must be fetched before they can be returned.
 * Pure (takes a `now` for deterministic tests); used by both `fetchIssues` and
 * `prefetch` so their SWR logic cannot diverge.
 */
export interface CacheDecision {
  /** ids whose entry is present and NOT expired (served immediately, no refetch). */
  fresh: IssueId[];
  /** ids whose entry is present but expired (served immediately AND refreshed). */
  stale: IssueId[];
  /** ids with no cache entry at all (must be fetched). */
  missing: IssueId[];
}

/**
 * Classify each id against the in-memory cache for SWR. Pure: it only reads the
 * provided map and `now`, never mutates or evicts. The caller decides what to do
 * with each bucket (serve fresh, serve-stale-and-refresh, fetch-missing).
 *
 * @param ids - The (deduped) ids to classify.
 * @param cache - The current normalized-id → {@link CachedEntry} map.
 * @param now - Reference time in epoch ms (injected for deterministic tests).
 * @returns The {@link CacheDecision} buckets.
 */
export function classifyForSwr(
  ids: IssueId[],
  cache: ReadonlyMap<string, CachedEntry>,
  now: number,
): CacheDecision {
  const fresh: IssueId[] = [];
  const stale: IssueId[] = [];
  const missing: IssueId[] = [];
  for (const id of ids) {
    const entry = cache.get(id.normalized);
    if (!entry) {
      missing.push(id);
    } else if (now < entry.expiresAt) {
      fresh.push(id);
    } else {
      stale.push(id);
    }
  }
  return { fresh, stale, missing };
}

/**
 * De-duplicate `ids` by their `normalized` form, preserving first-seen order.
 * Pure helper used to coalesce the same id appearing multiple times in a document
 * before it ever reaches the network. Never throws.
 *
 * @param ids - The possibly-duplicated ids.
 * @returns A new array with at most one id per `normalized` key.
 */
export function dedupeIds(ids: IssueId[]): IssueId[] {
  const seen = new Set<string>();
  const out: IssueId[] = [];
  for (const id of ids) {
    if (!seen.has(id.normalized)) {
      seen.add(id.normalized);
      out.push(id);
    }
  }
  return out;
}

/**
 * Create the optional Linear API client. Degrades gracefully; never throws.
 *
 * The returned client implements {@link LinearClient}. Metadata reads batch into
 * ONE GraphQL request (`issues(filter:{ or:[…] })`), coalesce concurrent fetches of
 * the same id (in-flight dedupe), and serve stale-while-revalidate (a stale cache
 * value is returned instantly while a background refresh repopulates it). Results
 * are cached in-memory keyed by `id.normalized` with a TTL from config and — when a
 * {@link MetadataStore} is injected — persisted so the cache survives editor
 * reloads. ALL paths resolve to `null`/empty whenever the API is disabled, no auth
 * is present, or any error occurs; nothing here ever throws.
 *
 * The `Authorization` header value is taken directly from `auth.value` — the
 * caller is responsible for providing the correct format (e.g. `"Bearer <token>"`
 * for OAuth sessions, or the raw key for personal API keys).
 *
 * Mutations and picker reads are delegated to the `vscode`-free
 * {@link file://./linearMutations.ts} module. Mutations use `resolveWriteAuth`
 * (a write-capable credential, personal key preferred); picker reads reuse the
 * read `resolveAuth`. Picker results are cached in a small TTL map (pickers are
 * stable) so repeated edit/create flows do not re-fetch every list.
 *
 * @param getCfg - Accessor returning the current resolved configuration.
 * @param resolveAuth - Async accessor that returns the current (read) auth
 *   header, or `undefined` when no credential is available.
 * @param resolveWriteAuth - Async accessor returning a WRITE-capable auth header
 *   (personal key preferred), or `undefined`. Defaults to `resolveAuth` when
 *   omitted, but the caller SHOULD pass a dedicated write resolver.
 * @param fetchImpl - Optional `fetch` override (injected in tests for metadata,
 *   workspace, mutation, and picker reads). Defaults to the global `fetch`.
 * @param logDebug - Optional debug sink for mutation/picker operation names and
 *   sanitized error messages (NEVER tokens/variables).
 * @param store - Optional Memento-like persistence so the metadata cache survives
 *   reloads. When present it is rehydrated on construction and written through on
 *   every positive cache write (negative lookups are never persisted). When omitted
 *   the cache is purely in-memory (back-compat with existing two-arg call sites).
 * @param onActivity - Optional sink called with the count of in-flight network
 *   operations this CLIENT MODULE issues (single/batch/list/search/workspace),
 *   whenever it changes (0 = idle). Best-effort; never affects correctness.
 * @returns A graceful, never-throwing {@link LinearClient}.
 */
export function createLinearClient(
  getCfg: () => LinearLensConfig,
  resolveAuth: () => Promise<AuthHeader | undefined>,
  resolveWriteAuth: () => Promise<AuthHeader | undefined> = resolveAuth,
  fetchImpl?: typeof fetch,
  logDebug?: (line: string) => void,
  store?: MetadataStore,
  onActivity?: (inFlightCount: number) => void,
): LinearClient {
  const cache = new Map<string, CachedEntry>();
  /**
   * Separate TTL cache for the heavier {@link TicketDetail} payload so the
   * on-demand webview fetch never shares state with the lightweight hover cache.
   */
  const detailCache: TicketDetailCache = createTicketDetailCache(getCfg);
  /** Cached boolean: whether the last `refreshAuth()` call found a credential. */
  let hasAuthCached = false;

  /**
   * In-memory TTL cache for picker reads (teams/users/labels/states/cycles/
   * projects). Pickers are stable; without this, every edit command and create
   * step would re-fetch. Keyed by operation + scope, e.g. `"teams"`,
   * `"states:<teamId>"`. Only successful NON-EMPTY lists are cached so a
   * transient failure self-heals on the next open. See spec §3.5a.
   */
  const pickerCache = new Map<string, { value: unknown; expiresAt: number }>();

  /** Read a non-expired picker-cache entry, or `undefined`. */
  const readPicker = <T>(key: string): T[] | undefined => {
    const entry = pickerCache.get(key);
    if (!entry) {
      return undefined;
    }
    if (Date.now() >= entry.expiresAt) {
      pickerCache.delete(key);
      return undefined;
    }
    return entry.value as T[];
  };

  /** Cache a non-empty picker list under the configured TTL. Empty lists are skipped. */
  const writePicker = <T>(key: string, value: T[]): void => {
    if (value.length === 0) {
      return;
    }
    const ttlMs = Math.max(0, getCfg().cacheTtlSeconds) * 1000;
    pickerCache.set(key, { value, expiresAt: Date.now() + ttlMs });
  };

  /** Read-through picker helper: serve a cached non-empty list or fetch + cache. */
  const cachedPicker = async <T>(key: string, fetcher: () => Promise<T[]>): Promise<T[]> => {
    const hit = readPicker<T>(key);
    if (hit) {
      return hit;
    }
    const value = await fetcher();
    writePicker(key, value);
    return value;
  };

  /** Deps for picker READ queries (read auth + injected fetch/log). */
  const pickerDeps: PickerDeps = { getCfg, resolveAuth, fetchImpl, logDebug };
  /** Deps for WRITE mutations (write auth + injected fetch/log). */
  const mutationDeps: MutationDeps = { getCfg, resolveWriteAuth, fetchImpl, logDebug };

  // -------------------------------------------------------------------------
  // SWR cache primitives (no delete-on-read; expiry only marks an entry STALE,
  // never removes it — the stale value is still served while it is refreshed).
  // The fresh/stale/missing decision lives in the pure, tested `classifyForSwr`.
  // -------------------------------------------------------------------------

  /**
   * Read the raw cache entry REGARDLESS of expiry (no delete-on-read — SWR needs
   * the stale value preserved so `peekIssue` can paint it instantly). Returns
   * `undefined` only when nothing is cached.
   */
  const readEntry = (key: string): CachedEntry | undefined => cache.get(key);

  /**
   * Best-effort fire-and-forget write to the persistent store. Swallows every error
   * (a rejected/throwing store must never break the hot path). `undefined` value
   * removes the key (Memento semantics).
   */
  const storeSet = (fullKey: string, value: unknown): void => {
    if (!store) {
      return;
    }
    try {
      void Promise.resolve(store.set(fullKey, value)).catch(() => {});
    } catch {
      // Synchronous throw from a non-Promise `set` — also swallowed.
    }
  };

  /**
   * Cap the number of POSITIVE persisted entries at {@link MAX_PERSISTED_KEYS},
   * pruning the soonest-to-expire first. Only runs when a store with `keys()` is
   * injected. Best-effort; never throws.
   */
  const prunePersisted = (): void => {
    if (!store?.keys) {
      return;
    }
    try {
      const positives = [...cache.entries()].filter(([, e]) => e.value !== null);
      if (positives.length <= MAX_PERSISTED_KEYS) {
        return;
      }
      // Sort soonest-to-expire first; drop everything beyond the cap from the store.
      positives.sort((a, b) => a[1].expiresAt - b[1].expiresAt);
      const drop = positives.slice(0, positives.length - MAX_PERSISTED_KEYS);
      for (const [key] of drop) {
        storeSet(STORE_PREFIX + key, undefined);
      }
    } catch {
      // Best-effort; never throw on the hot path.
    }
  };

  /**
   * Store a value in the in-memory cache and, for POSITIVE entries, write it through
   * to the persistent store (negatives are cheap to recompute and would bloat
   * `workspaceState`, so they are never persisted). `ttlMs` defaults to the
   * configured positive TTL; callers pass {@link NEGATIVE_TTL_MS} for negative
   * lookups so a transient miss is not pinned for the full positive TTL. Never throws.
   */
  const writeCache = (
    key: string,
    value: IssueMetadata | null,
    ttlMs: number = Math.max(0, getCfg().cacheTtlSeconds) * 1000,
  ): void => {
    const entry: CachedEntry = { value, expiresAt: Date.now() + ttlMs };
    cache.set(key, entry);
    if (value !== null) {
      storeSet(STORE_PREFIX + key, entry);
      prunePersisted();
    }
  };

  /**
   * REHYDRATE the in-memory cache from the injected store on construction. Reads
   * every `STORE_PREFIX` key, drops entries whose shape is invalid, and never
   * throws (a corrupt store must not break startup — it just starts cold).
   */
  const rehydrate = (): void => {
    if (!store?.keys) {
      return;
    }
    try {
      for (const fullKey of store.keys()) {
        if (!fullKey.startsWith(STORE_PREFIX)) {
          continue;
        }
        const raw = store.get<CachedEntry>(fullKey);
        if (
          raw &&
          typeof raw === "object" &&
          typeof raw.expiresAt === "number" &&
          "value" in raw
        ) {
          cache.set(fullKey.slice(STORE_PREFIX.length), {
            value: raw.value,
            expiresAt: raw.expiresAt,
          });
        }
      }
    } catch {
      // Corrupt/unsupported store — start cold.
    }
  };
  rehydrate();

  // -------------------------------------------------------------------------
  // In-flight dedupe + background-activity signal.
  // -------------------------------------------------------------------------

  /**
   * Normalized id → the promise of its currently-running network fetch. Both the
   * single and batch paths register/await per-id here so hover + pill + rail + tree
   * never triple-fetch the same id concurrently; the entry is removed in `finally`.
   */
  const inFlight = new Map<string, Promise<IssueMetadata | null>>();

  /** Count of in-flight network operations this CLIENT MODULE itself issues. */
  let activityCount = 0;

  /** The injected `fetch` (tests) or the global one. */
  const doFetch: typeof fetch = fetchImpl ?? fetch;

  /**
   * Run `op` while reporting it to the optional activity sink: increment on entry,
   * decrement in `finally` (so a thrown/aborted fetch cannot strand the counter and
   * leave a status-bar pulse spinning forever). Best-effort; never throws on report.
   */
  const withActivity = async <T>(op: () => Promise<T>): Promise<T> => {
    activityCount += 1;
    try {
      onActivity?.(activityCount);
    } catch {
      // Reporting must never affect correctness.
    }
    try {
      return await op();
    } finally {
      activityCount -= 1;
      try {
        onActivity?.(activityCount);
      } catch {
        // Reporting must never affect correctness.
      }
    }
  };

  /**
   * Per-id FALLBACK used when the batch `issues(filter:{or:[…]})` query fails
   * (non-200 or GraphQL errors): fetch each id with the proven single-issue
   * {@link ISSUE_QUERY}, which Linear is known to accept. Writes through to the
   * cache (positive, or a short-TTL negative when the issue is absent) and returns
   * whatever resolved. This keeps hovers working even if a workspace rejects the
   * batch shape. Never throws.
   */
  const fallbackSingles = async (
    chunk: IssueId[],
    auth: AuthHeader,
  ): Promise<Map<string, IssueMetadata>> => {
    const out = new Map<string, IssueMetadata>();
    for (const id of chunk) {
      try {
        const response = await withActivity(() =>
          doFetch(LINEAR_GRAPHQL_ENDPOINT, {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              Authorization: auth.value,
            },
            body: JSON.stringify({
              query: ISSUE_QUERY,
              variables: { team: id.team, number: id.number },
            }),
          }),
        );
        if (!response.ok) {
          continue; // transient — leave uncached for a later retry
        }
        const json = (await response.json()) as BatchIssuesResponse;
        if (json.errors) {
          logDebug?.("single issue query returned GraphQL errors");
          continue;
        }
        const hit = mapBatchResponse(json).get(id.normalized);
        if (hit) {
          writeCache(id.normalized, hit);
          out.set(id.normalized, hit);
        } else {
          writeCache(id.normalized, null, NEGATIVE_TTL_MS);
        }
      } catch {
        // Network/parse error — do not cache; allow a later retry.
      }
    }
    return out;
  };

  /**
   * POST the BATCH query for a chunk of ids and merge results into the in-memory
   * cache: present nodes become positive entries; requested ids absent from the
   * response become negative lookups (short TTL). Returns the per-chunk results
   * map. Never throws (resolves with whatever it could gather).
   */
  const fetchChunk = async (
    chunk: IssueId[],
    auth: AuthHeader,
  ): Promise<Map<string, IssueMetadata>> => {
    const { query, variables } = buildBatchIssuesQuery(chunk);
    let json: BatchIssuesResponse;
    try {
      const response = await withActivity(() =>
        doFetch(LINEAR_GRAPHQL_ENDPOINT, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: auth.value,
          },
          body: JSON.stringify({ query, variables }),
        }),
      );
      if (!response.ok) {
        return fallbackSingles(chunk, auth);
      }
      json = (await response.json()) as BatchIssuesResponse;
    } catch {
      // Network/parse failure — do not cache; allow a later retry.
      return new Map();
    }
    if (json.errors) {
      logDebug?.(
        "batch issues query returned GraphQL errors; falling back to single-issue queries",
      );
      return fallbackSingles(chunk, auth);
    }
    const mapped = mapBatchResponse(json);
    for (const id of chunk) {
      const hit = mapped.get(id.normalized);
      if (hit) {
        writeCache(id.normalized, hit);
      } else {
        // Requested but absent → negative lookup with the short TTL.
        writeCache(id.normalized, null, NEGATIVE_TTL_MS);
      }
    }
    return mapped;
  };

  /**
   * Fetch `ids` (already deduped, NOT in cache fresh) coalescing against in-flight
   * promises: ids already being fetched are awaited rather than re-requested; the
   * remainder are chunked (≤ MAX_BATCH) and fetched, each chunk's per-id promise
   * registered in `inFlight` for the duration. Writes through to the cache. Returns
   * a map of every id it could resolve. Never throws.
   */
  const networkFetch = async (
    ids: IssueId[],
    auth: AuthHeader,
  ): Promise<Map<string, IssueMetadata>> => {
    const result = new Map<string, IssueMetadata>();
    const toFetch: IssueId[] = [];
    const awaiting: Array<Promise<void>> = [];

    for (const id of ids) {
      const pending = inFlight.get(id.normalized);
      if (pending) {
        // Coalesce: await the concurrent fetch instead of issuing another.
        awaiting.push(
          pending.then((value) => {
            if (value) {
              result.set(id.normalized, value);
            }
          }),
        );
      } else {
        toFetch.push(id);
      }
    }

    for (const chunk of chunkIds(toFetch)) {
      const chunkPromise = fetchChunk(chunk, auth);
      // Register a per-id slice of this chunk's promise for dedupe.
      for (const id of chunk) {
        const perId = chunkPromise
          .then((m) => m.get(id.normalized) ?? null)
          .finally(() => {
            if (inFlight.get(id.normalized) === perId) {
              inFlight.delete(id.normalized);
            }
          });
        inFlight.set(id.normalized, perId);
        awaiting.push(
          perId.then((value) => {
            if (value) {
              result.set(id.normalized, value);
            }
          }),
        );
      }
    }

    await Promise.all(awaiting);
    return result;
  };

  /**
   * Shared batch + SWR read path behind both `fetchIssues` and `fetchIssue`.
   * Serves fresh ids from cache, serves stale ids from cache while firing a deduped
   * background refresh, and awaits the network only for missing ids. Never throws;
   * resolves with whatever it could gather. Defined as a closure (not via `this`)
   * so it is safe to destructure the returned client.
   */
  const fetchIssuesImpl = async (
    ids: IssueId[],
  ): Promise<Map<string, IssueMetadata>> => {
    const result = new Map<string, IssueMetadata>();
    try {
      if (!getCfg().enableApi || ids.length === 0) {
        return result;
      }
      const auth = await resolveAuth();
      if (!auth) {
        return result;
      }

      const deduped = dedupeIds(ids);
      const { fresh, stale, missing } = classifyForSwr(deduped, cache, Date.now());

      // 1. FRESH + 2. STALE: serve the cached value immediately (positive entries
      //    only — a cached negative lookup is simply absent from the result map).
      for (const id of [...fresh, ...stale]) {
        const value = readEntry(id.normalized)?.value;
        if (value) {
          result.set(id.normalized, value);
        }
      }

      // 2b. STALE: kick a deduped background refresh that writes through on resolve
      //     (fire-and-forget; do NOT await — the stale value is already returned).
      if (stale.length > 0) {
        void networkFetch(stale, auth).catch(() => {});
      }

      // 3. MISSING: must fetch before returning (deduped + chunked + coalesced).
      if (missing.length > 0) {
        const fetched = await networkFetch(missing, auth);
        for (const [key, value] of fetched) {
          result.set(key, value);
        }
      }

      return result;
    } catch {
      // Absolute backstop: never throw; return whatever we gathered.
      return result;
    }
  };

  return {
    fetchIssues(ids: IssueId[]): Promise<Map<string, IssueMetadata>> {
      return fetchIssuesImpl(ids);
    },

    async fetchIssue(id: IssueId): Promise<IssueMetadata | null> {
      // Thin wrapper: routes through the shared batch/cache/dedupe path so a single
      // hover, the pill, the rail, and the tree all share one warm cache + one
      // in-flight promise. Never throws (the callee is a hard backstop).
      return (await fetchIssuesImpl([id])).get(id.normalized) ?? null;
    },

    async prefetch(ids: IssueId[]): Promise<void> {
      try {
        if (!getCfg().enableApi || ids.length === 0) {
          return;
        }
        const auth = await resolveAuth();
        if (!auth) {
          return;
        }
        const deduped = dedupeIds(ids);
        const { stale, missing } = classifyForSwr(deduped, cache, Date.now());
        const notFresh = [...missing, ...stale];
        if (notFresh.length === 0) {
          return;
        }
        // Warm the cache; the returned map is discarded (the cache is the point).
        await networkFetch(notFresh, auth);
      } catch {
        // Prefetch is best-effort; never throw.
      }
    },

    peekIssue(id: IssueId): IssueMetadata | null {
      // Synchronous, network-free read of the shared metadata cache. Returns the
      // cached metadata when present — INCLUDING a STALE value (SWR wants the
      // last-known value painted instantly while a background refresh runs). A
      // null means "nothing cached yet". Used by the inline pill, rail, and tree.
      return readEntry(id.normalized)?.value ?? null;
    },

    async fetchTicketDetail(id: IssueId): Promise<TicketDetail | null> {
      // Delegates to the heavier detail path, reusing this client's auth/config
      // and a dedicated TTL cache. Never throws (the callee is a hard backstop).
      return fetchTicketDetail(id, {
        getCfg,
        resolveAuth,
        cache: detailCache,
      });
    },

    clearCache(): void {
      cache.clear();
      detailCache.clear();
      pickerCache.clear();
      // Drop every persisted metadata entry under our namespace.
      if (store?.keys) {
        try {
          for (const fullKey of store.keys()) {
            if (fullKey.startsWith(STORE_PREFIX)) {
              storeSet(fullKey, undefined);
            }
          }
        } catch {
          // Best-effort; never throw out of clearCache.
        }
      }
    },

    hasAuth(): boolean {
      // Reflects the API-enabled config flag plus the last-known auth presence;
      // call refreshAuth() after sign-in/out or a key change to update the latter.
      return getCfg().enableApi && hasAuthCached;
    },

    async refreshAuth(): Promise<void> {
      try {
        hasAuthCached = (await resolveAuth()) !== undefined;
      } catch {
        hasAuthCached = false;
      }
    },

    async listIssues(scope: IssueListScope, limit: number): Promise<IssueListItem[]> {
      try {
        if (!getCfg().enableApi) {
          return [];
        }
        const auth = await resolveAuth();
        if (!auth) {
          return [];
        }

        const query = scope === "mine" ? MY_ISSUES_QUERY : RECENT_ISSUES_QUERY;

        let response: Response;
        try {
          response = await withActivity(() =>
            doFetch(LINEAR_GRAPHQL_ENDPOINT, {
              method: "POST",
              headers: {
                "Content-Type": "application/json",
                Authorization: auth.value,
              },
              body: JSON.stringify({ query, variables: { first: limit } }),
            }),
          );
        } catch {
          return [];
        }

        if (!response.ok) {
          return [];
        }

        let json: MyIssuesResponse | RecentIssuesResponse;
        try {
          json = (await response.json()) as MyIssuesResponse | RecentIssuesResponse;
        } catch {
          return [];
        }

        if (json.errors) {
          return [];
        }

        let rawNodes: RawListNode[] | null | undefined;
        if (scope === "mine") {
          rawNodes = (json as MyIssuesResponse).data?.viewer?.assignedIssues?.nodes;
        } else {
          rawNodes = (json as RecentIssuesResponse).data?.issues?.nodes;
        }

        return (rawNodes ?? []).map(mapListNode);
      } catch {
        return [];
      }
    },

    async searchIssues(query: string, limit: number): Promise<IssueListItem[]> {
      try {
        const term = query.trim();
        if (!term) {
          return [];
        }
        if (!getCfg().enableApi) {
          return [];
        }
        const auth = await resolveAuth();
        if (!auth) {
          return [];
        }

        let response: Response;
        try {
          response = await withActivity(() =>
            doFetch(LINEAR_GRAPHQL_ENDPOINT, {
              method: "POST",
              headers: {
                "Content-Type": "application/json",
                Authorization: auth.value,
              },
              body: JSON.stringify({
                query: ISSUE_SEARCH_QUERY,
                variables: { term, first: limit },
              }),
            }),
          );
        } catch {
          return [];
        }

        if (!response.ok) {
          return [];
        }

        let json: SearchIssuesResponse;
        try {
          json = (await response.json()) as SearchIssuesResponse;
        } catch {
          return [];
        }

        if (json.errors) {
          return [];
        }

        const rawNodes = json.data?.searchIssues?.nodes;
        return (rawNodes ?? []).map(mapListNode);
      } catch {
        return [];
      }
    },

    async fetchWorkspaceInfo(): Promise<WorkspaceInfo | null> {
      try {
        if (!getCfg().enableApi) {
          return null;
        }
        const auth = await resolveAuth();
        if (!auth) {
          return null;
        }

        let response: Response;
        try {
          response = await withActivity(() =>
            doFetch(LINEAR_GRAPHQL_ENDPOINT, {
              method: "POST",
              headers: {
                "Content-Type": "application/json",
                Authorization: auth.value,
              },
              body: JSON.stringify({
                query: WORKSPACE_INFO_QUERY,
                variables: { first: WORKSPACE_INFO_TEAM_LIMIT },
              }),
            }),
          );
        } catch {
          return null;
        }

        if (!response.ok) {
          return null;
        }

        let json: unknown;
        try {
          json = await response.json();
        } catch {
          return null;
        }

        // The pure mapper defends against null fields / errors and never throws;
        // it returns null on GraphQL errors or wholly-absent data.
        return mapWorkspaceInfo(json);
      } catch {
        // Absolute backstop: never throw out of fetchWorkspaceInfo.
        return null;
      }
    },

    // --- Pickers (read; cached; delegate to the pure module; never throw) ---

    listTeams(): Promise<TeamOption[]> {
      return cachedPicker("teams", () => fetchTeams(pickerDeps));
    },

    listViewerTeams(): Promise<TeamOption[]> {
      return cachedPicker("viewerTeams", () => fetchViewerTeams(pickerDeps));
    },

    listWorkflowStates(teamId: string): Promise<WorkflowStateOption[]> {
      return cachedPicker("states:" + teamId, () =>
        fetchWorkflowStates(teamId, pickerDeps),
      );
    },

    listLabels(teamId: string): Promise<LabelOption[]> {
      return cachedPicker("labels:" + teamId, () => fetchLabels(teamId, pickerDeps));
    },

    listUsers(): Promise<UserOption[]> {
      return cachedPicker("users", () => fetchUsers(pickerDeps));
    },

    listCycles(teamId: string): Promise<CycleOption[]> {
      return cachedPicker("cycles:" + teamId, () => fetchCycles(teamId, pickerDeps));
    },

    listProjects(): Promise<ProjectOption[]> {
      return cachedPicker("projects", () => fetchProjects(pickerDeps));
    },

    getEditContext(id: IssueId): Promise<IssueEditContext | null> {
      // Not cached: edit context reflects live, mutable field values + relations.
      return fetchEditContext(id, pickerDeps);
    },

    // --- Mutations (write; delegate to the pure module; never throw) ---

    createIssue(
      input: IssueCreateFields,
    ): Promise<LinearWriteResult<IssueMutationResult>> {
      return createIssueMutation(buildCreateInput(input), mutationDeps);
    },

    updateIssue(
      issueUuid: string,
      input: IssueUpdateFields,
    ): Promise<LinearWriteResult<IssueMutationResult>> {
      return updateIssueMutation(issueUuid, buildUpdateInput(input), mutationDeps);
    },

    addRelation(input: {
      issueId: string;
      relatedIssueId: string;
      type: "blocks";
    }): Promise<LinearWriteResult<RelationMutationResult>> {
      return addRelationMutation(input, mutationDeps);
    },

    removeRelation(
      relationId: string,
    ): Promise<LinearWriteResult<RelationMutationResult>> {
      return removeRelationMutation(relationId, mutationDeps);
    },
  };
}
