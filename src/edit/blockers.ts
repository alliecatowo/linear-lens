/**
 * Linear Lens — blocker relation commands.
 *
 * Registers:
 *  - `linearLens.addBlocker`    — "This issue blocks another issue."
 *  - `linearLens.addBlockedBy`  — "This issue is blocked by another issue."
 *  - `linearLens.removeBlocker` — Remove an existing blocking relation.
 *
 * All three commands are **[WRITE-AUTH GATE]**: they call
 * {@link ensureWriteAuth} before any mutation.  Mutations never throw;
 * errors surface as toasts. The client's `addRelation` / `removeRelation`
 * are delegated to the pure {@link LinearMutations} layer.
 *
 * This module imports `vscode` (QuickPick / InputBox glue). The underlying
 * direction-mapping and row-building logic lives in the `vscode`-free
 * {@link file://./blockerFlow.ts} module and is independently tested.
 */

import * as vscode from "vscode";

import type { IssueId, LinearClient, LinearLensConfig, LinearWriteError } from "../types";
import type { WriteAuthDeps } from "../writeAuth";
import { ensureWriteAuth } from "../writeAuth";
import { parseIssueId, scanText } from "../parser";
import { blockerRows, addBlockerInput } from "./blockerFlow";

// ---------------------------------------------------------------------------
// Dependency bag
// ---------------------------------------------------------------------------

