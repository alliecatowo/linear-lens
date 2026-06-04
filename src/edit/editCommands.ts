/**
 * Linear Lens — edit command module (EDIT spec §3).
 *
 * Registers the issue-edit commands. Each resolves the target issue (from a
 * command argument / tree node / webview / editor cursor / prompt), gates on
 * WRITE access ({@link ensureWriteAuth}), loads the issue's edit context once,
 * presents a QuickPick built by the pure {@link ./editFlow} helpers, performs the
 * mutation through the never-throwing Linear client, then refreshes the UI and
 * surfaces a result toast.
 *
 * Commands registered:
 *  - `linearLens.editIssue`   — dispatcher (pick a field, then run its sub-flow).
 *  - `linearLens.setStatus`   — status sub-flow.
 *  - `linearLens.setAssignee` — assignee sub-flow.
 *  - `linearLens.editLabels`  — labels multi-select.
 *  - `linearLens.setTeam`     — team (move) sub-flow.
 *  - `linearLens.setProject`  — project sub-flow.
 *  - `linearLens.setPriority` — priority sub-flow.
 *  - `linearLens.setCycle`    — cycle sub-flow.
 *
 * HARD SAFETY RULE: no real Linear writes happen during implementation /
 * verification. The mutation code paths are exercised only by unit tests with
 * MOCKED clients. The client itself NEVER throws — mutations return a typed
 * {@link LinearWriteResult} and permission/validation/network errors become
 * toasts here.
 */

import * as vscode from "vscode";

import { parseIssueId, scanText } from "../parser";
import { PRIORITY_LABELS } from "../types";
import type {
  IssueEditContext,
  IssueId,
  IssueUpdateFields,
  LinearClient,
  LinearLensConfig,
  LinearWriteError,
  LinearWriteResult,
} from "../types";
import { ensureWriteAuth, WriteAuthDeps } from "../writeAuth";
import {
  assigneeRows,
  cycleRows,
  EditField,
  labelRows,
  labelsToUpdate,
  PickRow,
  priorityRows,
  projectRows,
  singleSelectToUpdate,
  statusRows,
  teamRows,
} from "./editFlow";

// ---------------------------------------------------------------------------
// Dependencies
// ---------------------------------------------------------------------------

/** Dependencies injected into {@link registerEditCommands} by `extension.ts`. */
export interface EditCommandDeps {
  /** Returns the current, validated extension configuration. */
  readonly getCfg: () => LinearLensConfig;
  /**
   * Returns the effective team-key allowlist (auth-aware detection); `undefined`
   * for zero-config "match any". Optional; defaults to the configured `teamKeys`.
   */
  readonly getTeamKeys?: () => string[] | undefined;
  /** Linear API client (pickers + mutations; degrades gracefully, never throws). */
  readonly client: LinearClient;
  /** Write-auth dependencies (SecretStorage) for the write-auth gate. */
  readonly writeAuthDeps: WriteAuthDeps;
  /** Re-paint editor surfaces (hover/inline) after a write. */
  readonly refreshUi?: () => void;
  /** Refresh the Activity Bar trees after a write. */
  readonly refreshViews?: () => void;
  /** Re-render the open detail webview after a write. */
  readonly refreshDetail?: () => void;
  /** Drop the cached metadata + detail for a single id after a write. */
  readonly invalidate?: (id: IssueId) => void;
}

// ---------------------------------------------------------------------------
// Result feedback (self-contained toasts; the client never throws)
// ---------------------------------------------------------------------------

/** Command id the user runs to set a personal API key (write path). */
const SET_API_KEY_COMMAND = "linearLens.setApiKey";

/**
 * Show a user-facing toast for a {@link LinearWriteError}, offering the right
 * call-to-action. Routes auth/permission failures toward the personal-API-key
 * path and lets the user retry a write-capable sign-in. Never throws.
 *
 * @param err - The failed mutation result.
 * @param writeAuthDeps - Deps used to retry a write-capable sign-in.
 */
