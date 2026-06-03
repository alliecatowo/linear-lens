import { describe, it, expect } from "vitest";
import {
  applyGrouping,
  compareIssues,
  groupIssues,
  sortIssues,
  type GroupBy,
  type IssueSort,
} from "../src/views/grouping";
import type { IssueListItem } from "../src/types";

/**
 * The grouping helpers read fields that the shipped {@link IssueListItem} does
 * not yet declare (`stateId`, `assigneeId`, `priority`, `project`, `labels`,
 * `number`, `createdAt`). They are populated by the team/board list mapper. We
 * build test fixtures with those extra fields via a permissive factory so the
 * tests exercise the real (defensive) grouping logic.
 */
type RichIssue = IssueListItem & {
  stateId?: string;
  assigneeId?: string;
  priority?: number;
  priorityLabel?: string;
  project?: string;
  projectId?: string;
  number?: number;
  createdAt?: string;
  labels?: { id: string; name: string; color?: string }[];
};

function issue(over: Partial<RichIssue> & { id: string }): RichIssue {
  return {
    title: over.title ?? `Title ${over.id}`,
    state: over.state ?? "Todo",
    url: over.url ?? `https://linear.app/x/issue/${over.id}`,
    ...over,
  };
}

const ASC: IssueSort = { by: "title", dir: "asc" };

describe("compareIssues / sortIssues", () => {
  it("sorts by title case-insensitively", () => {
    const items = [issue({ id: "A", title: "banana" }), issue({ id: "B", title: "Apple" })];
    const sorted = sortIssues(items, ASC);
    expect(sorted.map((i) => i.title)).toEqual(["Apple", "banana"]);
  });

  it("respects sort direction", () => {
    const items = [issue({ id: "A", title: "a" }), issue({ id: "B", title: "b" })];
    expect(sortIssues(items, { by: "title", dir: "desc" }).map((i) => i.id)).toEqual(["B", "A"]);
  });

  it("priority desc lists Urgent first and No priority last", () => {
    const items = [
      issue({ id: "NONE", priority: 0 }),
      issue({ id: "LOW", priority: 4 }),
      issue({ id: "URGENT", priority: 1 }),
      issue({ id: "HIGH", priority: 2 }),
    ];
    const sorted = sortIssues(items, { by: "priority", dir: "desc" });
    expect(sorted.map((i) => i.id)).toEqual(["URGENT", "HIGH", "LOW", "NONE"]);
  });

  it("priority asc lists No priority first then Low..Urgent", () => {
    const items = [
      issue({ id: "URGENT", priority: 1 }),
      issue({ id: "NONE", priority: 0 }),
      issue({ id: "LOW", priority: 4 }),
    ];
    const sorted = sortIssues(items, { by: "priority", dir: "asc" });
    expect(sorted.map((i) => i.id)).toEqual(["NONE", "LOW", "URGENT"]);
  });

  it("sorts by updatedAt with missing timestamps treated as oldest", () => {
    const items = [
      issue({ id: "OLD", updatedAt: "2020-01-01T00:00:00.000Z" }),
      issue({ id: "MISSING" }),
      issue({ id: "NEW", updatedAt: "2024-01-01T00:00:00.000Z" }),
    ];
    const desc = sortIssues(items, { by: "updated", dir: "desc" });
    expect(desc.map((i) => i.id)).toEqual(["NEW", "OLD", "MISSING"]);
  });

  it("sorts by number numerically", () => {
    const items = [
      issue({ id: "X-10", number: 10 }),
      issue({ id: "X-2", number: 2 }),
      issue({ id: "X-100", number: 100 }),
    ];
    expect(sortIssues(items, { by: "number", dir: "asc" }).map((i) => i.number)).toEqual([
      2, 10, 100,
    ]);
  });

  it("is stable: equal primary keys break ties by number then id", () => {
    const items = [
      issue({ id: "X-3", title: "same", number: 3 }),
      issue({ id: "X-1", title: "same", number: 1 }),
      issue({ id: "X-2", title: "same", number: 2 }),
    ];
    expect(sortIssues(items, { by: "title", dir: "asc" }).map((i) => i.number)).toEqual([1, 2, 3]);
  });

  it("does not mutate its input", () => {
    const items = [issue({ id: "B", title: "b" }), issue({ id: "A", title: "a" })];
    const snapshot = items.map((i) => i.id);
    sortIssues(items, ASC);
    expect(items.map((i) => i.id)).toEqual(snapshot);
  });

  it("compareIssues returns a stable ordering relation", () => {
    const a = issue({ id: "A", title: "a" });
    const b = issue({ id: "B", title: "b" });
    expect(compareIssues(a, b, ASC)).toBeLessThan(0);
    expect(compareIssues(b, a, ASC)).toBeGreaterThan(0);
    expect(compareIssues(a, a, ASC)).toBe(0);
  });
});

