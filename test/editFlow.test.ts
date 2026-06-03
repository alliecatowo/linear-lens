import { describe, it, expect } from "vitest";
import {
  assigneeRows,
  cycleRows,
  labelRows,
  labelsToUpdate,
  priorityRows,
  projectRows,
  singleSelectToUpdate,
  statusRows,
  teamRows,
} from "../src/edit/editFlow";
import {
  CycleOption,
  LabelOption,
  ProjectOption,
  TeamOption,
  UserOption,
  WorkflowStateOption,
} from "../src/types";

// ---------------------------------------------------------------------------
// statusRows
// ---------------------------------------------------------------------------

describe("statusRows", () => {
  const states: WorkflowStateOption[] = [
    { id: "s3", name: "Done", type: "completed", position: 3 },
    { id: "s1", name: "Todo", type: "unstarted", position: 1 },
    { id: "s2", name: "In Progress", type: "started", position: 2 },
  ];

  it("marks the current state picked and sorts by position", () => {
    const rows = statusRows(states, "s2");
    expect(rows.map((r) => r.id)).toEqual(["s1", "s2", "s3"]);
    expect(rows.map((r) => r.label)).toEqual(["Todo", "In Progress", "Done"]);
    expect(rows.find((r) => r.id === "s2")?.picked).toBe(true);
    expect(rows.filter((r) => r.picked)).toHaveLength(1);
  });

  it("marks nothing picked when the current id is absent", () => {
    const rows = statusRows(states);
    expect(rows.some((r) => r.picked)).toBe(false);
  });

  it("never mutates the input array", () => {
    const input = [...states];
    statusRows(input, "s1");
    expect(input).toEqual(states);
  });
});

// ---------------------------------------------------------------------------
// assigneeRows
// ---------------------------------------------------------------------------