async function showWriteError(
  err: LinearWriteError,
  writeAuthDeps: WriteAuthDeps,
): Promise<void> {
  const setKey = "Set Personal API Key";
  const trySignIn = "Try Write Sign-in";
  const openSettings = "Open Settings";

  try {
    switch (err.kind) {
      case "noAuth":
      case "noWriteScope":
      case "permission": {
        const message =
          err.kind === "permission"
            ? "Linear rejected the change (your token may be read-only). Set a full-access personal API key to edit issues."
            : "Editing Linear issues requires full (write) access. Set a personal API key, or try a write-capable sign-in.";
        const choice = await vscode.window.showWarningMessage(message, setKey, trySignIn);
        if (choice === setKey) {
          await vscode.commands.executeCommand(SET_API_KEY_COMMAND);
        } else if (choice === trySignIn) {
          await ensureWriteAuth(writeAuthDeps);
        }
        return;
      }
      case "apiDisabled": {
        const choice = await vscode.window.showWarningMessage(
          "Linear Lens: the Linear API is disabled (linearLens.api.enable).",
          openSettings,
        );
        if (choice === openSettings) {
          await vscode.commands.executeCommand(
            "workbench.action.openSettings",
            "linearLens.api.enable",
          );
        }
        return;
      }
      case "network":
        void vscode.window.showErrorMessage(
          "Linear Lens: could not reach Linear. Check your connection and retry.",
        );
        return;
      case "notFound":
      case "validation":
      case "unknown":
      default:
        void vscode.window.showErrorMessage(`Linear Lens: ${err.message}`);
        return;
    }
  } catch {
    // Surfacing the error must itself never throw.
  }
}

/** Show a success toast for a completed write. Never throws. */
function showWriteSuccess(message: string): void {
  void vscode.window.showInformationMessage(`Linear Lens: ${message}`);
}

// ---------------------------------------------------------------------------
// Id resolution
// ---------------------------------------------------------------------------

/**
 * Resolve a normalized issue id from a loosely-typed command argument (a bare id
 * string or an `{ id }` object as tree nodes / the webview pass), falling back to
 * the reference under the active editor's cursor. Returns `undefined` when none
 * can be resolved. Never throws.
 *
 * @param arg - The loosely-typed command argument.
 * @param cfg - The current resolved configuration (marker parsing).
 * @param teamKeys - The effective team-key allowlist (auth-aware detection).
 * @returns The normalized id, or `undefined`.
 */
function resolveIssueId(
  arg: unknown,
  cfg: LinearLensConfig,
  teamKeys: string[] | undefined,
): string | undefined {
  // 1. Explicit string / `{ id }` argument.
  let raw: string | undefined;
  if (typeof arg === "string") {
    raw = arg.trim();
  } else if (typeof arg === "object" && arg !== null) {
    const candidate = (arg as { id?: unknown }).id;
    raw = typeof candidate === "string" ? candidate.trim() : undefined;
  }
  if (raw) {
    const parsed = parseIssueId(raw, { teamKeys });
    return parsed?.normalized ?? raw;
  }

  // 2. The reference under the editor cursor.
  try {
    const editor = vscode.window.activeTextEditor;
    if (!editor) {
      return undefined;
    }
    const document = editor.document;
    const refs = scanText(document.getText(), {
      teamKeys,
      markers: cfg.markers,
    });
    const offset = document.offsetAt(editor.selection.active);
    const ref = refs.find((r) => offset >= r.start && offset <= r.end);
    return ref?.issue.normalized;
  } catch {
    return undefined;
  }
}

/**
 * Resolve the id from the argument/cursor or, failing that, prompt for one. Then
 * parse it to a strict {@link IssueId}. Returns `undefined` when the user cancels
 * the prompt or the input is not a valid issue id (a warning is shown for the
 * latter). Never throws.
 *
 * @param arg - The loosely-typed command argument.
 * @param cfg - The current resolved configuration.
 * @param teamKeys - The effective team-key allowlist (auth-aware detection).
 * @returns A parsed {@link IssueId}, or `undefined`.
 */
async function resolveIssueIdOrPrompt(
  arg: unknown,
  cfg: LinearLensConfig,
  teamKeys: string[] | undefined,
): Promise<IssueId | undefined> {
  let id = resolveIssueId(arg, cfg, teamKeys);
  if (!id) {
    const input = await vscode.window.showInputBox({
      title: "Linear Lens: Edit Issue",
      prompt: "Enter a Linear issue id to edit.",
      placeHolder: "ENG-123",
      ignoreFocusOut: true,
    });
    if (input === undefined) {
      return undefined;
    }
    id = input.trim();
  }
  const parsed = parseIssueId(id, { teamKeys });
  if (!parsed) {
    void vscode.window.showWarningMessage(
      `Linear Lens: "${id}" is not a valid Linear issue id.`,
    );
    return undefined;
  }
  return parsed;
}

