/**
 * Linear Lens — write-auth model.
 *
 * Mutations require WRITE access. The `linear.linear-connect` OAuth session
 * grants only the `read` scope, so OAuth alone cannot write. The reliable write
 * path is a **personal API key** (Linear → Settings → Security & access →
 * Personal API keys; full-access by default). We ALSO opportunistically try an
 * OAuth session with `["read", "write"]` when the user opts in — though Linear
 * Connect may hand back a read-only session even when write is requested, so the
 * returned session's `scopes` are always re-validated.
 *
 * This module imports `vscode` (it prompts and reads SecretStorage / sessions),
 * but it NEVER throws — every export resolves to a typed value, returning the
 * safe/false outcome on any error.
 */

import * as vscode from "vscode";

import { LINEAR_PROVIDER_ID } from "./auth";
import { API_KEY_SECRET } from "./linearClient";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * Scopes we attempt for a WRITE-capable OAuth session. The personal API key
 * (stored under {@link API_KEY_SECRET}) remains the reliable write path; these
 * scopes are only used for the opportunistic OAuth sign-in flow.
 */
export const LINEAR_WRITE_SCOPES: readonly string[] = ["read", "write"];

// ---------------------------------------------------------------------------
// Dependencies
// ---------------------------------------------------------------------------

/** Dependencies write-auth resolution needs from the host. */
export interface WriteAuthDeps {
  /** SecretStorage (context.secrets) — to detect a personal API key. */
  readonly secrets: vscode.SecretStorage;
}

// ---------------------------------------------------------------------------
// Result type
// ---------------------------------------------------------------------------

/**
 * The outcome of an {@link ensureWriteAuth} prompt flow. `ok` means a write
 * credential is now present; otherwise the user declined / it failed and the
 * caller MUST abort.
 */
export type EnsureWriteAuthResult =
  | { readonly ok: true; readonly via: "apiKey" | "oauth" }
  | { readonly ok: false };

// ---------------------------------------------------------------------------
// sessionHasWriteScope (pure, exported for testing)
// ---------------------------------------------------------------------------

/**
 * True when a session-like object has a `"write"` scope. Pure; null-tolerant.
 *
 * Trust the session's actual `scopes`, never the scopes that were requested:
 * Linear Connect may return a read-only session even when write was asked for.
 *
 * @param session - A session-like object (or null/undefined) to inspect.
 * @returns `true` only when `session.scopes` includes `"write"`.
 */
export function sessionHasWriteScope(
  session: { scopes?: readonly string[] } | undefined | null,
): boolean {
  return session?.scopes?.includes("write") ?? false;
}

// ---------------------------------------------------------------------------
// Internal helpers (vscode-bound)
// ---------------------------------------------------------------------------

/**
 * Whether a personal API key is currently stored in SecretStorage. Never throws.
 */
async function hasPersonalApiKey(deps: WriteAuthDeps): Promise<boolean> {
  try {
    const key = await deps.secrets.get(API_KEY_SECRET);
    return typeof key === "string" && key.length > 0;
  } catch {
    return false;
  }
}

/**
 * Whether a SILENT OAuth session exists whose scopes include `"write"`. Does not
 * prompt. A silent call with the write scope only returns a session if one was
 * previously granted with that scope; otherwise it resolves `undefined`. Never
 * throws.
 */
