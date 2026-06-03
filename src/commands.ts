import * as vscode from "vscode";
import type { IssueId, IssueRef, LinearLensConfig, LinearClient } from "./types";
import type { BranchStatusBar } from "./branch";
import type { DiagnosticsManager } from "./diagnostics";
import type { FileIssuesProvider } from "./views/fileIssuesProvider";
import type { IssueListProvider } from "./views/issueListProvider";
import type { LinearTreeNode } from "./views/issueTreeModel";
import {
  signInToLinear,
  signOutOfLinear,
  isLinearConnectInstalled,
  getLinearAccountLabel,
  LINEAR_CONNECT_EXTENSION_ID,
} from "./auth";
import { CONFIG_SECTION, issueUrl } from "./config";
import { parseIssueId, scanText } from "./parser";
import { goToIssue } from "./search/issueQuickPick";
import { API_KEY_SECRET } from "./linearClient";

/**
 * Dependencies injected into {@link registerCommands}. The integration layer
 * (`src/extension.ts`) constructs these and owns their lifecycles.
 */
export interface CommandDeps {
  /** Returns the current, validated extension configuration. */
  getCfg: () => LinearLensConfig;
  /** Optional Linear API client (degrades gracefully). */
  client: LinearClient;
  /** Branch status bar, providing the current branch's issue id. */
  branch: BranchStatusBar;
  /** Diagnostics manager, for forced refreshes. */
  diagnostics: DiagnosticsManager;
  /** Re-read config after a setting changes (extension.ts provides this). */
  refreshConfig: () => void;
  /** Re-apply decorations / refresh UI after an auth or cache change. */
  refreshUi: () => void;
  /** SecretStorage for API key commands. */
  secrets: vscode.SecretStorage;
  /** The Activity Bar tree views, for refresh / reveal commands. */
  views: ViewDeps;
}

/** The Activity Bar tree providers + the file tree view handle (spec V2 §7). */
export interface ViewDeps {
  /** "Issues in This File" provider. */
  file: FileIssuesProvider;
  /** "My Issues" provider (scope "mine"). */
  mine: IssueListProvider;
  /** "Assigned / Recent" provider (scope "recent"). */
  recent: IssueListProvider;
  /** The file tree view handle, needed to `reveal()` a node. */
  fileTreeView: vscode.TreeView<LinearTreeNode>;
}

/**
 * An issue argument passed by a tree node or another command — carries a
 * normalized id and (optionally) a canonical URL. Loosely typed because it
 * crosses the command boundary; {@link asIssueArg} validates it.
 */
interface IssueArg {
  /** Normalized issue id, e.g. "ENG-123". */
  id: string;
  /** Canonical Linear URL, when the caller already resolved one. */
  url?: string;
}

/**
 * Validate a loosely-typed command argument into an {@link IssueArg}. Returns
 * `null` when there is no usable id. Accepts either a bare id string or an
 * `{ id, url }` object (as the tree nodes pass). Never throws.
 */
function asIssueArg(raw: unknown): IssueArg | null {
  if (typeof raw === "string") {
    const id = raw.trim();
    return id ? { id } : null;
  }
  if (typeof raw === "object" && raw !== null) {
    const candidate = raw as { id?: unknown; url?: unknown };
    const id = typeof candidate.id === "string" ? candidate.id.trim() : "";
    if (!id) {
      return null;
    }
    const url = typeof candidate.url === "string" ? candidate.url.trim() : undefined;
    return { id, url: url || undefined };
  }
  return null;
}

/**
 * Find the recognized Linear reference whose token contains (or is nearest after)
 * the given offset in the active editor's document. Used by the editor-context
 * and reveal commands. Returns `null` when there is no reference at the cursor.
 */
function refUnderCursor(
  document: vscode.TextDocument,
  offset: number,
  cfg: LinearLensConfig,
): IssueRef | null {
  const refs = scanText(document.getText(), {
    teamKeys: cfg.teamKeys,
    markers: cfg.markers,
  });
  for (const ref of refs) {
    if (offset >= ref.start && offset <= ref.end) {
      return ref;
    }
  }
  return null;
}

/**
 * Open the configured workspace's issue URL externally, guarding against an
 * unconfigured workspace slug by offering to run the configure command.
 */
