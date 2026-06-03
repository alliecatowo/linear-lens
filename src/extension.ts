/**
 * Linear Lens — extension entry point.
 *
 * Wires together every module: configuration, the optional Linear API client,
 * document links + hovers, marker-bound diagnostics, in-editor decorations, the
 * current-branch status bar, and the contributed commands. Sign-in is delegated
 * to Linear's first-party "linear" authentication provider; here we only read the
 * resulting OAuth header (falling back to a personal API key). All disposables are
 * registered on `context.subscriptions` so deactivation is a no-op.
 */

import * as vscode from "vscode";

import { CONFIG_SECTION, getConfig } from "./config";
import { createLinearClient, API_KEY_SECRET } from "./linearClient";
import { IssueLinkProvider } from "./providers/linkProvider";
import { IssueHoverProvider } from "./providers/hoverProvider";
import { DiagnosticsManager } from "./diagnostics";
import { BranchStatusBar } from "./branch";
import { IssueDecorator } from "./decorations";
import { InlineStatusDecorator } from "./decorations/inlineStatus";
import { registerCommands } from "./commands";
import { registerBranchActions, createAgentBridge } from "./branchActions";
import { FileIssuesProvider } from "./views/fileIssuesProvider";
import { IssueListProvider } from "./views/issueListProvider";
import type { LinearTreeNode } from "./views/issueTreeModel";
import { getLinearOAuthHeader } from "./auth";
import { scanText } from "./parser";
import type { AuthHeader, LinearLensConfig } from "./types";

/** Custom context key: whether a Linear credential is currently available. */
const CONTEXT_AUTHED = "linearLens.authed";

/** Custom context key: whether the primary cursor sits on a recognized reference. */
const CONTEXT_REF_UNDER_CURSOR = "linearLens.refUnderCursor";

/** Custom context key: whether the active document has ≥1 recognized reference. */
const CONTEXT_HAS_REFS = "linearLens.hasRefs";

/** Debounce (ms) for recomputing the cursor/document context keys on selection. */
const SELECTION_CONTEXT_DEBOUNCE_MS = 150;

/** Documents Linear Lens operates on: real files and untitled buffers. */
const DOCUMENT_SELECTOR: vscode.DocumentSelector = [
  { scheme: "file" },
  { scheme: "untitled" },
];

/**
 * Activate Linear Lens: wire the parser-backed providers, diagnostics,
 * decorations, branch status bar, and commands together, and keep them all in
 * sync with configuration and authentication changes.
 *
 * @param context The extension context whose `subscriptions` own all disposables.
 */
