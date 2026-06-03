/**
 * Linear Lens — pure blocker-flow helpers (`vscode`-free).
 *
 * Maps an {@link IssueEditContext} blocker shape into display rows for the
 * "Edit Blockers" quick-pick, and computes the exact
 * {@link addRelation} input for adding a new "blocks" relation in either
 * direction.
 *
 * This module MUST NOT import `vscode`. It is fully unit-testable in plain
 * Node/vitest with no mocking beyond data fixtures.
 */

import type { IssueRelation } from "../types";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * A flat row describing one existing blocker relation — used to populate the
 * "Edit Blockers" quick-pick. Each row carries enough data to remove the
 * relation ({@link relationId}) and to identify the other issue.
 */
export interface BlockerRow {
  /** The relation's id, passed to {@link LinearClient.removeRelation}. */
  readonly relationId: string;
  /** Whether THIS issue blocks the other, or the other blocks THIS issue. */
  readonly direction: "blocks" | "blockedBy";
  /**
   * Human-readable quick-pick label, e.g.
   * `"Blocks ENG-200 — Fix the login bug"` or
   * `"Blocked by ENG-50 — Upgrade auth lib"`.
   */
  readonly label: string;
  /** Normalized identifier of the OTHER issue, e.g. `"ENG-200"`. */
  readonly relatedIdentifier: string;
}

// ---------------------------------------------------------------------------
// blockerRows
// ---------------------------------------------------------------------------

/**
 * Flatten the `blocks` and `blockedBy` relation arrays from the issue edit
 * context into a list of {@link BlockerRow}s suitable for a VS Code
 * QuickPick. Relations in `blocks` appear before those in `blockedBy`; both
 * groups preserve their original order.
 *
 * Pure; never throws. Returns `[]` when both arrays are empty.
 *
 * @param view - The subset of {@link IssueEditContext} that holds the
 *   relation arrays.
 * @returns One {@link BlockerRow} per relation.
 */
export function blockerRows(view: {
  blocks: IssueRelation[];
  blockedBy: IssueRelation[];
}): BlockerRow[] {
  const rows: BlockerRow[] = [];

  for (const rel of view.blocks) {
    const identifier = rel.relatedIssue.identifier;
    const title = rel.relatedIssue.title;
    rows.push({
      relationId: rel.id,
      direction: "blocks",
      label: `Blocks ${identifier}${title ? ` — ${title}` : ""}`,
      relatedIdentifier: identifier,
    });
  }

  for (const rel of view.blockedBy) {
    const identifier = rel.relatedIssue.identifier;
    const title = rel.relatedIssue.title;
    rows.push({
      relationId: rel.id,
      direction: "blockedBy",
      label: `Blocked by ${identifier}${title ? ` — ${title}` : ""}`,
      relatedIdentifier: identifier,
    });
  }

  return rows;
}

// ---------------------------------------------------------------------------
// addBlockerInput
// ---------------------------------------------------------------------------

/**
 * Map an "add blocker" choice into an {@link addRelation} input bag.
 *
 * Linear's `IssueRelationType` enum has EXACTLY `{ blocks, duplicate, related,
 * similar }` — there is NO `blocked_by`. "A is blocked by B" is therefore
 * modeled as **B blocks A**:
 *
 * ```
 * direction "blocks":    issueId=thisUuid  blocks relatedIssueId=otherUuid
 * direction "blockedBy": issueId=otherUuid blocks relatedIssueId=thisUuid
 * ```
 *
 * Pure; never throws.
 *
 * @param direction - Which end of the "blocks" edge THIS issue sits on.
 * @param thisUuid  - Linear's internal UUID of THIS issue.
 * @param otherUuid - Linear's internal UUID of the OTHER (related) issue.
 * @returns The exact input to pass to {@link LinearClient.addRelation}.
 */
export function addBlockerInput(
  direction: "blocks" | "blockedBy",
  thisUuid: string,
  otherUuid: string,
): { issueId: string; relatedIssueId: string; type: "blocks" } {
  if (direction === "blocks") {
    // This issue blocks the other.
    return { issueId: thisUuid, relatedIssueId: otherUuid, type: "blocks" };
  }
  // The other issue blocks this one: model as otherUuid blocks thisUuid.
  return { issueId: otherUuid, relatedIssueId: thisUuid, type: "blocks" };
}
