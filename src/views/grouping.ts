/**
 * Linear Lens — pure grouping + sorting helpers for the issue trees.
 *
 * This module is intentionally `vscode`-free so the transform applied to any
 * {@link IssueListItem}[] before display (in the My / Recent / Team / Cycle
 * trees) can be unit-tested in plain Node (vitest). The `TreeDataProvider`
 * classes that consume these helpers import `vscode`; this module never does.
 *
 * The helpers are PURE, STABLE, and NEVER throw. They read the group-by / sort
 * fields off {@link IssueListItem} defensively: the shipped `IssueListItem` does
 * not yet carry every field these helpers can group/sort by (`stateId`,
 * `assigneeId`, `priority`, `project`, `cycle`, `labels`, `number`, …). Those
 * are optional, null-tolerant extensions the list mapper populates over time, so
 * every read here guards for `undefined` and falls back to a stable bucket.
 *
 * See board spec §4 (grouping / sorting).
 */

import { IssueListItem } from "../types";

// ---------------------------------------------------------------------------
// Option types
// ---------------------------------------------------------------------------

/** How issues are grouped under a tree's root (or left flat with `"none"`). */
export type GroupBy = "none" | "status" | "assignee" | "priority" | "project" | "label";

/** The field issues are ordered by within a group (or the flat list). */
export type SortBy = "updated" | "priority" | "status" | "created" | "title" | "number";

/** Sort direction. */
export type SortDir = "asc" | "desc";

/** A sort specification: a field plus a direction. */
export interface IssueSort {
  /** Which field to order by. */
  readonly by: SortBy;
  /** Ascending or descending. */
  readonly dir: SortDir;
}

/** The default grouping/sort applied when a view has no persisted preference. */
export const DEFAULT_SORT: IssueSort = { by: "updated", dir: "desc" };

/**
 * One grouped bucket of issues. Mirrors the `GroupNode.items` shape consumed by
 * the tree's `GroupNode` so a provider can map a bucket straight onto a header
 * node plus its issue children.
 */
export interface IssueGroup<T extends IssueListItem = IssueListItem> {
  /** Stable group key (state id / assignee id / project name / label id / "none"). */
  readonly groupId: string;
  /** Human-readable header label. */
  readonly label: string;
  /** Optional color (state / label color) for the group icon. */
  readonly color?: string;
  /** Workflow state type for status groups, used to tint the group icon. */
  readonly stateType?: string;
  /** The issues under this group, already sorted. */
  readonly items: T[];
}

/**
 * Structural view of the optional group-by / sort fields the list mapper may
 * attach to an {@link IssueListItem}. Read defensively — every field is treated
 * as possibly absent so these helpers compile against the shipped (narrower)
 * `IssueListItem` and tolerate the richer node the team/board queries return.
 */
interface GroupingFields {
  stateId?: string;
  assigneeId?: string;
  assignee?: string;
  priority?: number;
  priorityLabel?: string;
  project?: string;
  projectId?: string;
  cycleNumber?: number;
  number?: number;
  createdAt?: string;
  updatedAt?: string;
  labels?: { id: string; name: string; color?: string }[];
  stateType?: string;
  stateColor?: string;
  state?: string;
  title?: string;
  id?: string;
}

/** Reinterpret an item through the optional-field lens without an `any` cast. */
function fields(item: IssueListItem): GroupingFields {
  return item as GroupingFields;
}

/** The stable label for the catch-all bucket (unassigned / no project / …). */
const NONE_LABEL = "None";

/** The stable group id for the catch-all bucket. */
const NONE_ID = "none";

// ---------------------------------------------------------------------------
// Sorting
// ---------------------------------------------------------------------------

/**
 * Map a priority value to its sort rank. Linear priority is `0` = No priority,
 * `1` = Urgent … `4` = Low, so a naive numeric sort buries Urgent and floats
 * "No priority". This remaps to a severity rank where Urgent is highest and
 * "No priority" is always lowest, so a `desc` sort lists Urgent first and
 * no-priority last regardless of direction-by-number quirks.
 */
function priorityRank(priority: number | undefined): number {
  // 1 Urgent → 4, 2 High → 3, 3 Normal → 2, 4 Low → 1, 0/none → 0.
  if (typeof priority !== "number" || !Number.isFinite(priority) || priority <= 0) {
    return 0;
  }
  if (priority >= 5) {
    return 0;
  }
  return 5 - priority;
}

