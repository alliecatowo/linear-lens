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
import { GutterDecorator } from "./decorations/gutter";
import { LinearCommentController } from "./comments/commentController";
import { registerCommands } from "./commands";
import { registerBranchActions, createAgentBridge } from "./branchActions";
import { FileIssuesProvider } from "./views/fileIssuesProvider";
import { IssueListProvider } from "./views/issueListProvider";
import type { LinearTreeNode } from "./views/issueTreeModel";
import { getLinearOAuthHeader } from "./auth";
import { parseIssueId, scanText } from "./parser";
import { TicketPanel } from "./webview/ticketPanel";
import type { AuthHeader, IssueId, IssueMetadata, LinearLensConfig, TicketDetail } from "./types";

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
    fileIssues.refresh();
    myIssues.refresh();
    recentIssues.refresh();
  });

  // In-editor highlight of references.
  const decorator = new IssueDecorator(getCfg);

  // Live, auth-gated inline status indicator (dot/pill) after each reference.
  const inline = new InlineStatusDecorator(getCfg, client);

  // Live, auth-gated gutter status circle beside each line containing a reference.
  const gutter = new GutterDecorator(getCfg, client);

  // Live, auth-gated read-only Linear comment threads inline beside each reference.
  const comments = new LinearCommentController(getCfg, client);

  // Refresh every editor-side surface after an auth / cache / config change. The
  // tree views are refreshed separately (auth/config/editor handlers) so this
  // stays cheap on hot paths like document edits.
  const refreshUi = (): void => {
    decorator.applyToVisible();
    inline.applyToVisible();
    gutter.applyToVisible();
    comments.refreshActive();
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
  gutter.applyToVisible();
  comments.refreshActive();

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
    { dispose: () => gutter.dispose() },
    { dispose: () => comments.dispose() },
    vscode.workspace.onDidOpenTextDocument((doc) => {
      diagnostics.refresh(doc);
      refreshUi();
    }),
    vscode.workspace.onDidChangeTextDocument((e) => {
      diagnostics.refresh(e.document);
      if (vscode.window.activeTextEditor?.document === e.document) {
        decorator.apply(vscode.window.activeTextEditor);
        inline.apply(vscode.window.activeTextEditor);
        gutter.apply(vscode.window.activeTextEditor);
        comments.refresh(vscode.window.activeTextEditor);
        fileIssues.refresh();
      }
    }),
    vscode.workspace.onDidCloseTextDocument((doc) => diagnostics.clear(doc.uri)),
    vscode.window.onDidChangeActiveTextEditor((editor) => {
      decorator.apply(editor);
      inline.apply(editor);
      gutter.apply(editor);
      comments.refresh(editor);
      // The file view follows the active editor; refresh its refs + context keys.
      fileIssues.refresh();
      updateSelectionContext();
    }),
    vscode.window.onDidChangeVisibleTextEditors(() => {
      decorator.applyToVisible();
      inline.applyToVisible();
      gutter.applyToVisible();
      comments.refreshActive();
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

  // V3 ticket-detail webview. A single panel is reused across opens; its action
  // handlers delegate to the same local, read-only branch/diff commands the hover
  // and tree use. The host re-derives the branch from its cached metadata, so a
  // misbehaving webview can never shell out an attacker-chosen branch string.
  const detail = new TicketPanel(context.extensionUri, {
    onCheckoutBranch: async ({ id, branchName }) => {
      await vscode.commands.executeCommand("linearLens.checkoutBranch", { id, branchName });
    },
    onRefresh: async (id) => fetchTicketMetadata(client, getCfg, id),
  });
  context.subscriptions.push({ dispose: () => detail.dispose() });

  // Open (or retarget) the ticket-detail webview for a normalized id. Shows a
  // loading skeleton immediately, fetches the heavy detail off the client, and
  // renders it — or an actionable error pane. Never throws.
  const showTicket = async (id: string): Promise<void> => {
    const cfg = getCfg();
    const parsed = parseIssueId(id, { teamKeys: cfg.teamKeys });
    if (!parsed) {
      detail.showError(id, `"${id}" is not a valid Linear issue id.`);
      return;
    }
    detail.showLoading(parsed.normalized);
    const issue = await fetchTicketMetadata(client, getCfg, parsed.normalized);
    if (issue) {
      detail.render(issue);
    } else {
      detail.showError(parsed.normalized, ticketErrorMessage(client, cfg, parsed.normalized));
    }
  };

  // Re-render the open ticket (if any) after sign-in/out or a cache refresh.
  const refreshDetail = (): void => {
    const open = detail.currentId;
    if (open) {
      void showTicket(open);
    }
  };

  // `linearLens.openTicket`: open the detail webview for an explicit id arg, a
  // tree selection (`{ id }`), or the reference under the editor cursor.
  context.subscriptions.push(
    vscode.commands.registerCommand("linearLens.openTicket", async (arg?: unknown) => {
      let id = resolveTicketId(arg, getCfg());
      if (!id) {
        // Palette invocation with no cursor ref / tree selection: prompt for one.
        const input = await vscode.window.showInputBox({
          title: "Linear Lens: Open Issue Detail",
          prompt: "Enter a Linear issue id to open.",
          placeHolder: "ENG-123",
          ignoreFocusOut: true,
        });
        if (input === undefined) {
          return;
        }
        const parsed = parseIssueId(input, { teamKeys: getCfg().teamKeys });
        if (!parsed) {
          void vscode.window.showWarningMessage(
            `Linear Lens: "${input.trim()}" is not a valid Linear issue id.`,
          );
          return;
        }
        id = parsed.normalized;
      }
      await showTicket(id);
    }),
  );

  // `linearLens.inlineComments.toggle`: flip the inline-comments setting. The
  // configuration-change handler re-applies the comment threads, so the toggle
  // takes effect immediately without a window reload. Never throws.
  context.subscriptions.push(
    vscode.commands.registerCommand("linearLens.inlineComments.toggle", async () => {
      try {
        const configuration = vscode.workspace.getConfiguration(CONFIG_SECTION);
        const current = configuration.get<boolean>("inlineComments.enable", true);
        await configuration.update(
          "inlineComments.enable",
          !current,
          vscode.ConfigurationTarget.Global,
        );
        void vscode.window.showInformationMessage(
          `Linear Lens: inline comments ${!current ? "enabled" : "disabled"}.`,
        );
      } catch {
        // Settings update can fail (e.g. read-only profile); never throw.
      }
    }),
  );

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
          gutter.refresh();
          comments.refreshActive();
          refreshViews();
          refreshDetail();
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
      gutter.refresh();
      comments.refreshActive();
      refreshViews();
      refreshDetail();
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
 * Resolve the issue id to open in the detail webview from a command argument or,
 * failing that, the reference under the active editor's cursor. Accepts a bare
 * id string, an `{ id }` object (as tree nodes pass), or no argument (cursor).
 * Returns the normalized id, or `undefined` when none can be resolved.
 *
 * @param arg The loosely-typed command argument.
 * @param cfg The current resolved configuration (for team-key parsing).
 */
function resolveTicketId(arg: unknown, cfg: LinearLensConfig): string | undefined {
  // 1. Explicit string / `{ id }` argument (palette input, tree selection).
  let raw: string | undefined;
  if (typeof arg === "string") {
    raw = arg.trim();
  } else if (typeof arg === "object" && arg !== null) {
    const candidate = (arg as { id?: unknown }).id;
    raw = typeof candidate === "string" ? candidate.trim() : undefined;
  }
  if (raw) {
    const parsed = parseIssueId(raw, { teamKeys: cfg.teamKeys });
    return parsed?.normalized ?? raw;
  }

  // 2. Otherwise, the reference under the cursor in the active editor.
  try {
    const editor = vscode.window.activeTextEditor;
    if (!editor) {
      return undefined;
    }
    const document = editor.document;
    const refs = scanText(document.getText(), {
      teamKeys: cfg.teamKeys,
      markers: cfg.markers,
    });
    const offset = document.offsetAt(editor.selection.active);
    const ref = refs.find((r) => offset >= r.start && offset <= r.end);
    return ref?.issue.normalized;
  } catch {
    return undefined;
  }
}

/**
 * Fetch the full {@link TicketDetail} for a normalized id and adapt it to the
 * {@link IssueMetadata} shape the webview panel renders. Returns `null` when the
 * client cannot resolve the issue. Never throws.
 *
 * @param client The Linear API client (degrades gracefully).
 * @param getCfg Accessor for the current configuration (team-key parsing).
 * @param id     The normalized issue id, e.g. "ENG-123".
 */
async function fetchTicketMetadata(
  client: { fetchTicketDetail(id: IssueId): Promise<TicketDetail | null> },
  getCfg: () => LinearLensConfig,
  id: string,
): Promise<IssueMetadata | null> {
  const parsed = parseIssueId(id, { teamKeys: getCfg().teamKeys });
  if (!parsed) {
    return null;
  }
  try {
    const detail = await client.fetchTicketDetail(parsed);
    return detail ? ticketDetailToMetadata(detail) : null;
  } catch {
    return null;
  }
}

/**
 * Adapt a {@link TicketDetail} (the heavy on-demand payload) to the
 * {@link IssueMetadata} shape the webview panel consumes. The only structural
 * difference is `collaborators` → `subscribers`; everything else maps 1:1.
 *
 * @param detail The normalized ticket detail.
 * @returns Equivalent {@link IssueMetadata} for the panel.
 */
function ticketDetailToMetadata(detail: TicketDetail): IssueMetadata {
  return {
    id: detail.id,
    title: detail.title,
    state: detail.state,
    stateType: detail.stateType,
    stateColor: detail.stateColor,
    assignee: detail.assignee,
    creator: detail.creator,
    priority: detail.priority,
    project: detail.project,
    labels: detail.labels,
    subscribers: detail.collaborators,
    description: detail.description,
    branchName: detail.branchName,
    comments: detail.comments,
    attachments: detail.attachments,
    url: detail.url,
    archived: detail.archived,
  };
}

/**
 * Compute a specific, actionable error message for a failed ticket fetch so the
 * webview's error pane reads as finished rather than a generic failure. Checks,
 * in order: API disabled, not signed in, then a generic not-found / offline.
 *
 * @param client A client exposing `hasAuth()`.
 * @param cfg    The current resolved configuration.
 * @param id     The normalized issue id that failed to load.
 */
function ticketErrorMessage(
  client: { hasAuth(): boolean },
  cfg: LinearLensConfig,
  id: string,
): string {
  if (!cfg.enableApi) {
    return `The Linear API is disabled (linearLens.api.enable), so ${id} cannot be loaded. Enable it in Settings, then retry.`;
  }
  if (!safeHasAuth(client)) {
    return `Sign in to Linear (or set a personal API key) to view ${id}.`;
  }
  return `Could not load ${id}. It may not exist, or your connection / Linear may be unavailable. Check and retry.`;
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
