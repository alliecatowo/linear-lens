/**
 * Linear Lens — ticket-detail webview panel.
 *
 * A self-contained host-side module that opens (and reuses) a single
 * {@link vscode.WebviewPanel} rendering one Linear issue: title, properties
 * (status with color, assignee with avatar, priority, project, labels),
 * the rendered markdown description, comments (author avatar + name + relative
 * time + body), and attachments/images.
 *
 * Design notes:
 *  - **Data flows in from the extension side.** This module never imports the
 *    Linear client; the caller resolves an {@link IssueMetadata} and hands it to
 *    {@link TicketPanel.render}. Actions (open externally, check out a branch,
 *    refresh) are delegated to caller-supplied handlers, keeping the panel
 *    decoupled and unit-friendly.
 *  - **The webview never fetches.** All payload arrives via `postMessage`; the
 *    CSP forbids `connect-src` entirely. Avatars/attachment images are the only
 *    network egress (`img-src https:`), an accepted read-only trade-off.
 *  - **Untrusted data.** Issue titles, descriptions, comment bodies, label
 *    names, branch names and attachment titles/URLs are attacker-influenceable
 *    (any workspace member can file an issue). The webview script therefore
 *    builds its DOM with `textContent`/`createElement`, runs a tiny escape-then-
 *    format markdown renderer with a strict tag allowlist and `http(s)`-only
 *    links, validates colors against `^#[0-9a-fA-F]{6}$`, and routes every link
 *    click back through `postMessage` rather than navigating.
 *  - **Host trusts its own state, not the webview.** `openExternal`/
 *    `checkoutBranch` re-derive the URL/branch from the host's cached metadata;
 *    the values echoed in messages are advisory only (defense in depth).
 *
 * The HTML/CSS/JS are inlined as nonce-guarded strings so this module is fully
 * self-contained (no `media/**` assets required).
 */

import { randomBytes } from "node:crypto";
import * as vscode from "vscode";
import { IssueMetadata } from "../types";

// ---------------------------------------------------------------------------
// Message protocol (host <-> webview)
// ---------------------------------------------------------------------------

/**
 * Messages sent FROM the extension host TO the webview.
 *
 * `openIssue` carries the full payload to render (the "open issue" message);
 * `loading` and `error` drive the first-class non-data states.
 */
export type HostToWebviewMessage =
  /** Render (or re-render) a single issue. */
  | { readonly type: "openIssue"; readonly issue: IssueMetadata; readonly canCheckout: boolean }
  /** Show a calm skeleton/spinner while the host re-fetches. */
  | { readonly type: "loading"; readonly id: string }
  /** Show an actionable error/empty state with a retry affordance. */
  | { readonly type: "error"; readonly id: string; readonly message: string };

/**
 * Messages sent FROM the webview TO the extension host.
 *
 * The host validates every inbound message with {@link isWebviewToHostMessage}
 * and never `as`-casts raw payloads.
 */
export type WebviewToHostMessage =
  /** The webview finished loading and is ready for an `openIssue` message. */
  | { readonly type: "ready" }
  /** Re-fetch the current issue (bypassing cache). */
  | { readonly type: "refresh" }
  /** Open a URL externally. The host honors only `http(s)` schemes. */
  | { readonly type: "openExternal"; readonly url: string }
  /** Check out the issue's git branch. The host re-derives the branch name. */
  | { readonly type: "checkoutBranch"; readonly branchName: string };

/**
 * Type guard narrowing an unknown `postMessage` payload to a
 * {@link WebviewToHostMessage}. Rejects anything malformed so callers never act
 * on untyped input.
 *
 * @param value - The raw message received from the webview.
 * @returns `true` when `value` is a recognized webview-to-host message.
 */
export function isWebviewToHostMessage(value: unknown): value is WebviewToHostMessage {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const record = value as Record<string, unknown>;
  switch (record.type) {
    case "ready":
    case "refresh":
      return true;
    case "openExternal":
      return typeof record.url === "string";
    case "checkoutBranch":
      return typeof record.branchName === "string";
    default:
      return false;
  }
}

// ---------------------------------------------------------------------------
// Panel options
// ---------------------------------------------------------------------------

/**
 * Caller-supplied collaborators for the panel. Each handler is optional; when a
 * handler is absent the corresponding UI affordance still renders but its
 * message is ignored by the host. All handlers may be async and may throw — the
 * panel swallows handler errors so the webview can never break the host.
 */
export interface TicketPanelHandlers {
  /**
   * Open a URL in the user's browser. Defaults to {@link vscode.env.openExternal}
   * when omitted. The URL is always scheme-checked (`http`/`https`) first.
   */
  readonly onOpenExternal?: (url: string) => void | Promise<void>;
  /**
   * Check out the git branch for the current issue. Receives the
   * host-derived branch name and normalized issue id.
   */
  readonly onCheckoutBranch?: (args: { readonly id: string; readonly branchName: string }) => void | Promise<void>;
  /**
   * Re-fetch the current issue. The returned metadata (or `null`) is rendered
   * automatically; if omitted, the refresh button is inert.
   */
  readonly onRefresh?: (id: string) => IssueMetadata | null | Promise<IssueMetadata | null>;
}

