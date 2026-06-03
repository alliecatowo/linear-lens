/**
 * Linear Lens — worktree filtering (pure, no `vscode` import).
 *
 * Provides best-effort, heuristic helpers that relate Linear issues to the
 * current git checkout context. Decision logic is PURE so it can be unit-tested
 * in plain Node via vitest without any VS Code mocking.
 *
 * The filtering behavior is SORT-emphasis (not a hard hide): `worktreeRelevance`
 * returns `{ keep, emphasize }` and callers sort `emphasize === true` items to
 * the top rather than dropping non-matches. This prevents silent loss of issues.
 * A future `worktree.hardFilter` boolean can be added if requested.
 */

import type { IssueListItem, WorktreeFilterMode } from "../types";
import { issueIdFromBranch as parseIdFromBranch } from "../parser";

export type { WorktreeFilterMode };

// ---------------------------------------------------------------------------
// GitContext — gathered by the host (vscode/git), passed in as a plain object
// ---------------------------------------------------------------------------

/** Context about the current git checkout, gathered by the host (vscode/git). */
export interface GitContext {
  /** Current branch name in the active repo/worktree, if any. */
  readonly currentBranch?: string;
  /** The issue id parsed from the current branch (e.g. "ENG-123"), if any. */
  readonly branchIssueId?: string;
  /** Root path of the active worktree/repo, for de-dup/labeling. */
  readonly worktreeRoot?: string;
}

// ---------------------------------------------------------------------------
// issueIdFromBranch — pure wrapper for testing
// ---------------------------------------------------------------------------

/**
 * Parse an issue id from a git branch name.
 *
 * Delegates to {@link parseIdFromBranch} from `src/parser.ts`. `teamKeys` is
 * optional; when empty/undefined, any `ABC-123`-shaped token is recognized.
 * Returns the normalized id (e.g. `"ENG-123"`) or `undefined` when no match
 * is found.
 *
 * @param branch    Branch name, e.g. `"jane/eng-123-fix-auth"`. May be `undefined`.
 * @param teamKeys  Optional team-key allowlist for narrowing recognition.
 */
export function issueIdFromBranch(
  branch: string | undefined,
  teamKeys: string[],
): string | undefined {
  if (!branch) {
    return undefined;
  }
  const result = parseIdFromBranch(branch, { teamKeys: teamKeys.length > 0 ? teamKeys : undefined });
  return result?.normalized ?? undefined;
}

// ---------------------------------------------------------------------------
// worktreeRelevance — the core filtering decision
// ---------------------------------------------------------------------------

/** Result of a worktree-relevance check for a single issue. */
export interface WorktreeRelevance {
  /**
   * Whether the issue should be shown at all.
   * Always `true` in the current implementation — callers sort, not hide.
   * Reserved for a future `worktree.hardFilter` mode.
   */
  keep: boolean;
  /**
   * Whether the issue should be sorted to the top of the list.
   * `true` when the mode is not `"off"` AND the issue's id matches the
   * `branchIssueId` in the current git context.
   */
  emphasize: boolean;
}

/**
 * Decide whether an issue should be emphasized/kept given the worktree filter
 * mode and current git context. PURE — no side effects, no `vscode` import.
 *
 * Behavior:
 * - `"off"` → `{ keep: true, emphasize: false }` always.
 * - `"currentRepo"` or `"currentWorktree"` → `emphasize: true` when the
 *   issue's id matches `ctx.branchIssueId`; `keep: true` in all cases (we
 *   sort-to-top rather than hide).
 *
 * @param item  The issue to evaluate.
 * @param mode  The configured worktree filter mode.
 * @param ctx   The current git context populated by the host.
 */
export function worktreeRelevance(
  item: IssueListItem,
  mode: WorktreeFilterMode,
  ctx: GitContext,
): WorktreeRelevance {
  if (mode === "off") {
    return { keep: true, emphasize: false };
  }

  // Both "currentRepo" and "currentWorktree" emphasize the branch-matched issue.
  const branchId = ctx.branchIssueId;
  const emphasize =
    typeof branchId === "string" &&
    branchId.length > 0 &&
    item.id.toUpperCase() === branchId.toUpperCase();

  return { keep: true, emphasize };
}