// ---------------------------------------------------------------------------
// Shared command preamble (EDIT spec §3.1)
// ---------------------------------------------------------------------------

/** The resolved preamble state shared by every edit sub-flow. */
interface EditTarget {
  /** The parsed, normalized issue id (for toasts + invalidation). */
  readonly id: IssueId;
  /** The loaded edit context (UUID + current field values + labels + relations). */
  readonly ctx: IssueEditContext;
}

/**
 * Run the shared preamble: resolve the issue id, GATE on write access, then load
 * the issue's edit context. Returns `undefined` (caller aborts) when the id is
 * missing, write access is declined, or the context cannot be loaded. Never
 * throws.
 *
 * @param arg - The command argument (id / tree node / webview / cursor).
 * @param deps - The injected command dependencies.
 * @returns The resolved {@link EditTarget}, or `undefined` to abort.
 */
async function runPreamble(
  arg: unknown,
  deps: EditCommandDeps,
): Promise<EditTarget | undefined> {
  const cfg = deps.getCfg();
  const teamKeys = deps.getTeamKeys ? deps.getTeamKeys() : cfg.teamKeys;

  // 1. Resolve the target id.
  const id = await resolveIssueIdOrPrompt(arg, cfg, teamKeys);
  if (!id) {
    return undefined;
  }

  // 2. [WRITE-AUTH GATE] before any network read so we never offer picks the
  //    user cannot act on.
  const gate = await ensureWriteAuth(deps.writeAuthDeps);
  if (!gate.ok) {
    return undefined;
  }

  // 3. Load the edit context (UUID + current values + labels + relations).
  const ctx = await deps.client.getEditContext(id);
  if (!ctx || !ctx.issueUuid) {
    await showWriteError(
      { ok: false, kind: "notFound", message: `Could not load ${id.normalized}.` },
      deps.writeAuthDeps,
    );
    return undefined;
  }

  return { id, ctx };
}

/**
 * Apply an {@link IssueUpdateFields} patch to the target issue and surface the
 * result. An empty patch is treated as a silent no-op (e.g. the user picked the
 * already-current value or a non-clearable field's clear sentinel). On success,
 * invalidate the cached id and refresh the UI surfaces. Never throws.
 *
 * @param target - The resolved edit target.
 * @param patch - The mutation patch (may be empty).
 * @param deps - The injected command dependencies.
 */
async function applyUpdate(
  target: EditTarget,
  patch: IssueUpdateFields,
  deps: EditCommandDeps,
): Promise<void> {
  if (Object.keys(patch).length === 0) {
    return; // No-op: nothing changed.
  }
  const result = await deps.client.updateIssue(target.ctx.issueUuid, patch);
  await handleWriteResult(result, target.id, `${target.id.normalized} updated.`, deps);
}

/**
 * Common write-result handler: success → invalidate + refresh + success toast;
 * failure → error toast. Never throws.
 *
 * @param result - The mutation result.
 * @param id - The affected issue id (for invalidation + the toast).
 * @param successMessage - The success-toast text.
 * @param deps - The injected command dependencies.
 */
async function handleWriteResult(
  result: LinearWriteResult<unknown>,
  id: IssueId,
  successMessage: string,
  deps: EditCommandDeps,
): Promise<void> {
  if (result.ok) {
    try {
      deps.invalidate?.(id);
      deps.refreshUi?.();
      deps.refreshViews?.();
      deps.refreshDetail?.();
    } catch {
      // Refreshing the UI must never surface as a failure.
    }
    showWriteSuccess(successMessage);
  } else {
    await showWriteError(result, deps.writeAuthDeps);
  }
}

// ---------------------------------------------------------------------------
// QuickPick glue (EDIT spec §3.2)
// ---------------------------------------------------------------------------

/**
 * Show a single-select QuickPick built from {@link PickRow}s, returning the
 * chosen row's id (`null` for the clear sentinel) or `undefined` when cancelled.
 * The current value (the `picked` row) is marked with a `$(check)` glyph so the
 * user can see which option is already set. Never throws.
 *
 * @param rows - The display rows.
 * @param title - The picker title.
 * @param emptyPlaceholder - Placeholder shown when `rows` is empty.
 * @returns `{ chosen: id }` when picked, or `undefined` on cancel / empty.
 */
