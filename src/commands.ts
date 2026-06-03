import * as vscode from "vscode";
import type { LinearLensConfig, LinearClient } from "./types";
import type { BranchStatusBar } from "./branch";
import type { DiagnosticsManager } from "./diagnostics";
import {
  signInToLinear,
  signOutOfLinear,
  isLinearConnectInstalled,
  getLinearAccountLabel,
  LINEAR_CONNECT_EXTENSION_ID,
} from "./auth";
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
  const { getCfg, client, branch, diagnostics, refreshConfig, refreshUi, secrets } = deps;

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
    const session = await signInToLinear();
    if (session) {
      await client.refreshAuth();
      refreshUi();
      void vscode.window.showInformationMessage(`Linear Lens: signed in to Linear as ${session.account.label}.`);
    }
  });

  const signOut = vscode.commands.registerCommand("linearLens.signOut", async () => {
    await signOutOfLinear();
    await client.refreshAuth();
    refreshUi();
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