async function hasSilentWriteSession(): Promise<boolean> {
  try {
    const session = await vscode.authentication.getSession(
      LINEAR_PROVIDER_ID,
      [...LINEAR_WRITE_SCOPES],
      { silent: true },
    );
    return sessionHasWriteScope(session);
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// hasWriteAuth
// ---------------------------------------------------------------------------

/**
 * Resolve whether a WRITE-CAPABLE credential is currently available, WITHOUT
 * prompting. Returns `true` when EITHER:
 *   (a) a personal API key is set in SecretStorage ({@link API_KEY_SECRET}
 *       present), OR
 *   (b) a silent OAuth session exists whose `scopes` include `"write"`.
 *
 * Never throws; returns `false` on any error.
 *
 * @param deps - Host dependencies (SecretStorage).
 * @returns A promise resolving to whether a write credential is present.
 */
export async function hasWriteAuth(deps: WriteAuthDeps): Promise<boolean> {
  try {
    if (await hasPersonalApiKey(deps)) {
      return true;
    }
    return await hasSilentWriteSession();
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// activeWriteCredentialKind
// ---------------------------------------------------------------------------

/**
 * Best-effort: whether the CURRENT credential the client will use for a write is
 * a personal API key (the reliable write path) vs. OAuth. Mirrors the write
 * resolution priority — a personal API key is preferred over a write-scoped
 * OAuth session. Used only for clearer toasts ("OAuth grants read-only; set a
 * personal API key to edit"). Never throws.
 *
 * @param deps - Host dependencies (SecretStorage).
 * @returns `"apiKey"` when a personal key is set, else `"oauth"` when a
 *   write-scoped silent session exists, else `"none"`.
 */
export async function activeWriteCredentialKind(
  deps: WriteAuthDeps,
): Promise<"apiKey" | "oauth" | "none"> {
  try {
    if (await hasPersonalApiKey(deps)) {
      return "apiKey";
    }
    if (await hasSilentWriteSession()) {
      return "oauth";
    }
    return "none";
  } catch {
    return "none";
  }
}

// ---------------------------------------------------------------------------
// ensureWriteAuth
// ---------------------------------------------------------------------------

/**
 * Ensure a write-capable credential exists, prompting the user if not.
 *
 * Flow:
 *  1. If {@link hasWriteAuth} already → return `{ ok: true, via }` (the `via`
 *     reflects which credential is active).
 *  2. Else show an information message explaining writes need full access,
 *     offering three choices:
 *       - "Set Personal API Key" → runs command `linearLens.setApiKey`, then
 *         re-checks.
 *       - "Try Write Sign-in" → attempts
 *         `getSession("linear", ["read", "write"], { createIfNone: true })`;
 *         success only if the returned session's scopes include `"write"`.
 *       - "Cancel" / dismiss → returns `{ ok: false }`.
 *  3. Re-check {@link hasWriteAuth} after the chosen path; return ok accordingly.
 *
 * NEVER throws. A failed OAuth write attempt (Connect refuses write) shows a
 * toast directing the user to the personal-API-key path and returns
 * `{ ok: false }`.
 *
 * @param deps - Host dependencies (SecretStorage).
 * @returns A promise resolving to the {@link EnsureWriteAuthResult}.
 */
export async function ensureWriteAuth(deps: WriteAuthDeps): Promise<EnsureWriteAuthResult> {
  try {
    // 1. Already write-capable? Report which credential will be used.
    if (await hasWriteAuth(deps)) {
      const kind = await activeWriteCredentialKind(deps);
      return { ok: true, via: kind === "oauth" ? "oauth" : "apiKey" };
    }

    // 2. Prompt the user to obtain a write credential.
    const setKey = "Set Personal API Key";
    const writeSignIn = "Try Write Sign-in";
    const cancel = "Cancel";

    const choice = await vscode.window.showInformationMessage(
      "Editing Linear issues requires full (write) access. Linear Connect's sign-in " +
        "grants read-only access, so set a personal API key (Linear → Settings → " +
        "Security & access → Personal API keys), or try a write-capable sign-in.",
      { modal: false },
      setKey,
      writeSignIn,
      cancel,
    );

    if (choice === setKey) {
      // Hand off to the host command, then re-check.
      try {
        await vscode.commands.executeCommand("linearLens.setApiKey");
      } catch {
        // Command failure is non-fatal; the re-check below decides the outcome.
      }
      if (await hasPersonalApiKey(deps)) {
        return { ok: true, via: "apiKey" };
      }
      return { ok: false };
    }

    if (choice === writeSignIn) {
      let session: vscode.AuthenticationSession | undefined;
      try {
        session = await vscode.authentication.getSession(
          LINEAR_PROVIDER_ID,
          [...LINEAR_WRITE_SCOPES],
          { createIfNone: true },
        );
      } catch {
        session = undefined;
      }

      // Trust the returned session's scopes, not the request.
      if (sessionHasWriteScope(session)) {
        return { ok: true, via: "oauth" };
      }

      // Connect refused write (read-only session or none): direct to the key path.
      vscode.window.showWarningMessage(
        "Linear sign-in granted read-only access (write was refused). Set a personal " +
          "API key to edit issues (Linear → Settings → Security & access → Personal API keys).",
      );

      // A user may have set a key out-of-band meanwhile; re-check before failing.
      if (await hasWriteAuth(deps)) {
        const kind = await activeWriteCredentialKind(deps);
        return { ok: true, via: kind === "oauth" ? "oauth" : "apiKey" };
      }
      return { ok: false };
    }

    // 3. Cancelled / dismissed.
    return { ok: false };
  } catch {
    // Absolute backstop: never throw out of ensureWriteAuth.
    return { ok: false };
  }
}