async function showSingleSelect(
  rows: PickRow[],
  title: string,
  emptyPlaceholder: string,
): Promise<{ chosen: string | null } | undefined> {
  if (rows.length === 0) {
    void vscode.window.showWarningMessage(`Linear Lens: ${emptyPlaceholder}`);
    return undefined;
  }

  interface RowItem extends vscode.QuickPickItem {
    readonly rowId: string | null;
  }
  const items: RowItem[] = rows.map((r) => ({
    label: r.picked ? `$(check) ${r.label}` : r.label,
    description: r.description,
    detail: r.detail,
    rowId: r.id,
  }));

  const picked = await vscode.window.showQuickPick(items, {
    title,
    placeHolder: "Select an option",
    ignoreFocusOut: true,
    matchOnDescription: true,
  });
  if (!picked) {
    return undefined;
  }
  return { chosen: picked.rowId };
}

/**
 * Show a multi-select QuickPick built from {@link PickRow}s, returning the chosen
 * non-null ids (the pre-checked rows are selected by default), or `undefined`
 * when cancelled. Never throws.
 *
 * @param rows - The display rows (each with a non-null id for labels).
 * @param title - The picker title.
 * @param emptyPlaceholder - Placeholder shown when `rows` is empty.
 * @returns `{ chosen: ids }` when accepted, or `undefined` on cancel / empty.
 */
async function showMultiSelect(
  rows: PickRow[],
  title: string,
  emptyPlaceholder: string,
): Promise<{ chosen: string[] } | undefined> {
  if (rows.length === 0) {
    void vscode.window.showWarningMessage(`Linear Lens: ${emptyPlaceholder}`);
    return undefined;
  }

  interface RowItem extends vscode.QuickPickItem {
    readonly rowId: string;
  }
  const items: RowItem[] = rows.flatMap((r) =>
    r.id === null
      ? []
      : [
          {
            label: r.label,
            description: r.description,
            detail: r.detail,
            picked: r.picked,
            rowId: r.id,
          },
        ],
  );

  const picked = await vscode.window.showQuickPick(items, {
    title,
    placeHolder: "Toggle labels, then press Enter",
    canPickMany: true,
    ignoreFocusOut: true,
    matchOnDescription: true,
  });
  if (!picked) {
    return undefined;
  }
  return { chosen: picked.map((p) => p.rowId) };
}

// ---------------------------------------------------------------------------
// Field sub-flows (EDIT spec §3.2)
// ---------------------------------------------------------------------------

/** Run the status sub-flow against an already-resolved target. */
async function runStatusFlow(target: EditTarget, deps: EditCommandDeps): Promise<void> {
  const teamId = target.ctx.team?.id;
  if (!teamId) {
    void vscode.window.showWarningMessage(
      `Linear Lens: ${target.id.normalized} has no team; cannot list statuses.`,
    );
    return;
  }
  const states = await deps.client.listWorkflowStates(teamId);
  const result = await showSingleSelect(
    statusRows(states, target.ctx.currentStateId),
    `Set Status — ${target.id.normalized}`,
    "no statuses to show (the team has none, or the list could not be loaded).",
  );
  if (!result) {
    return;
  }
  await applyUpdate(target, singleSelectToUpdate("status", result.chosen), deps);
}

/** Run the assignee sub-flow against an already-resolved target. */
async function runAssigneeFlow(target: EditTarget, deps: EditCommandDeps): Promise<void> {
  const users = await deps.client.listUsers();
  const result = await showSingleSelect(
    assigneeRows(users, target.ctx.currentAssigneeId),
    `Set Assignee — ${target.id.normalized}`,
    "no users to show (the list could not be loaded).",
  );
  if (!result) {
    return;
  }
  await applyUpdate(target, singleSelectToUpdate("assignee", result.chosen), deps);
}