/** Compare two ISO-8601 timestamps; missing values sort as the oldest. */
function compareTimes(a: string | undefined, b: string | undefined): number {
  const ta = a ? Date.parse(a) : NaN;
  const tb = b ? Date.parse(b) : NaN;
  const va = Number.isNaN(ta) ? -Infinity : ta;
  const vb = Number.isNaN(tb) ? -Infinity : tb;
  return va === vb ? 0 : va < vb ? -1 : 1;
}

/** Case-insensitive string compare with a stable tiebreak on raw value. */
function compareStrings(a: string, b: string): number {
  const la = a.toLocaleLowerCase();
  const lb = b.toLocaleLowerCase();
  if (la < lb) {
    return -1;
  }
  if (la > lb) {
    return 1;
  }
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * The ascending comparison for a given {@link SortBy}, before direction is
 * applied. Returns a negative / zero / positive number per `Array#sort`.
 */
function compareBy(a: IssueListItem, b: IssueListItem, by: SortBy): number {
  const fa = fields(a);
  const fb = fields(b);
  switch (by) {
    case "priority":
      return priorityRank(fa.priority) - priorityRank(fb.priority);
    case "status":
      return compareStrings(a.state ?? "", b.state ?? "");
    case "title":
      return compareStrings(a.title ?? "", b.title ?? "");
    case "number": {
      const na = typeof fa.number === "number" ? fa.number : Number.NaN;
      const nb = typeof fb.number === "number" ? fb.number : Number.NaN;
      const va = Number.isNaN(na) ? -Infinity : na;
      const vb = Number.isNaN(nb) ? -Infinity : nb;
      return va - vb;
    }
    case "created":
      return compareTimes(fa.createdAt, fb.createdAt);
    case "updated":
    default:
      return compareTimes(a.updatedAt, b.updatedAt);
  }
}

/** Stable tiebreak so equal primary keys keep a deterministic order. */
function tiebreak(a: IssueListItem, b: IssueListItem): number {
  const fa = fields(a);
  const fb = fields(b);
  if (typeof fa.number === "number" && typeof fb.number === "number" && fa.number !== fb.number) {
    return fa.number - fb.number;
  }
  return compareStrings(a.id ?? "", b.id ?? "");
}

/**
 * Compare two issues per a {@link IssueSort}. Pure, total, and stable: the
 * primary comparison is by the chosen field (direction applied), with a
 * deterministic tiebreak by issue number then id so the order never wobbles.
 *
 * @param a    The first issue.
 * @param b    The second issue.
 * @param sort The active sort field + direction.
 * @returns    A negative / zero / positive number suitable for `Array#sort`.
 */
export function compareIssues(a: IssueListItem, b: IssueListItem, sort: IssueSort): number {
  const primary = compareBy(a, b, sort.by);
  const directed = sort.dir === "asc" ? primary : -primary;
  if (directed !== 0) {
    return directed;
  }
  return tiebreak(a, b);
}

/**
 * Return a new, sorted copy of `items` per `sort`. Does not mutate the input.
 * Never throws.
 *
 * @param items The issues to sort.
 * @param sort  The active sort field + direction.
 * @returns     A new array sorted per `sort`.
 */
export function sortIssues<T extends IssueListItem>(items: T[], sort: IssueSort): T[] {
  return [...items].sort((a, b) => compareIssues(a, b, sort));
}

// ---------------------------------------------------------------------------
// Grouping
// ---------------------------------------------------------------------------

/**
 * The bucket key + presentation for an item under a non-label grouping. Label
 * grouping is handled separately because one issue may appear under many labels.
 */
function singleBucket(
  item: IssueListItem,
  groupBy: Exclude<GroupBy, "none" | "label">,
): { groupId: string; label: string; color?: string; stateType?: string } {
  const f = fields(item);
  switch (groupBy) {
    case "status": {
      const groupId = f.stateId ?? item.state ?? NONE_ID;
      return {
        groupId: groupId || NONE_ID,
        label: item.state || "No status",
        color: item.stateColor,
        stateType: item.stateType,
      };
    }
    case "assignee": {
      const name = item.assignee;
      if (!name) {
        return { groupId: NONE_ID, label: "Unassigned" };
      }
      return { groupId: f.assigneeId ?? name, label: name };
    }
    case "priority": {
      const rank = priorityRank(f.priority);
      if (rank === 0) {
        return { groupId: "priority:0", label: f.priorityLabel || "No priority" };
      }
      return { groupId: `priority:${f.priority}`, label: f.priorityLabel || `Priority ${f.priority}` };
    }
    case "project": {
      const name = f.project;
      if (!name) {
        return { groupId: NONE_ID, label: "No project" };
      }
      return { groupId: f.projectId ?? name, label: name };
    }
  }
}

/**
 * Group `items` by `groupBy`, preserving first-seen bucket order. Each bucket's
 * `items` keep the order they appear in the input (callers sort first, then
 * group, so buckets inherit the sorted order). Pure; never throws.
 *
 * Behavior:
 *  - `groupBy: "none"` → a single bucket holding every item (callers usually
 *    skip grouping entirely; this keeps the function total).
 *  - `status` buckets carry `color` + `stateType` so the header icon is tinted.
 *  - `assignee` / `project` collapse missing values into a stable "None" bucket.
 *  - `priority` buckets are keyed by the numeric priority (No priority last when
 *    the caller sorted by priority desc).
 *  - `label` is multi-valued: an issue with N labels appears under N buckets; an
 *    unlabeled issue lands in the "No label" bucket.
 *  - Empty input → `[]`.
 *
 * @param items   The (typically already-sorted) issues to group.
 * @param groupBy The grouping dimension.
 * @returns       The buckets in first-seen order.
 */
export function groupIssues<T extends IssueListItem>(
  items: T[],
  groupBy: GroupBy,
): IssueGroup<T>[] {
  if (items.length === 0) {
    return [];
  }
  if (groupBy === "none") {
    return [{ groupId: NONE_ID, label: NONE_LABEL, items: [...items] }];
  }

  const order: string[] = [];
  const byKey = new Map<string, { meta: Omit<IssueGroup<T>, "items">; items: T[] }>();

  const push = (
    meta: { groupId: string; label: string; color?: string; stateType?: string },
    item: T,
  ): void => {
    let bucket = byKey.get(meta.groupId);
    if (!bucket) {
      bucket = { meta, items: [] };
      byKey.set(meta.groupId, bucket);
      order.push(meta.groupId);
    }
    bucket.items.push(item);
  };

  for (const item of items) {
    if (groupBy === "label") {
      const labels = fields(item).labels;
      if (!labels || labels.length === 0) {
        push({ groupId: "label:none", label: "No label" }, item);
        continue;
      }
      for (const label of labels) {
        const id = label?.id || label?.name || "label:none";
        push({ groupId: `label:${id}`, label: label?.name || "Label", color: label?.color }, item);
      }
      continue;
    }
    push(singleBucket(item, groupBy), item);
  }

  return order.map((key) => {
    const bucket = byKey.get(key)!;
    const group: IssueGroup<T> = {
      groupId: bucket.meta.groupId,
      label: bucket.meta.label,
      items: bucket.items,
    };
    return bucket.meta.color !== undefined || bucket.meta.stateType !== undefined
      ? { ...group, color: bucket.meta.color, stateType: bucket.meta.stateType }
      : group;
  });
}

// ---------------------------------------------------------------------------
// Combined transform
// ---------------------------------------------------------------------------

/** The result of {@link applyGrouping}: either a flat sorted list or buckets. */
export type GroupedResult<T extends IssueListItem = IssueListItem> =
  | { readonly grouped: false; readonly items: T[] }
  | { readonly grouped: true; readonly groups: IssueGroup<T>[] };

/**
 * Sort then (optionally) group `items` for tree display. The trees call this in
 * `getChildren`: when `groupBy` is `"none"` they render the flat `items` as
 * issue nodes; otherwise they render each {@link IssueGroup} as a group header
 * whose children are its (already-sorted) `items`. Pure; stable; never throws.
 *
 * @param items   The issues to transform.
 * @param groupBy The grouping dimension (`"none"` for a flat list).
 * @param sort    The active sort field + direction.
 * @returns       A discriminated flat-or-grouped result.
 */
export function applyGrouping<T extends IssueListItem>(
  items: T[],
  groupBy: GroupBy,
  sort: IssueSort,
): GroupedResult<T> {
  const sorted = sortIssues(items, sort);
  if (groupBy === "none") {
    return { grouped: false, items: sorted };
  }
  return { grouped: true, groups: groupIssues(sorted, groupBy) };
}
