/**
 * Linear Lens — "Go to Linear Issue" quick-pick command.
 *
 * Presents a VS Code QuickPick populated with the viewer's recent/assigned
 * issues (when authenticated). As the user types, it debounces and queries
 * Linear's `searchIssues` API (minimum 2 characters). Selecting an item opens
 * the issue in the browser (or the detail webview when V3 lands).
 *
 * When unauthenticated (or when the API is disabled), the picker falls back to
 * a plain free-text ID entry: the user types an issue ID (e.g. "ENG-123") and
 * pressing Enter opens it.
 *
 * Exported as {@link goToIssue}, registered by the integrate step as
 * `linearLens.goToIssue`.
 *
 * Never throws — all errors are swallowed and the picker degrades gracefully.
 */

import * as vscode from "vscode";
import type { LinearClient, LinearLensConfig, IssueListItem } from "../types";
import { parseIssueId } from "../parser";
import { issueUrl } from "../config";

/** Default cap on the number of list/search results to show. */
const DEFAULT_LIMIT = 25;

/** Minimum number of characters before a live search query fires. */
const SEARCH_MIN_CHARS = 2;

/** Debounce delay for live search (ms). */
const SEARCH_DEBOUNCE_MS = 250;

// ---------------------------------------------------------------------------
// Quick-pick item type
// ---------------------------------------------------------------------------

/**
 * A quick-pick item carrying enough data to open the selected issue.
 * Extends {@link vscode.QuickPickItem} so the VS Code API types correctly.
 */
