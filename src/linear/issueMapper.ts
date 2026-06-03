/**
 * Linear Lens — pure issue list mapper (no `vscode` import).
 *
 * Defines the GraphQL list queries (MY_ISSUES_QUERY, RECENT_ISSUES_QUERY,
 * ISSUE_SEARCH_QUERY) and the mapper function that converts a raw list node
 * from any of these queries into an {@link IssueListItem}. All logic is
 * defensively null-tolerant. This module is unit-testable in plain Node.
 *
 * ### GraphQL field-correctness notes
 * - `searchIssues(term: String!, …)` is the current Linear root field;
 *   the deprecated `issueSearch(query:)` MUST NOT be used.
 * - `orderBy: updatedAt` is a `PaginationOrderBy` enum literal — never quote it.
 * - `viewer.assignedIssues` returns an `IssueConnection`; the client reads
 *   `data.viewer.assignedIssues.nodes`.
 */

import { IssueListItem } from "../types";

// ---------------------------------------------------------------------------
// GraphQL list queries (pure string constants)
// ---------------------------------------------------------------------------

/**
 * Issues assigned to the viewer, most-recently-updated first.
 * Variables: `{ first: Float! }`.
 */
export const MY_ISSUES_QUERY: string = `
query MyIssues($first: Float!) {
  viewer {
    assignedIssues(first: $first, orderBy: updatedAt) {
      nodes {
        identifier
        title
        url
        updatedAt
        state { name type color }
        assignee { displayName name }
      }
    }
  }
}`.trim();

/**
 * Recently-updated issues across the viewer's workspace.
 * Variables: `{ first: Float! }`.
 */
export const RECENT_ISSUES_QUERY: string = `
query RecentIssues($first: Float!) {
  issues(first: $first, orderBy: updatedAt) {
    nodes {
      identifier
      title
      url
      updatedAt
      state { name type color }
      assignee { displayName name }
    }
  }
}`.trim();

/**
 * Full-text issue search using Linear's `searchIssues(term:)` root field.
 * MUST use `searchIssues`, NOT the deprecated `issueSearch(query:)`.
 * Variables: `{ term: String!, first: Float! }`.
 */
export const ISSUE_SEARCH_QUERY: string = `
query SearchIssues($term: String!, $first: Float!) {
  searchIssues(term: $term, first: $first) {
    nodes {
      identifier
      title
      url
      updatedAt
      state { name type color }
      assignee { displayName name }
    }
  }
}`.trim();

// ---------------------------------------------------------------------------
// Raw node shape (shared across all three queries)
// ---------------------------------------------------------------------------

/** Raw shape of one list node (subset of the full issue node + updatedAt). */
export interface RawListNode {
  identifier?: string | null;
  title?: string | null;
  url?: string | null;
  updatedAt?: string | null;
  state?: { name?: string | null; type?: string | null; color?: string | null } | null;
  assignee?: { displayName?: string | null; name?: string | null } | null;
}

// ---------------------------------------------------------------------------
// Mapper
// ---------------------------------------------------------------------------

/**
 * Map a raw list node from any list/search query to an {@link IssueListItem}.
 * Tolerates all-null fields; never throws.
 *
 * - `assignee` is `displayName ?? name ?? undefined`.
 * - `id`, `title`, and `url` fall back to `""` when absent.
 * - `updatedAt` and state fields are `undefined` when absent.
 */
export function mapListNode(node: RawListNode): IssueListItem {
  return {
    id: node.identifier ?? "",
    title: node.title ?? "",
    state: node.state?.name ?? "",
    stateColor: node.state?.color ?? undefined,
    stateType: node.state?.type ?? undefined,
    assignee: node.assignee?.displayName || node.assignee?.name || undefined,
    url: node.url ?? "",
    updatedAt: node.updatedAt ?? undefined,
  };
}