async function openIssueUrl(issue: ReturnType<typeof parseIssueId>, cfg: LinearLensConfig): Promise<void> {
  if (!issue) {
    return;
  }
  if (!cfg.workspaceSlug) {
    const choice = await vscode.window.showWarningMessage(
      "Linear Lens: no workspace slug configured, so the issue URL is incomplete.",
      "Configure Workspace Slug",
    );
    if (choice === "Configure Workspace Slug") {
      await vscode.commands.executeCommand("linearLens.configureWorkspace");
    }
    return;
  }
  const url = issueUrl(issue, cfg.workspaceSlug);
  await vscode.env.openExternal(vscode.Uri.parse(url));
}

/**
 * Register every contributed command. Each registration's disposable is pushed
 * to `context.subscriptions` so it is cleaned up on deactivation.
 */
export function registerCommands(context: vscode.ExtensionContext, deps: CommandDeps): void {
  const { getCfg, client, branch, diagnostics, refreshConfig, refreshUi, secrets, views } = deps;

  /** Refresh all three Activity Bar tree views. */
  const refreshViewsAll = (): void => {
    views.file.refresh();
    views.mine.refresh();
    views.recent.refresh();
  };

  /**
   * Re-publish the `linearLens.authed` context key from the client's current auth
   * state. The session-change listener in extension.ts covers OAuth sign-in/out,
   * but a personal-API-key set/clear fires no session event — so these commands
   * update the key directly, keeping viewsWelcome / view-title menus in sync.
   */
  const setAuthedContext = (): void => {
    let authed = false;
    try {
      authed = client.hasAuth();
    } catch {
      authed = false;
    }
    void vscode.commands.executeCommand("setContext", "linearLens.authed", authed);
  };

  const configureWorkspace = vscode.commands.registerCommand("linearLens.configureWorkspace", async () => {
    const cfg = getCfg();
    const value = await vscode.window.showInputBox({
      title: "Linear Lens: Configure Workspace Slug",
      prompt: "Your Linear workspace slug (used to build issue URLs).",
      placeHolder: "acme",
      value: cfg.workspaceSlug,
      ignoreFocusOut: true,
    });
    if (value === undefined) {
      return;
    }
    const slug = value.trim();
    const configuration = vscode.workspace.getConfiguration(CONFIG_SECTION);
    const target = vscode.workspace.workspaceFolders && vscode.workspace.workspaceFolders.length > 0
      ? vscode.ConfigurationTarget.Workspace
      : vscode.ConfigurationTarget.Global;
    await configuration.update("workspaceSlug", slug, target);
    refreshConfig();
    void vscode.window.showInformationMessage(
      slug ? `Linear Lens: workspace slug set to "${slug}".` : "Linear Lens: workspace slug cleared.",
    );
  });

  const openIssue = vscode.commands.registerCommand("linearLens.openIssue", async (arg?: unknown) => {
    const cfg = getCfg();

    // Tree nodes (and other commands) pass `{ id, url }`; honor it directly so a
    // node click opens the canonical URL without re-prompting.
    const fromArg = asIssueArg(arg);
    if (fromArg) {
      if (fromArg.url) {
        await vscode.env.openExternal(vscode.Uri.parse(fromArg.url));
        return;
      }
      const parsed = parseIssueId(fromArg.id, { teamKeys: cfg.teamKeys });
      if (parsed) {
        await openIssueUrl(parsed, cfg);
        return;
      }
    }

    // No usable arg (e.g. editor context menu): open the reference under the
    // cursor so the command matches the menu's `refUnderCursor` guard.
    const editor = vscode.window.activeTextEditor;
    if (editor) {
      const offset = editor.document.offsetAt(editor.selection.active);
      const ref = refUnderCursor(editor.document, offset, cfg);
      if (ref) {
        await openIssueUrl(ref.issue, cfg);
        return;
      }
    }

    const input = await vscode.window.showInputBox({
      title: "Linear Lens: Open Issue",
      prompt: "Enter a Linear issue id to open.",
      placeHolder: "ENG-123",
      ignoreFocusOut: true,
    });
    if (input === undefined) {
      return;
    }
    const issue = parseIssueId(input, { teamKeys: cfg.teamKeys });
    if (!issue) {
      void vscode.window.showWarningMessage(`Linear Lens: "${input.trim()}" is not a valid Linear issue id.`);
      return;
    }
    await openIssueUrl(issue, cfg);
  });

  const copyIssueLink = vscode.commands.registerCommand("linearLens.copyIssueLink", async (arg?: unknown) => {
    const cfg = getCfg();

    // Tree nodes pass `{ id, url }`; copy the canonical URL straight away.
    const fromArg = asIssueArg(arg);
    if (fromArg?.url) {
      await vscode.env.clipboard.writeText(fromArg.url);
      void vscode.window.showInformationMessage(`Linear Lens: copied link to ${fromArg.id}.`);
      return;
    }

    // No arg id (e.g. editor context menu): fall back to the reference under the
    // cursor so the command matches the menu's `refUnderCursor` guard.
    let cursorId: string | undefined;
    if (!fromArg?.id) {
      const editor = vscode.window.activeTextEditor;
      if (editor) {
        const offset = editor.document.offsetAt(editor.selection.active);
        cursorId = refUnderCursor(editor.document, offset, cfg)?.issue.normalized;
      }
    }

    const input = fromArg?.id ?? cursorId ?? (await vscode.window.showInputBox({
      title: "Linear Lens: Copy Issue Link",
      prompt: "Enter a Linear issue id to copy a link for.",
      placeHolder: "ENG-123",
      ignoreFocusOut: true,
    }));
    if (input === undefined) {
      return;
    }
    const issue = parseIssueId(input, { teamKeys: cfg.teamKeys });
    if (!issue) {
      void vscode.window.showWarningMessage(`Linear Lens: "${input.trim()}" is not a valid Linear issue id.`);
      return;
    }
    if (!cfg.workspaceSlug) {
      const choice = await vscode.window.showWarningMessage(
        "Linear Lens: no workspace slug configured, so the issue URL is incomplete.",
        "Configure Workspace Slug",
      );
      if (choice === "Configure Workspace Slug") {
        await vscode.commands.executeCommand("linearLens.configureWorkspace");
      }
      return;
    }
    const url = issueUrl(issue, cfg.workspaceSlug);
    await vscode.env.clipboard.writeText(url);
    void vscode.window.showInformationMessage(`Linear Lens: copied link to ${issue.normalized}.`);
  });

  const refreshCache = vscode.commands.registerCommand("linearLens.refreshCache", async () => {
    client.clearCache();
    diagnostics.refreshAll(vscode.workspace.textDocuments);
    branch.refresh();
    await client.refreshAuth();
    refreshUi();
    refreshViewsAll();
    void vscode.window.showInformationMessage("Linear Lens: issue cache refreshed.");
  });

  const openCurrentBranchIssue = vscode.commands.registerCommand("linearLens.openCurrentBranchIssue", async () => {
    const id = branch.current();
    if (!id) {
      void vscode.window.showWarningMessage("Linear Lens: no Linear issue in the current branch.");
      return;
    }
    await openIssueUrl(id, getCfg());
  });

  const signIn = vscode.commands.registerCommand("linearLens.signIn", async () => {
    const session = await signInToLinear();
    if (session) {
      await client.refreshAuth();
      setAuthedContext();
      refreshUi();
      refreshViewsAll();
      void vscode.window.showInformationMessage(`Linear Lens: signed in to Linear as ${session.account.label}.`);
    }
  });

  const signOut = vscode.commands.registerCommand("linearLens.signOut", async () => {
    await signOutOfLinear();
    await client.refreshAuth();
    setAuthedContext();
    refreshUi();
    refreshViewsAll();
    void vscode.window.showInformationMessage("Linear Lens: signed out of Linear.");
  });

  const showAuthStatus = vscode.commands.registerCommand("linearLens.showAuthStatus", async () => {
    try {
      const connectInstalled = isLinearConnectInstalled();
      const accountLabel = await getLinearAccountLabel();
      const hasApiKey = !!(await secrets.get(API_KEY_SECRET));

      const signedIn = accountLabel !== undefined;

      let statusLine: string;
      if (signedIn) {
        statusLine = `Signed in as: **${accountLabel}**`;
      } else if (hasApiKey) {
        statusLine = "Not signed in via OAuth. Personal API key is set.";
      } else {
        statusLine = "Not signed in. No personal API key set.";
      }

      const connectLine = connectInstalled
        ? "Linear Connect extension: installed."
        : "Linear Connect extension: **not installed** — required for OAuth sign-in.";

      const message = [statusLine, connectLine].join("\n\n");

      // Build button list based on state
      const buttons: string[] = [];
      if (signedIn) {
        buttons.push("Sign out");
      } else {
        buttons.push("Sign in");
      }
      if (!connectInstalled) {
        buttons.push("Install Linear Connect");
      }
      buttons.push("Set Personal API Key");
      buttons.push("Open Settings");

      const choice = await vscode.window.showInformationMessage(message, ...buttons);

      if (choice === "Sign in") {
        await vscode.commands.executeCommand("linearLens.signIn");
      } else if (choice === "Sign out") {
        await vscode.commands.executeCommand("linearLens.signOut");
      } else if (choice === "Install Linear Connect") {
        await vscode.commands.executeCommand(
          "workbench.extensions.installExtension",
          LINEAR_CONNECT_EXTENSION_ID,
        );
      } else if (choice === "Set Personal API Key") {
        await vscode.commands.executeCommand("linearLens.setApiKey");
      } else if (choice === "Open Settings") {
        await vscode.commands.executeCommand("workbench.action.openSettings", "linearLens");
      }
    } catch {
      // Never throw from showAuthStatus
    }
  });

  const setApiKey = vscode.commands.registerCommand("linearLens.setApiKey", async () => {
    const key = await vscode.window.showInputBox({
      title: "Linear Lens: Set Linear API Key",
      prompt: "Paste your Linear personal API key. It is stored securely in SecretStorage.",
      password: true,
      ignoreFocusOut: true,
    });
    if (key === undefined) {
      return;
    }
    const trimmed = key.trim();
    if (!trimmed) {
      void vscode.window.showWarningMessage("Linear Lens: no API key entered.");
      return;
    }
    await secrets.store(API_KEY_SECRET, trimmed);
    await client.refreshAuth();
    setAuthedContext();
    refreshUi();
    refreshViewsAll();
    void vscode.window.showInformationMessage("Linear Lens: Linear API key saved.");

    const cfg = getCfg();
    if (!cfg.enableApi) {
      const choice = await vscode.window.showInformationMessage(
        "Linear Lens: the Linear API is disabled, so rich hovers will not fetch metadata. Enable it?",
        "Enable API",
      );
      if (choice === "Enable API") {
        const configuration = vscode.workspace.getConfiguration(CONFIG_SECTION);
        await configuration.update("api.enable", true, vscode.ConfigurationTarget.Global);
        refreshConfig();
        await client.refreshAuth();
        refreshUi();
      }
    }
  });

  const clearApiKey = vscode.commands.registerCommand("linearLens.clearApiKey", async () => {
    await secrets.delete(API_KEY_SECRET);
    await client.refreshAuth();
    setAuthedContext();
    refreshUi();
    refreshViewsAll();
    void vscode.window.showInformationMessage("Linear Lens: Linear API key cleared.");
  });

  // --- V2: search / navigation / view commands -----------------------------

  /** Open the fuzzy "Go to Linear Issue" quick-pick (search + recent + open by id). */
  const searchIssues = vscode.commands.registerCommand("linearLens.searchIssues", async () => {
    await goToIssue(getCfg, client);
  });

  /** Manually refresh all three Activity Bar tree views. */
  const refreshViews = vscode.commands.registerCommand("linearLens.refreshViews", () => {
    refreshViewsAll();
  });

  /**
   * Reveal a file reference (arg-only, palette-hidden): open the active document
   * at the given 0-based line and place the cursor there. Tolerates missing args.
   */
  const revealFileRef = vscode.commands.registerCommand("linearLens.revealFileRef", async (arg?: unknown) => {
    const line = readLineArg(arg);
    if (line === undefined) {
      return;
    }
    const editor = vscode.window.activeTextEditor;
    if (!editor) {
      return;
    }
    const clamped = Math.max(0, Math.min(line, editor.document.lineCount - 1));
    const pos = new vscode.Position(clamped, 0);
    const range = new vscode.Range(pos, pos);
    editor.selection = new vscode.Selection(pos, pos);
    editor.revealRange(range, vscode.TextEditorRevealType.InCenterIfOutsideViewport);
  });

  /** Jump the cursor to the next Linear reference after it (wraps to the top). */
  const jumpToNextReference = vscode.commands.registerCommand("linearLens.jumpToNextReference", () => {
    jumpToReference("next");
  });

  /** Jump the cursor to the previous Linear reference before it (wraps to the bottom). */
  const jumpToPreviousReference = vscode.commands.registerCommand("linearLens.jumpToPreviousReference", () => {
    jumpToReference("previous");
  });

  /**
   * Move the active editor's cursor to the reference after/before its current
   * position, wrapping around the document. No network. Never throws.
   */
  function jumpToReference(direction: "next" | "previous"): void {
    const editor = vscode.window.activeTextEditor;
    if (!editor) {
      return;
    }
    const cfg = getCfg();
    const document = editor.document;
    const refs = scanText(document.getText(), { teamKeys: cfg.teamKeys, markers: cfg.markers });
    if (refs.length === 0) {
      void vscode.window.showInformationMessage("Linear Lens: no Linear references in this file.");
      return;
    }
    const cursor = document.offsetAt(editor.selection.active);

    let target: IssueRef | undefined;
    if (direction === "next") {
      target = refs.find((ref) => ref.start > cursor) ?? refs[0];
    } else {
      for (let i = refs.length - 1; i >= 0; i--) {
        if (refs[i].start < cursor) {
          target = refs[i];
          break;
        }
      }
      target = target ?? refs[refs.length - 1];
    }

    const start = document.positionAt(target.start);
    const end = document.positionAt(target.end);
    editor.selection = new vscode.Selection(start, end);
    editor.revealRange(new vscode.Range(start, end), vscode.TextEditorRevealType.InCenterIfOutsideViewport);
  }

  /**
   * Copy the normalized issue id to the clipboard. Resolves the id from a passed
   * `{ id }`/string arg (tree node) or the reference under the cursor.
   */
  const copyIssueId = vscode.commands.registerCommand("linearLens.copyIssueId", async (arg?: unknown) => {
    const cfg = getCfg();
    const fromArg = asIssueArg(arg);
    let id: string | undefined = fromArg?.id;

    if (!id) {
      const editor = vscode.window.activeTextEditor;
      if (editor) {
        const offset = editor.document.offsetAt(editor.selection.active);
        const ref = refUnderCursor(editor.document, offset, cfg);
        id = ref?.issue.normalized;
      }
    }

    if (!id) {
      void vscode.window.showWarningMessage("Linear Lens: no Linear issue id at the cursor.");
      return;
    }

    // Normalize loose ids (e.g. lowercase from a tree label) when possible.
    const parsed = parseIssueId(id, { teamKeys: cfg.teamKeys });
    const normalized = parsed?.normalized ?? id;
    await vscode.env.clipboard.writeText(normalized);
    void vscode.window.showInformationMessage(`Linear Lens: copied ${normalized}.`);
  });

  /**
   * Reveal the issue under the cursor in the "Issues in This File" view. Focuses
   * the view and reveals the matching file-ref node when present.
   */
  const revealInLinearView = vscode.commands.registerCommand("linearLens.revealInLinearView", async (arg?: unknown) => {
    const cfg = getCfg();
    const fromArg = asIssueArg(arg);
    let id: IssueId | null = fromArg ? parseIssueId(fromArg.id, { teamKeys: cfg.teamKeys }) : null;

    if (!id) {
      const editor = vscode.window.activeTextEditor;
      if (editor) {
        const offset = editor.document.offsetAt(editor.selection.active);
        const ref = refUnderCursor(editor.document, offset, cfg);
        id = ref?.issue ?? null;
      }
    }

    if (!id) {
      void vscode.window.showWarningMessage("Linear Lens: no Linear issue id at the cursor.");
      return;
    }

    try {
      // Focus the file view; its children reflect the active editor's refs.
      await vscode.commands.executeCommand("linearLens.viewFile.focus");
      const node = await findFileNode(views.file, id.normalized);
      if (node) {
        await views.fileTreeView.reveal(node, { select: true, focus: true });
      }
    } catch {
      // Reveal is best-effort; focusing the view is enough on failure.
    }
  });

  context.subscriptions.push(
    configureWorkspace,
    openIssue,
    copyIssueLink,
    refreshCache,
    openCurrentBranchIssue,
    signIn,
    signOut,
    showAuthStatus,
    setApiKey,
    clearApiKey,
    searchIssues,
    refreshViews,
    revealFileRef,
    jumpToNextReference,
    jumpToPreviousReference,
    copyIssueId,
    revealInLinearView,
  );
}

/** Extract a 0-based line number from a `{ line }` reveal arg. */
function readLineArg(raw: unknown): number | undefined {
  if (typeof raw === "number" && Number.isFinite(raw)) {
    return Math.floor(raw);
  }
  if (typeof raw === "object" && raw !== null) {
    const candidate = (raw as { line?: unknown }).line;
    if (typeof candidate === "number" && Number.isFinite(candidate)) {
      return Math.floor(candidate);
    }
  }
  return undefined;
}

/**
 * Find the root file-ref node matching `id` in the file view's current children,
 * for `TreeView.reveal`. Returns `undefined` when not present. Never throws.
 */
async function findFileNode(
  provider: FileIssuesProvider,
  id: string,
): Promise<LinearTreeNode | undefined> {
  try {
    const children = await Promise.resolve(provider.getChildren());
    if (!children) {
      return undefined;
    }
    return children.find((node) => node.kind === "fileRef" && node.id === id);
  } catch {
    return undefined;
  }
}
