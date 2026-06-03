import * as vscode from "vscode";
import { IssueId, IssueMetadata, LinearClient, LinearLensConfig } from "./types";

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
 * `null` whenever the API is disabled, no key is present, or any error occurs.
 *
 * @param getCfg - Accessor returning the current resolved configuration.
 * @param secrets - VS Code SecretStorage holding the Linear API key.
 * @returns A graceful, never-throwing {@link LinearClient}.
 */
export function createLinearClient(
  getCfg: () => LinearLensConfig,
  secrets: vscode.SecretStorage,
): LinearClient {
  const cache = new Map<string, CacheEntry>();
  let apiKey: string | undefined;

  /** Whether config enables the API and a key is currently present. */
  const isAuthed = (): boolean =>
    getCfg().enableApi && typeof apiKey === "string" && apiKey.length > 0;

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
        if (!isAuthed()) {
          return null;
        }

        const cached = readCache(id.normalized);
        if (cached) {
          return cached.value;
        }

        // `isAuthed()` guarantees a non-empty key here.
        const key = apiKey as string;
        let response: Response;
        try {
          response = await fetch(LINEAR_GRAPHQL_ENDPOINT, {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              // Linear personal API keys are sent raw, without a "Bearer" prefix.
              Authorization: key,
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
      // Reflects the API-enabled config flag plus the last-read key presence;
      // call refreshAuth() after the key is set/cleared to update the latter.
      return isAuthed();
    },

    async refreshAuth(): Promise<void> {
      try {
        apiKey = await secrets.get(API_KEY_SECRET);
      } catch {
        apiKey = undefined;
      }
    },
  };
}