/** Run the labels multi-select sub-flow against an already-resolved target. */
async function runLabelsFlow(target: EditTarget, deps: EditCommandDeps): Promise<void> {
  const teamId = target.ctx.team?.id;
  if (!teamId) {
    void vscode.window.showWarningMessage(
      `Linear Lens: ${target.id.normalized} has no team; cannot list labels.`,
    );
    return;
  }
  const labels = await deps.client.listLabels(teamId);
  const current = target.ctx.labels.map((l) => l.id);
  const result = await showMultiSelect(
    labelRows(labels, current),
    `Edit Labels — ${target.id.normalized}`,
    "no labels to show (the team has none, or the list could not be loaded).",
  );
  if (!result) {
    return;
  }
  await applyUpdate(target, labelsToUpdate(result.chosen), deps);
}

/** Run the team-move sub-flow against an already-resolved target. */
async function runTeamFlow(target: EditTarget, deps: EditCommandDeps): Promise<void> {
  const teams = await deps.client.listTeams();
  const result = await showSingleSelect(
    teamRows(teams, target.ctx.team?.id),
    `Move to Team — ${target.id.normalized}`,
    "no teams to show (the list could not be loaded).",
  );
  if (!result) {
    return;
  }
  // No-op when the user re-picks the current team.
  if (result.chosen === target.ctx.team?.id) {
    return;
  }
  // Moving teams re-keys the issue and may reset state/cycle — a destructive
  // change. Honors `linearLens.write.confirmDestructive`: when false, proceed
  // silently. Never throws.
  if (deps.getCfg().confirmDestructive) {
    const proceed = await vscode.window.showWarningMessage(
      `Move ${target.id.normalized} to another team? This re-keys the issue (e.g. ENG-123 → DES-45) and may reset its state/cycle.`,
      { modal: true },
      "Move",
    );
    if (proceed !== "Move") {
      return;
    }
  }
  await applyUpdate(target, singleSelectToUpdate("team", result.chosen), deps);
}

/** Run the project sub-flow against an already-resolved target. */
async function runProjectFlow(target: EditTarget, deps: EditCommandDeps): Promise<void> {
  const projects = await deps.client.listProjects();
  const result = await showSingleSelect(
    projectRows(projects, target.ctx.currentProjectId),
    `Set Project — ${target.id.normalized}`,
    "no projects to show (the list could not be loaded).",
  );
  if (!result) {
    return;
  }
  await applyUpdate(target, singleSelectToUpdate("project", result.chosen), deps);
}

/** Run the priority sub-flow against an already-resolved target (no network). */
async function runPriorityFlow(target: EditTarget, deps: EditCommandDeps): Promise<void> {
  const result = await showSingleSelect(
    priorityRows(target.ctx.currentPriority),
    `Set Priority — ${target.id.normalized}`,
    "no priorities to show.",
  );
  if (!result) {
    return;
  }
  await applyUpdate(target, singleSelectToUpdate("priority", result.chosen), deps);
}

/** Run the cycle sub-flow against an already-resolved target. */
async function runCycleFlow(target: EditTarget, deps: EditCommandDeps): Promise<void> {
  const teamId = target.ctx.team?.id;
  if (!teamId) {
    void vscode.window.showWarningMessage(
      `Linear Lens: ${target.id.normalized} has no team; cannot list cycles.`,
    );
    return;
  }
  const cycles = await deps.client.listCycles(teamId);
  const result = await showSingleSelect(
    cycleRows(cycles, target.ctx.currentCycleId),
    `Set Cycle — ${target.id.normalized}`,
    "no cycles to show (the team has none, or the list could not be loaded).",
  );
  if (!result) {
    return;
  }
  await applyUpdate(target, singleSelectToUpdate("cycle", result.chosen), deps);
}

/** Dispatch table from {@link EditField} to its sub-flow runner. */
const FIELD_FLOWS: Record<
  EditField,
  (target: EditTarget, deps: EditCommandDeps) => Promise<void>
> = {
  status: runStatusFlow,
  assignee: runAssigneeFlow,
  labels: runLabelsFlow,
  team: runTeamFlow,
  project: runProjectFlow,
  priority: runPriorityFlow,
  cycle: runCycleFlow,
};

// ---------------------------------------------------------------------------
// editIssue dispatcher (EDIT spec §3.3)
// ---------------------------------------------------------------------------

/** A field row in the `editIssue` dispatcher, with a `$(...)` icon + current value. */
interface FieldChoice extends vscode.QuickPickItem {
  readonly field: EditField;
}

/**
 * Build the dispatcher rows, showing each field's CURRENT value inline from the
 * single edit-context already in hand (no extra fetch). State/assignee names are
 * not in the context (only ids), so id-free fields (priority) and label counts
 * are shown verbatim; id-only fields note whether they are set.
 */