describe("assigneeRows", () => {
  const users: UserOption[] = [
    { id: "u2", name: "bob", displayName: "Bob" },
    { id: "u1", name: "alice", displayName: "Alice" },
  ];

  it("prepends an 'Unassigned' clear sentinel with id null", () => {
    const rows = assigneeRows(users, "u1");
    expect(rows[0]).toMatchObject({ id: null, label: "Unassigned" });
  });

  it("marks the current assignee picked and sorts by display name", () => {
    const rows = assigneeRows(users, "u1");
    expect(rows.map((r) => r.label)).toEqual(["Unassigned", "Alice", "Bob"]);
    expect(rows.find((r) => r.id === "u1")?.picked).toBe(true);
    expect(rows[0].picked).toBe(false);
  });

  it("picks the 'Unassigned' sentinel when there is no current assignee", () => {
    const rows = assigneeRows(users);
    expect(rows[0].picked).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// labelRows
// ---------------------------------------------------------------------------

describe("labelRows", () => {
  const labels: LabelOption[] = [
    { id: "l2", name: "backend" },
    { id: "l1", name: "bug" },
    { id: "l3", name: "ui" },
  ];

  it("pre-checks exactly the current label ids", () => {
    const rows = labelRows(labels, ["l1", "l3"]);
    expect(rows.filter((r) => r.picked).map((r) => r.id).sort()).toEqual(["l1", "l3"]);
  });

  it("orders by name", () => {
    const rows = labelRows(labels, []);
    expect(rows.map((r) => r.label)).toEqual(["backend", "bug", "ui"]);
  });

  it("pre-checks nothing when the current set is empty", () => {
    const rows = labelRows(labels, []);
    expect(rows.some((r) => r.picked)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// teamRows
// ---------------------------------------------------------------------------

describe("teamRows", () => {
  const teams: TeamOption[] = [
    { id: "t2", key: "DES", name: "Design" },
    { id: "t1", key: "ENG", name: "Engineering" },
  ];

  it("sorts by key and marks the current team picked", () => {
    const rows = teamRows(teams, "t1");
    expect(rows.map((r) => r.label)).toEqual(["DES — Design", "ENG — Engineering"]);
    expect(rows.find((r) => r.id === "t1")?.picked).toBe(true);
  });

  it("warns in the detail when a row is not the current team", () => {
    const rows = teamRows(teams, "t1");
    const other = rows.find((r) => r.id === "t2");
    expect(other?.detail).toMatch(/re-keys the issue/i);
    expect(rows.find((r) => r.id === "t1")?.detail).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// projectRows
// ---------------------------------------------------------------------------

describe("projectRows", () => {
  const projects: ProjectOption[] = [
    { id: "p2", name: "Billing" },
    { id: "p1", name: "Auth" },
  ];

  it("prepends a 'No project' clear sentinel with id null", () => {
    const rows = projectRows(projects, "p1");
    expect(rows[0]).toMatchObject({ id: null, label: "No project" });
  });

  it("marks the current project picked and sorts by name", () => {
    const rows = projectRows(projects, "p1");
    expect(rows.map((r) => r.label)).toEqual(["No project", "Auth", "Billing"]);
    expect(rows.find((r) => r.id === "p1")?.picked).toBe(true);
  });

  it("picks the sentinel when there is no current project", () => {
    const rows = projectRows(projects);
    expect(rows[0].picked).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// priorityRows
// ---------------------------------------------------------------------------

describe("priorityRows", () => {
  it("yields 5 rows in canonical order with the current one picked", () => {
    const rows = priorityRows(2);
    expect(rows.map((r) => r.label)).toEqual([
      "No priority",
      "Urgent",
      "High",
      "Normal",
      "Low",
    ]);
    expect(rows.map((r) => r.id)).toEqual(["0", "1", "2", "3", "4"]);
    expect(rows.find((r) => r.id === "2")?.picked).toBe(true);
    expect(rows.filter((r) => r.picked)).toHaveLength(1);
  });

  it("picks nothing when the current priority is undefined", () => {
    const rows = priorityRows();
    expect(rows.some((r) => r.picked)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// cycleRows
// ---------------------------------------------------------------------------

describe("cycleRows", () => {
  it("prepends a 'No cycle' clear sentinel with id null", () => {
    const rows = cycleRows([], undefined);
    expect(rows[0]).toMatchObject({ id: null, label: "No cycle" });
    expect(rows[0].picked).toBe(true);
  });

  it("derives 'Cycle 7' for an unnamed cycle", () => {
    const cycles: CycleOption[] = [{ id: "c1", number: 7 }];
    const rows = cycleRows(cycles, undefined);
    expect(rows.find((r) => r.id === "c1")?.label).toBe("Cycle 7");
  });

  it("uses the cycle name when present and marks the current cycle picked", () => {
    const cycles: CycleOption[] = [{ id: "c1", name: "Sprint A", number: 7 }];
    const rows = cycleRows(cycles, "c1");
    expect(rows.find((r) => r.id === "c1")?.label).toBe("Sprint A");
    expect(rows.find((r) => r.id === "c1")?.picked).toBe(true);
    expect(rows[0].picked).toBe(false);
  });

  it("sorts cycles by number ascending", () => {
    const cycles: CycleOption[] = [
      { id: "c2", number: 9 },
      { id: "c1", number: 3 },
    ];
    const rows = cycleRows(cycles, undefined);
    expect(rows.map((r) => r.id)).toEqual([null, "c1", "c2"]);
  });
});

// ---------------------------------------------------------------------------
// singleSelectToUpdate
// ---------------------------------------------------------------------------

describe("singleSelectToUpdate", () => {
  it("coerces a chosen priority string to an Int", () => {
    expect(singleSelectToUpdate("priority", "2")).toEqual({ priority: 2 });
    expect(singleSelectToUpdate("priority", "0")).toEqual({ priority: 0 });
  });

  it("ignores an out-of-range priority (no-op)", () => {
    expect(singleSelectToUpdate("priority", "9")).toEqual({});
    expect(singleSelectToUpdate("priority", "x")).toEqual({});
  });

  it("clears assignee/project/cycle on the null sentinel", () => {
    expect(singleSelectToUpdate("assignee", null)).toEqual({ assigneeId: null });
    expect(singleSelectToUpdate("project", null)).toEqual({ projectId: null });
    expect(singleSelectToUpdate("cycle", null)).toEqual({ cycleId: null });
  });

  it("sets non-clearable fields and treats their null choice as a no-op", () => {
    expect(singleSelectToUpdate("status", "s1")).toEqual({ stateId: "s1" });
    expect(singleSelectToUpdate("status", null)).toEqual({});
    expect(singleSelectToUpdate("team", "t1")).toEqual({ teamId: "t1" });
    expect(singleSelectToUpdate("team", null)).toEqual({});
    expect(singleSelectToUpdate("priority", null)).toEqual({});
  });

  it("sets assignee/project/cycle to a chosen id", () => {
    expect(singleSelectToUpdate("assignee", "u1")).toEqual({ assigneeId: "u1" });
    expect(singleSelectToUpdate("project", "p1")).toEqual({ projectId: "p1" });
    expect(singleSelectToUpdate("cycle", "c1")).toEqual({ cycleId: "c1" });
  });

  it("treats a single-select on labels as a no-op", () => {
    expect(singleSelectToUpdate("labels", "l1")).toEqual({});
  });
});

// ---------------------------------------------------------------------------
// labelsToUpdate
// ---------------------------------------------------------------------------

describe("labelsToUpdate", () => {
  it("maps chosen ids into a full-replace labelIds patch", () => {
    expect(labelsToUpdate(["a", "b"])).toEqual({ labelIds: ["a", "b"] });
  });

  it("maps an empty selection to an empty labelIds array (clears all labels)", () => {
    expect(labelsToUpdate([])).toEqual({ labelIds: [] });
  });

  it("returns a fresh array (does not alias the input)", () => {
    const input = ["a"];
    const patch = labelsToUpdate(input);
    expect(patch.labelIds).not.toBe(input);
    expect(patch.labelIds).toEqual(["a"]);
  });
});
