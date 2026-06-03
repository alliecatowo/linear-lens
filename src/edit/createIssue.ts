/**
 * Linear Lens — create-issue flow (EDIT spec §4, BOARD task).
 *
 * Implements the multi-step "Create Issue" wizard and registers the
 * `linearLens.createIssue` command. The wizard collects a title + description
 * (InputBox), then the team / project / priority / labels / assignee / cycle
 * (QuickPicks built from the pure {@link ../edit/editFlow} row helpers), gates on
 * WRITE access ({@link ensureWriteAuth}), performs the `createIssue` mutation
 * through the never-throwing Linear client, then offers to OPEN the new issue
 * (detail webview or Linear in the browser).
 *
 * The command is also seedable from the active editor's selected text: when a
 * non-empty selection exists it pre-fills the title InputBox.
 *
 * The PURE assembly (`buildCreateInput`) is `vscode`-free and unit-testable; the
 * QuickPick / InputBox glue is the only `vscode`-bound part.
 *
 * HARD SAFETY RULE: no real Linear writes happen during implementation /
 * verification. The mutation code path is exercised only by unit tests with a
 * MOCKED client. The client itself NEVER throws — `createIssue` returns a typed
 * {@link LinearWriteResult} and permission/validation/network errors become
 * toasts here. This module NEVER throws out of the registered command handler.
 */

import * as vscode from "vscode";

import type {
  IssueCreateFields,
  LinearClient,
  LinearLensConfig,
  LinearPriority,
  LinearWriteError,
} from "../types";
import { ensureWriteAuth, WriteAuthDeps } from "../writeAuth";
import {
  assigneeRows,
  cycleRows,
  labelRows,
  PickRow,
  priorityRows,
  projectRows,
  teamRows,
} from "./editFlow";

// ---------------------------------------------------------------------------
// Dependencies
// ---------------------------------------------------------------------------

/** Dependencies injected into {@link registerCreateCommand} by `extension.ts`. */
export interface CreateCommandDeps {
  /** Returns the current, validated extension configuration. */
  readonly getCfg: () => LinearLensConfig;
  /** Linear API client (pickers + mutation; degrades gracefully, never throws). */
  readonly client: LinearClient;
  /** Write-auth dependencies (SecretStorage) for the write-auth gate. */
  readonly writeAuthDeps: WriteAuthDeps;
  /** Refresh the Activity Bar trees after a successful create. */
  readonly refreshViews?: () => void;
}

// ---------------------------------------------------------------------------
// Pure assembly (EDIT spec §4.1) — vscode-free, unit-tested
// ---------------------------------------------------------------------------

/** Raw collected answers from the create wizard. */
export interface CreateAnswers {
  /** Issue title (required, must be non-empty after trimming). */
  title: string;
  /** Markdown description body (optional). */
  description?: string;
  /** Owning team UUID (required). */
  teamId: string;
  /** Project UUID, or `null`/omitted to leave unset. */
  projectId?: string | null;
  /** Priority Int 0–4 (omitted ⇒ Linear's default). */
  priority?: LinearPriority;
  /** Full label UUID set (optional). */
  labelIds?: string[];
  /** Assignee user UUID, or `null`/omitted to leave unassigned. */
  assigneeId?: string | null;
  /** Cycle UUID, or `null`/omitted to leave unset. */
  cycleId?: string | null;
}

/**
 * Validate + assemble wizard answers into {@link IssueCreateFields}. PURE; throws
 * nothing.
 *
 * Returns `{ ok: false, error }` when the title (after trimming) or the team id is
 * missing. On success, the title is trimmed and EMPTY optional fields are STRIPPED
 * rather than passed as `undefined`/`null` (for create, an unset field is omitted,
 * not cleared): a blank description, an empty `labelIds`, and `null`/empty
 * `projectId`/`assigneeId`/`cycleId` are all dropped. A defined `priority` is
 * coerced to the 0–4 Int (out-of-range ⇒ omitted).
 *
 * @param answers - The raw answers gathered by the wizard.
 * @returns A discriminated result carrying the assembled input or an error.
 */
