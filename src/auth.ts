/**
 * Linear Lens — OAuth 2.0 Authorization Code + PKCE authentication provider.
 *
 * Implements RFC 8252 loopback redirect (`http://localhost:<port>/callback`).
 * NO client secret is ever used — token exchange and refresh send only
 * `client_id` and `code_verifier`.
 *
 * Exposes a `vscode.AuthenticationProvider` that stores sessions in VS Code's
 * `SecretStorage` and fires the standard `onDidChangeSessions` events.
 */

import * as vscode from "vscode";
import * as http from "node:http";
import * as crypto from "node:crypto";
import type { LinearLensConfig } from "./types";

// ---------------------------------------------------------------------------
// Public constants
// ---------------------------------------------------------------------------

/** The provider ID used with `vscode.authentication.*`. */
export const LINEAR_AUTH_PROVIDER_ID = "linearLens";

/** Human-readable label shown in VS Code's Accounts menu. */
export const LINEAR_AUTH_PROVIDER_LABEL = "Linear";

/** Default OAuth scopes requested when signing in. */
export const LINEAR_AUTH_SCOPES: string[] = ["read"];

// ---------------------------------------------------------------------------
// Linear endpoint constants
// ---------------------------------------------------------------------------

const AUTHORIZE_URL = "https://linear.app/oauth/authorize";
const TOKEN_URL = "https://api.linear.app/oauth/token";
const REVOKE_URL = "https://api.linear.app/oauth/revoke";
const GRAPHQL_URL = "https://api.linear.app/graphql";

/** SecretStorage key holding the serialized session array. */
const SESSIONS_SECRET_KEY = "linearLens.oauthSessions";

/** Timeout (ms) waiting for the browser callback. */
const CALLBACK_TIMEOUT_MS = 300_000;

// ---------------------------------------------------------------------------
// Internal stored-session shape (superset of vscode.AuthenticationSession)
// ---------------------------------------------------------------------------

interface StoredSession {
  id: string;
  accessToken: string;
  refreshToken: string;
  /** Expiry as epoch milliseconds. */
  expiresAt: number;
  account: { id: string; label: string };
  scopes: string[];
}

// ---------------------------------------------------------------------------
// PKCE + misc helpers
// ---------------------------------------------------------------------------

/**
 * Encode a Buffer as URL-safe base64 (RFC 4648 §5), stripping padding.
 * Maps `+` → `-`, `/` → `_`, removes trailing `=`.
 */
