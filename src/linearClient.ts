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
 * GraphQL query that looks up a single issue by its team key + number, returning
 * the full metadata used by rich hovers. Variables: `{ team: String!, number: Float! }`.
 *
 * Every selected field is nullable-tolerant; {@link toMetadata} defends against
 * missing nodes and fields. Nested connections are capped (`first: N`) so a
 * heavily-commented issue cannot return a huge payload on every hover — the TTL
 * cache means a hover and a later detail view share this single fetch.
 */
const ISSUE_QUERY = `query Issue($team: String!, $number: Float!) {
  issues(filter: { team: { key: { eq: $team } }, number: { eq: $number } }, first: 1) {
    nodes {
      identifier
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
      attachments(first: 20) { nodes { title url } }
    }
  }
}`;

/** Raw shape of a person node (assignee/creator/subscriber/comment author). */
interface RawPerson {
  name?: string | null;
  displayName?: string | null;
  avatarUrl?: string | null;
}

/** Raw shape of a single comment node from the query. */
interface RawComment {
  id?: string | null;
  body?: string | null;
  createdAt?: string | null;
  /** Linear's field is `user`; we expose it as {@link IssueComment.author}. */
  user?: RawPerson | null;
}

/** Shape of a single issue node returned by the GraphQL query (all nullable). */
interface IssueNode {
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

/** Shape of the GraphQL response envelope we care about. */
interface IssueQueryResponse {
  data?: {
    issues?: {
      nodes?: IssueNode[];
    } | null;
  } | null;
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

/** A cache entry holding a (possibly null) metadata value and its expiry timestamp. */
interface CacheEntry {
  /** Resolved metadata, or `null` for a cached negative lookup. */
  value: IssueMetadata | null;
  /** Epoch milliseconds (`Date.now()`) after which this entry is stale. */
  expiresAt: number;
}

/**
 * Create the optional Linear API client. Degrades gracefully; never throws.
 *
 * The returned client implements {@link LinearClient}: it POSTs the GraphQL
 * {@link ISSUE_QUERY} to Linear using the global `fetch`, caches results
 * in-memory keyed by `id.normalized` with a TTL from config, and resolves to
 * `null` whenever the API is disabled, no auth is present, or any error occurs.
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
 * @param fetchImpl - Optional `fetch` override (injected in tests for mutations
 *   and picker reads). Defaults to the global `fetch`.
 * @param logDebug - Optional debug sink for mutation/picker operation names and
 *   sanitized error messages (NEVER tokens/variables).
 * @returns A graceful, never-throwing {@link LinearClient}.
 */
export function createLinearClient(
  getCfg: () => LinearLensConfig,
  resolveAuth: () => Promise<AuthHeader | undefined>,
  resolveWriteAuth: () => Promise<AuthHeader | undefined> = resolveAuth,
  fetchImpl?: typeof fetch,
  logDebug?: (line: string) => void,
): LinearClient {
  const cache = new Map<string, CacheEntry>();
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

  /**
   * Map a raw person node onto {@link Person}, or `undefined` when the node is
   * null/empty. `displayName` falls back to `name`, then to "".
   */
  const mapPerson = (raw: RawPerson | null | undefined): Person | undefined => {
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
  };

  /** Map the labels connection to {@link IssueLabel}[], dropping null entries. */
  const mapLabels = (node: IssueNode): IssueLabel[] =>
    (node.labels?.nodes ?? []).flatMap((label) =>
      label ? [{ name: label.name ?? "", color: label.color ?? undefined }] : [],
    );

  /** Map the subscribers connection to {@link Person}[], dropping null entries. */
  const mapSubscribers = (node: IssueNode): Person[] =>
    (node.subscribers?.nodes ?? []).flatMap((raw) => {
      const person = mapPerson(raw);
      return person ? [person] : [];
    });

  /** Map the comments connection to {@link IssueComment}[], dropping null entries. */
  const mapComments = (node: IssueNode): IssueComment[] =>
    (node.comments?.nodes ?? []).flatMap((comment) =>
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

  /** Map the attachments connection to {@link IssueAttachment}[], dropping null entries. */
  const mapAttachments = (node: IssueNode): IssueAttachment[] =>
    (node.attachments?.nodes ?? []).flatMap((attachment) =>
      attachment ? [{ title: attachment.title ?? "", url: attachment.url ?? "" }] : [],
    );

  /** Map a raw GraphQL issue node onto our {@link IssueMetadata} shape. */
  const toMetadata = (node: IssueNode): IssueMetadata => ({
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
  });

  /** Read a cache entry that has not expired, or `undefined`. */
  const readCache = (key: string): CacheEntry | undefined => {
    const entry = cache.get(key);
    if (!entry) {
      return undefined;
    }
    if (Date.now() >= entry.expiresAt) {
      cache.delete(key);
      return undefined;
    }
    return entry;
  };

  /** Store a value in the cache using the configured TTL. */
  const writeCache = (key: string, value: IssueMetadata | null): void => {
    const ttlMs = Math.max(0, getCfg().cacheTtlSeconds) * 1000;
    cache.set(key, { value, expiresAt: Date.now() + ttlMs });
  };

  return {
    async fetchIssue(id: IssueId): Promise<IssueMetadata | null> {
      try {
        if (!getCfg().enableApi) {
          return null;
        }

        const auth = await resolveAuth();
        if (!auth) {
          return null;
        }

        const cached = readCache(id.normalized);
        if (cached) {
          return cached.value;
        }

        let response: Response;
        try {
          response = await fetch(LINEAR_GRAPHQL_ENDPOINT, {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              // Use auth.value directly — it is already in the correct format:
              // "Bearer <token>" for OAuth or the raw key for personal API keys.
              Authorization: auth.value,
            },
            body: JSON.stringify({
              query: ISSUE_QUERY,
              variables: { team: id.team, number: id.number },
            }),
          });
        } catch {
          // Network failure — do not cache, allow a later retry.
          return null;
        }

        if (!response.ok) {
          return null;
        }

        let json: IssueQueryResponse;
        try {
          json = (await response.json()) as IssueQueryResponse;
        } catch {
          return null;
        }

        if (json.errors) {
          return null;
        }

        const node = json.data?.issues?.nodes?.[0];
        if (!node) {
          // Cache the negative lookup briefly to avoid hammering the API.
          writeCache(id.normalized, null);
          return null;
        }

        const metadata = toMetadata(node);
        writeCache(id.normalized, metadata);
        return metadata;
      } catch {
        // Absolute backstop: never throw out of fetchIssue.
        return null;
      }
    },

    peekIssue(id: IssueId): IssueMetadata | null {
      // Synchronous, network-free read of the shared hover cache. Returns the
      // cached metadata when present and unexpired, else null — used by the
      // inline status pill, gutter, and tree to paint without awaiting a fetch.
      return readCache(id.normalized)?.value ?? null;
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
          response = await fetch(LINEAR_GRAPHQL_ENDPOINT, {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              Authorization: auth.value,
            },
            body: JSON.stringify({ query, variables: { first: limit } }),
          });
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
          response = await fetch(LINEAR_GRAPHQL_ENDPOINT, {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              Authorization: auth.value,
            },
            body: JSON.stringify({
              query: ISSUE_SEARCH_QUERY,
              variables: { term, first: limit },
            }),
          });
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
