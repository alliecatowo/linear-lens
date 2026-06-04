/**
 * Pure (vscode-free) workspace-info query + response mapper that powers
 * auth-aware detection. Given a signed-in credential, the client fetches the
 * organization slug (`organization.urlKey`) and every visible team key in one
 * GraphQL request; {@link mapWorkspaceInfo} folds the raw envelope into a
 * defensive {@link WorkspaceInfo}. Like every `src/linear/*` module this MUST
 * NOT import `vscode` so it stays unit-testable in plain Node (vitest).
 */

/** The signed-in workspace's identity, used for auth-aware detection. */
export interface WorkspaceInfo {
  /** organization.urlKey, e.g. "acme" — the slug used to build issue URLs. May be "". */
  slug: string;
  /** All team keys the viewer can see, UPPERCASE + trimmed + de-duped, e.g. ["ENG","DES"]. */
  teamKeys: string[];
  /** Full team rows (id/key/name) for reuse by pickers if useful. */
  teams: { id: string; key: string; name: string }[];
}

/**
 * Maximum number of team rows requested in a single page. Most workspaces have
 * far fewer; if a workspace exceeds this, detection still works — unknown keys
 * simply fall back to zero-config behavior, never a hard failure. Paging beyond
 * the first page is intentionally out of scope.
 */
export const WORKSPACE_INFO_TEAM_LIMIT = 250;

/**
 * The org + teams query. Fetches the workspace slug plus every visible team key
 * in a single round-trip. Variables: `{ first: Int! }` (the team page size,
 * typically {@link WORKSPACE_INFO_TEAM_LIMIT}).
 */
export const WORKSPACE_INFO_QUERY: string = `
query WorkspaceInfo($first: Int!) {
  organization { urlKey }
  teams(first: $first) { nodes { id key name } }
}`.trim();

/** Raw shape of a single team node (all fields nullable/defensive). */
interface RawTeamNode {
  id?: string | null;
  key?: string | null;
  name?: string | null;
}

/** Raw envelope shape this mapper defends against (every field optional). */
interface RawWorkspaceResponse {
  data?: {
    organization?: { urlKey?: string | null } | null;
    teams?: { nodes?: Array<RawTeamNode | null> | null } | null;
  } | null;
  errors?: unknown;
}

/**
 * Map the raw GraphQL response → {@link WorkspaceInfo}. Defensive: tolerates
 * null nodes, a missing `urlKey` (slug becomes `""`), and arbitrary shapes.
 * NEVER throws. Returns `null` only when `data` is entirely absent or `errors`
 * are present (so the caller keeps any previously cached info instead of
 * clobbering it with an empty result).
 *
 * `teamKeys` are derived from the team rows: trimmed, uppercased, non-empty,
 * and de-duped while preserving first-seen order.
 *
 * @param json - The parsed JSON body returned by Linear's GraphQL endpoint.
 * @returns The folded workspace identity, or `null` on error/empty data.
 */
export function mapWorkspaceInfo(json: unknown): WorkspaceInfo | null {
  if (typeof json !== "object" || json === null) {
    return null;
  }

  const envelope = json as RawWorkspaceResponse;

  // GraphQL errors or a totally missing data object → treat as "no info" so the
  // caller retains its last good cache rather than wiping detection.
  if (envelope.errors != null) {
    return null;
  }
  if (envelope.data == null) {
    return null;
  }

  const slug = envelope.data.organization?.urlKey ?? "";

  const rawNodes = envelope.data.teams?.nodes ?? [];
  const teams: WorkspaceInfo["teams"] = [];
  const teamKeys: string[] = [];
  const seenKeys = new Set<string>();

  for (const node of rawNodes) {
    if (node == null) {
      continue;
    }
    const key = (node.key ?? "").trim().toUpperCase();
    if (key) {
      teams.push({
        id: node.id ?? "",
        key,
        name: node.name ?? "",
      });
      if (!seenKeys.has(key)) {
        seenKeys.add(key);
        teamKeys.push(key);
      }
    }
  }

  return { slug, teamKeys, teams };
}