export function activate(context: vscode.ExtensionContext): void {
  // Cached config snapshot, re-read on configuration changes. All modules
  // receive the same `getCfg` accessor so they always see the latest values.
  let cfg: LinearLensConfig = getConfig();
  const getCfg = (): LinearLensConfig => cfg;
  const refreshConfig = (): void => {
    cfg = getConfig();
  };

  // Resolve an Authorization header: prefer an OAuth session, else a personal key.
  const resolveAuth = async (): Promise<AuthHeader | undefined> => {
    const oauth = await getLinearOAuthHeader();
    if (oauth) {
      return { value: oauth, kind: "oauth" };
    }
    const key = await context.secrets.get(API_KEY_SECRET);
    if (key) {
      return { value: key, kind: "apiKey" };
    }
    return undefined;
  };

  const client = createLinearClient(getCfg, resolveAuth);

  // Activity Bar tree views (constructed early so refreshUi can fold them in).
  const fileIssues = new FileIssuesProvider(getCfg, client);
  const myIssues = new IssueListProvider("mine", getCfg, client);
  const recentIssues = new IssueListProvider("recent", getCfg, client);

  // Custom context key: reflects `client.hasAuth()` for viewsWelcome + view/title.
  const setAuthedContext = (): void => {
    void vscode.commands.executeCommand("setContext", CONTEXT_AUTHED, safeHasAuth(client));
  };
  // Seed the key on activation (false until the first auth read resolves) so the
  // viewsWelcome sign-in prompts render immediately instead of empty trees.
  setAuthedContext();

  // Refresh after the FIRST auth read so context keys / views reflect real state.
  void client.refreshAuth().then(() => {
    setAuthedContext();
    myIssues.refresh();
    recentIssues.refresh();
  });

  // In-editor highlight of references.
  const decorator = new IssueDecorator(getCfg);

  // Live, auth-gated inline status indicator (dot/pill) after each reference.
  const inline = new InlineStatusDecorator(getCfg, client);

  // Refresh every editor-side surface after an auth / cache / config change. The
  // tree views are refreshed separately (auth/config/editor handlers) so this
  // stays cheap on hot paths like document edits.
  const refreshUi = (): void => {
    decorator.applyToVisible();
    inline.applyToVisible();
  };

  // Links + hovers.
  context.subscriptions.push(
    vscode.languages.registerDocumentLinkProvider(
      DOCUMENT_SELECTOR,
      new IssueLinkProvider(getCfg),
    ),
    vscode.languages.registerHoverProvider(
      DOCUMENT_SELECTOR,
      new IssueHoverProvider(getCfg, client),
    ),
  );

  // Diagnostics (marker-bound refs only).
  const collection = vscode.languages.createDiagnosticCollection("linearLens");
  const diagnostics = new DiagnosticsManager(collection, getCfg);
  diagnostics.refreshAll(vscode.workspace.textDocuments);
  decorator.applyToVisible();
  inline.applyToVisible();

  // Register the Activity Bar tree views. Providers are ALWAYS registered (content
  // is gated by `views.enable`, not registration) so toggling the setting needs no
  // window reload (spec V2 §8). The file view uses `createTreeView` so reveal works.
  const fileTreeView = vscode.window.createTreeView<LinearTreeNode>("linearLens.viewFile", {
    treeDataProvider: fileIssues,
  });
  context.subscriptions.push(
    fileTreeView,
    vscode.window.registerTreeDataProvider("linearLens.viewMine", myIssues),
    vscode.window.registerTreeDataProvider("linearLens.viewRecent", recentIssues),
    { dispose: () => fileIssues.dispose() },
    { dispose: () => myIssues.dispose() },
    { dispose: () => recentIssues.dispose() },
  );

  context.subscriptions.push(
    { dispose: () => diagnostics.dispose() },
    { dispose: () => decorator.dispose() },
    { dispose: () => inline.dispose() },
    vscode.workspace.onDidOpenTextDocument((doc) => {
      diagnostics.refresh(doc);
      refreshUi();
    }),
    vscode.workspace.onDidChangeTextDocument((e) => {
      diagnostics.refresh(e.document);
      if (vscode.window.activeTextEditor?.document === e.document) {
        decorator.apply(vscode.window.activeTextEditor);
        inline.apply(vscode.window.activeTextEditor);
        fileIssues.refresh();
      }
    }),
    vscode.workspace.onDidCloseTextDocument((doc) => diagnostics.clear(doc.uri)),
    vscode.window.onDidChangeActiveTextEditor((editor) => {
      decorator.apply(editor);
      inline.apply(editor);
      // The file view follows the active editor; refresh its refs + context keys.
      fileIssues.refresh();
      updateSelectionContext();
    }),
    vscode.window.onDidChangeVisibleTextEditors(() => {
      decorator.applyToVisible();
      inline.applyToVisible();
    }),
  );

  // Maintain the cursor / has-refs context keys, debounced, on selection changes.
  let selectionTimer: ReturnType<typeof setTimeout> | undefined;
  function updateSelectionContext(): void {
    if (selectionTimer) {
      clearTimeout(selectionTimer);
    }
    selectionTimer = setTimeout(() => {
      selectionTimer = undefined;
      computeSelectionContext(getCfg());
    }, SELECTION_CONTEXT_DEBOUNCE_MS);
  }
  context.subscriptions.push(
    vscode.window.onDidChangeTextEditorSelection(() => updateSelectionContext()),
    { dispose: () => { if (selectionTimer) { clearTimeout(selectionTimer); } } },
  );
  // Seed the keys for the current editor on activation.
  computeSelectionContext(getCfg());

  // Current-branch issue status bar.
  const branch = new BranchStatusBar(getCfg);
  branch.start();
  context.subscriptions.push({ dispose: () => branch.dispose() });

  // Refresh all three Activity Bar views in one call.
  const refreshViews = (): void => {
    fileIssues.refresh();
    myIssues.refresh();
    recentIssues.refresh();
  };

  // Coding-agent bridge + branch/diff/agent command handlers (local, read-only).
  const agent = createAgentBridge(getCfg);
  registerBranchActions(context, { getCfg, client, agent });

  // Commands (search / navigation / view / auth / branch).
  registerCommands(context, {
    getCfg,
    client,
    branch,
    diagnostics,
    refreshConfig,
    refreshUi,
    secrets: context.secrets,
    views: { file: fileIssues, mine: myIssues, recent: recentIssues, fileTreeView },
  });

  // Refresh when Linear's authentication sessions change (sign in/out).
  context.subscriptions.push(
    vscode.authentication.onDidChangeSessions((e) => {
      if (e.provider.id === "linear") {
        void client.refreshAuth().then(() => {
          setAuthedContext();
          refreshUi();
          inline.refresh();
          refreshViews();
        });
      }
    }),
  );

  // React to configuration changes.
  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (!e.affectsConfiguration(CONFIG_SECTION)) {
        return;
      }
      refreshConfig();
      void client.refreshAuth().then(setAuthedContext);
      diagnostics.refreshAll(vscode.workspace.textDocuments);
      branch.refresh();
      decorator.applyToVisible();
      inline.refresh();
      refreshViews();
    }),
  );
}

/** Read `client.hasAuth()` without ever throwing. */
function safeHasAuth(client: { hasAuth(): boolean }): boolean {
  try {
    return client.hasAuth();
  } catch {
    return false;
  }
}

/**
 * Recompute the `refUnderCursor` / `hasRefs` context keys for the active editor.
 * Sets both to `false` when there is no editor or no reference. Never throws.
 *
 * @param cfg The current resolved configuration (for team keys / markers).
 */
function computeSelectionContext(cfg: LinearLensConfig): void {
  let hasRefs = false;
  let refUnderCursor = false;
  try {
    const editor = vscode.window.activeTextEditor;
    if (editor) {
      const document = editor.document;
      const refs = scanText(document.getText(), {
        teamKeys: cfg.teamKeys,
        markers: cfg.markers,
      });
      hasRefs = refs.length > 0;
      const offset = document.offsetAt(editor.selection.active);
      refUnderCursor = refs.some((ref) => offset >= ref.start && offset <= ref.end);
    }
  } catch {
    hasRefs = false;
    refUnderCursor = false;
  }
  void vscode.commands.executeCommand("setContext", CONTEXT_HAS_REFS, hasRefs);
  void vscode.commands.executeCommand("setContext", CONTEXT_REF_UNDER_CURSOR, refUnderCursor);
}

/** Deactivate Linear Lens. Disposables registered on the context handle cleanup. */
export function deactivate(): void {
  // No-op: everything is disposed via context.subscriptions.
}
