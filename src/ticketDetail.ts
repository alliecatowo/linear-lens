/**
 * Linear Lens — heavier, on-demand ticket-detail fetch (no `vscode` import).
 *
 * The lightweight {@link LinearClient.fetchIssue} powers hovers and inline
 * status and intentionally caps its nested connections so a mouse-move never
 * pulls a large payload. The webview detail panel (V3) needs the FULL picture:
 * the complete comment thread, every label, all attachments, and the full
 * collaborator list. This module owns that heavier path.
 *
 * It is `vscode`-free so it remains unit-testable in plain Node. It reuses the
 * host's existing auth, config, and an in-memory TTL cache via a small injected
 * {@link TicketDetailDeps} bag — the same shape `linearClient.ts` already has —
 * rather than constructing its own. Like the rest of the client surface, every
 * function degrades gracefully and NEVER throws: on any failure (API disabled,
 * no auth, network error, malformed response, not found) it resolves to `null`.
 */

import {
  AuthHeader,
  IssueAttachment,
  IssueComment,
  IssueId,
  IssueLabel,
  LinearLensConfig,
  Person,
  TicketDetail,
} from "./types";

/** Linear GraphQL endpoint. */
const LINEAR_GRAPHQL_ENDPOINT = "https://api.linear.app/graphql";

/**
 * Upper bound on each nested connection in the detail query. Generous enough to
 * show a full thread in the panel while still capping a pathological issue (a
 * spam-commented ticket) so one detail fetch cannot return an unbounded payload.
 */
const DETAIL_CONNECTION_LIMIT = 100;

/**
 * GraphQL query that looks up a single issue by its team key + number, returning
 * the FULL detail used by the webview panel. Variables:
 * `{ team: String!, number: Float!, first: Int! }`.
 *
 * Fields mirror the live Linear schema and are all nullable-tolerant; the mapper
 * ({@link toTicketDetail}) defends against missing nodes and fields. Nested
 * connections take `first: $first` (capped at {@link DETAIL_CONNECTION_LIMIT})
 * so the payload stays bounded.
 */
export const TICKET_DETAIL_QUERY: string = `
query TicketDetail($team: String!, $number: Float!, $first: Int!) {
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
      labels(first: $first) { nodes { name color } }
      subscribers(first: $first) { nodes { name displayName avatarUrl } }
      comments(first: $first) { nodes { id body createdAt user { name displayName avatarUrl } } }
      attachments(first: $first) { nodes { title url } }
    }
  }
}`.trim();

// ---------------------------------------------------------------------------
// Raw GraphQL node shapes (all fields nullable)
// ---------------------------------------------------------------------------

/** Raw shape of a person node (assignee/creator/subscriber/comment author). */
interface RawDetailPerson {
  name?: string | null;
  displayName?: string | null;
  avatarUrl?: string | null;
}

/** Raw shape of a single comment node from the detail query. */
interface RawDetailComment {
  id?: string | null;
  body?: string | null;
  createdAt?: string | null;
  /** Linear's field is `user`; we expose it as {@link IssueComment.author}. */
  user?: RawDetailPerson | null;
}

/** Raw shape of one detail issue node returned by {@link TICKET_DETAIL_QUERY}. */
export interface RawDetailNode {
  identifier?: string | null;
  title?: string | null;
  url?: string | null;
  branchName?: string | null;
  archivedAt?: string | null;
  priorityLabel?: string | null;
  description?: string | null;
  state?: { name?: string | null; type?: string | null; color?: string | null } | null;
  assignee?: RawDetailPerson | null;
  creator?: RawDetailPerson | null;
  project?: { name?: string | null } | null;
  labels?: { nodes?: Array<{ name?: string | null; color?: string | null } | null> | null } | null;
  subscribers?: { nodes?: Array<RawDetailPerson | null> | null } | null;
  comments?: { nodes?: Array<RawDetailComment | null> | null } | null;
  attachments?: { nodes?: Array<{ title?: string | null; url?: string | null } | null> | null } | null;
}