describe("groupIssues", () => {
  it("returns [] for empty input", () => {
    expect(groupIssues([], "status")).toEqual([]);
  });

  it("groups by status carrying color + stateType", () => {
    const items = [
      issue({ id: "A", stateId: "s1", state: "In Progress", stateType: "started", stateColor: "#fc0" }),
      issue({ id: "B", stateId: "s1", state: "In Progress", stateType: "started", stateColor: "#fc0" }),
      issue({ id: "C", stateId: "s2", state: "Done", stateType: "completed", stateColor: "#0c0" }),
    ];
    const groups = groupIssues(items, "status");
    expect(groups).toHaveLength(2);
    expect(groups[0]).toMatchObject({ groupId: "s1", label: "In Progress", stateType: "started", color: "#fc0" });
    expect(groups[0].items.map((i) => i.id)).toEqual(["A", "B"]);
    expect(groups[1]).toMatchObject({ groupId: "s2", label: "Done", stateType: "completed" });
  });

  it("groups by assignee with an Unassigned bucket", () => {
    const items = [
      issue({ id: "A", assignee: "Alice", assigneeId: "u1" }),
      issue({ id: "B" }),
      issue({ id: "C", assignee: "Alice", assigneeId: "u1" }),
    ];
    const groups = groupIssues(items, "assignee");
    expect(groups.map((g) => g.label)).toEqual(["Alice", "Unassigned"]);
    expect(groups[0].groupId).toBe("u1");
    expect(groups[1].groupId).toBe("none");
    expect(groups[1].items.map((i) => i.id)).toEqual(["B"]);
  });

  it("groups by project with a No project bucket", () => {
    const items = [
      issue({ id: "A", project: "Apollo", projectId: "p1" }),
      issue({ id: "B" }),
    ];
    const groups = groupIssues(items, "project");
    expect(groups.map((g) => g.label)).toEqual(["Apollo", "No project"]);
  });

  it("groups by priority keyed by numeric priority", () => {
    const items = [
      issue({ id: "A", priority: 1, priorityLabel: "Urgent" }),
      issue({ id: "B", priority: 0 }),
      issue({ id: "C", priority: 1, priorityLabel: "Urgent" }),
    ];
    const groups = groupIssues(items, "priority");
    const byKey = new Map(groups.map((g) => [g.groupId, g]));
    expect(byKey.get("priority:1")?.items.map((i) => i.id)).toEqual(["A", "C"]);
    expect(byKey.get("priority:0")?.label).toBe("No priority");
  });

  it("groups by label placing multi-labeled issues in each bucket", () => {
    const items = [
      issue({ id: "A", labels: [{ id: "l1", name: "bug" }, { id: "l2", name: "ui" }] }),
      issue({ id: "B", labels: [{ id: "l1", name: "bug" }] }),
      issue({ id: "C" }),
    ];
    const groups = groupIssues(items, "label");
    const byKey = new Map(groups.map((g) => [g.label, g]));
    expect(byKey.get("bug")?.items.map((i) => i.id)).toEqual(["A", "B"]);
    expect(byKey.get("ui")?.items.map((i) => i.id)).toEqual(["A"]);
    expect(byKey.get("No label")?.items.map((i) => i.id)).toEqual(["C"]);
  });

  it("preserves first-seen bucket order", () => {
    const items = [
      issue({ id: "A", stateId: "s2", state: "Done" }),
      issue({ id: "B", stateId: "s1", state: "Todo" }),
    ];
    expect(groupIssues(items, "status").map((g) => g.groupId)).toEqual(["s2", "s1"]);
  });

  it("treats groupBy none as a single all-items bucket", () => {
    const items = [issue({ id: "A" }), issue({ id: "B" })];
    const groups = groupIssues(items, "none");
    expect(groups).toHaveLength(1);
    expect(groups[0].items).toHaveLength(2);
  });
});

describe("applyGrouping", () => {
  it("returns a flat sorted list for groupBy none", () => {
    const items = [issue({ id: "B", title: "b" }), issue({ id: "A", title: "a" })];
    const result = applyGrouping(items, "none", ASC);
    expect(result.grouped).toBe(false);
    if (!result.grouped) {
      expect(result.items.map((i) => i.id)).toEqual(["A", "B"]);
    }
  });

  it("sorts BEFORE grouping so buckets inherit the sorted order", () => {
    const items = [
      issue({ id: "X-3", state: "Todo", stateId: "s1", number: 3 }),
      issue({ id: "X-1", state: "Todo", stateId: "s1", number: 1 }),
      issue({ id: "X-2", state: "Todo", stateId: "s1", number: 2 }),
    ];
    const result = applyGrouping(items, "status" as GroupBy, { by: "number", dir: "asc" });
    expect(result.grouped).toBe(true);
    if (result.grouped) {
      expect(result.groups[0].items.map((i) => i.number)).toEqual([1, 2, 3]);
    }
  });

  it("returns grouped buckets when grouping is active", () => {
    const items = [
      issue({ id: "A", assignee: "Alice", assigneeId: "u1" }),
      issue({ id: "B" }),
    ];
    const result = applyGrouping(items, "assignee", ASC);
    expect(result.grouped).toBe(true);
    if (result.grouped) {
      expect(result.groups.map((g) => g.label)).toEqual(["Alice", "Unassigned"]);
    }
  });
});