// ---------------------------------------------------------------------------
// TicketPanel
// ---------------------------------------------------------------------------

/** The webview type id used by VS Code to identify this panel. */
const VIEW_TYPE = "linearLens.ticketDetail";

/**
 * Manages the single "Linear Issue" detail webview panel.
 *
 * Reuses one {@link vscode.WebviewPanel} across calls: a second {@link open}
 * retargets the existing panel rather than spawning a new tab. The panel is
 * created `Beside` the active editor with `retainContextWhenHidden` so toggling
 * tabs preserves scroll position and rendered content.
 */
export class TicketPanel {
  private panel: vscode.WebviewPanel | undefined;
  private currentIssue: IssueMetadata | undefined;
  private readonly disposables: vscode.Disposable[] = [];

  /**
   * @param extensionUri - The extension's root URI (used for `localResourceRoots`).
   * @param handlers - Caller-supplied action handlers; see {@link TicketPanelHandlers}.
   */
  public constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly handlers: TicketPanelHandlers = {},
  ) {}

  /**
   * The normalized id of the issue currently shown, or `undefined` when no
   * issue is loaded. Useful for callers that want to re-`render` after a
   * sign-in or cache refresh.
   */
  public get currentId(): string | undefined {
    return this.currentIssue?.id;
  }

  /**
   * Reveal (or create) the panel and render the given issue. Reuses one panel:
   * a second call retargets it. Never throws.
   *
   * @param issue - The fully-resolved issue metadata to display.
   * @param options - Optional rendering flags.
   * @param options.canCheckout - Whether the "Checkout branch" action should be
   *   offered (typically `true` when a branch name is present and git is usable).
   */
  public render(issue: IssueMetadata, options: { canCheckout?: boolean } = {}): void {
    try {
      const panel = this.ensurePanel();
      this.currentIssue = issue;
      panel.title = issue.id ? `Linear · ${issue.id}` : "Linear Issue";
      const canCheckout = options.canCheckout ?? Boolean(issue.branchName);
      void this.post({ type: "openIssue", issue, canCheckout });
    } catch {
      // Never let a render fault bubble into the host.
    }
  }

  /**
   * Reveal (or create) the panel showing a calm loading state for `id`. Use
   * this before an async fetch so the user sees immediate feedback.
   *
   * @param id - The normalized issue id being loaded.
   */
  public showLoading(id: string): void {
    try {
      const panel = this.ensurePanel();
      panel.title = id ? `Linear · ${id}` : "Linear Issue";
      void this.post({ type: "loading", id });
    } catch {
      // ignore
    }
  }

  /**
   * Reveal (or create) the panel showing an actionable error/empty state. The
   * webview renders a retry button that posts `refresh`.
   *
   * @param id - The normalized issue id that failed to load.
   * @param message - A specific, user-facing explanation.
   */
  public showError(id: string, message: string): void {
    try {
      const panel = this.ensurePanel();
      panel.title = id ? `Linear · ${id}` : "Linear Issue";
      void this.post({ type: "error", id, message });
    } catch {
      // ignore
    }
  }

  /** Dispose the panel and all listeners. Safe to call multiple times. */
  public dispose(): void {
    this.panel?.dispose();
    this.panel = undefined;
    this.currentIssue = undefined;
    while (this.disposables.length) {
      try {
        this.disposables.pop()?.dispose();
      } catch {
        // ignore
      }
    }
  }

  // -------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------

  /** Create the panel on first use, or reveal the existing one. */
  private ensurePanel(): vscode.WebviewPanel {
    if (this.panel) {
      this.panel.reveal(vscode.ViewColumn.Beside, true);
      return this.panel;
    }

    const panel = vscode.window.createWebviewPanel(
      VIEW_TYPE,
      "Linear Issue",
      { viewColumn: vscode.ViewColumn.Beside, preserveFocus: true },
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [vscode.Uri.joinPath(this.extensionUri, "media")],
      },
    );

    panel.webview.html = buildHtml(panel.webview);

    panel.onDidDispose(
      () => {
        this.panel = undefined;
        this.currentIssue = undefined;
      },
      undefined,
      this.disposables,
    );

    panel.webview.onDidReceiveMessage(
      (raw: unknown) => {
        void this.handleMessage(raw);
      },
      undefined,
      this.disposables,
    );

    this.panel = panel;
    return panel;
  }

  /** Post a host-to-webview message; tolerates a disposed panel. */
  private async post(message: HostToWebviewMessage): Promise<void> {
    if (!this.panel) {
      return;
    }
    try {
      await this.panel.webview.postMessage(message);
    } catch {
      // Panel may have been disposed between checks; ignore.
    }
  }

  /**
   * Validate and dispatch an inbound webview message. Unknown/guard-failing
   * messages are ignored silently; handler errors are swallowed.
   */
  private async handleMessage(raw: unknown): Promise<void> {
    if (!isWebviewToHostMessage(raw)) {
      return;
    }

    try {
      switch (raw.type) {
        case "ready":
          // Re-send the last render so a reloaded webview repaints.
          if (this.currentIssue) {
            await this.post({
              type: "openIssue",
              issue: this.currentIssue,
              canCheckout: Boolean(this.currentIssue.branchName),
            });
          }
          return;

        case "openExternal":
          await this.handleOpenExternal(raw.url);
          return;

        case "checkoutBranch":
          await this.handleCheckoutBranch();
          return;

        case "refresh":
          await this.handleRefresh();
          return;
      }
    } catch {
      // A misbehaving webview must never crash the host.
    }
  }

  /**
   * The one place a webview-supplied URL is honored. The scheme must be
   * `http`/`https`; everything else is rejected.
   */
  private async handleOpenExternal(url: string): Promise<void> {
    let parsed: vscode.Uri;
    try {
      parsed = vscode.Uri.parse(url, true);
    } catch {
      return;
    }
    if (parsed.scheme !== "http" && parsed.scheme !== "https") {
      return;
    }
    if (this.handlers.onOpenExternal) {
      await this.handlers.onOpenExternal(parsed.toString());
    } else {
      await vscode.env.openExternal(parsed);
    }
  }

  /**
   * Check out the current issue's branch. The branch name is re-derived from
   * the host's cached metadata, never trusted from the message payload.
   */
  private async handleCheckoutBranch(): Promise<void> {
    const issue = this.currentIssue;
    if (!issue?.branchName) {
      return;
    }
    if (this.handlers.onCheckoutBranch) {
      await this.handlers.onCheckoutBranch({ id: issue.id, branchName: issue.branchName });
    }
  }

  /** Re-fetch the current issue via the caller's handler and re-render. */
  private async handleRefresh(): Promise<void> {
    const issue = this.currentIssue;
    if (!issue || !this.handlers.onRefresh) {
      return;
    }
    const id = issue.id;
    await this.post({ type: "loading", id });
    const fresh = await this.handlers.onRefresh(id);
    if (fresh) {
      this.render(fresh);
    } else {
      await this.post({
        type: "error",
        id,
        message: `Could not refresh ${id}. Check your connection and Linear sign-in, then try again.`,
      });
    }
  }
}