/** Dependencies injected into {@link registerBlockerCommands} by the host. */
export interface BlockerCommandDeps {
  /** Returns the current, validated extension configuration. */
  readonly getCfg: () => LinearLensConfig;
  /** Linear API client — reads and writes; never throws. */
  readonly client: LinearClient;
  /** Write-auth deps (SecretStorage) for {@link ensureWriteAuth}. */
  readonly writeAuthDeps: WriteAuthDeps;
  /** Re-paint editor surfaces (inline status, decorations) after a write. */
  readonly refreshUi: () => void;
  /** Refresh the Activity Bar tree views after a write. */
  readonly refreshViews: () => void;
  /** Re-render the open ticket detail webview after a write. */
  readonly refreshDetail: () => void;
  /**
   * Drop cached metadata + detail for a single issue id (targeted invalidation).
   * Call after every successful write so the next hover / tree render is fresh.
   * Do NOT call `client.clearCache()` — that storms the whole cache.
   */
  readonly invalidate: (id: IssueId) => void;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Show a success information toast. Never throws.
 *
 * @param message - Human-readable confirmation, e.g. "ENG-123 updated."
 */
function showSuccess(message: string): void {
  void vscode.window.showInformationMessage(`Linear Lens: ${message}`);
}

/**
 * Map a {@link LinearWriteError} to a user-facing toast with a relevant CTA.
 * Never throws.
 *
 * @param err - The typed error returned by the client mutation.
 */
async function showWriteError(err: LinearWriteError): Promise<void> {
  try {
    const setKeyBtn = "Set Personal API Key";
    const openSettingsBtn = "Open Settings";

    switch (err.kind) {
      case "noAuth":
      case "noWriteScope":
      case "permission": {
        const choice = await vscode.window.showWarningMessage(
          `Linear Lens: ${err.message} A personal API key (full access) is the reliable write path.`,
          setKeyBtn,
        );
        if (choice === setKeyBtn) {
          await vscode.commands.executeCommand("linearLens.setApiKey");
        }
        break;
      }
      case "apiDisabled": {
        const choice = await vscode.window.showWarningMessage(
          "Linear Lens: The Linear API is disabled (linearLens.api.enable). Enable it to edit issues.",
          openSettingsBtn,
        );
        if (choice === openSettingsBtn) {
          await vscode.commands.executeCommand("workbench.action.openSettings", "linearLens.api.enable");
        }
        break;
      }
      case "network": {
        void vscode.window.showWarningMessage(
          "Linear Lens: Could not reach Linear. Check your connection and retry.",
        );
        break;
      }
      case "validation":
      case "notFound":
      default: {
        void vscode.window.showErrorMessage(`Linear Lens: ${err.message}`);
        break;
      }
    }
  } catch {
    // Never throw out of showWriteError.
  }
}

/**
 * Resolve a normalized {@link IssueId} from a command argument (a
 * `{ id: string }` / bare string), the reference under the active editor
 * cursor, or an {@link InputBox} prompt. Returns `null` when none can be
 * resolved (command should abort silently).
 *
 * Never throws.
 */
async function resolveIssueId(
  arg: unknown,
  getCfg: () => LinearLensConfig,
): Promise<IssueId | null> {
  try {
    const cfg = getCfg();

    // 1. Explicit argument from a tree node or another command.
    if (arg !== null && arg !== undefined) {
      let rawId: string | undefined;
      if (typeof arg === "string") {
        rawId = arg.trim();
      } else if (typeof arg === "object" && typeof (arg as { id?: unknown }).id === "string") {
        rawId = ((arg as { id: string }).id).trim();
      }
      if (rawId) {
        const parsed = parseIssueId(rawId, { teamKeys: cfg.teamKeys });
        if (parsed) {
          return parsed;
        }
      }
    }

    // 2. Reference under the cursor in the active editor.
    const editor = vscode.window.activeTextEditor;
    if (editor) {
      const offset = editor.document.offsetAt(editor.selection.active);
      const text = editor.document.getText();
      const refs = scanText(text, { teamKeys: cfg.teamKeys, markers: cfg.markers });
      for (const ref of refs) {
        if (offset >= ref.start && offset <= ref.end) {
          return ref.issue;
        }
      }
    }

    // 3. Prompt the user for an issue id.
    const input = await vscode.window.showInputBox({
      title: "Linear Lens: Issue ID",
      prompt: "Enter the Linear issue id to act on (e.g. ENG-123).",
      placeHolder: "ENG-123",
      ignoreFocusOut: true,
    });
    if (input === undefined) {
      return null;
    }
    const parsed = parseIssueId(input.trim(), { teamKeys: cfg.teamKeys });
    if (!parsed) {
      void vscode.window.showWarningMessage(
        `Linear Lens: "${input.trim()}" is not a valid Linear issue id.`,
      );
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

/**
 * Prompt for the OTHER issue involved in a relation.  Uses a live-search
 * QuickPick backed by {@link LinearClient.searchIssues} when possible,
 * falling back to a plain InputBox so the command still works when search
 * returns nothing.
 *
 * Returns the OTHER issue's UUID (for the relation mutation) and its
 * normalized identifier (for toasts / invalidation), or `null` on cancel.
 * Never throws.
 */
async function pickOtherIssue(
  client: LinearClient,
  getCfg: () => LinearLensConfig,
  title: string,
): Promise<{ uuid: string; id: IssueId } | null> {
  try {
    const cfg = getCfg();
    const SEARCH_LIMIT = 25;
    const DEBOUNCE_MS = 250;

    /** Map a list item to a plain QuickPickItem — label is the normalized id. */
    const toPickItem = (item: { id: string; title: string; state: string }): vscode.QuickPickItem => ({
      label: item.id,
      description: item.title,
      detail: item.state,
    });

    // Build a QuickPick with live search.
    const qp = vscode.window.createQuickPick();
    qp.title = title;
    qp.placeholder = "Type an issue id (ENG-123) or search by title…";
    qp.ignoreFocusOut = true;
    qp.busy = true;

    // Seed with recent issues so the picker isn't empty on open.
    const seed = await client.listIssues("recent", SEARCH_LIMIT);
    qp.busy = false;
    qp.items = seed.map(toPickItem);

    let debounce: ReturnType<typeof setTimeout> | undefined;

    qp.onDidChangeValue((value) => {
      if (debounce) {
        clearTimeout(debounce);
      }
      const term = value.trim();
      if (!term) {
        return;
      }
      debounce = setTimeout(async () => {
        qp.busy = true;
        try {
          const results = await client.searchIssues(term, SEARCH_LIMIT);
          qp.items = results.map(toPickItem);
        } catch {
          // Keep existing items on search failure.
        } finally {
          qp.busy = false;
        }
      }, DEBOUNCE_MS);
    });

    const chosenLabel = await new Promise<string | undefined>((resolve) => {
      qp.onDidAccept(() => {
        resolve(qp.selectedItems[0]?.label);
        qp.hide();
      });
      qp.onDidHide(() => {
        resolve(undefined);
        qp.dispose();
      });
      qp.show();
    });

    if (!chosenLabel) {
      return null;
    }

    // Parse the chosen item's label (which is the normalized id).
    const chosenId = parseIssueId(chosenLabel, { teamKeys: cfg.teamKeys });
    if (!chosenId) {
      void vscode.window.showWarningMessage(
        `Linear Lens: "${chosenLabel}" could not be parsed as a Linear issue id.`,
      );
      return null;
    }

    // Resolve the other issue's UUID via getEditContext (we need the UUID for the mutation).
    const ctx = await client.getEditContext(chosenId);
    if (!ctx || !ctx.issueUuid) {
      void vscode.window.showWarningMessage(
        `Linear Lens: Could not resolve ${chosenId.normalized}. It may not exist or API is unavailable.`,
      );
      return null;
    }

    return { uuid: ctx.issueUuid, id: chosenId };
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// addBlockerHandler (shared logic for addBlocker + addBlockedBy)
// ---------------------------------------------------------------------------

/**
 * Shared implementation for `linearLens.addBlocker` and
 * `linearLens.addBlockedBy`. Resolves the THIS issue, gates on write-auth,
 * fetches the edit context, prompts for the OTHER issue, calls
 * `addRelation`, then toasts + invalidates + refreshes.
 *
 * Never throws.
 */
async function addBlockerHandler(
  arg: unknown,
  direction: "blocks" | "blockedBy",
  deps: BlockerCommandDeps,
): Promise<void> {
  try {
    const { getCfg, client, writeAuthDeps, invalidate, refreshUi, refreshViews, refreshDetail } =
      deps;

    // 1. Resolve THIS issue id.
    const thisId = await resolveIssueId(arg, getCfg);
    if (!thisId) {
      return;
    }

    // 2. [WRITE-AUTH GATE] — check before any network read.
    const auth = await ensureWriteAuth(writeAuthDeps);
    if (!auth.ok) {
      return;
    }

    // 3. Load edit context for THIS issue (to get its UUID).
    const ctx = await client.getEditContext(thisId);
    if (!ctx) {
      void vscode.window.showWarningMessage(
        `Linear Lens: Could not load ${thisId.normalized}. It may not exist or the API is unavailable.`,
      );
      return;
    }

    // 4. Pick the OTHER issue (live-search QuickPick, fallback to InputBox).
    const addLabel =
      direction === "blocks"
        ? `Add issue that ${thisId.normalized} will BLOCK`
        : `Add issue that BLOCKS ${thisId.normalized}`;

    const other = await pickOtherIssue(client, getCfg, addLabel);
    if (!other) {
      // pickOtherIssue already showed a warning if something went wrong; if the
      // user simply cancelled, silently abort.
      return;
    }

    // Guard against self-relation.
    if (other.uuid === ctx.issueUuid) {
      void vscode.window.showWarningMessage(
        "Linear Lens: An issue cannot block itself.",
      );
      return;
    }

    // 5. Build and fire the mutation.
    const input = addBlockerInput(direction, ctx.issueUuid, other.uuid);
    const result = await client.addRelation(input);

    if (result.ok) {
      const dirLabel = direction === "blocks" ? "blocks" : "is blocked by";
      showSuccess(`${thisId.normalized} now ${dirLabel} ${other.id.normalized}.`);
      invalidate(thisId);
      invalidate(other.id);
      refreshUi();
      refreshViews();
      refreshDetail();
    } else {
      await showWriteError(result);
    }
  } catch {
    // Absolute backstop — never throw out of the handler.
  }
}

// ---------------------------------------------------------------------------
// removeBlockerHandler
// ---------------------------------------------------------------------------

/**
 * Implementation for `linearLens.removeBlocker`. Resolves THIS issue, gates
 * on write-auth, fetches the edit context, shows all existing blocker
 * relations in a QuickPick, lets the user pick one to remove, and calls
 * `removeRelation`. Toasts + invalidates + refreshes on success.
 *
 * Never throws.
 */
async function removeBlockerHandler(
  arg: unknown,
  deps: BlockerCommandDeps,
): Promise<void> {
  try {
    const { getCfg, client, writeAuthDeps, invalidate, refreshUi, refreshViews, refreshDetail } =
      deps;

    // 1. Resolve THIS issue id.
    const thisId = await resolveIssueId(arg, getCfg);
    if (!thisId) {
      return;
    }

    // 2. [WRITE-AUTH GATE].
    const auth = await ensureWriteAuth(writeAuthDeps);
    if (!auth.ok) {
      return;
    }

    // 3. Load edit context to get current relations.
    const ctx = await client.getEditContext(thisId);
    if (!ctx) {
      void vscode.window.showWarningMessage(
        `Linear Lens: Could not load ${thisId.normalized}. It may not exist or the API is unavailable.`,
      );
      return;
    }

    // 4. Build relation rows for the picker.
    const rows = blockerRows({ blocks: ctx.blocks, blockedBy: ctx.blockedBy });

    if (rows.length === 0) {
      void vscode.window.showInformationMessage(
        `Linear Lens: ${thisId.normalized} has no blocker relations to remove.`,
      );
      return;
    }

    // 5. Show a QuickPick of existing blocker relations.
    const items: (vscode.QuickPickItem & { relationId: string; relatedIdentifier: string })[] =
      rows.map((row) => ({
        label: row.label,
        description: row.direction === "blocks" ? "$(arrow-right) blocks" : "$(arrow-left) blocked by",
        relationId: row.relationId,
        relatedIdentifier: row.relatedIdentifier,
      }));

    const chosen = await vscode.window.showQuickPick(items, {
      title: `Linear Lens: Remove Blocker Relation — ${thisId.normalized}`,
      placeHolder: "Select a relation to remove",
      ignoreFocusOut: true,
    });

    if (!chosen) {
      return;
    }

    // 6. Confirm removal (a destructive action). Honors
    //    `linearLens.write.confirmDestructive`: when false, proceed silently.
    if (getCfg().confirmDestructive) {
      const confirm = await vscode.window.showWarningMessage(
        `Remove relation: ${chosen.label}?`,
        { modal: true },
        "Remove",
      );
      if (confirm !== "Remove") {
        return;
      }
    }

    // 7. Fire the mutation.
    const result = await client.removeRelation(chosen.relationId);

    if (result.ok) {
      showSuccess(`Removed blocker relation from ${thisId.normalized}.`);
      invalidate(thisId);
      // Attempt to parse the related identifier so we can also invalidate it.
      const cfg = getCfg();
      const relatedId = parseIssueId(chosen.relatedIdentifier, { teamKeys: cfg.teamKeys });
      if (relatedId) {
        invalidate(relatedId);
      }
      refreshUi();
      refreshViews();
      refreshDetail();
    } else {
      await showWriteError(result);
    }
  } catch {
    // Absolute backstop — never throw out of the handler.
  }
}

// ---------------------------------------------------------------------------
// registerBlockerCommands
// ---------------------------------------------------------------------------

/**
 * Register the three blocker relation commands on the extension context.
 *
 * Commands registered:
 *  - `linearLens.addBlocker`   — Mark another issue as blocked by THIS issue.
 *  - `linearLens.addBlockedBy` — Mark THIS issue as blocked by another issue.
 *  - `linearLens.removeBlocker`— Remove an existing blocker relation from THIS issue.
 *
 * Each command's {@link vscode.Disposable} is pushed to `context.subscriptions`
 * so it is cleaned up on extension deactivation.
 *
 * @param context - The VS Code extension context.
 * @param deps    - Injected dependencies (client, auth, refresh callbacks, …).
 */
export function registerBlockerCommands(
  context: vscode.ExtensionContext,
  deps: BlockerCommandDeps,
): void {
  context.subscriptions.push(
    vscode.commands.registerCommand(
      "linearLens.addBlocker",
      async (arg?: unknown) => {
        await addBlockerHandler(arg, "blocks", deps);
      },
    ),

    vscode.commands.registerCommand(
      "linearLens.addBlockedBy",
      async (arg?: unknown) => {
        await addBlockerHandler(arg, "blockedBy", deps);
      },
    ),

    vscode.commands.registerCommand(
      "linearLens.removeBlocker",
      async (arg?: unknown) => {
        await removeBlockerHandler(arg, deps);
      },
    ),
  );
}