export function buildCreateInput(
  answers: CreateAnswers,
):
  | { ok: true; input: IssueCreateFields }
  | { ok: false; error: string } {
  const title = (answers.title ?? "").trim();
  if (title.length === 0) {
    return { ok: false, error: "A title is required to create an issue." };
  }
  const teamId = (answers.teamId ?? "").trim();
  if (teamId.length === 0) {
    return { ok: false, error: "A team is required to create an issue." };
  }

  const input: IssueCreateFields = { title, teamId };

  const description = answers.description?.trim();
  if (description) {
    input.description = description;
  }

  const projectId = nonEmptyId(answers.projectId);
  if (projectId) {
    input.projectId = projectId;
  }

  const assigneeId = nonEmptyId(answers.assigneeId);
  if (assigneeId) {
    input.assigneeId = assigneeId;
  }

  const cycleId = nonEmptyId(answers.cycleId);
  if (cycleId) {
    input.cycleId = cycleId;
  }

  const priority = coercePriority(answers.priority);
  if (priority !== undefined) {
    input.priority = priority;
  }

  if (answers.labelIds && answers.labelIds.length > 0) {
    input.labelIds = [...answers.labelIds];
  }

  return { ok: true, input };
}

/** Return a trimmed non-empty id, or `undefined` for `null`/`undefined`/blank. */
function nonEmptyId(value: string | null | undefined): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