/**
 * Convenience factory: create a {@link TicketPanel} and immediately render an
 * issue. Returns the panel so callers can keep it for reuse/refresh.
 *
 * @param extensionUri - The extension's root URI.
 * @param issue - The issue metadata to display.
 * @param handlers - Optional action handlers.
 * @returns The created (and now-visible) {@link TicketPanel}.
 */
export function openTicketPanel(
  extensionUri: vscode.Uri,
  issue: IssueMetadata,
  handlers: TicketPanelHandlers = {},
): TicketPanel {
  const panel = new TicketPanel(extensionUri, handlers);
  panel.render(issue);
  return panel;
}

// ---------------------------------------------------------------------------
// HTML / CSP / nonce
// ---------------------------------------------------------------------------

/**
 * Generate a 32-character base62 nonce for the CSP. Uses `crypto.randomBytes`
 * when available, falling back to `Math.random` (the nonce only needs to be
 * unguessable enough to gate inline `<script>` execution per load).
 */
function createNonce(): string {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  let bytes: Uint8Array | undefined;
  try {
    bytes = randomBytes(32);
  } catch {
    bytes = undefined;
  }
  let out = "";
  for (let i = 0; i < 32; i++) {
    const value = bytes ? bytes[i] : Math.floor(Math.random() * 256);
    out += alphabet[value % alphabet.length];
  }
  return out;
}

/**
 * Build the static HTML shell for the panel: a strict CSP (nonce-gated script,
 * no `connect-src`, no `unsafe-inline`/`unsafe-eval`), the inline stylesheet,
 * the root container, and the inline render script.
 */
