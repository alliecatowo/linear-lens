/**
 * Linear Lens — authentication consumer for Linear's first-party provider.
 *
 * This module does NOT register any OAuth provider, run a loopback server, or
 * perform PKCE. It consumes the "linear" `vscode.authentication` provider
 * registered by the official Linear Connect extension (`linear.linear-connect`).
 *
 * Personal API key remains the zero-dependency fallback (handled in extension.ts).
 */

import * as vscode from "vscode";

// ---------------------------------------------------------------------------
// Public constants
// ---------------------------------------------------------------------------

/** Linear Connect's authentication provider id. */
export const LINEAR_PROVIDER_ID = "linear";

/** Scopes requested from Linear (read is enough for issue metadata). */
export const LINEAR_SCOPES: readonly string[] = ["read"];

/** The first-party extension that provides the "linear" auth provider. */
export const LINEAR_CONNECT_EXTENSION_ID = "linear.linear-connect";

/** Linear Connect's logout command (used for sign-out when present). */
export const LINEAR_CONNECT_LOGOUT_COMMAND = "linear-connect.logout";

// ---------------------------------------------------------------------------
// isLinearConnectInstalled
// ---------------------------------------------------------------------------

/** Whether the Linear Connect provider extension is installed. */
export function isLinearConnectInstalled(): boolean {
  return vscode.extensions.getExtension(LINEAR_CONNECT_EXTENSION_ID) !== undefined;
}

// ---------------------------------------------------------------------------
// getLinearOAuthHeader
// ---------------------------------------------------------------------------

/**
 * Current OAuth `Authorization` header (`"Bearer <token>"`) from a silent
 * session, or `undefined` when no session is available without prompting.
 * Never throws.
 */
export async function getLinearOAuthHeader(): Promise<string | undefined> {
  try {
    const session = await vscode.authentication.getSession(
      LINEAR_PROVIDER_ID,
      [...LINEAR_SCOPES],
      { silent: true },
    );
    return session ? "Bearer " + session.accessToken : undefined;
  } catch {
    return undefined;
  }
}

// ---------------------------------------------------------------------------
// getLinearAccountLabel
// ---------------------------------------------------------------------------

/**
 * The signed-in account label from a silent session, or `undefined` when no
 * session is available without prompting. Never throws.
 */
export async function getLinearAccountLabel(): Promise<string | undefined> {
  try {
    const session = await vscode.authentication.getSession(
      LINEAR_PROVIDER_ID,
      [...LINEAR_SCOPES],
      { silent: true },
    );
    return session?.account.label;
  } catch {
    return undefined;
  }
}

// ---------------------------------------------------------------------------
// signInToLinear
// ---------------------------------------------------------------------------

/**
 * Interactive sign-in. If the Linear Connect extension is not installed, offers
 * the user a choice to install it, fall back to a personal API key, or cancel.
 * On success returns the created `vscode.AuthenticationSession`; returns
 * `undefined` when the user cancels or an error occurs.
 */
export async function signInToLinear(): Promise<vscode.AuthenticationSession | undefined> {
  if (!isLinearConnectInstalled()) {
    const install = "Install Linear Connect";
    const apiKey = "Use a Personal API Key";
    const cancel = "Cancel";

    const choice = await vscode.window.showInformationMessage(
      "Signing in uses Linear's official **Linear Connect** extension (one-time install). " +
        "No OAuth app or API key needed.",
      { modal: false },
      install,
      apiKey,
      cancel,
    );

    if (choice === install) {
      await vscode.commands.executeCommand(
        "workbench.extensions.installExtension",
        LINEAR_CONNECT_EXTENSION_ID,
      );
      // If the provider still isn't available after installation, advise a reload.
      if (!isLinearConnectInstalled()) {
        await vscode.window.showInformationMessage(
          "Linear Connect was installed. Please reload the window and try signing in again.",
        );
        return undefined;
      }
      // Fall through to getSession below.
    } else if (choice === apiKey) {
      await vscode.commands.executeCommand("linearLens.setApiKey");
      return undefined;
    } else {
      return undefined;
    }
  }

  try {
    return await vscode.authentication.getSession(LINEAR_PROVIDER_ID, [...LINEAR_SCOPES], {
      createIfNone: true,
    });
  } catch (e) {
    vscode.window.showErrorMessage(
      "Linear sign-in failed: " + (e instanceof Error ? e.message : String(e)),
    );
    return undefined;
  }
}

// ---------------------------------------------------------------------------
// signOutOfLinear
// ---------------------------------------------------------------------------

/**
 * Sign out of Linear. If Linear Connect's logout command is registered, invokes
 * it; otherwise guides the user to the Accounts menu. Never throws.
 */
export async function signOutOfLinear(): Promise<void> {
  try {
    const cmds = await vscode.commands.getCommands(true);
    if (cmds.includes(LINEAR_CONNECT_LOGOUT_COMMAND)) {
      await vscode.commands.executeCommand(LINEAR_CONNECT_LOGOUT_COMMAND);
    } else {
      vscode.window.showInformationMessage(
        "Sign out of Linear from the Accounts menu (bottom-left) → Linear → Sign Out.",
      );
    }
  } catch {
    // Never throw
  }
}
