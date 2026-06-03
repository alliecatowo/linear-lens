/**
 * Unit tests for `src/git/worktree.ts`.
 *
 * All tested functions are pure (no `vscode` import) and can run in plain Node
 * via vitest without any VS Code mocking.
 */

import { describe, expect, it } from "vitest";
import {
  issueIdFromBranch,
  worktreeRelevance,
  type GitContext,
} from "../src/git/worktree";
import type { IssueListItem } from "../src/types";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeIssue(id: string): IssueListItem {
  return {
    id,
    title: `Issue ${id}`,
    state: "In Progress",
    url: `https://linear.app/test/issue/${id}`,
  };
}

// ---------------------------------------------------------------------------
// issueIdFromBranch
// ---------------------------------------------------------------------------

describe("issueIdFromBranch", () => {
  it("parses a typical Linear branch name", () => {
    expect(issueIdFromBranch("jane/eng-123-fix-auth", [])).toBe("ENG-123");
  });

  it("normalizes to uppercase", () => {
    expect(issueIdFromBranch("feat/abc-99-cool-feature", [])).toBe("ABC-99");
  });

  it("returns undefined when no id is found", () => {
    expect(issueIdFromBranch("main", [])).toBeUndefined();
    expect(issueIdFromBranch("feature/no-issue-here", [])).toBeUndefined();
  });

  it("returns undefined for undefined branch", () => {
    expect(issueIdFromBranch(undefined, [])).toBeUndefined();
  });

  it("respects teamKeys allowlist — matches known key", () => {
    expect(issueIdFromBranch("jane/eng-123-feature", ["ENG"])).toBe("ENG-123");
  });

  it("respects teamKeys allowlist — rejects unknown key", () => {
    expect(issueIdFromBranch("jane/xyz-456-feature", ["ENG"])).toBeUndefined();
  });

  it("handles branch name with multiple id-shaped tokens (returns first)", () => {
    // "abc-1" comes before "eng-99"; first match wins.
    const result = issueIdFromBranch("abc-1-then-eng-99", []);
    expect(result).toBe("ABC-1");
  });
});

// ---------------------------------------------------------------------------
// worktreeRelevance — "off" mode
// ---------------------------------------------------------------------------

describe("worktreeRelevance — off", () => {
  const ctx: GitContext = { currentBranch: "jane/eng-123-auth", branchIssueId: "ENG-123" };

  it("always returns keep:true, emphasize:false", () => {
    expect(worktreeRelevance(makeIssue("ENG-123"), "off", ctx)).toEqual({
      keep: true,
      emphasize: false,
    });
    expect(worktreeRelevance(makeIssue("ENG-456"), "off", ctx)).toEqual({
      keep: true,
      emphasize: false,
    });
  });

  it("returns keep:true, emphasize:false even with empty context", () => {
    expect(worktreeRelevance(makeIssue("ENG-1"), "off", {})).toEqual({
      keep: true,
      emphasize: false,
    });
  });
});

// ---------------------------------------------------------------------------
// worktreeRelevance — "currentRepo" mode
// ---------------------------------------------------------------------------

describe("worktreeRelevance — currentRepo", () => {
  const ctx: GitContext = {
    currentBranch: "jane/eng-123-auth",
    branchIssueId: "ENG-123",
    worktreeRoot: "/home/jane/projects/myapp",
  };

  it("emphasizes the matching issue", () => {
    expect(worktreeRelevance(makeIssue("ENG-123"), "currentRepo", ctx)).toEqual({
      keep: true,
      emphasize: true,
    });
  });

  it("does not emphasize non-matching issues but keeps them", () => {
    expect(worktreeRelevance(makeIssue("ENG-456"), "currentRepo", ctx)).toEqual({
      keep: true,
      emphasize: false,
    });
  });

  it("is case-insensitive for the id match", () => {
    const ctxLower: GitContext = { branchIssueId: "eng-123" };
    expect(worktreeRelevance(makeIssue("ENG-123"), "currentRepo", ctxLower)).toEqual({
      keep: true,
      emphasize: true,
    });
  });

  it("returns keep:true, emphasize:false when branchIssueId is undefined", () => {
    expect(worktreeRelevance(makeIssue("ENG-123"), "currentRepo", {})).toEqual({
      keep: true,
      emphasize: false,
    });
  });

  it("returns keep:true, emphasize:false when branchIssueId is empty string", () => {
    expect(worktreeRelevance(makeIssue("ENG-123"), "currentRepo", { branchIssueId: "" })).toEqual({
      keep: true,
      emphasize: false,
    });
  });
});

// ---------------------------------------------------------------------------
// worktreeRelevance — "currentWorktree" mode
// ---------------------------------------------------------------------------

describe("worktreeRelevance — currentWorktree", () => {
  const ctx: GitContext = {
    currentBranch: "jane/des-7-redesign",
    branchIssueId: "DES-7",
    worktreeRoot: "/home/jane/projects/myapp/.git/worktrees/design",
  };

  it("emphasizes the matching issue", () => {
    expect(worktreeRelevance(makeIssue("DES-7"), "currentWorktree", ctx)).toEqual({
      keep: true,
      emphasize: true,
    });
  });

  it("does not emphasize non-matching issues but keeps them", () => {
    expect(worktreeRelevance(makeIssue("ENG-99"), "currentWorktree", ctx)).toEqual({
      keep: true,
      emphasize: false,
    });
  });

  it("returns keep:true, emphasize:false when branchIssueId is undefined", () => {
    expect(worktreeRelevance(makeIssue("DES-7"), "currentWorktree", {})).toEqual({
      keep: true,
      emphasize: false,
    });
  });
});