function buildHtml(webview: vscode.Webview): string {
  const nonce = createNonce();
  const cspSource = webview.cspSource;
  const csp = [
    "default-src 'none'",
    `img-src https: data: ${cspSource}`,
    `style-src 'nonce-${nonce}' ${cspSource}`,
    `font-src ${cspSource}`,
    `script-src 'nonce-${nonce}'`,
    "connect-src 'none'",
  ].join("; ");

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta http-equiv="Content-Security-Policy" content="${csp}" />
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <style nonce="${nonce}">${PANEL_CSS}</style>
  <title>Linear Issue</title>
</head>
<body>
  <div id="root" aria-live="polite"></div>
  <script nonce="${nonce}">${PANEL_SCRIPT}</script>
</body>
</html>`;
}

// ---------------------------------------------------------------------------
// CSS — calm "panel of panes" using --vscode-* tokens only
// ---------------------------------------------------------------------------

/** Theme-driven stylesheet. Chrome uses only `--vscode-*` variables. */
const PANEL_CSS = `
:root {
  --ll-gap: 16px;
  --ll-radius: 6px;
}
* { box-sizing: border-box; }
body {
  margin: 0;
  padding: 0;
  font-family: var(--vscode-font-family);
  font-size: var(--vscode-font-size, 13px);
  color: var(--vscode-foreground);
  background: var(--vscode-editor-background);
  line-height: 1.5;
}
#root { padding: var(--ll-gap); }

/* Layout: two columns wide, single column narrow. */
.layout {
  display: grid;
  grid-template-columns: minmax(0, 1fr) 260px;
  gap: var(--ll-gap);
  align-items: start;
}
@media (max-width: 720px) {
  .layout { grid-template-columns: minmax(0, 1fr); }
}
.main { min-width: 0; }
.side { min-width: 0; }

/* Header */
.header { margin-bottom: var(--ll-gap); }
.header .id {
  color: var(--vscode-descriptionForeground);
  font-variant-numeric: tabular-nums;
  font-size: 0.9em;
}
.header h1 {
  margin: 4px 0 10px;
  font-size: 1.4em;
  font-weight: 600;
  line-height: 1.3;
  word-break: break-word;
}
.badges { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; margin-bottom: 10px; }
.actions { display: flex; flex-wrap: wrap; gap: 8px; }

/* Buttons (toolkit-like, theme tokens) */
button {
  font-family: inherit;
  font-size: 0.92em;
  color: var(--vscode-button-secondaryForeground, var(--vscode-button-foreground));
  background: var(--vscode-button-secondaryBackground, var(--vscode-button-background));
  border: 1px solid transparent;
  border-radius: var(--ll-radius);
  padding: 4px 12px;
  cursor: pointer;
}
button.primary {
  color: var(--vscode-button-foreground);
  background: var(--vscode-button-background);
}
button:hover { background: var(--vscode-button-secondaryHoverBackground, var(--vscode-button-hoverBackground)); }
button.primary:hover { background: var(--vscode-button-hoverBackground); }
button:focus-visible { outline: 1px solid var(--vscode-focusBorder); outline-offset: 2px; }
button:disabled { opacity: 0.5; cursor: default; }

/* Pills & chips */
.pill, .chip {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 2px 10px;
  border-radius: 999px;
  font-size: 0.85em;
  white-space: nowrap;
  border: 1px solid transparent;
}
.pill { color: var(--vscode-foreground); background: var(--vscode-badge-background); }
.chip { color: var(--vscode-foreground); background: var(--vscode-badge-background); }
.dot { width: 9px; height: 9px; border-radius: 50%; flex: 0 0 auto; background: var(--vscode-descriptionForeground); }
.badge-archived {
  color: var(--vscode-foreground);
  background: var(--vscode-badge-background);
  border-radius: 999px;
  padding: 2px 10px;
  font-size: 0.8em;
}

/* High-contrast: outline pills/chips instead of filled. */
.vscode-high-contrast .pill,
.vscode-high-contrast-light .pill,
.vscode-high-contrast .chip,
.vscode-high-contrast-light .chip {
  background: transparent;
  border: 1px solid var(--vscode-contrastBorder, var(--vscode-foreground));
}
.vscode-high-contrast button:focus-visible,
.vscode-high-contrast-light button:focus-visible,
.vscode-high-contrast a:focus-visible,
.vscode-high-contrast-light a:focus-visible {
  outline: 1px solid var(--vscode-focusBorder);
}

/* Avatars */
.avatar {
  width: 20px; height: 20px; border-radius: 50%;
  object-fit: cover;
  background: var(--vscode-badge-background);
  flex: 0 0 auto;
}
.avatar.lg { width: 28px; height: 28px; }
.avatar-fallback {
  display: inline-flex; align-items: center; justify-content: center;
  width: 20px; height: 20px; border-radius: 50%;
  font-size: 0.7em; font-weight: 600;
  color: var(--vscode-badge-foreground);
  background: var(--vscode-badge-background);
  flex: 0 0 auto;
}
.avatar-stack { display: inline-flex; }
.avatar-stack > * { margin-left: -6px; border: 1px solid var(--vscode-editor-background); }
.avatar-stack > *:first-child { margin-left: 0; }

/* Section cards */
.section { margin-bottom: var(--ll-gap); }
.section h2 {
  font-size: 0.78em;
  text-transform: uppercase;
  letter-spacing: 0.06em;
  color: var(--vscode-descriptionForeground);
  margin: 0 0 8px;
  font-weight: 600;
}

/* Description body */
.body { word-wrap: break-word; }
.body p { margin: 0 0 0.8em; }
.body h1, .body h2, .body h3 { margin: 1em 0 0.4em; line-height: 1.3; }
.body h1 { font-size: 1.25em; }
.body h2 { font-size: 1.12em; }
.body h3 { font-size: 1em; }
.body ul, .body ol { margin: 0 0 0.8em; padding-left: 1.4em; }
.body li { margin: 0.2em 0; }
.body code {
  font-family: var(--vscode-editor-font-family, monospace);
  font-size: 0.92em;
  background: var(--vscode-textCodeBlock-background, var(--vscode-textBlockQuote-background));
  padding: 1px 5px;
  border-radius: 4px;
}
.body pre {
  background: var(--vscode-textCodeBlock-background, var(--vscode-textBlockQuote-background));
  padding: 10px 12px;
  border-radius: var(--ll-radius);
  overflow: auto;
}
.body pre code { background: none; padding: 0; }
.body blockquote {
  margin: 0 0 0.8em;
  padding: 0 0 0 12px;
  border-left: 3px solid var(--vscode-textBlockQuote-border, var(--vscode-panel-border));
  color: var(--vscode-descriptionForeground);
}
.body a, a.link {
  color: var(--vscode-textLink-foreground);
  text-decoration: none;
  cursor: pointer;
}
.body a:hover, a.link:hover { color: var(--vscode-textLink-activeForeground); text-decoration: underline; }

/* Comments */
.comment { padding: 12px 0; border-top: 1px solid var(--vscode-panel-border); }
.comment:first-child { border-top: none; }
.comment-head { display: flex; align-items: center; gap: 8px; margin-bottom: 6px; }
.comment-author { font-weight: 600; }
.comment-time { color: var(--vscode-descriptionForeground); font-size: 0.85em; }

/* Attachments */
.attachment { display: flex; align-items: center; gap: 8px; padding: 4px 0; }
.attachment img.thumb {
  max-width: 100%;
  border-radius: var(--ll-radius);
  border: 1px solid var(--vscode-panel-border);
  margin: 6px 0;
  display: block;
}

/* Properties (side) */
.prop { display: flex; flex-direction: column; gap: 3px; margin-bottom: 12px; }
.prop .label {
  font-size: 0.75em;
  text-transform: uppercase;
  letter-spacing: 0.05em;
  color: var(--vscode-descriptionForeground);
}
.prop .value { display: flex; align-items: center; flex-wrap: wrap; gap: 6px; }
.chips { display: flex; flex-wrap: wrap; gap: 6px; }

.muted { color: var(--vscode-descriptionForeground); }
hr.divider { border: none; border-top: 1px solid var(--vscode-panel-border); margin: var(--ll-gap) 0; }

/* States */
.state-wrap { padding: 40px 16px; text-align: center; color: var(--vscode-descriptionForeground); }
.spinner {
  width: 24px; height: 24px; margin: 0 auto 16px;
  border: 3px solid var(--vscode-panel-border);
  border-top-color: var(--vscode-progressBar-background, var(--vscode-focusBorder));
  border-radius: 50%;
}
@media (prefers-reduced-motion: no-preference) {
  .spinner { animation: ll-spin 0.9s linear infinite; }
}
@keyframes ll-spin { to { transform: rotate(360deg); } }
`;

// ---------------------------------------------------------------------------
// Webview script — vanilla JS, DOM via createElement/textContent
// ---------------------------------------------------------------------------

/**
 * The inline webview script. Acquires the VS Code API, signals `ready`, and
 * renders inbound payloads. All issue-derived text is inserted via
 * `textContent`; the only HTML is produced by a tiny escape-then-format
 * markdown renderer with a strict tag allowlist and `http(s)`-only links.
 * Colors are validated against `^#[0-9a-fA-F]{6}$` and applied with
 * `style.setProperty`.
 */
const PANEL_SCRIPT = `
(function () {
  "use strict";
  const vscode = acquireVsCodeApi();
  const root = document.getElementById("root");

  const HEX = /^#[0-9a-fA-F]{6}$/;

  function post(msg) { vscode.postMessage(msg); }
  function clear(el) { while (el.firstChild) el.removeChild(el.firstChild); }

  function el(tag, props, children) {
    const node = document.createElement(tag);
    if (props) {
      for (const k in props) {
        if (k === "class") node.className = props[k];
        else if (k === "text") node.textContent = props[k];
        else if (k === "title") node.title = props[k];
        else node.setAttribute(k, props[k]);
      }
    }
    if (children) for (const c of children) { if (c) node.appendChild(c); }
    return node;
  }

  function validColor(c) { return typeof c === "string" && HEX.test(c) ? c : null; }
  function isHttp(u) { return typeof u === "string" && /^https?:\\/\\//i.test(u); }

  /* Choose readable foreground (black/white) for a validated hex background. */
  function contrastOn(hex) {
    const r = parseInt(hex.slice(1, 3), 16);
    const g = parseInt(hex.slice(3, 5), 16);
    const b = parseInt(hex.slice(5, 7), 16);
    const lum = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
    return lum > 0.6 ? "#111111" : "#ffffff";
  }

  function setBg(node, hex) {
    const v = validColor(hex);
    if (v) {
      node.style.setProperty("background-color", v);
      node.style.setProperty("color", contrastOn(v));
    }
  }

  function setDot(node, hex) {
    const v = validColor(hex);
    if (v) node.style.setProperty("background-color", v);
  }

  function avatar(person, large) {
    const p = person || {};
    const name = p.displayName || p.name || "?";
    if (isHttp(p.avatarUrl)) {
      const img = el("img", { class: "avatar" + (large ? " lg" : ""), alt: name, title: name });
      img.src = p.avatarUrl;
      img.addEventListener("error", function () {
        const fb = fallbackAvatar(name);
        if (img.parentNode) img.parentNode.replaceChild(fb, img);
      });
      return img;
    }
    return fallbackAvatar(name);
  }

  function fallbackAvatar(name) {
    const initial = (name || "?").trim().charAt(0).toUpperCase() || "?";
    return el("span", { class: "avatar-fallback", title: name, text: initial });
  }

  function personRow(person, large) {
    const p = person || {};
    const name = p.displayName || p.name || "Unknown";
    return el("span", { class: "value" }, [avatar(p, large), el("span", { text: name })]);
  }

  /* Relative timestamp, tolerant of unparseable dates. */
  function relativeTime(iso) {
    const t = Date.parse(iso);
    if (isNaN(t)) return typeof iso === "string" ? iso : "";
    const diff = Date.now() - t;
    const s = Math.round(diff / 1000);
    if (s < 60) return "just now";
    const m = Math.round(s / 60);
    if (m < 60) return m + "m ago";
    const h = Math.round(m / 60);
    if (h < 24) return h + "h ago";
    const d = Math.round(h / 24);
    if (d < 30) return d + "d ago";
    try { return new Date(t).toLocaleDateString(); } catch (e) { return ""; }
  }

  /* ------- Tiny markdown renderer (escape THEN format, allowlist tags) ----- */
  function escapeHtml(s) {
    return String(s)
      .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
  }

  /* Inline formatting on already-escaped text. */
  function inlineMd(escaped) {
    let s = escaped;
    s = s.replace(/\`([^\`]+)\`/g, "<code>$1</code>");
    s = s.replace(/\\*\\*([^*]+)\\*\\*/g, "<strong>$1</strong>");
    s = s.replace(/(^|[^*])\\*([^*]+)\\*/g, "$1<em>$2</em>");
    s = s.replace(/_([^_]+)_/g, "<em>$1</em>");
    /* Links: only http(s); routed via openExternal (no navigation). */
    s = s.replace(/\\[([^\\]]+)\\]\\(([^)\\s]+)\\)/g, function (_m, label, href) {
      /* href is from already HTML-escaped text; ":" and "/" are untouched by escapeHtml. */
      if (!/^https?:\\/\\//i.test(href)) return label;
      const safeHref = href.replace(/"/g, "&quot;");
      return '<a class="link" data-href="' + safeHref + '">' + label + "</a>";
    });
    return s;
  }

  /* Block-level renderer producing a sanitized DocumentFragment. */
  function renderMarkdown(md) {
    const frag = document.createDocumentFragment();
    const lines = String(md || "").replace(/\\r\\n/g, "\\n").split("\\n");
    let i = 0;
    while (i < lines.length) {
      let line = lines[i];

      if (/^\\s*$/.test(line)) { i++; continue; }

      /* Fenced code block */
      if (/^\\s*\`\`\`/.test(line)) {
        const buf = [];
        i++;
        while (i < lines.length && !/^\\s*\`\`\`/.test(lines[i])) { buf.push(lines[i]); i++; }
        i++;
        const pre = el("pre");
        pre.appendChild(el("code", { text: buf.join("\\n") }));
        frag.appendChild(pre);
        continue;
      }

      /* Heading */
      const h = /^(#{1,3})\\s+(.*)$/.exec(line);
      if (h) {
        const tag = "h" + h[1].length;
        const node = el(tag);
        node.innerHTML = inlineMd(escapeHtml(h[2]));
        frag.appendChild(node);
        i++;
        continue;
      }

      /* Blockquote */
      if (/^\\s*>\\s?/.test(line)) {
        const buf = [];
        while (i < lines.length && /^\\s*>\\s?/.test(lines[i])) {
          buf.push(lines[i].replace(/^\\s*>\\s?/, ""));
          i++;
        }
        const bq = el("blockquote");
        bq.innerHTML = inlineMd(escapeHtml(buf.join(" ")));
        frag.appendChild(bq);
        continue;
      }

      /* Lists */
      if (/^\\s*[-*+]\\s+/.test(line) || /^\\s*\\d+\\.\\s+/.test(line)) {
        const ordered = /^\\s*\\d+\\.\\s+/.test(line);
        const list = el(ordered ? "ol" : "ul");
        while (i < lines.length && (/^\\s*[-*+]\\s+/.test(lines[i]) || /^\\s*\\d+\\.\\s+/.test(lines[i]))) {
          const item = lines[i].replace(/^\\s*(?:[-*+]|\\d+\\.)\\s+/, "");
          const li = el("li");
          li.innerHTML = inlineMd(escapeHtml(item));
          list.appendChild(li);
          i++;
        }
        frag.appendChild(list);
        continue;
      }

      /* Paragraph (gather consecutive non-blank, non-special lines) */
      const buf = [];
      while (
        i < lines.length &&
        !/^\\s*$/.test(lines[i]) &&
        !/^\\s*\`\`\`/.test(lines[i]) &&
        !/^(#{1,3})\\s+/.test(lines[i]) &&
        !/^\\s*>\\s?/.test(lines[i]) &&
        !/^\\s*[-*+]\\s+/.test(lines[i]) &&
        !/^\\s*\\d+\\.\\s+/.test(lines[i])
      ) {
        buf.push(lines[i]);
        i++;
      }
      const p = el("p");
      p.innerHTML = inlineMd(escapeHtml(buf.join("\\n"))).replace(/\\n/g, "<br>");
      frag.appendChild(p);
    }
    return frag;
  }

  /* Delegate clicks on markdown/attachment links to the host. */
  root.addEventListener("click", function (ev) {
    let t = ev.target;
    while (t && t !== root) {
      if (t.tagName === "A" && t.getAttribute("data-href")) {
        ev.preventDefault();
        post({ type: "openExternal", url: t.getAttribute("data-href") });
        return;
      }
      t = t.parentNode;
    }
  });

  /* ------------------------------ Renderers ------------------------------- */

  function renderState(msg) {
    clear(root);
    const wrap = el("div", { class: "state-wrap" });
    if (msg.type === "loading") {
      wrap.appendChild(el("div", { class: "spinner", "aria-hidden": "true" }));
      wrap.appendChild(el("div", { text: "Loading " + (msg.id || "issue") + "…" }));
    } else {
      wrap.appendChild(el("div", { text: msg.message || "Something went wrong." }));
      const retry = el("button", { class: "primary", text: "Retry" });
      retry.style.marginTop = "12px";
      retry.addEventListener("click", function () { post({ type: "refresh" }); });
      wrap.appendChild(retry);
    }
    root.appendChild(wrap);
  }

  function header(issue, canCheckout) {
    const head = el("div", { class: "header" });
    head.appendChild(el("div", { class: "id", text: issue.id || "" }));
    head.appendChild(el("h1", { text: issue.title || "(untitled)" }));

    const badges = el("div", { class: "badges" });
    if (issue.state) {
      const pill = el("span", { class: "pill" });
      const dot = el("span", { class: "dot" });
      setDot(dot, issue.stateColor);
      setBg(pill, issue.stateColor);
      pill.appendChild(dot);
      pill.appendChild(el("span", { text: issue.state }));
      badges.appendChild(pill);
    }
    if (issue.archived) badges.appendChild(el("span", { class: "badge-archived", text: "Archived" }));
    head.appendChild(badges);

    const actions = el("div", { class: "actions" });
    if (isHttp(issue.url)) {
      const b = el("button", { class: "primary", text: "Open in Linear" });
      b.addEventListener("click", function () { post({ type: "openExternal", url: issue.url }); });
      actions.appendChild(b);
    }
    if (canCheckout && issue.branchName) {
      const b = el("button", { text: "Checkout branch" });
      b.addEventListener("click", function () {
        post({ type: "checkoutBranch", branchName: issue.branchName });
      });
      actions.appendChild(b);
    }
    const refresh = el("button", { text: "Refresh" });
    refresh.addEventListener("click", function () { post({ type: "refresh" }); });
    actions.appendChild(refresh);
    head.appendChild(actions);
    return head;
  }

  function descriptionSection(issue) {
    const sec = el("section", { class: "section" });
    sec.appendChild(el("h2", { text: "Description" }));
    const body = el("div", { class: "body" });
    if (issue.description && issue.description.trim()) {
      body.appendChild(renderMarkdown(issue.description));
    } else {
      body.appendChild(el("p", { class: "muted", text: "No description." }));
    }
    sec.appendChild(body);
    return sec;
  }

  function attachmentsSection(issue) {
    const list = (issue.attachments || []).filter(function (a) { return a && isHttp(a.url); });
    if (!list.length) return null;
    const sec = el("section", { class: "section" });
    sec.appendChild(el("h2", { text: "Attachments" }));
    list.forEach(function (a) {
      const row = el("div", { class: "attachment" });
      const isImage = /\\.(png|jpe?g|gif|webp|svg|bmp)(\\?|$)/i.test(a.url);
      if (isImage) {
        const img = el("img", { class: "thumb", alt: a.title || "attachment" });
        img.src = a.url;
        sec.appendChild(img);
      }
      const link = el("a", { class: "link", text: a.title || a.url, "data-href": a.url });
      row.appendChild(link);
      sec.appendChild(row);
    });
    return sec;
  }

  function commentsSection(issue) {
    const comments = issue.comments || [];
    const sec = el("section", { class: "section" });
    sec.appendChild(el("h2", { text: "Comments (" + comments.length + ")" }));
    if (!comments.length) {
      sec.appendChild(el("p", { class: "muted", text: "No comments yet." }));
      return sec;
    }
    comments.forEach(function (c) {
      const author = c.author || {};
      const wrap = el("div", { class: "comment" });
      const head = el("div", { class: "comment-head" });
      head.appendChild(avatar(author, false));
      head.appendChild(el("span", { class: "comment-author", text: author.displayName || author.name || "Unknown" }));
      head.appendChild(el("span", { class: "comment-time", text: relativeTime(c.createdAt) }));
      wrap.appendChild(head);
      const body = el("div", { class: "body" });
      if (c.body && c.body.trim()) body.appendChild(renderMarkdown(c.body));
      else body.appendChild(el("p", { class: "muted", text: "(empty comment)" }));
      wrap.appendChild(body);
      sec.appendChild(wrap);
    });
    return sec;
  }

  function prop(label, valueNode) {
    if (!valueNode) return null;
    const p = el("div", { class: "prop" });
    p.appendChild(el("div", { class: "label", text: label }));
    const v = el("div", { class: "value" });
    v.appendChild(valueNode);
    p.appendChild(v);
    return p;
  }

  function textValue(text) { return text ? el("span", { text: text }) : null; }

  function propertiesSection(issue) {
    const sec = el("section", { class: "section side-props" });
    sec.appendChild(el("h2", { text: "Properties" }));

    if (issue.state) {
      const pill = el("span", { class: "pill" });
      const dot = el("span", { class: "dot" });
      setDot(dot, issue.stateColor);
      setBg(pill, issue.stateColor);
      pill.appendChild(dot);
      pill.appendChild(el("span", { text: issue.state }));
      sec.appendChild(prop("Status", pill));
    }
    if (issue.assignee) sec.appendChild(prop("Assignee", personRow(issue.assignee, false)));
    sec.appendChild(prop("Priority", textValue(issue.priority)));
    sec.appendChild(prop("Project", textValue(issue.project)));

    const labels = (issue.labels || []).filter(function (l) { return l && l.name; });
    if (labels.length) {
      const chips = el("div", { class: "chips" });
      labels.forEach(function (l) {
        const chip = el("span", { class: "chip" });
        const dot = el("span", { class: "dot" });
        setDot(dot, l.color);
        chip.appendChild(dot);
        chip.appendChild(el("span", { text: l.name }));
        chips.appendChild(chip);
      });
      sec.appendChild(prop("Labels", chips));
    }

    if (issue.creator) sec.appendChild(prop("Creator", personRow(issue.creator, false)));
    if (issue.branchName) {
      const code = el("code", { text: issue.branchName });
      sec.appendChild(prop("Branch", code));
    }

    const subs = (issue.subscribers || []).filter(Boolean);
    if (subs.length) {
      const stack = el("span", { class: "avatar-stack" });
      subs.slice(0, 8).forEach(function (s) { stack.appendChild(avatar(s, false)); });
      sec.appendChild(prop("Subscribers", stack));
    }
    return sec;
  }

  function renderIssue(issue, canCheckout) {
    clear(root);
    root.appendChild(header(issue, canCheckout));

    const layout = el("div", { class: "layout" });
    const main = el("div", { class: "main" });
    main.appendChild(descriptionSection(issue));
    const att = attachmentsSection(issue);
    if (att) main.appendChild(att);
    main.appendChild(commentsSection(issue));
    layout.appendChild(main);

    const side = el("div", { class: "side" });
    side.appendChild(propertiesSection(issue));
    layout.appendChild(side);

    root.appendChild(layout);
  }

  window.addEventListener("message", function (event) {
    const msg = event.data;
    if (!msg || typeof msg.type !== "string") return;
    if (msg.type === "openIssue" && msg.issue) renderIssue(msg.issue, !!msg.canCheckout);
    else if (msg.type === "loading" || msg.type === "error") renderState(msg);
  });

  post({ type: "ready" });
})();
`;