interface IssuePickItem extends vscode.QuickPickItem {
  /** Normalized issue identifier, e.g. "ENG-123". Used for fallback URL build. */
  id: string;
  /** Canonical Linear URL for this issue. May be "" for sign-in / fallback items. */
  url: string;
  /** True when this is the sign-in placeholder. */
  isSignIn?: boolean;
  /** True when this is the fallback "open by ID" manual entry. */
  isManualEntry?: boolean;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Build a state-indicator prefix string (unicode circle) based on the state
 * type. Used in the item description to give a quick visual cue without
 * relying on icons (QuickPick items support limited icon surface).
 *
 * @param stateType - The Linear state type string, e.g. "started".
 */
function statePrefix(stateType: string | undefined): string {
  switch (stateType) {
    case "completed":
      return "● ";
    case "canceled":
      return "✕ ";
    case "started":
      return "◑ ";
    case "backlog":
      return "○ ";
    default:
      return "○ ";
  }
}

/**
 * Convert an {@link IssueListItem} to an {@link IssuePickItem} for display in
 * the QuickPick.
 */
function toPickItem(item: IssueListItem): IssuePickItem {
  const prefix = statePrefix(item.stateType);
  const assigneePart = item.assignee ? `  ·  ${item.assignee}` : "";
  return {
    id: item.id,
    url: item.url,
    label: `$(issues) ${item.id}  ${item.title}`,
    description: `${prefix}${item.state}${assigneePart}`,
    alwaysShow: true,
  };
}

/**
 * Build the single sign-in placeholder item shown when the user is not
 * authenticated. Clicking it triggers `linearLens.signIn`.
 */
function makeSignInItem(): IssuePickItem {
  return {
    id: "",
    url: "",
    isSignIn: true,
    label: "$(sign-in) Sign in to Linear",
    description: "Authenticate to search and browse your issues",
    alwaysShow: true,
  };
}

/**
 * Build a manual "open issue by ID" fallback item shown below live results (or
 * as the only item when there is no auth). The user types an ID like "ENG-123"
 * and selecting this item opens it.
 *
 * @param input - The current raw input text (may be empty or invalid).
 */
function makeManualEntryItem(input: string): IssuePickItem {
  const trimmed = input.trim();
  if (trimmed) {
    return {
      id: trimmed,
      url: "",
      isManualEntry: true,
      label: `$(link-external) Open "${trimmed}"`,
      description: "Open this issue ID in Linear",
      alwaysShow: true,
    };
  }
  return {
    id: "",
    url: "",
    isManualEntry: true,
    label: "$(link-external) Enter an issue ID to open…",
    description: 'e.g. ENG-123',
    alwaysShow: true,
  };
}

// ---------------------------------------------------------------------------
// Core command implementation
// ---------------------------------------------------------------------------

/**
 * Show the "Go to Linear Issue" quick-pick command.
 *
 * **Authenticated flow:**
 * - Seeds with `client.listIssues("recent", limit)` so the box is immediately
 *   useful on open.
 * - Debounces `onDidChangeValue` at {@link SEARCH_DEBOUNCE_MS} ms; fires a
 *   live `client.searchIssues` when the typed text is ≥ {@link SEARCH_MIN_CHARS}.
 *   Falls back to the recent list for shorter / empty inputs.
 * - A manual "open by ID" item always appears at the bottom.
 *
 * **Unauthenticated fallback:**
 * - Shows a "Sign in to Linear" item and a "Enter an issue ID" manual entry.
 * - Manual entry parses the typed text as an issue ID using
 *   {@link parseIssueId} and opens a constructed URL using the configured
 *   workspace slug.
 *
 * @param getCfg - Accessor for the current extension configuration.
 * @param client - The Linear API client (must implement listIssues / searchIssues).
 */
export async function goToIssue(
  getCfg: () => LinearLensConfig,
  client: LinearClient,
): Promise<void> {
  try {
    const limit = DEFAULT_LIMIT;
    const isAuthed = client.hasAuth();

    const qp = vscode.window.createQuickPick<IssuePickItem>();
    qp.placeholder = isAuthed ? "Search issues or type an ID (e.g. ENG-123)…" : "Enter an issue ID to open (e.g. ENG-123)";
    qp.matchOnDescription = true;
    qp.matchOnDetail = false;

    /** Pending debounce timer handle. */
    let debounceTimer: ReturnType<typeof setTimeout> | undefined;

    /**
     * Open the given item: prefer the canonical `url` from the API, fall back
     * to constructing one from the workspace slug + parsed id.
     */
    const openItem = async (item: IssuePickItem): Promise<void> => {
      if (item.isSignIn) {
        await vscode.commands.executeCommand("linearLens.signIn");
        return;
      }

      // Use the item's URL when present; otherwise build one from the id.
      let target = item.url;
      if (!target) {
        const parsed = parseIssueId(item.id, { teamKeys: getCfg().teamKeys });
        if (!parsed) {
          void vscode.window.showWarningMessage(
            `Linear Lens: "${item.id}" is not a valid Linear issue ID.`,
          );
          return;
        }
        const slug = getCfg().workspaceSlug;
        if (!slug) {
          // Prompt to configure the workspace slug.
          const choice = await vscode.window.showWarningMessage(
            "Linear Lens: no workspace slug configured, so the issue URL is incomplete.",
            "Configure Workspace Slug",
          );
          if (choice === "Configure Workspace Slug") {
            await vscode.commands.executeCommand("linearLens.configureWorkspace");
          }
          return;
        }
        target = issueUrl(parsed, slug);
      }

      await vscode.env.openExternal(vscode.Uri.parse(target));
    };

    if (!isAuthed) {
      // Unauthenticated: show sign-in + manual entry only.
      qp.items = [makeSignInItem(), makeManualEntryItem("")];

      qp.onDidChangeValue((value) => {
        qp.items = [makeSignInItem(), makeManualEntryItem(value)];
      });

      qp.onDidAccept(async () => {
        const [selected] = qp.selectedItems;
        if (!selected) {
          return;
        }
        // For manual entry when signed out, use the raw input.
        const effectiveItem: IssuePickItem = selected.isManualEntry
          ? { ...selected, id: qp.value.trim() || selected.id }
          : selected;
        qp.hide();
        await openItem(effectiveItem);
      });

      qp.show();
      return;
    }

    // Authenticated: seed with recent issues, then provide live search.
    qp.busy = true;
    qp.items = [makeManualEntryItem("")];

    // Fetch seed items (recent issues) immediately.
    const seedItems = await client.listIssues("recent", limit);
    qp.busy = false;

    // Build the initial item list: recent results + manual entry at bottom.
    const buildItems = (results: IssueListItem[], rawInput: string): IssuePickItem[] => {
      const pickItems = results.map(toPickItem);
      pickItems.push(makeManualEntryItem(rawInput));
      return pickItems;
    };

    qp.items = buildItems(seedItems, "");

    /** The most-recently-seeded/searched result list (for re-appending the footer). */
    let latestResults: IssueListItem[] = seedItems;

    qp.onDidChangeValue((value) => {
      // Clear any pending debounce.
      if (debounceTimer !== undefined) {
        clearTimeout(debounceTimer);
        debounceTimer = undefined;
      }

      const trimmed = value.trim();

      if (trimmed.length < SEARCH_MIN_CHARS) {
        // Revert to seed list when input is too short.
        qp.items = buildItems(latestResults, value);
        return;
      }

      // Debounce live search.
      debounceTimer = setTimeout(async () => {
        debounceTimer = undefined;
        qp.busy = true;
        try {
          const results = await client.searchIssues(trimmed, limit);
          latestResults = results.length > 0 ? results : seedItems;
          qp.items = buildItems(latestResults, value);
        } catch {
          // Keep current items on error.
        } finally {
          qp.busy = false;
        }
      }, SEARCH_DEBOUNCE_MS);
    });

    qp.onDidAccept(async () => {
      if (debounceTimer !== undefined) {
        clearTimeout(debounceTimer);
        debounceTimer = undefined;
      }
      const [selected] = qp.selectedItems;
      if (!selected) {
        return;
      }
      // For the manual entry item, use the live input value as the id.
      const effectiveItem: IssuePickItem = selected.isManualEntry
        ? { ...selected, id: qp.value.trim() || selected.id }
        : selected;
      qp.hide();
      await openItem(effectiveItem);
    });

    qp.onDidHide(() => {
      if (debounceTimer !== undefined) {
        clearTimeout(debounceTimer);
        debounceTimer = undefined;
      }
      qp.dispose();
    });

    qp.show();
  } catch {
    // Absolute backstop: goToIssue must never throw.
  }
}