/** Shape of the {@link TICKET_DETAIL_QUERY} response envelope we care about. */
interface TicketDetailResponse {
  data?: {
    issues?: {
      nodes?: RawDetailNode[] | null;
    } | null;
  } | null;
  errors?: unknown;
}

// ---------------------------------------------------------------------------
// Pure mappers (null-tolerant; never throw)
// ---------------------------------------------------------------------------

/**
 * Map a raw person node onto {@link Person}, or `undefined` when the node is
 * null/empty. `displayName` falls back to `name`, then to "".
 */
function mapPerson(raw: RawDetailPerson | null | undefined): Person | undefined {
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
function mapLabels(node: RawDetailNode): IssueLabel[] {
  return (node.labels?.nodes ?? []).flatMap((label) =>
    label ? [{ name: label.name ?? "", color: label.color ?? undefined }] : [],
  );
}

/** Map the subscribers connection to collaborator {@link Person}[], dropping nulls. */
function mapCollaborators(node: RawDetailNode): Person[] {
  return (node.subscribers?.nodes ?? []).flatMap((raw) => {
    const person = mapPerson(raw);
    return person ? [person] : [];
  });
}

/** Map the comments connection to {@link IssueComment}[], dropping null entries. */
function mapComments(node: RawDetailNode): IssueComment[] {
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

/** Map the attachments connection to {@link IssueAttachment}[], dropping nulls. */
function mapAttachments(node: RawDetailNode): IssueAttachment[] {
  return (node.attachments?.nodes ?? []).flatMap((attachment) =>
    attachment ? [{ title: attachment.title ?? "", url: attachment.url ?? "" }] : [],
  );
}

/**
 * Map a raw GraphQL detail node onto the normalized {@link TicketDetail} shape.
 * Pure and null-tolerant: every absent field collapses to its default
 * (`""`, `[]`, or `undefined`) so the webview never sees `null`. Never throws.
 *
 * @param node - A raw issue node from {@link TICKET_DETAIL_QUERY}.
 * @returns The normalized {@link TicketDetail}.
 */
export function toTicketDetail(node: RawDetailNode): TicketDetail {
  return {
    id: node.identifier ?? "",
    title: node.title ?? "",
    url: node.url ?? "",
    branchName: node.branchName ?? undefined,
    archived: node.archivedAt != null,
    priority: node.priorityLabel ?? undefined,
    project: node.project?.name ?? undefined,
    state: node.state?.name ?? "",
    stateType: node.state?.type ?? undefined,
    stateColor: node.state?.color ?? undefined,
    description: node.description ?? "",
    assignee: mapPerson(node.assignee),
    creator: mapPerson(node.creator),
    collaborators: mapCollaborators(node),
    labels: mapLabels(node),
    comments: mapComments(node),
    attachments: mapAttachments(node),
  };
}

// ---------------------------------------------------------------------------
// Cache + fetch
// ---------------------------------------------------------------------------

/** A cache entry holding a (possibly null) detail value and its expiry timestamp. */
interface DetailCacheEntry {
  /** Resolved detail, or `null` for a cached negative lookup. */
  value: TicketDetail | null;
  /** Epoch milliseconds (`Date.now()`) after which this entry is stale. */
  expiresAt: number;
}

/**
 * A minimal TTL cache for ticket detail, keyed by `id.normalized`. The host
 * owns the {@link Map} so detail and hover caches stay separate and can be
 * cleared/invalidated independently. All operations are synchronous and safe.
 */
export interface TicketDetailCache {
  /** Read a non-expired entry, or `undefined`. Deletes the entry if stale. */
  read(key: string): DetailCacheEntry | undefined;
  /** Store a value under the configured TTL (seconds). */
  write(key: string, value: TicketDetail | null): void;
  /** Drop a single entry (targeted invalidation, e.g. webview "refresh"). */
  invalidate(key: string): void;
  /** Drop every entry. */
  clear(): void;
}

/**
 * Create an in-memory {@link TicketDetailCache} whose TTL is read fresh from
 * `getCfg().cacheTtlSeconds` on every write, mirroring `linearClient.ts`.
 *
 * @param getCfg - Accessor returning the current resolved configuration.
 * @returns A self-contained TTL cache for {@link TicketDetail} values.
 */
export function createTicketDetailCache(
  getCfg: () => LinearLensConfig,
): TicketDetailCache {
  const cache = new Map<string, DetailCacheEntry>();
  return {
    read(key: string): DetailCacheEntry | undefined {
      const entry = cache.get(key);
      if (!entry) {
        return undefined;
      }
      if (Date.now() >= entry.expiresAt) {
        cache.delete(key);
        return undefined;
      }
      return entry;
    },
    write(key: string, value: TicketDetail | null): void {
      const ttlMs = Math.max(0, getCfg().cacheTtlSeconds) * 1000;
      cache.set(key, { value, expiresAt: Date.now() + ttlMs });
    },
    invalidate(key: string): void {
      cache.delete(key);
    },
    clear(): void {
      cache.clear();
    },
  };
}

/**
 * Dependencies the {@link fetchTicketDetail} call needs from the host. These are
 * the SAME primitives `linearClient.ts` already holds, so the detail path reuses
 * the existing auth, config, and cache rather than constructing its own.
 */
export interface TicketDetailDeps {
  /** Accessor returning the current resolved configuration. */
  getCfg: () => LinearLensConfig;
  /**
   * Async accessor returning the current auth header, or `undefined` when no
   * credential is available. The header `value` is used verbatim (already in the
   * correct format: `"Bearer <token>"` for OAuth or the raw key for API keys).
   */
  resolveAuth: () => Promise<AuthHeader | undefined>;
  /** The shared detail cache (kept separate from the hover metadata cache). */
  cache: TicketDetailCache;
  /**
   * Optional `fetch` override (injectable for tests). Defaults to the global
   * `fetch`. Must conform to the standard `fetch` signature.
   */
  fetchImpl?: typeof fetch;
}

/**
 * Fetch the full {@link TicketDetail} for an issue, or `null` if unavailable.
 *
 * Reuses the host's existing auth/config and a dedicated TTL cache, then POSTs
 * {@link TICKET_DETAIL_QUERY} to Linear. Resolves to `null` — never throws —
 * whenever the API is disabled, no auth is present, the network/parse fails, the
 * response carries GraphQL `errors`, or the issue is not found. Negative lookups
 * (not found) are cached briefly to avoid hammering the API; transient network
 * failures are NOT cached so a later retry can succeed.
 *
 * @param id   - The normalized issue identity (team key + number).
 * @param deps - Injected auth/config/cache primitives (see {@link TicketDetailDeps}).
 * @returns The normalized {@link TicketDetail}, or `null`.
 */
export async function fetchTicketDetail(
  id: IssueId,
  deps: TicketDetailDeps,
): Promise<TicketDetail | null> {
  try {
    if (!deps.getCfg().enableApi) {
      return null;
    }

    const auth = await deps.resolveAuth();
    if (!auth) {
      return null;
    }

    const cached = deps.cache.read(id.normalized);
    if (cached) {
      return cached.value;
    }

    const doFetch = deps.fetchImpl ?? fetch;

    let response: Response;
    try {
      response = await doFetch(LINEAR_GRAPHQL_ENDPOINT, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          // Use auth.value verbatim — it is already correctly formatted.
          Authorization: auth.value,
        },
        body: JSON.stringify({
          query: TICKET_DETAIL_QUERY,
          variables: { team: id.team, number: id.number, first: DETAIL_CONNECTION_LIMIT },
        }),
      });
    } catch {
      // Network failure — do not cache, allow a later retry.
      return null;
    }

    if (!response.ok) {
      return null;
    }

    let json: TicketDetailResponse;
    try {
      json = (await response.json()) as TicketDetailResponse;
    } catch {
      return null;
    }

    if (json.errors) {
      return null;
    }

    const node = json.data?.issues?.nodes?.[0];
    if (!node) {
      // Cache the negative lookup briefly to avoid hammering the API.
      deps.cache.write(id.normalized, null);
      return null;
    }

    const detail = toTicketDetail(node);
    deps.cache.write(id.normalized, detail);
    return detail;
  } catch {
    // Absolute backstop: never throw out of fetchTicketDetail.
    return null;
  }
}