/** Coerce a priority to the canonical 0–4 Int, or `undefined` when out of range. */
function coercePriority(value: LinearPriority | undefined): LinearPriority | undefined {
  if (value === undefined) {
    return undefined;
  }
  const n = Number(value);
  if (Number.isInteger(n) && n >= 0 && n <= 4) {
    return n as LinearPriority;
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Result feedback (self-contained toasts; the client never throws)
// ---------------------------------------------------------------------------

/** Command id the user runs to set a personal API key (write path). */
const SET_API_KEY_COMMAND = "linearLens.setApiKey";

/**
 * Show a user-facing toast for a failed {@link LinearWriteError}, routing
 * auth/permission failures toward the personal-API-key path. Mirrors the edit
 * command module's handling so create and edit feel consistent. Never throws.
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
            ? "Linear rejected the change (your token may be read-only). Set a full-access personal API key to create issues."
            : "Creating Linear issues requires full (write) access. Set a personal API key, or try a write-capable sign-in.";
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

// ---------------------------------------------------------------------------
// QuickPick / InputBox glue (vscode-bound)
// ---------------------------------------------------------------------------

/** A QuickPick item carrying its source {@link PickRow}'s id. */
interface RowItem extends vscode.QuickPickItem {
  readonly rowId: string | null;
}

/**
 * Sentinel returned by an OPTIONAL single-select step the user dismissed (Esc),
 * distinguished from a deliberate "clear" pick (`{ chosen: null }`). The wizard
 * treats both as "leave unset" for create, but the distinction keeps the glue
 * explicit and mirrors the editCommands single-select contract.
 */
type SingleSelectOutcome = { chosen: string | null } | undefined;

/**
 * Show a single-select QuickPick built from {@link PickRow}s, returning the chosen
 * row's id (`null` for the clear sentinel) or `undefined` when cancelled / empty.
 * Pre-`picked` rows are marked with a `$(check)` glyph. Never throws.
 *
 * @param rows - The display rows.
 * @param title - The picker title.
 * @param placeholder - The picker placeholder.
 * @returns `{ chosen }` when picked, or `undefined` on cancel / empty.
 */
async function showSingleSelect(
  rows: PickRow[],
  title: string,
  placeholder: string,
): Promise<SingleSelectOutcome> {
  if (rows.length === 0) {
    return undefined;
  }
  const items: RowItem[] = rows.map((r) => ({
    label: r.picked ? `$(check) ${r.label}` : r.label,
    description: r.description,
    detail: r.detail,
    rowId: r.id,
  }));
  const picked = await vscode.window.showQuickPick(items, {
    title,
    placeHolder: placeholder,
    ignoreFocusOut: true,
    matchOnDescription: true,
  });
  if (!picked) {
    return undefined;
  }
  return { chosen: picked.rowId };
}

/**
 * Show a multi-select labels QuickPick, returning the chosen non-null ids, or
 * `undefined` when cancelled. Never throws.
 *
 * @param rows - The label rows (non-null id each).
 * @param title - The picker title.
 * @returns `{ chosen }` when accepted, or `undefined` on cancel / empty.
 */
async function showMultiSelect(
  rows: PickRow[],
  title: string,
): Promise<{ chosen: string[] } | undefined> {
  if (rows.length === 0) {
    return undefined;
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
    placeHolder: "Toggle labels, then press Enter (Esc to skip)",
    canPickMany: true,
    ignoreFocusOut: true,
    matchOnDescription: true,
  });
  if (!picked) {
    return undefined;
  }
  return { chosen: picked.map((p) => p.rowId as string) };
}

// ---------------------------------------------------------------------------
// Optional-field selection (which optional steps to fill)
// ---------------------------------------------------------------------------

/** The optional fields the user may fill after Title + Team. */
type OptionalField = "description" | "priority" | "assignee" | "project" | "cycle" | "labels";

/** A QuickPick row offering an optional field to fill. */
interface OptionalChoice extends vscode.QuickPickItem {
  readonly field: OptionalField | "create";
}

/**
 * After Title + Team are set, offer a multi-pick of which optional fields to fill,
 * plus a "Create now" fast path. Returns the selected optional fields in a fixed,
 * sensible order, or `undefined` when the user cancelled the whole wizard. An
 * empty selection (just "Create now", or nothing toggled) yields `[]` ⇒ create
 * with only Title + Team. Never throws.
 *
 * @param title - The picker title (carries the chosen team for context).
 * @returns The ordered optional fields to fill, or `undefined` to abort.
 */
async function pickOptionalFields(title: string): Promise<OptionalField[] | undefined> {
  const choices: OptionalChoice[] = [
    { field: "create", label: "$(check) Create now", detail: "Skip optional fields and create with title + team." },
    { field: "description", label: "$(note) Description" },
    { field: "priority", label: "$(arrow-up) Priority" },
    { field: "assignee", label: "$(account) Assignee" },
    { field: "project", label: "$(project) Project" },
    { field: "cycle", label: "$(sync) Cycle" },
    { field: "labels", label: "$(tag) Labels" },
  ];
  const picked = await vscode.window.showQuickPick(choices, {
    title,
    placeHolder: "Choose optional fields to fill, or 'Create now' (Esc cancels)",
    canPickMany: true,
    ignoreFocusOut: true,
  });
  if (!picked) {
    return undefined;
  }
  // Fixed display order regardless of pick order; "create" is just a no-op marker.
  const order: OptionalField[] = ["description", "priority", "assignee", "project", "cycle", "labels"];
  const selected = new Set(picked.map((p) => p.field));
  return order.filter((f) => selected.has(f));
}

// ---------------------------------------------------------------------------
// Wizard (EDIT spec §4.2)
// ---------------------------------------------------------------------------

/**
 * Seed the title from the active editor's non-empty selection, trimmed and
 * collapsed to a single line (a title is one line). Returns `undefined` when there
 * is no editor or the selection is empty. Never throws.
 */
function seedTitleFromSelection(): string | undefined {
  try {
    const editor = vscode.window.activeTextEditor;
    if (!editor || editor.selection.isEmpty) {
      return undefined;
    }
    const text = editor.document.getText(editor.selection).trim();
    if (text.length === 0) {
      return undefined;
    }
    // A Linear title is a single line; collapse newlines + runs of whitespace.
    return text.replace(/\s+/g, " ").slice(0, 250);
  } catch {
    return undefined;
  }
}

/**
 * Run the create wizard end-to-end. Returns when done (success, failure, or any
 * cancellation). Never throws.
 *
 * @param deps - The injected dependencies.
 * @param seedTitle - Optional pre-filled title (from selected text / command arg).
 */
async function runCreateWizard(
  deps: CreateCommandDeps,
  seedTitle: string | undefined,
): Promise<void> {
  const { client, getCfg } = deps;
  const cfg = getCfg();

  // Feature toggle: respect `linearLens.create.enable` when the config exposes it.
  // The field is added to `LinearLensConfig` by the integrate step; read it
  // defensively so this module compiles before/after that wiring lands and treats
  // an absent flag as "enabled".
  const enableCreate = (cfg as { enableCreate?: boolean }).enableCreate;
  if (enableCreate === false) {
    void vscode.window.showInformationMessage(
      "Linear Lens: creating issues is disabled (linearLens.create.enable).",
    );
    return;
  }

  // 1. [WRITE-AUTH GATE] before any network read so we never run a wizard the
  //    user cannot complete.
  const gate = await ensureWriteAuth(deps.writeAuthDeps);
  if (!gate.ok) {
    return;
  }

  // 2. Title (required).
  const title = await vscode.window.showInputBox({
    title: "Create Issue — Title",
    prompt: "Issue title (required).",
    placeHolder: "Short, descriptive summary",
    value: seedTitle,
    ignoreFocusOut: true,
    validateInput: (v) => (v.trim().length === 0 ? "A title is required." : undefined),
  });
  if (title === undefined) {
    return; // Cancelled.
  }

  // 3. Team (required). Default to the viewer's first team when available.
  const teams = await client.listTeams();
  if (teams.length === 0) {
    void vscode.window.showWarningMessage(
      "Linear Lens: no teams to show (you may lack access, or the list could not be loaded).",
    );
    return;
  }
  let defaultTeamId: string | undefined;
  try {
    const viewerTeams = await client.listViewerTeams();
    defaultTeamId = viewerTeams[0]?.id;
  } catch {
    defaultTeamId = undefined;
  }
  const teamPick = await showSingleSelect(
    teamRows(teams, defaultTeamId),
    "Create Issue — Team",
    "Select the owning team",
  );
  if (!teamPick || !teamPick.chosen) {
    return; // Cancelled or no team chosen.
  }
  const teamId = teamPick.chosen;

  // 4. Choose which optional fields to fill (or create now).
  const optional = await pickOptionalFields(`Create Issue — ${title.trim()}`);
  if (optional === undefined) {
    return; // Cancelled the whole wizard.
  }

  const answers: CreateAnswers = { title, teamId };

  // 5. Run the chosen optional steps in order. Esc on an optional step SKIPS that
  //    field (leaves it unset) rather than cancelling the whole create.
  for (const field of optional) {
    switch (field) {
      case "description": {
        const description = await vscode.window.showInputBox({
          title: "Create Issue — Description",
          prompt: "Markdown description (optional; Esc to skip).",
          placeHolder: "What needs doing? Why?",
          ignoreFocusOut: true,
        });
        if (description) {
          answers.description = description;
        }
        break;
      }
      case "priority": {
        const pick = await showSingleSelect(
          priorityRows(),
          "Create Issue — Priority",
          "Select a priority (Esc to skip)",
        );
        if (pick && pick.chosen !== null) {
          const n = Number.parseInt(pick.chosen, 10);
          if (Number.isInteger(n) && n >= 0 && n <= 4) {
            answers.priority = n as LinearPriority;
          }
        }
        break;
      }
      case "assignee": {
        const users = await client.listUsers();
        const pick = await showSingleSelect(
          assigneeRows(users),
          "Create Issue — Assignee",
          "Select an assignee (Esc to skip)",
        );
        if (pick) {
          answers.assigneeId = pick.chosen; // null ⇒ Unassigned (stripped on build).
        }
        break;
      }
      case "project": {
        const projects = await client.listProjects();
        const pick = await showSingleSelect(
          projectRows(projects),
          "Create Issue — Project",
          "Select a project (Esc to skip)",
        );
        if (pick) {
          answers.projectId = pick.chosen;
        }
        break;
      }
      case "cycle": {
        const cycles = await client.listCycles(teamId);
        const pick = await showSingleSelect(
          cycleRows(cycles),
          "Create Issue — Cycle",
          "Select a cycle (Esc to skip)",
        );
        if (pick) {
          answers.cycleId = pick.chosen;
        }
        break;
      }
      case "labels": {
        const labels = await client.listLabels(teamId);
        const pick = await showMultiSelect(labelRows(labels, []), "Create Issue — Labels");
        if (pick) {
          answers.labelIds = pick.chosen;
        }
        break;
      }
      default:
        break;
    }
  }

  // 6. Assemble + validate the input.
  const built = buildCreateInput(answers);
  if (!built.ok) {
    void vscode.window.showWarningMessage(`Linear Lens: ${built.error}`);
    return;
  }

  // 7. Mutate (the client never throws).
  const result = await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: "Linear Lens: creating issue…" },
    () => client.createIssue(built.input),
  );

  if (!result.ok) {
    await showWriteError(result, deps.writeAuthDeps);
    return;
  }

  // 8. Success: refresh trees + offer to open the new issue.
  try {
    deps.refreshViews?.();
  } catch {
    // Refreshing the UI must never surface as a failure.
  }
  await offerOpen(result.value.identifier, result.value.url);
}

