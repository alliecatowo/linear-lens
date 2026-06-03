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
import { registerCommands } from "./commands";
import { getLinearOAuthHeader } from "./auth";
import type { AuthHeader, LinearLensConfig } from "./types";

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
  void client.refreshAuth();

  // In-editor highlight of references.
  const decorator = new IssueDecorator(getCfg);
  const refreshUi = (): void => decorator.applyToVisible();

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

  context.subscriptions.push(
    { dispose: () => diagnostics.dispose() },
    { dispose: () => decorator.dispose() },
    vscode.workspace.onDidOpenTextDocument((doc) => {
      diagnostics.refresh(doc);
      refreshUi();
    }),
    vscode.workspace.onDidChangeTextDocument((e) => {
      diagnostics.refresh(e.document);
      if (vscode.window.activeTextEditor?.document === e.document) {
        decorator.apply(vscode.window.activeTextEditor);
      }
    }),
    vscode.workspace.onDidCloseTextDocument((doc) => diagnostics.clear(doc.uri)),
    vscode.window.onDidChangeActiveTextEditor((editor) => decorator.apply(editor)),
    vscode.window.onDidChangeVisibleTextEditors(() => decorator.applyToVisible()),
  );

  // Current-branch issue status bar.
  const branch = new BranchStatusBar(getCfg);
  branch.start();
  context.subscriptions.push({ dispose: () => branch.dispose() });

  // Commands.
  registerCommands(context, {
    getCfg,
    client,
    branch,
    diagnostics,
    refreshConfig,
    refreshUi,
    secrets: context.secrets,
  });

  // Refresh when Linear's authentication sessions change (sign in/out).
  context.subscriptions.push(
    vscode.authentication.onDidChangeSessions((e) => {
      if (e.provider.id === "linear") {
        void client.refreshAuth();
        refreshUi();
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
      void client.refreshAuth();
      diagnostics.refreshAll(vscode.workspace.textDocuments);
      branch.refresh();
      decorator.applyToVisible();
    }),
  );
}

/** Deactivate Linear Lens. Disposables registered on the context handle cleanup. */
export function deactivate(): void {
  // No-op: everything is disposed via context.subscriptions.
}
