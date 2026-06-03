import { AuthHeader, IssueId, IssueMetadata, LinearClient, LinearLensConfig } from "./types";

/** SecretStorage key under which the Linear API key is stored. */
export const API_KEY_SECRET = "linearLens.apiKey";

/** Linear GraphQL endpoint. */
const LINEAR_GRAPHQL_ENDPOINT = "https://api.linear.app/graphql";

/**
 * GraphQL query that looks up a single issue by its team key + number.
 * Variables: `{ team: string, number: number }`.
 */
const ISSUE_QUERY = `query Issue($team: String!, $number: Float!) {
  issues(filter: { team: { key: { eq: $team } }, number: { eq: $number } }, first: 1) {
    nodes {
      identifier
      title
      state { name type }
      assignee { name }
      priorityLabel
      project { name }
      url
      archivedAt
    }
  }
}`;

/** Shape of a single issue node returned by the GraphQL query. */
interface IssueNode {
  identifier?: string;
  title?: string;
  state?: { name?: string; type?: string } | null;
  assignee?: { name?: string } | null;
  priorityLabel?: string | null;
  project?: { name?: string } | null;
  url?: string;
  archivedAt?: string | null;
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
 * @param getCfg - Accessor returning the current resolved configuration.
 * @param resolveAuth - Async accessor that returns the current auth header, or
 *   `undefined` when no credential is available.
 * @returns A graceful, never-throwing {@link LinearClient}.
 */
export function createLinearClient(
  getCfg: () => LinearLensConfig,
  resolveAuth: () => Promise<AuthHeader | undefined>,
): LinearClient {
  const cache = new Map<string, CacheEntry>();
  /** Cached boolean: whether the last `refreshAuth()` call found a credential. */
  let hasAuthCached = false;

  /** Map a raw GraphQL issue node onto our {@link IssueMetadata} shape. */
  const toMetadata = (node: IssueNode): IssueMetadata => ({
    id: node.identifier ?? "",
    title: node.title ?? "",
    state: node.state?.name ?? "",
    stateType: node.state?.type ?? undefined,
    assignee: node.assignee?.name ?? undefined,
    priority: node.priorityLabel ?? undefined,
    project: node.project?.name ?? undefined,
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

    clearCache(): void {
      cache.clear();
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
  };
}
