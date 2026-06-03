/**
 * Unit tests for the pure normalizer functions exported from `src/config.ts`.
 *
 * These tests call the normalizers directly — no VS Code mocking needed because
 * the normalizers are free of any `vscode` import.
 */

import { describe, expect, it } from "vitest";
import {
  normalizeGroupBy,
  normalizeOpenInTool,
  normalizeSortBy,
  normalizeWorktreeFilter,
} from "../src/configNormalizers";

// ---------------------------------------------------------------------------
// normalizeGroupBy
// ---------------------------------------------------------------------------

describe("normalizeGroupBy", () => {
  it("returns valid values as-is", () => {
    expect(normalizeGroupBy("none")).toBe("none");
    expect(normalizeGroupBy("status")).toBe("status");
    expect(normalizeGroupBy("assignee")).toBe("assignee");
    expect(normalizeGroupBy("priority")).toBe("priority");
    expect(normalizeGroupBy("project")).toBe("project");
    expect(normalizeGroupBy("label")).toBe("label");
  });

  it("defaults to 'none' for unknown strings", () => {
    expect(normalizeGroupBy("unknown")).toBe("none");
    expect(normalizeGroupBy("NONE")).toBe("none");
    expect(normalizeGroupBy("Status")).toBe("none");
  });

  it("defaults to 'none' for non-strings", () => {
    expect(normalizeGroupBy(undefined)).toBe("none");
    expect(normalizeGroupBy(null)).toBe("none");
    expect(normalizeGroupBy(42)).toBe("none");
    expect(normalizeGroupBy(true)).toBe("none");
  });
});

// ---------------------------------------------------------------------------
// normalizeSortBy
// ---------------------------------------------------------------------------

describe("normalizeSortBy", () => {
  it("returns valid values as-is", () => {
    expect(normalizeSortBy("updated")).toBe("updated");
    expect(normalizeSortBy("priority")).toBe("priority");
    expect(normalizeSortBy("status")).toBe("status");
    expect(normalizeSortBy("created")).toBe("created");
    expect(normalizeSortBy("title")).toBe("title");
    expect(normalizeSortBy("number")).toBe("number");
  });

  it("defaults to 'updated' for unknown strings", () => {
    expect(normalizeSortBy("latest")).toBe("updated");
    expect(normalizeSortBy("Updated")).toBe("updated");
  });

  it("defaults to 'updated' for non-strings", () => {
    expect(normalizeSortBy(undefined)).toBe("updated");
    expect(normalizeSortBy(null)).toBe("updated");
    expect(normalizeSortBy(0)).toBe("updated");
  });
});

// ---------------------------------------------------------------------------
// normalizeWorktreeFilter
// ---------------------------------------------------------------------------

describe("normalizeWorktreeFilter", () => {
  it("returns valid enum values as-is", () => {
    expect(normalizeWorktreeFilter("off")).toBe("off");
    expect(normalizeWorktreeFilter("currentRepo")).toBe("currentRepo");
    expect(normalizeWorktreeFilter("currentWorktree")).toBe("currentWorktree");
  });

  it("defaults to 'off' for unknown strings", () => {
    expect(normalizeWorktreeFilter("repo")).toBe("off");
    expect(normalizeWorktreeFilter("CurrentRepo")).toBe("off");
    expect(normalizeWorktreeFilter("worktree")).toBe("off");
  });

  it("defaults to 'off' for non-strings", () => {
    expect(normalizeWorktreeFilter(undefined)).toBe("off");
    expect(normalizeWorktreeFilter(null)).toBe("off");
    expect(normalizeWorktreeFilter(false)).toBe("off");
    expect(normalizeWorktreeFilter(1)).toBe("off");
  });
});

// ---------------------------------------------------------------------------
// normalizeOpenInTool
// ---------------------------------------------------------------------------

describe("normalizeOpenInTool", () => {
  it("returns valid enum values as-is", () => {
    expect(normalizeOpenInTool("auto")).toBe("auto");
    expect(normalizeOpenInTool("vscode")).toBe("vscode");
    expect(normalizeOpenInTool("cursor")).toBe("cursor");
    expect(normalizeOpenInTool("linear")).toBe("linear");
    expect(normalizeOpenInTool("custom")).toBe("custom");
  });

  it("defaults to 'auto' for unknown strings", () => {
    expect(normalizeOpenInTool("editor")).toBe("auto");
    expect(normalizeOpenInTool("VSCode")).toBe("auto");
    expect(normalizeOpenInTool("CURSOR")).toBe("auto");
  });

  it("defaults to 'auto' for non-strings", () => {
    expect(normalizeOpenInTool(undefined)).toBe("auto");
    expect(normalizeOpenInTool(null)).toBe("auto");
    expect(normalizeOpenInTool(true)).toBe("auto");
    expect(normalizeOpenInTool(0)).toBe("auto");
  });
});
