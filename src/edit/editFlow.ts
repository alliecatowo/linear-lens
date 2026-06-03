/**
 * Linear Lens — pure edit-flow helpers (EDIT spec §1).
 *
 * The QuickPick PRESENTATION layer for editing an issue's fields: mapping picker
 * options → display rows (label/description/picked), computing the pre-selected
 * row(s) for the issue's current value, and mapping a selection back into a typed
 * {@link IssueUpdateFields} patch.
 *
 * This module is `vscode`-FREE and deterministic so it is unit-testable with
 * vitest. The thin glue that actually SHOWS a QuickPick lives in the command
 * module (`src/edit/editCommands.ts`).
 */

import {
  CycleOption,
  IssueUpdateFields,
  LabelOption,
  LinearPriority,
  PRIORITY_LABELS,
  ProjectOption,
  TeamOption,
  UserOption,
  WorkflowStateOption,
} from "../types";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Which single field an "Edit field" sub-flow targets. */
export type EditField =
  | "status"
  | "assignee"
  | "labels"
  | "team"
  | "project"
  | "priority"
  | "cycle";

/**
 * A presentation row for a QuickPick. `id === null` is the "clear" sentinel
 * (Unassigned / No project / No cycle); a non-null `id` carries the entity UUID
 * (or the stringified priority Int) to map back into a mutation input.
 */
export interface PickRow {
  /** Entity id, or `null` for the "Unassigned / None / Clear" sentinel. */
  readonly id: string | null;
  /** The primary display label. */
  readonly label: string;
  /** Secondary, dimmed text shown beside the label. */
  readonly description?: string;
  /** A full-width detail line shown beneath the label (e.g. warnings). */
  readonly detail?: string;
  /** Pre-checked state, used for multi-select (labels) and current-value marks. */
  readonly picked?: boolean;
}

// ---------------------------------------------------------------------------
// Internal sort helpers
// ---------------------------------------------------------------------------

/**
 * Stable comparator by an optional numeric `position` (ascending); rows without
 * a position sort last, ties broken by name for determinism.
 */
function byPosition(
  a: { position?: number; name: string },
  b: { position?: number; name: string },
): number {
  const pa = a.position ?? Number.POSITIVE_INFINITY;
  const pb = b.position ?? Number.POSITIVE_INFINITY;
  if (pa !== pb) {
    return pa - pb;
  }
  return a.name.localeCompare(b.name);
}

/** Case-insensitive comparator by `name`. */
function byName(a: { name: string }, b: { name: string }): number {
  return a.name.localeCompare(b.name);
}

/** Case-insensitive comparator by `key`. */
function byKey(a: { key: string }, b: { key: string }): number {
  return a.key.localeCompare(b.key);
}

// ---------------------------------------------------------------------------
// Row builders
// ---------------------------------------------------------------------------

/**
 * Build status rows from workflow states, marking the current state `picked`.
 * Sorted by `position` (ascending), so the rows mirror Linear's state order.
 *
 * @param states - The team's workflow states (any order).
 * @param currentStateId - The issue's current state UUID, pre-selected when set.
 * @returns Display rows for a single-select status QuickPick.
 */
export function statusRows(
  states: WorkflowStateOption[],
  currentStateId?: string,
): PickRow[] {
  return [...states].sort(byPosition).map((s) => ({
    id: s.id,
    label: s.name,
    description: s.type,
    picked: s.id === currentStateId,
  }));
}

/**
 * Build assignee rows (active users) preceded by an "Unassigned" clear sentinel.
 * Marks the current assignee `picked` (or the sentinel when there is none).
 * Users are sorted by display name.
 *
 * @param users - The candidate assignees.
 * @param currentAssigneeId - The issue's current assignee UUID, if any.
 * @returns Display rows for a single-select assignee QuickPick.
 */
export function assigneeRows(
  users: UserOption[],
  currentAssigneeId?: string,
): PickRow[] {
  const clear: PickRow = {
    id: null,
    label: "Unassigned",
    picked: !currentAssigneeId,
  };
  const rows = [...users]
    .sort((a, b) => a.displayName.localeCompare(b.displayName))
    .map<PickRow>((u) => ({
      id: u.id,
      label: u.displayName || u.name,
      description: u.displayName && u.name && u.displayName !== u.name ? u.name : undefined,
      picked: u.id === currentAssigneeId,
    }));
  return [clear, ...rows];
}

/**
 * Build label rows for a multi-select QuickPick, pre-checking exactly the issue's
 * current label ids. Sorted by name.
 *
 * @param labels - The team's available labels.
 * @param currentLabelIds - The issue's current label UUIDs (pre-checked).
 * @returns Display rows for a multi-select labels QuickPick.
 */
export function labelRows(
  labels: LabelOption[],
  currentLabelIds: string[],
): PickRow[] {
  const current = new Set(currentLabelIds);
  return [...labels].sort(byName).map((l) => ({
    id: l.id,
    label: l.name,
    description: l.color,
    picked: current.has(l.id),
  }));
}

/**
 * Build team rows, marking the current team `picked`. Sorted by key. Each row's
 * detail warns that moving teams re-keys the issue and may reset state/cycle.
 *
 * @param teams - The available teams.
 * @param currentTeamId - The issue's current team UUID, if any.
 * @returns Display rows for a single-select team QuickPick.
 */