/**
 * Show the success toast for a created issue and offer to open it: in the detail
 * webview (`linearLens.openTicket`) when a human identifier is available, or in
 * the browser (`openExternal`) when a URL is available. Never throws.
 *
 * @param identifier - The created issue's human identifier (may be empty).
 * @param url - The created issue's canonical URL, if Linear returned one.
 */
async function offerOpen(identifier: string, url: string | undefined): Promise<void> {
  const label = identifier && identifier.length > 0 ? identifier : "issue";
  const open = "Open";
  const openInLinear = "Open in Linear";

  const buttons: string[] = [];
  if (identifier && identifier.length > 0) {
    buttons.push(open);
  }
  if (url) {
    buttons.push(openInLinear);
  }

  try {
    const choice = await vscode.window.showInformationMessage(
      `Linear Lens: created ${label}.`,
      ...buttons,
    );
    if (choice === open && identifier) {
      await vscode.commands.executeCommand("linearLens.openTicket", { id: identifier });
    } else if (choice === openInLinear && url) {
      await vscode.env.openExternal(vscode.Uri.parse(url));
    }
  } catch {
    // Opening must never surface as a failure.
  }
}

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

/**
 * Register the `linearLens.createIssue` command. The handler resolves an optional
 * seed title (from a string / `{ title }` argument, else the active editor's
 * selected text), then runs the create wizard. The disposable is pushed onto
 * `context.subscriptions`.
 *
 * @param context - The extension context owning the command disposable.
 * @param deps - The injected configuration accessor, client, write-auth deps, and
 *   the views-refresh callback.
 */