function base64url(buf: Buffer): string {
  return buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/**
 * Generate a PKCE code verifier: 32 random bytes, base64url-encoded.
 * Satisfies the RFC 7636 length requirement of 43–128 characters.
 */
function generateCodeVerifier(): string {
  return base64url(crypto.randomBytes(32));
}

/**
 * Derive the PKCE S256 code challenge from a verifier:
 * `BASE64URL(SHA256(ASCII(code_verifier)))`.
 */
function deriveCodeChallenge(verifier: string): string {
  return base64url(crypto.createHash("sha256").update(verifier, "ascii").digest());
}

/**
 * Generate a random state value for CSRF protection: 16 random bytes,
 * base64url-encoded.
 */
function generateState(): string {
  return base64url(crypto.randomBytes(16));
}

// ---------------------------------------------------------------------------
// LinearAuthProvider
// ---------------------------------------------------------------------------

/**
 * VS Code `AuthenticationProvider` that performs the Linear OAuth 2.0
 * Authorization Code + PKCE flow using an RFC 8252 loopback HTTP server.
 *
 * Single-account provider — only one Linear session is kept at a time.
 */
export class LinearAuthProvider implements vscode.AuthenticationProvider {
  /** Fires whenever sessions are added, changed, or removed. */
  readonly onDidChangeSessions: vscode.Event<vscode.AuthenticationProviderAuthenticationSessionsChangeEvent>;

  private readonly _context: vscode.ExtensionContext;
  private readonly _getCfg: () => LinearLensConfig;
  private readonly _emitter: vscode.EventEmitter<vscode.AuthenticationProviderAuthenticationSessionsChangeEvent>;
  private readonly _disposables: vscode.Disposable[] = [];

  constructor(context: vscode.ExtensionContext, getCfg: () => LinearLensConfig) {
    this._context = context;
    this._getCfg = getCfg;
    this._emitter = new vscode.EventEmitter<vscode.AuthenticationProviderAuthenticationSessionsChangeEvent>();
    this.onDidChangeSessions = this._emitter.event;
    this._disposables.push(this._emitter);
  }

  // -------------------------------------------------------------------------
  // Session storage helpers
  // -------------------------------------------------------------------------

  /** Load all stored sessions from SecretStorage; returns [] on any error. */
  private async _loadSessions(): Promise<StoredSession[]> {
    try {
      const raw = await this._context.secrets.get(SESSIONS_SECRET_KEY);
      if (!raw) {
        return [];
      }
      const parsed: unknown = JSON.parse(raw);
      if (!Array.isArray(parsed)) {
        return [];
      }
      return parsed as StoredSession[];
    } catch {
      return [];
    }
  }

  /** Persist the full sessions array to SecretStorage. */
  private async _saveSessions(sessions: StoredSession[]): Promise<void> {
    await this._context.secrets.store(SESSIONS_SECRET_KEY, JSON.stringify(sessions));
  }

  /** Convert a {@link StoredSession} to the VS Code public shape. */
  private static _toPublic(s: StoredSession): vscode.AuthenticationSession {
    return {
      id: s.id,
      accessToken: s.accessToken,
      account: s.account,
      scopes: s.scopes,
    };
  }

  // -------------------------------------------------------------------------
  // Token refresh
  // -------------------------------------------------------------------------

  /**
   * Refresh a single stored session using `grant_type=refresh_token`.
   * Returns the updated session on success, or `null` when the refresh fails
   * (caller should drop the session).
   */
  private async _refreshSession(session: StoredSession): Promise<StoredSession | null> {
    const cfg = this._getCfg();
    if (!cfg.authClientId) {
      return null;
    }
    try {
      const body = new URLSearchParams({
        grant_type: "refresh_token",
        refresh_token: session.refreshToken,
        client_id: cfg.authClientId,
      });
      const resp = await fetch(TOKEN_URL, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: body.toString(),
      });
      if (!resp.ok) {
        return null;
      }
      const json = await resp.json() as Record<string, unknown>;
      const accessToken = typeof json["access_token"] === "string" ? json["access_token"] : null;
      if (!accessToken) {
        return null;
      }
      const expiresIn =
        typeof json["expires_in"] === "number" ? (json["expires_in"] as number) : 86400;
      const refreshToken =
        typeof json["refresh_token"] === "string"
          ? (json["refresh_token"] as string)
          : session.refreshToken;

      return {
        ...session,
        accessToken,
        refreshToken,
        expiresAt: Date.now() + expiresIn * 1000,
      };
    } catch {
      return null;
    }
  }

  // -------------------------------------------------------------------------
  // getSessions
  // -------------------------------------------------------------------------

  /**
   * Return all stored (and optionally refreshed) Linear sessions.
   *
   * Sessions expiring within 60 seconds are refreshed transparently.
   * Sessions that fail to refresh are silently dropped (removed event fired).
   * This method NEVER rejects — callers always get a (possibly empty) array.
   *
   * @param scopes - Requested scopes. This is a single-account provider, so
   *   all sessions are returned regardless of scopes.
   */
  async getSessions(
    _scopes: readonly string[] | undefined,
    _options?: vscode.AuthenticationProviderSessionOptions,
  ): Promise<vscode.AuthenticationSession[]> {
    try {
      const stored = await this._loadSessions();
      const now = Date.now();
      const kept: StoredSession[] = [];
      const removed: vscode.AuthenticationSession[] = [];
      const changed: vscode.AuthenticationSession[] = [];

      for (const session of stored) {
        if (session.expiresAt - 60_000 <= now) {
          // Needs refresh
          const refreshed = await this._refreshSession(session);
          if (refreshed) {
            kept.push(refreshed);
            changed.push(LinearAuthProvider._toPublic(refreshed));
          } else {
            removed.push(LinearAuthProvider._toPublic(session));
          }
        } else {
          kept.push(session);
        }
      }

      if (removed.length > 0 || changed.length > 0) {
        await this._saveSessions(kept);
        this._emitter.fire({ added: [], removed, changed });
      }

      return kept.map(LinearAuthProvider._toPublic);
    } catch {
      return [];
    }
  }

  // -------------------------------------------------------------------------
  // createSession
  // -------------------------------------------------------------------------

  /**
   * Launch the OAuth 2.0 PKCE flow in the user's browser and return a new
   * {@link vscode.AuthenticationSession} on success.
   *
   * Steps:
   * 1. Validate that `authClientId` is configured.
   * 2. Generate PKCE verifier / challenge / state.
   * 3. Start a loopback HTTP server on the configured port.
   * 4. Open the Linear authorization URL in the browser.
   * 5. Await the callback (up to 300 s), validate state.
   * 6. Exchange the code for tokens.
   * 7. Fetch the viewer account via GraphQL.
   * 8. Persist and return the session (single-account: replaces any prior session).
   *
   * @throws When configuration is missing, auth fails, or the user times out.
   */
  async createSession(scopes: readonly string[]): Promise<vscode.AuthenticationSession> {
    const cfg = this._getCfg();
    if (!cfg.authClientId) {
      throw new Error(
        "Set linearLens.auth.clientId to your Linear OAuth application's Client ID first.",
      );
    }

    const redirectUri = `http://localhost:${cfg.authRedirectPort}/callback`;
    const codeVerifier = generateCodeVerifier();
    const codeChallenge = deriveCodeChallenge(codeVerifier);
    const state = generateState();
    const effectiveScopes = scopes.length > 0 ? [...scopes] : [...LINEAR_AUTH_SCOPES];

    // ---- Build authorize URL ----
    const params = new URLSearchParams({
      response_type: "code",
      client_id: cfg.authClientId,
      redirect_uri: redirectUri,
      state,
      scope: effectiveScopes.join(","),
      code_challenge: codeChallenge,
      code_challenge_method: "S256",
    });
    const authorizeUrl = `${AUTHORIZE_URL}?${params.toString()}`;

    // ---- Start loopback server, open browser, and await callback (with timeout) ----
    // The server promise resolves when the /callback request arrives.
    // We race it against a timeout so createSession always terminates.
    let timeoutHandle: ReturnType<typeof setTimeout> | undefined;

    const result = await new Promise<{ code: string; state: string; error?: string }>(
      (resolve, reject) => {
        const server = http.createServer((req, res) => {
          const reqUrl = req.url ?? "";
          if (!reqUrl.startsWith("/callback")) {
            res.writeHead(204);
            res.end();
            return;
          }
          const urlObj = new URL(reqUrl, `http://127.0.0.1:${cfg.authRedirectPort}`);
          const code = urlObj.searchParams.get("code") ?? "";
          const returnedState = urlObj.searchParams.get("state") ?? "";
          const error = urlObj.searchParams.get("error") ?? undefined;

          const html = `<!DOCTYPE html>
<html lang="en">
<head><meta charset="utf-8"><title>Linear Lens</title>
<style>body{font-family:system-ui,sans-serif;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0;background:#f5f5f5}
.card{background:#fff;padding:2rem 2.5rem;border-radius:12px;box-shadow:0 2px 12px rgba(0,0,0,.1);text-align:center}
h1{margin:0 0 .5rem;font-size:1.4rem;color:#333}p{color:#666;margin:0}</style></head>
<body><div class="card"><h1>Linear Lens — signed in!</h1><p>You can close this tab and return to your editor.</p></div></body>
</html>`;
          res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
          res.end(html);

          if (timeoutHandle !== undefined) {
            clearTimeout(timeoutHandle);
          }
          server.close(() => {
            resolve({ code, state: returnedState, error });
          });
        });

        server.on("error", (err: NodeJS.ErrnoException) => {
          if (timeoutHandle !== undefined) {
            clearTimeout(timeoutHandle);
          }
          if (err.code === "EADDRINUSE") {
            reject(
              new Error(
                `Port ${cfg.authRedirectPort} is already in use. ` +
                  "Change the linearLens.auth.redirectPort setting and try again.",
              ),
            );
          } else {
            reject(err);
          }
        });

        // Start listening; once the server is up, open the browser.
        server.listen(cfg.authRedirectPort, "127.0.0.1", () => {
          // Server is listening — open the authorize URL.
          void vscode.env.openExternal(vscode.Uri.parse(authorizeUrl));

          // Arm the timeout AFTER the browser is opened.
          timeoutHandle = setTimeout(() => {
            server.close();
            reject(new Error("Linear sign-in timed out after 5 minutes."));
          }, CALLBACK_TIMEOUT_MS);
        });
      },
    );

    if (result.error) {
      throw new Error(`Linear OAuth error: ${result.error}`);
    }
    if (result.state !== state) {
      throw new Error("OAuth state mismatch — the sign-in response may have been tampered with.");
    }
    if (!result.code) {
      throw new Error("No authorization code received from Linear.");
    }

    // ---- Exchange code for tokens ----
    const tokenBody = new URLSearchParams({
      grant_type: "authorization_code",
      code: result.code,
      redirect_uri: redirectUri,
      client_id: cfg.authClientId,
      code_verifier: codeVerifier,
    });
    const tokenResp = await fetch(TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: tokenBody.toString(),
    });
    if (!tokenResp.ok) {
      const errText = await tokenResp.text().catch(() => String(tokenResp.status));
      throw new Error(`Linear token exchange failed (${tokenResp.status}): ${errText}`);
    }
    const tokenJson = await tokenResp.json() as Record<string, unknown>;
    const accessToken = tokenJson["access_token"] as string | undefined;
    if (!accessToken) {
      throw new Error("Linear token response did not include an access_token.");
    }
    const refreshToken = (tokenJson["refresh_token"] as string | undefined) ?? "";
    const expiresIn =
      typeof tokenJson["expires_in"] === "number" ? (tokenJson["expires_in"] as number) : 86400;

    // ---- Fetch viewer account ----
    let account: { id: string; label: string } = { id: "linear", label: "Linear" };
    try {
      const viewerResp = await fetch(GRAPHQL_URL, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${accessToken}`,
        },
        body: JSON.stringify({ query: "{ viewer { id name email } }" }),
      });
      if (viewerResp.ok) {
        const viewerJson = await viewerResp.json() as Record<string, unknown>;
        const viewer = (viewerJson["data"] as Record<string, unknown> | undefined)?.["viewer"] as
          | Record<string, unknown>
          | undefined;
        if (viewer) {
          account = {
            id: (typeof viewer["id"] === "string" ? viewer["id"] : undefined) ?? "linear",
            label:
              (typeof viewer["name"] === "string" ? viewer["name"] : undefined) ||
              (typeof viewer["email"] === "string" ? viewer["email"] : undefined) ||
              "Linear",
          };
        }
      }
    } catch {
      // Tolerate failure — fall back to default account
    }

    // ---- Build and persist session (single-account: replace any prior) ----
    const newSession: StoredSession = {
      id: crypto.randomUUID(),
      accessToken,
      refreshToken,
      expiresAt: Date.now() + expiresIn * 1000,
      account,
      scopes: effectiveScopes,
    };

    // Replace all existing sessions (single-account provider)
    await this._saveSessions([newSession]);
    const publicSession = LinearAuthProvider._toPublic(newSession);
    this._emitter.fire({ added: [publicSession], removed: [], changed: [] });
    return publicSession;
  }

  // -------------------------------------------------------------------------
  // removeSession
  // -------------------------------------------------------------------------

  /**
   * Remove a stored session by ID, revoking the access token best-effort.
   * Fires the `removed` event even if revocation fails (it's best-effort).
   */
  async removeSession(sessionId: string): Promise<void> {
    const stored = await this._loadSessions();
    const session = stored.find((s) => s.id === sessionId);
    if (!session) {
      return;
    }
    // Best-effort revocation
    try {
      const body = new URLSearchParams({ token: session.accessToken });
      await fetch(REVOKE_URL, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: body.toString(),
      });
    } catch {
      // Ignore revocation errors
    }

    const remaining = stored.filter((s) => s.id !== sessionId);
    await this._saveSessions(remaining);
    this._emitter.fire({
      added: [],
      removed: [LinearAuthProvider._toPublic(session)],
      changed: [],
    });
  }

  // -------------------------------------------------------------------------
  // signOutAll
  // -------------------------------------------------------------------------

  /**
   * Remove every stored Linear session, revoking each token best-effort.
   * Used by the `linearLens.signOut` command.
   */
  async signOutAll(): Promise<void> {
    const stored = await this._loadSessions();
    if (stored.length === 0) {
      return;
    }

    // Best-effort revocation for each session
    await Promise.allSettled(
      stored.map(async (session) => {
        try {
          const body = new URLSearchParams({ token: session.accessToken });
          await fetch(REVOKE_URL, {
            method: "POST",
            headers: { "Content-Type": "application/x-www-form-urlencoded" },
            body: body.toString(),
          });
        } catch {
          // Ignore
        }
      }),
    );

    await this._saveSessions([]);
    this._emitter.fire({
      added: [],
      removed: stored.map(LinearAuthProvider._toPublic),
      changed: [],
    });
  }

  // -------------------------------------------------------------------------
  // dispose
  // -------------------------------------------------------------------------

  /** Release all internal resources (EventEmitter, etc.). */
  dispose(): void {
    for (const d of this._disposables) {
      d.dispose();
    }
    this._disposables.length = 0;
  }
}

// ---------------------------------------------------------------------------
// registerLinearAuthProvider
// ---------------------------------------------------------------------------

/**
 * Construct a {@link LinearAuthProvider}, register it with VS Code's
 * authentication framework, push its disposable to `context.subscriptions`,
 * and return the provider instance.
 */
export function registerLinearAuthProvider(
  context: vscode.ExtensionContext,
  getCfg: () => LinearLensConfig,
): LinearAuthProvider {
  const provider = new LinearAuthProvider(context, getCfg);
  context.subscriptions.push(
    vscode.authentication.registerAuthenticationProvider(
      LINEAR_AUTH_PROVIDER_ID,
      LINEAR_AUTH_PROVIDER_LABEL,
      provider,
      { supportsMultipleAccounts: false },
    ),
    provider,
  );
  return provider;
}

// ---------------------------------------------------------------------------
// getLinearOAuthHeader
// ---------------------------------------------------------------------------

/**
 * Retrieve the current OAuth `Authorization` header value (e.g.
 * `"Bearer <accessToken>"`) from a silent VS Code authentication session.
 *
 * Returns `undefined` when the user is not signed in or the session is
 * unavailable without prompting the user.
 */
export async function getLinearOAuthHeader(): Promise<string | undefined> {
  const session = await vscode.authentication.getSession(
    LINEAR_AUTH_PROVIDER_ID,
    LINEAR_AUTH_SCOPES,
    { silent: true },
  );
  return session ? `Bearer ${session.accessToken}` : undefined;
}