function dispatcherChoices(ctx: IssueEditContext): FieldChoice[] {
  const labelSummary =
    ctx.labels.length === 0
      ? "none"
      : ctx.labels
          .slice(0, 3)
          .map((l) => l.name)
          .join(", ") + (ctx.labels.length > 3 ? `, +${ctx.labels.length - 3}` : "");
  const priorityName =
    ctx.currentPriority === undefined
      ? PRIORITY_LABELS[0]
      : PRIORITY_LABELS[ctx.currentPriority];

  return [
    { field: "status", label: "$(circle-outline) Status", description: setOrUnset(ctx.currentStateId) },
    {
      field: "assignee",
      label: "$(account) Assignee",
      description: ctx.currentAssigneeId ? "assigned" : "Unassigned",
    },
    { field: "labels", label: "$(tag) Labels", description: labelSummary },
    {
      field: "team",
      label: "$(organization) Team",
      description: ctx.team ? `${ctx.team.key} — ${ctx.team.name}` : "unknown",
    },
    {
      field: "project",
      label: "$(project) Project",
      description: ctx.currentProjectId ? "set" : "No project",
    },
    { field: "priority", label: "$(arrow-up) Priority", description: priorityName },
    {
      field: "cycle",
      label: "$(sync) Cycle",
      description: ctx.currentCycleId ? "set" : "No cycle",
    },
  ];
}

/** "set" / "unset" hint for an id-only current value. */
function setOrUnset(value: string | undefined): string {
  return value ? "set" : "unset";
}

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

/**
 * Register all issue-edit commands. Each command's disposable is pushed onto
 * `context.subscriptions`. The seven field sub-commands accept the same argument
 * shapes as `editIssue` (id string / `{ id }` / cursor) and run their sub-flow
 * directly; `editIssue` first prompts for which field to edit.
 *
 * @param context - The extension context owning the command disposables.
 * @param deps - The injected configuration accessor, client, write-auth deps,
 *   and UI-refresh callbacks.
 */
export function registerEditCommands(
  context: vscode.ExtensionContext,
  deps: EditCommandDeps,
): void {
  /** Run a single field sub-flow end-to-end (preamble → flow). */
  const runField = async (field: EditField, arg: unknown): Promise<void> => {
    const target = await runPreamble(arg, deps);
    if (!target) {
      return;
    }
    await FIELD_FLOWS[field](target, deps);
  };

  // editIssue dispatcher: one preamble, then loop the chosen field's sub-flow.
  const editIssue = vscode.commands.registerCommand(
    "linearLens.editIssue",
    async (arg?: unknown) => {
      const target = await runPreamble(arg, deps);
      if (!target) {
        return;
      }
      const choice = await vscode.window.showQuickPick(dispatcherChoices(target.ctx), {
        title: `Edit Issue — ${target.id.normalized}`,
        placeHolder: "Choose a field to edit",
        ignoreFocusOut: true,
        matchOnDescription: true,
      });
      if (!choice) {
        return;
      }
      await FIELD_FLOWS[choice.field](target, deps);
    },
  );

  const setStatus = vscode.commands.registerCommand(
    "linearLens.setStatus",
    (arg?: unknown) => runField("status", arg),
  );
  const setAssignee = vscode.commands.registerCommand(
    "linearLens.setAssignee",
    (arg?: unknown) => runField("assignee", arg),
  );
  const editLabels = vscode.commands.registerCommand(
    "linearLens.editLabels",
    (arg?: unknown) => runField("labels", arg),
  );
  const setTeam = vscode.commands.registerCommand(
    "linearLens.setTeam",
    (arg?: unknown) => runField("team", arg),
  );
  const setProject = vscode.commands.registerCommand(
    "linearLens.setProject",
    (arg?: unknown) => runField("project", arg),
  );
  const setPriority = vscode.commands.registerCommand(
    "linearLens.setPriority",
    (arg?: unknown) => runField("priority", arg),
  );
  const setCycle = vscode.commands.registerCommand(
    "linearLens.setCycle",
    (arg?: unknown) => runField("cycle", arg),
  );

  context.subscriptions.push(
    editIssue,
    setStatus,
    setAssignee,
    editLabels,
    setTeam,
    setProject,
    setPriority,
    setCycle,
  );
}