export function registerCreateCommand(
  context: vscode.ExtensionContext,
  deps: CreateCommandDeps,
): void {
  const createIssue = vscode.commands.registerCommand(
    "linearLens.createIssue",
    async (arg?: unknown) => {
      try {
        const seed = seedTitleFromArg(arg) ?? seedTitleFromSelection();
        await runCreateWizard(deps, seed);
      } catch {
        // Absolute backstop: the command handler must never throw.
        void vscode.window.showErrorMessage(
          "Linear Lens: could not create the issue. Please try again.",
        );
      }
    },
  );
  context.subscriptions.push(createIssue);
}

/**
 * Extract a seed title from a loosely-typed command argument: a bare string, or
 * an `{ title }` object. Returns `undefined` otherwise. Pure; never throws.
 *
 * @param arg - The loosely-typed command argument.
 * @returns The trimmed seed title, or `undefined`.
 */
function seedTitleFromArg(arg: unknown): string | undefined {
  if (typeof arg === "string") {
    const trimmed = arg.trim();
    return trimmed.length > 0 ? trimmed : undefined;
  }
  if (typeof arg === "object" && arg !== null) {
    const candidate = (arg as { title?: unknown }).title;
    if (typeof candidate === "string") {
      const trimmed = candidate.trim();
      return trimmed.length > 0 ? trimmed : undefined;
    }
  }
  return undefined;
}