export function teamRows(teams: TeamOption[], currentTeamId?: string): PickRow[] {
  return [...teams].sort(byKey).map((t) => ({
    id: t.id,
    label: `${t.key} — ${t.name}`,
    description: t.id === currentTeamId ? "current team" : undefined,
    detail:
      t.id === currentTeamId
        ? undefined
        : "Moving teams re-keys the issue (e.g. ENG-123 → DES-45) and may reset state/cycle.",
    picked: t.id === currentTeamId,
  }));
}

/**
 * Build project rows preceded by a "No project" clear sentinel; marks the current
 * project `picked` (or the sentinel when there is none). Sorted by name.
 *
 * @param projects - The available projects.
 * @param currentProjectId - The issue's current project UUID, if any.
 * @returns Display rows for a single-select project QuickPick.
 */
export function projectRows(
  projects: ProjectOption[],
  currentProjectId?: string,
): PickRow[] {
  const clear: PickRow = {
    id: null,
    label: "No project",
    picked: !currentProjectId,
  };
  const rows = [...projects].sort(byName).map<PickRow>((p) => ({
    id: p.id,
    label: p.name,
    description: p.state,
    picked: p.id === currentProjectId,
  }));
  return [clear, ...rows];
}

/**
 * Build priority rows from {@link PRIORITY_LABELS} in canonical order
 * (No priority / Urgent / High / Normal / Low), marking the current one `picked`.
 * The row id is the stringified priority Int (mapped back via
 * {@link singleSelectToUpdate}).
 *
 * @param currentPriority - The issue's current priority (0–4), if known.
 * @returns The five priority rows.
 */
export function priorityRows(currentPriority?: LinearPriority): PickRow[] {
  return PRIORITY_LABELS.map((label, index) => ({
    id: String(index),
    label,
    picked: index === currentPriority,
  }));
}

/**
 * Build cycle rows preceded by a "No cycle" clear sentinel; marks the current
 * cycle `picked` (or the sentinel when there is none). Unnamed cycles render as
 * "Cycle <number>". Sorted by cycle number (ascending), unnamed/unnumbered last.
 *
 * @param cycles - The team's cycles.
 * @param currentCycleId - The issue's current cycle UUID, if any.
 * @returns Display rows for a single-select cycle QuickPick.
 */
export function cycleRows(
  cycles: CycleOption[],
  currentCycleId?: string,
): PickRow[] {
  const clear: PickRow = {
    id: null,
    label: "No cycle",
    picked: !currentCycleId,
  };
  const rows = [...cycles]
    .sort(
      (a, b) =>
        (a.number ?? Number.POSITIVE_INFINITY) - (b.number ?? Number.POSITIVE_INFINITY),
    )
    .map<PickRow>((c) => ({
      id: c.id,
      label: cycleLabel(c),
      description: c.name && c.number != null ? `Cycle ${c.number}` : undefined,
      picked: c.id === currentCycleId,
    }));
  return [clear, ...rows];
}

/** Derive a human label for a cycle: its name, else "Cycle <number>", else "Cycle". */
function cycleLabel(cycle: CycleOption): string {
  if (cycle.name && cycle.name.length > 0) {
    return cycle.name;
  }
  if (cycle.number != null) {
    return `Cycle ${cycle.number}`;
  }
  return "Cycle";
}

// ---------------------------------------------------------------------------
// Selection → mutation input
// ---------------------------------------------------------------------------

/**
 * Map a single-select result (the chosen {@link PickRow.id}, possibly `null` for
 * the clear sentinel) for `field` into an {@link IssueUpdateFields} patch.
 *
 * `null` clears the field where Linear permits it (assignee / project / cycle all
 * send `null`). `status`, `team`, and `priority` REQUIRE a value, so a `null`
 * choice yields an EMPTY patch (`{}`) the caller treats as a no-op. `priority`
 * coerces the stringified row id to the 0–4 Int.
 *
 * Pure; never throws.
 *
 * @param field - The field being edited.
 * @param chosenId - The selected row's id, or `null` for the clear sentinel.
 * @returns The partial update patch (empty when the choice is a no-op).
 */
export function singleSelectToUpdate(
  field: EditField,
  chosenId: string | null,
): IssueUpdateFields {
  switch (field) {
    case "status":
      return chosenId === null ? {} : { stateId: chosenId };
    case "team":
      return chosenId === null ? {} : { teamId: chosenId };
    case "assignee":
      return { assigneeId: chosenId };
    case "project":
      return { projectId: chosenId };
    case "cycle":
      return { cycleId: chosenId };
    case "priority": {
      if (chosenId === null) {
        return {};
      }
      const priority = coerceUpdatePriority(chosenId);
      return priority === undefined ? {} : { priority };
    }
    case "labels":
      // Labels are multi-select; single-select is not a valid path. No-op.
      return {};
    default:
      return {};
  }
}

/**
 * Map a multi-select labels result (the chosen label ids) into an
 * {@link IssueUpdateFields} patch. `labelIds` is a FULL REPLACE of the issue's
 * label set. Pure.
 *
 * @param chosenIds - The full set of selected label UUIDs.
 * @returns A patch setting `labelIds` to the chosen set.
 */
export function labelsToUpdate(chosenIds: string[]): IssueUpdateFields {
  return { labelIds: [...chosenIds] };
}

/**
 * Coerce a stringified priority row id into the canonical {@link LinearPriority}
 * 0–4 Int, or `undefined` when out of range / unparseable.
 */
function coerceUpdatePriority(raw: string): LinearPriority | undefined {
  const value = Number.parseInt(raw, 10);
  if (Number.isInteger(value) && value >= 0 && value <= 4) {
    return value as LinearPriority;
  }
  return undefined;
}
