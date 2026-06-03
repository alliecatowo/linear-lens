/**
 * Tests for the pure blocker-flow helpers in `src/edit/blockerFlow.ts`.
 *
 * These tests exercise:
 *  - `blockerRows`: correct label formatting, direction labels, row count.
 *  - `addBlockerInput`: direction inversion is the critical correctness concern
 *    ("blocked by" reverses the issueId / relatedIssueId pair).
 *
 * No network; no `vscode` import.
 */

import { describe, it, expect } from "vitest";
import { blockerRows, addBlockerInput } from "../src/edit/blockerFlow";
import type { IssueRelation } from "../src/types";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/** Build a minimal {@link IssueRelation} fixture. */
function rel(
  id: string,
  identifier: string,
  title: string,
  type: string = "blocks",
): IssueRelation {
  return {
    id,
    type,
    relatedIssue: {
      id: `uuid-${identifier.toLowerCase()}`,
      identifier,
      title,
      url: `https://linear.app/test/issue/${identifier}`,
    },
  };
}

// ---------------------------------------------------------------------------
// blockerRows
// ---------------------------------------------------------------------------

describe("blockerRows", () => {
  it("returns empty array when both arrays are empty", () => {
    expect(blockerRows({ blocks: [], blockedBy: [] })).toEqual([]);
  });

  it("produces 'Blocks …' labels for relations in blocks[]", () => {
    const rows = blockerRows({
      blocks: [rel("r1", "ENG-200", "Fix the login bug")],
      blockedBy: [],
    });
    expect(rows).toHaveLength(1);
    expect(rows[0].direction).toBe("blocks");
    expect(rows[0].label).toBe("Blocks ENG-200 — Fix the login bug");
    expect(rows[0].relatedIdentifier).toBe("ENG-200");
    expect(rows[0].relationId).toBe("r1");
  });

  it("produces 'Blocked by …' labels for relations in blockedBy[]", () => {
    const rows = blockerRows({
      blocks: [],
      blockedBy: [rel("r2", "ENG-50", "Upgrade auth lib")],
    });
    expect(rows).toHaveLength(1);
    expect(rows[0].direction).toBe("blockedBy");
    expect(rows[0].label).toBe("Blocked by ENG-50 — Upgrade auth lib");
    expect(rows[0].relatedIdentifier).toBe("ENG-50");
    expect(rows[0].relationId).toBe("r2");
  });

  it("blocks rows appear before blockedBy rows", () => {
    const rows = blockerRows({
      blocks: [rel("r1", "ENG-200", "Block target")],
      blockedBy: [rel("r2", "ENG-50", "Blocker source")],
    });
    expect(rows).toHaveLength(2);
    expect(rows[0].direction).toBe("blocks");
    expect(rows[1].direction).toBe("blockedBy");
  });

  it("handles multiple relations in each array, preserving order", () => {
    const rows = blockerRows({
      blocks: [
        rel("r1", "ENG-201", "First block target"),
        rel("r2", "ENG-202", "Second block target"),
      ],
      blockedBy: [
        rel("r3", "ENG-10", "First blocker"),
        rel("r4", "ENG-11", "Second blocker"),
      ],
    });
    expect(rows).toHaveLength(4);
    expect(rows[0].relationId).toBe("r1");
    expect(rows[1].relationId).toBe("r2");
    expect(rows[2].relationId).toBe("r3");
    expect(rows[3].relationId).toBe("r4");
  });

  it("omits the em-dash separator when the title is empty", () => {
    const rows = blockerRows({
      blocks: [rel("r1", "ENG-300", "")],
      blockedBy: [],
    });
    expect(rows[0].label).toBe("Blocks ENG-300");
  });

  it("carries the relation id through correctly", () => {
    const rows = blockerRows({
      blocks: [rel("relation-uuid-abc", "ENG-999", "Some issue")],
      blockedBy: [],
    });
    expect(rows[0].relationId).toBe("relation-uuid-abc");
  });
});

// ---------------------------------------------------------------------------
// addBlockerInput
// ---------------------------------------------------------------------------

describe("addBlockerInput", () => {
  const THIS = "uuid-this-issue";
  const OTHER = "uuid-other-issue";

  it('direction "blocks": this issue is the source (issueId=this, relatedIssueId=other)', () => {
    const input = addBlockerInput("blocks", THIS, OTHER);
    expect(input).toEqual({
      issueId: THIS,
      relatedIssueId: OTHER,
      type: "blocks",
    });
  });

  it('direction "blockedBy": inverts ids so other issue is the source (issueId=other, relatedIssueId=this)', () => {
    // "A is blocked by B" ⟹ "B blocks A" ⟹ issueId=B, relatedIssueId=A
    const input = addBlockerInput("blockedBy", THIS, OTHER);
    expect(input).toEqual({
      issueId: OTHER,
      relatedIssueId: THIS,
      type: "blocks",
    });
  });

  it("type is always 'blocks' (Linear has no blocked_by enum)", () => {
    expect(addBlockerInput("blocks", THIS, OTHER).type).toBe("blocks");
    expect(addBlockerInput("blockedBy", THIS, OTHER).type).toBe("blocks");
  });

  it("round-trips: blocks(A,B) and blockedBy(B,A) produce the same issueId/relatedIssueId pair", () => {
    const A = "uuid-a";
    const B = "uuid-b";

    const blocksAB = addBlockerInput("blocks", A, B);
    const blockedByBA = addBlockerInput("blockedBy", B, A);

    // Both should mean "A blocks B": issueId=A, relatedIssueId=B
    expect(blocksAB.issueId).toBe(A);
    expect(blocksAB.relatedIssueId).toBe(B);
    expect(blockedByBA.issueId).toBe(A);
    expect(blockedByBA.relatedIssueId).toBe(B);
  });
});
