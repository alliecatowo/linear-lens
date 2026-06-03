/**
 * Linear Lens — pure configuration enum normalizers (no `vscode` import).
 *
 * These validators coerce an unknown setting value into a known enum member,
 * defaulting to the first/safe value on bad input. They are PURE so they can be
 * unit-tested in plain Node via vitest without any VS Code mocking — see
 * `test/config.test.ts`. `src/config.ts` re-exports these for `getConfig()`.
 */

import { GroupByName, OpenInTool, SortByName, WorktreeFilterMode } from "./types";

/** The valid `linearLens.view.defaultGroupBy` enum values. */
const GROUP_BY_VALUES: readonly GroupByName[] = [
  "none",
  "status",
  "assignee",
  "priority",
  "project",
  "label",
];

/** The valid `linearLens.view.defaultSortBy` enum values. */
const SORT_BY_VALUES: readonly SortByName[] = [
  "updated",
  "priority",
  "status",
  "created",
  "title",
  "number",
];

/** The valid `linearLens.worktree.filter` enum values. */
const WORKTREE_FILTER_VALUES: readonly WorktreeFilterMode[] = [
  "off",
  "currentRepo",
  "currentWorktree",
];

/** The valid `linearLens.openIn.tool` enum values. */
const OPEN_IN_TOOL_VALUES: readonly OpenInTool[] = [
  "auto",
  "vscode",
  "cursor",
  "linear",
  "custom",
];

/**
 * Validate an unknown value against the group-by enum, defaulting to `"none"`.
 * Exported for direct unit testing without mocking VS Code.
 */
export function normalizeGroupBy(value: unknown): GroupByName {
  return typeof value === "string" && (GROUP_BY_VALUES as readonly string[]).includes(value)
    ? (value as GroupByName)
    : "none";
}

/**
 * Validate an unknown value against the sort-by enum, defaulting to `"updated"`.
 * Exported for direct unit testing without mocking VS Code.
 */
export function normalizeSortBy(value: unknown): SortByName {
  return typeof value === "string" && (SORT_BY_VALUES as readonly string[]).includes(value)
    ? (value as SortByName)
    : "updated";
}

/**
 * Validate an unknown value against the worktree-filter enum, defaulting to `"off"`.
 * Exported for direct unit testing without mocking VS Code.
 */
export function normalizeWorktreeFilter(value: unknown): WorktreeFilterMode {
  return typeof value === "string" &&
    (WORKTREE_FILTER_VALUES as readonly string[]).includes(value)
    ? (value as WorktreeFilterMode)
    : "off";
}

/**
 * Validate an unknown value against the open-in-tool enum, defaulting to `"auto"`.
 * Exported for direct unit testing without mocking VS Code.
 */
export function normalizeOpenInTool(value: unknown): OpenInTool {
  return typeof value === "string" &&
    (OPEN_IN_TOOL_VALUES as readonly string[]).includes(value)
    ? (value as OpenInTool)
    : "auto";
}
