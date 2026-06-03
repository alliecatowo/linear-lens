import * as vscode from "vscode";

import { CONFIG_SECTION, getConfig } from "./config";
import { createLinearClient } from "./linearClient";
import { IssueLinkProvider } from "./providers/linkProvider";
import { IssueHoverProvider } from "./providers/hoverProvider";
import { DiagnosticsManager } from "./diagnostics";
import { BranchStatusBar } from "./branch";
import { registerCommands } from "./commands";
import type { LinearLensConfig } from "./types";

/** Documents Linear Lens operates on: real files and untitled buffers. */
const DOCUMENT_SELECTOR: vscode.DocumentSelector = [
  { scheme: "file" },
  { scheme: "untitled" },
];

/**
 * Activate Linear Lens: wire the parser-backed providers, diagnostics, branch
 * status bar, and commands together, and keep them in sync with configuration.
 */
export function activate(context: vscode.ExtensionContext): void {
  // Single cached config snapshot, re-read on configuration changes. All modules
  // receive the same `getCfg` accessor so they always see the latest values.
  let cfg: LinearLensConfig = getConfig();
  const getCfg = (): LinearLensConfig => cfg;
  const refreshConfig = (): void => {
    cfg = getConfig();
  };

  // Optional Linear API client (degrades gracefully when disabled/unauthenticated).
  const client = createLinearClient(getCfg, context.secrets);
  void client.refreshAuth();

  // Document links + hovers.
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

  // Diagnostics (TODO-bound refs only).
  const collection = vscode.languages.createDiagnosticCollection("linearLens");
  const diagnostics = new DiagnosticsManager(collection, getCfg);
  diagnostics.refreshAll(vscode.workspace.textDocuments);
  context.subscriptions.push(
    { dispose: () => diagnostics.dispose() },
    vscode.workspace.onDidOpenTextDocument((doc) => diagnostics.refresh(doc)),
    vscode.workspace.onDidChangeTextDocument((e) => diagnostics.refresh(e.document)),
    vscode.workspace.onDidCloseTextDocument((doc) => diagnostics.clear(doc.uri)),
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
    secrets: context.secrets,
  });

  // React to configuration changes: re-read config and refresh everything.
  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (!e.affectsConfiguration(CONFIG_SECTION)) {
        return;
      }
      refreshConfig();
      void client.refreshAuth();
      diagnostics.refreshAll(vscode.workspace.textDocuments);
      branch.refresh();
    }),
  );
}

/** Deactivate Linear Lens. Disposables registered on the context handle cleanup. */
export function deactivate(): void {
  // No-op: everything is disposed via context.subscriptions.
}
