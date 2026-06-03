import * as vscode from "vscode";
import type { LinearLensConfig, LinearClient } from "./types";
import type { BranchStatusBar } from "./branch";
import type { DiagnosticsManager } from "./diagnostics";
import type { LinearAuthProvider } from "./auth";
import { LINEAR_AUTH_PROVIDER_ID, LINEAR_AUTH_SCOPES } from "./auth";
import { CONFIG_SECTION, issueUrl } from "./config";
import { parseIssueId } from "./parser";
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
  /** The Linear OAuth authentication provider. */
  auth: LinearAuthProvider;
  /** Re-read config after a setting changes (extension.ts provides this). */
  refreshConfig: () => void;
  /** Re-apply decorations / refresh UI after an auth or cache change. */
  refreshUi: () => void;
  /** SecretStorage for API key commands. */
  secrets: vscode.SecretStorage;
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
  const { getCfg, client, branch, diagnostics, auth, refreshConfig, refreshUi, secrets } = deps;

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

  const openIssue = vscode.commands.registerCommand("linearLens.openIssue", async () => {
    const cfg = getCfg();
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

  const copyIssueLink = vscode.commands.registerCommand("linearLens.copyIssueLink", async () => {
    const cfg = getCfg();
    const input = await vscode.window.showInputBox({
      title: "Linear Lens: Copy Issue Link",
      prompt: "Enter a Linear issue id to copy a link for.",
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
    const cfg = getCfg();
    if (!cfg.authClientId) {
      const choice = await vscode.window.showWarningMessage(
        "Linear Lens: set linearLens.auth.clientId to your Linear OAuth application's Client ID before signing in.",
        "Open Settings",
      );
      if (choice === "Open Settings") {
        await vscode.commands.executeCommand(
          "workbench.action.openSettings",
          "linearLens.auth.clientId",
        );
      }
      return;
    }
    try {
      const s = await vscode.authentication.getSession(
        LINEAR_AUTH_PROVIDER_ID,
        LINEAR_AUTH_SCOPES,
        { createIfNone: true },
      );
      await client.refreshAuth();
      refreshUi();
      void vscode.window.showInformationMessage(`Linear Lens: signed in to Linear as ${s.account.label}.`);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      void vscode.window.showErrorMessage(`Linear Lens: sign-in failed — ${msg}`);
    }
  });

  const signOut = vscode.commands.registerCommand("linearLens.signOut", async () => {
    await auth.signOutAll();
    await client.refreshAuth();
    refreshUi();
    void vscode.window.showInformationMessage("Linear Lens: signed out of Linear.");
  });

  const showAuthStatus = vscode.commands.registerCommand("linearLens.showAuthStatus", async () => {
    const cfg = getCfg();
    const redirectUri = `http://localhost:${cfg.authRedirectPort}/callback`;

    const clientIdStatus = cfg.authClientId
      ? `Client ID: \`${cfg.authClientId}\``
      : "Client ID: **not configured** — set `linearLens.auth.clientId`";

    let accountLine: string;
    try {
      const session = await vscode.authentication.getSession(
        LINEAR_AUTH_PROVIDER_ID,
        LINEAR_AUTH_SCOPES,
        { silent: true },
      );
      accountLine = session
        ? `Signed in as: **${session.account.label}**`
        : "Not signed in.";
    } catch {
      accountLine = "Not signed in.";
    }

    const message = [
      `Redirect URI (register this in your Linear OAuth app): \`${redirectUri}\``,
      clientIdStatus,
      accountLine,
    ].join("\n\n");

    const choice = await vscode.window.showInformationMessage(
      message,
      "Copy Redirect URI",
      "Open Settings",
    );

    if (choice === "Copy Redirect URI") {
      await vscode.env.clipboard.writeText(redirectUri);
      void vscode.window.showInformationMessage(`Linear Lens: copied redirect URI to clipboard.`);
    } else if (choice === "Open Settings") {
      await vscode.commands.executeCommand(
        "workbench.action.openSettings",
        "linearLens.auth",
      );
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
    refreshUi();
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
    refreshUi();
    void vscode.window.showInformationMessage("Linear Lens: Linear API key cleared.");
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
  );
}
