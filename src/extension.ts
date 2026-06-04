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

import { CONFIG_SECTION, getConfig, issueUrl } from "./config";
import { createLinearClient, API_KEY_SECRET } from "./linearClient";
import { IssueLinkProvider } from "./providers/linkProvider";
import { IssueHoverProvider } from "./providers/hoverProvider";
import { BlameHoverProvider } from "./providers/blameHoverProvider";
import { DiagnosticsManager } from "./diagnostics";
import { BranchStatusBar } from "./branch";
import { IssueDecorator } from "./decorations";
import { InlineStatusDecorator } from "./decorations/inlineStatus";
import { RailDecorator } from "./decorations/rail";
import { LinearCommentController } from "./comments/commentController";
import { registerCommands } from "./commands";
import { registerCopyCommands } from "./copyCommands";
import { registerEditCommands } from "./edit/editCommands";
import { registerBlockerCommands } from "./edit/blockers";
import { registerCreateCommand } from "./edit/createIssue";
import { registerBranchActions, createAgentBridge, openInAgent } from "./branchActions";
import { resolveOpenInAction } from "./branch/openIn";
import { FileIssuesProvider } from "./views/fileIssuesProvider";
import { IssueListProvider } from "./views/issueListProvider";
import {
  TeamsProvider,
  CycleProvider,
  type ViewGroupingState,
} from "./views/teamsProvider";
import { DEFAULT_SORT, type GroupBy, type IssueSort, type SortBy } from "./views/grouping";
import type { LinearTreeNode } from "./views/issueTreeModel";
import { getLinearOAuthHeader } from "./auth";
import { DetectionService } from "./detection";
import { SyncStatusIndicator } from "./syncStatus";
import { parseIssueId, scanText } from "./parser";
import { TicketPanel } from "./webview/ticketPanel";
import {
  BoardPanel,
  type BoardCard,
  type BoardData,
  type BoardMoveOutcome,
} from "./webview/boardPanel";
import { ensureWriteAuth, hasWriteAuth } from "./writeAuth";
import type { GitContext } from "./git/worktree";
import type {
  AuthHeader,
  IssueId,
  IssueListItem,
  IssueMetadata,
  LinearClient,
  LinearLensConfig,
  MetadataStore,
  TeamOption,
  TicketDetail,
} from "./types";

/** Custom context key: whether a Linear credential is currently available. */
const CONTEXT_AUTHED = "linearLens.authed";

/** Custom context key: whether the primary cursor sits on a recognized reference. */
const CONTEXT_REF_UNDER_CURSOR = "linearLens.refUnderCursor";

/** Custom context key: whether the active document has ≥1 recognized reference. */
const CONTEXT_HAS_REFS = "linearLens.hasRefs";

/** Debounce (ms) for recomputing the cursor/document context keys on selection. */
const SELECTION_CONTEXT_DEBOUNCE_MS = 150;

/** Debounce (ms) for prefetching a document's refs after open / change. */
const PREFETCH_DEBOUNCE_MS = 300;

/**
 * Debounce (ms) for the per-keystroke editor recompute (diagnostics +
 * decorations + inline + rail + comments). Each of these `scanText`s the whole
 * document, so coalescing a burst of edits into a single pass keeps typing in a
 * large file cheap instead of paying N full scans on every keystroke.
 */
const EDIT_RECOMPUTE_DEBOUNCE_MS = 120;

/** Document schemes Linear Lens scans: real files and untitled buffers. */
const SUPPORTED_SCHEMES = new Set(["file", "untitled"]);

/** Documents Linear Lens operates on: real files and untitled buffers. */
const DOCUMENT_SELECTOR: vscode.DocumentSelector = [
  { scheme: "file" },
  { scheme: "untitled" },
];

/** De-dupe a list of {@link IssueId}s by their `normalized` form (order-stable). */
function dedupeById(ids: IssueId[]): IssueId[] {
  const seen = new Set<string>();
  const out: IssueId[] = [];
  for (const id of ids) {
    if (!seen.has(id.normalized)) {
      seen.add(id.normalized);
      out.push(id);
    }
  }
  return out;
}

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

  // Adapt this workspace's Memento (`context.workspaceState`) to the persistence
  // surface the client + detection service consume. Honors `cache.persist`: when
  // off, the client is built WITHOUT a store so the metadata cache stays purely
  // in-memory (it is rehydrated/persisted only when a store is injected).
  const makeStore = (): MetadataStore => ({
    get: (k) => context.workspaceState.get(k),
    set: (k, v) => context.workspaceState.update(k, v),
    keys: () => context.workspaceState.keys(),
  });

  // Subtle status-bar "syncing…" pulse driven by the client's in-flight count.
  const sync = new SyncStatusIndicator();
  context.subscriptions.push({ dispose: () => sync.dispose() });

  const client = createLinearClient(
    getCfg,
    resolveAuth,
    resolveAuth,
    undefined,
    undefined,
    cfg.cachePersist ? makeStore() : undefined,
    (n) => sync.set(n),
  );

  // Auth-aware detection: blends the configured team keys / slug with the real
  // signed-in workspace's org slug + team keys (fetched via the client, cached in
  // workspaceState). Every scan consumer reads `effectiveTeamKeys()` /
  // `effectiveSlug()` so only real refs are recognized and the "no slug" nag is
  // dropped once a slug is available (configured OR detected). Re-scans + repaints
  // every surface when detection changes.
  const detection = new DetectionService(getCfg, client, makeStore(), () => {
    refreshUi();
    // The effective team-key allowlist changed, so the rail's per-version scan
    // cache is stale; `refresh()` drops it (and rebuilds types) before re-applying.
    rail.refresh();
    refreshViews();
    computeSelectionContext(getCfg(), detection);
  });
  context.subscriptions.push({ dispose: () => detection.dispose() });
  const getTeamKeys = (): string[] | undefined => detection.effectiveTeamKeys();
  const getSlug = (): string => detection.effectiveSlug();

  // Active grouping/sort for the team + cycle trees. Until the saved-view store
  // lands, this resolves the per-workspace defaults from configuration
  // (`linearLens.view.defaultGroupBy` / `defaultSortBy`); the providers fall back
  // to a flat, newest-updated list when the config is absent/invalid.
  const getGrouping = (): ViewGroupingState => resolveGrouping(getCfg());

  // Current-branch issue status bar — constructed early so the list views can
  // read the checked-out branch's issue id for worktree-aware emphasis. Started
  // (watcher + first render) further below.
  const branch = new BranchStatusBar(getCfg, getTeamKeys);

  // Lazily expose the current git context (the checked-out branch's issue id) so
  // the My / Recent list views can sort the matching issue to the top when
  // `linearLens.worktree.filter` is enabled. Reuses the branch status bar's
  // already-derived id; never throws.
  const getGitContext = (): GitContext => {
    try {
      const id = branch.current();
      return id ? { branchIssueId: id.normalized } : {};
    } catch {
      return {};
    }
  };

  // Activity Bar tree views (constructed early so refreshUi can fold them in).
  const fileIssues = new FileIssuesProvider(getCfg, client, getTeamKeys, getSlug);
  const myIssues = new IssueListProvider("mine", getCfg, client, getGitContext);
  const recentIssues = new IssueListProvider("recent", getCfg, client, getGitContext);
  const teams = new TeamsProvider(getCfg, client, getGrouping);
  const cycle = new CycleProvider(getCfg, client, getGrouping);

  // Custom context key: reflects `client.hasAuth()` for viewsWelcome + view/title.
  const setAuthedContext = (): void => {
    void vscode.commands.executeCommand("setContext", CONTEXT_AUTHED, safeHasAuth(client));
  };
  // Seed the key on activation (false until the first auth read resolves) so the
  // viewsWelcome sign-in prompts render immediately instead of empty trees.
  setAuthedContext();

  // (Re)detect the signed-in workspace's real team keys + slug, but ONLY when
  // `teams.autoDetect` is enabled. When off, the configured `teamKeys` /
  // `workspaceSlug` still apply via the detection service's precedence; we just
  // never hit the network. Fire-and-forget; never throws.
  const maybeRefreshDetection = (): void => {
    if (getCfg().teamsAutoDetect) {
      void detection.refresh();
    }
  };

  // Refresh after the FIRST auth read so context keys / views reflect real state.
  void client.refreshAuth().then(() => {
    setAuthedContext();
    fileIssues.refresh();
    myIssues.refresh();
    recentIssues.refresh();
    teams.refresh();
    cycle.refresh();
    // Kick auth-aware detection now that the first auth read has resolved.
    maybeRefreshDetection();
  });

  // In-editor highlight of references.
  const decorator = new IssueDecorator(getCfg, getTeamKeys);

  // Live, auth-gated inline status indicator (dot/pill) after each reference.
  const inline = new InlineStatusDecorator(getCfg, client, getTeamKeys);

  // Live, auth-gated GitLens/Error-Lens-style rail: an end-of-line annotation
  // (`<ID> · <state> · <title>`) and/or status-colored overview-ruler ticks.
  const rail = new RailDecorator(getCfg, client, getTeamKeys);

  // Live, auth-gated read-only Linear comment threads inline beside each reference.
  const comments = new LinearCommentController(getCfg, client);

  // Refresh every editor-side surface after an auth / cache / config change. The
  // tree views are refreshed separately (auth/config/editor handlers) so this
  // stays cheap on hot paths like document edits.
  const refreshUi = (): void => {
    decorator.applyToVisible();
    inline.applyToVisible();
    rail.applyToVisible();
    comments.refreshActive();
  };

  // Per-document debounce timers for prefetching a file's refs so the first hover
  // / pill / rail render is instant (the cache is warm by then). Disposed on
  // deactivate. The prefetch itself is bounded + deduped + skips fresh ids inside
  // the client; here we only debounce + scan + de-dupe the document's refs.
  const prefetchTimers = new Map<string, ReturnType<typeof setTimeout>>();
  const schedulePrefetch = (doc: vscode.TextDocument): void => {
    if (!SUPPORTED_SCHEMES.has(doc.uri.scheme)) {
      return;
    }
    const key = doc.uri.toString();
    const existing = prefetchTimers.get(key);
    if (existing) {
      clearTimeout(existing);
    }
    prefetchTimers.set(
      key,
      setTimeout(() => {
        prefetchTimers.delete(key);
        try {
          const refs = scanText(doc.getText(), {
            teamKeys: getTeamKeys(),
            markers: getCfg().markers,
          });
          const ids = dedupeById(refs.map((r) => r.issue));
          if (ids.length > 0) {
            void client.prefetch(ids);
          }
        } catch {
          // Prefetch is best-effort warming; never surface a failure.
        }
      }, PREFETCH_DEBOUNCE_MS),
    );
  };
  context.subscriptions.push({
    dispose: () => {
      for (const t of prefetchTimers.values()) {
        clearTimeout(t);
      }
      prefetchTimers.clear();
    },
  });

  // Debounce the per-keystroke editor recompute so a burst of edits collapses
  // into a single pass. Each surface (diagnostics, decorator, inline, rail,
  // comments) scans the full document, so without this every keystroke in a
  // large file pays several full scans. Keyed by document URI so edits in one
  // buffer never starve another's pending recompute.
  const editRecomputeTimers = new Map<string, ReturnType<typeof setTimeout>>();
  const scheduleEditRecompute = (doc: vscode.TextDocument): void => {
    if (!SUPPORTED_SCHEMES.has(doc.uri.scheme)) {
      return;
    }
    const key = doc.uri.toString();
    const existing = editRecomputeTimers.get(key);
    if (existing) {
      clearTimeout(existing);
    }
    editRecomputeTimers.set(
      key,
      setTimeout(() => {
        editRecomputeTimers.delete(key);
        diagnostics.refresh(doc);
        const editor = vscode.window.activeTextEditor;
        if (editor?.document === doc) {
          decorator.apply(editor);
          inline.apply(editor);
          rail.apply(editor);
          comments.refresh(editor);
          fileIssues.refresh();
        }
      }, EDIT_RECOMPUTE_DEBOUNCE_MS),
    );
  };
  context.subscriptions.push({
    dispose: () => {
      for (const t of editRecomputeTimers.values()) {
        clearTimeout(t);
      }
      editRecomputeTimers.clear();
    },
  });

  // Links + hovers.
  context.subscriptions.push(
    vscode.languages.registerDocumentLinkProvider(
      DOCUMENT_SELECTOR,
      new IssueLinkProvider(getCfg, getTeamKeys, getSlug),
    ),
    vscode.languages.registerHoverProvider(
      DOCUMENT_SELECTOR,
      new IssueHoverProvider(getCfg, client, getTeamKeys, getSlug),
    ),
    // A SECOND, lightweight hover: when the hovered line has no direct ref but its
    // last commit (via git blame) mentions a Linear issue, contribute a minimal
    // `📋 <ID> · View in Linear · Open details` entry (no full card, no fetch).
    vscode.languages.registerHoverProvider(
      DOCUMENT_SELECTOR,
      new BlameHoverProvider(getCfg, getTeamKeys, getSlug),
    ),
  );

  // Diagnostics (marker-bound refs only).
  const collection = vscode.languages.createDiagnosticCollection("linearLens");
  const diagnostics = new DiagnosticsManager(collection, getCfg, getTeamKeys);
  diagnostics.refreshAll(vscode.workspace.textDocuments);
  decorator.applyToVisible();
  inline.applyToVisible();
  rail.applyToVisible();
  comments.refreshActive();

  // Register the Activity Bar tree views. Providers are ALWAYS registered (content
  // is gated by `views.enable`, not registration) so toggling the setting needs no
  // window reload (spec V2 §8). The file view uses `createTreeView` so reveal works.
  const fileTreeView = vscode.window.createTreeView<LinearTreeNode>("linearLens.viewFile", {
    treeDataProvider: fileIssues,
  });
  // The teams view uses `createTreeView` so `reveal`/`getParent` work; the cycle
  // view is a flat list driven by `linearLens.openCycle` (CycleProvider.setTeam).
  // The element type is inferred from the provider (TeamsProvider's private node
  // union), so no explicit generic is supplied.
  const teamsTreeView = vscode.window.createTreeView("linearLens.viewTeams", {
    treeDataProvider: teams,
  });
  context.subscriptions.push(
    fileTreeView,
    teamsTreeView,
    vscode.window.registerTreeDataProvider("linearLens.viewMine", myIssues),
    vscode.window.registerTreeDataProvider("linearLens.viewRecent", recentIssues),
    vscode.window.registerTreeDataProvider("linearLens.viewCycle", cycle),
    { dispose: () => fileIssues.dispose() },
    { dispose: () => myIssues.dispose() },
    { dispose: () => recentIssues.dispose() },
    { dispose: () => teams.dispose() },
    { dispose: () => cycle.dispose() },
  );

  context.subscriptions.push(
    { dispose: () => diagnostics.dispose() },
    { dispose: () => decorator.dispose() },
    { dispose: () => inline.dispose() },
    { dispose: () => rail.dispose() },
    { dispose: () => comments.dispose() },
    vscode.workspace.onDidOpenTextDocument((doc) => {
      diagnostics.refresh(doc);
      refreshUi();
      schedulePrefetch(doc);
    }),
    vscode.workspace.onDidChangeTextDocument((e) => {
      // Coalesce the (multi-scan) recompute of every editor surface so typing in
      // a large file does not pay several full document scans on each keystroke.
      // Diagnostics for non-active docs (multi-editor / background edits) are
      // covered too: the recompute always refreshes the changed document.
      scheduleEditRecompute(e.document);
      if (vscode.window.activeTextEditor?.document === e.document) {
        schedulePrefetch(e.document);
      }
    }),
    vscode.workspace.onDidCloseTextDocument((doc) => diagnostics.clear(doc.uri)),
    vscode.window.onDidChangeActiveTextEditor((editor) => {
      decorator.apply(editor);
      inline.apply(editor);
      rail.apply(editor);
      comments.refresh(editor);
      // The file view follows the active editor; refresh its refs + context keys.
      fileIssues.refresh();
      updateSelectionContext();
      // Warm the cache for the newly-focused document's refs (guard undefined).
      if (editor) {
        schedulePrefetch(editor.document);
      }
    }),
    vscode.window.onDidChangeVisibleTextEditors(() => {
      decorator.applyToVisible();
      inline.applyToVisible();
      rail.applyToVisible();
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
      computeSelectionContext(getCfg(), detection);
    }, SELECTION_CONTEXT_DEBOUNCE_MS);
  }
  context.subscriptions.push(
    vscode.window.onDidChangeTextEditorSelection((e) => {
      updateSelectionContext();
      // Let the `activeLine` rail follow the cursor; this is cheap (reuses the
      // cached document scan and only re-picks the active line's annotation).
      rail.onSelectionChanged(e.textEditor);
    }),
    { dispose: () => { if (selectionTimer) { clearTimeout(selectionTimer); } } },
  );
  // Seed the keys for the current editor on activation.
  computeSelectionContext(getCfg(), detection);
  // Warm the cache for the already-open active document (no open event fires for it).
  if (vscode.window.activeTextEditor) {
    schedulePrefetch(vscode.window.activeTextEditor.document);
  }

  // Current-branch issue status bar (constructed above; start the watcher now).
  branch.start();
  context.subscriptions.push({ dispose: () => branch.dispose() });

  // Refresh every Activity Bar view in one call (so a status change repaints the
  // file/list trees AND the teams/cycle trees).
  const refreshViews = (): void => {
    fileIssues.refresh();
    myIssues.refresh();
    recentIssues.refresh();
    teams.refresh();
    cycle.refresh();
  };

  // Targeted cache drop after a successful write so the next hover / tree / detail
  // read reflects the change. Prefers the client's targeted `invalidate(id)` (EDIT
  // spec §6) when present; never calls `clearCache()` (that storms a refetch). Falls
  // back to a no-op so stale entries simply age out via the TTL when the targeted
  // method is unavailable. Never throws.
  const invalidate = (id: IssueId): void => {
    try {
      const targeted = (client as Partial<{ invalidate: (id: IssueId) => void }>).invalidate;
      if (typeof targeted === "function") {
        targeted.call(client, id);
      }
    } catch {
      // Cache invalidation must never surface as a failure.
    }
  };

  // Coding-agent bridge + branch/diff/agent command handlers (local, read-only).
  const agent = createAgentBridge(getCfg);
  const branchDeps = { getCfg, getTeamKeys, getSlug, client, agent };
  registerBranchActions(context, branchDeps);

  // `linearLens.openInTool`: the canonical "Open in Coding Tool" command (settings
  // spec §3). Reads `openIn.tool` / `openIn.customCommand` and dispatches to the
  // resolved action: the issue URL, a user command id, or the auto-detected coding
  // agent (delegating to the same `openInAgent` internals the legacy alias uses).
  // READ-ONLY — no write-auth gate. Never throws.
  context.subscriptions.push(
    vscode.commands.registerCommand("linearLens.openInTool", async (arg?: unknown) => {
      try {
        const cfg = getCfg();
        const action = resolveOpenInAction(
          cfg.openInTool,
          cfg.openInCustomCommand,
          agent.isAvailable(),
        );
        if (action.kind === "agent") {
          await openInAgent(arg, branchDeps);
          return;
        }
        // The "url" and "command" actions both need the issue id + canonical URL.
        const resolved = await resolveOpenInTarget(arg, client, cfg, getTeamKeys(), getSlug());
        if (!resolved) {
          void vscode.window.showWarningMessage(
            "Linear Lens: no Linear issue id was provided to open.",
          );
          return;
        }
        if (action.kind === "command" && action.commandId) {
          await vscode.commands.executeCommand(action.commandId, {
            id: resolved.id,
            url: resolved.url,
          });
          return;
        }
        // "url" (or a "command" with no id — defensive): open the issue URL.
        if (resolved.url) {
          await vscode.env.openExternal(vscode.Uri.parse(resolved.url));
          return;
        }
        void vscode.window.showWarningMessage(
          `Linear Lens: could not resolve a URL for ${resolved.id}. Set a workspace slug (linearLens.workspaceSlug) to open it in Linear.`,
        );
      } catch {
        // The command handler must never throw.
      }
    }),
  );

  // V3 ticket-detail webview. A single panel is reused across opens; its action
  // handlers delegate to the same local, read-only branch/diff commands the hover
  // and tree use. The host re-derives the branch from its cached metadata, so a
  // misbehaving webview can never shell out an attacker-chosen branch string.
  const detail = new TicketPanel(context.extensionUri, {
    onCheckoutBranch: async ({ id, branchName }) => {
      await vscode.commands.executeCommand("linearLens.checkoutBranch", { id, branchName });
    },
    onRefresh: async (id) => fetchTicketMetadata(client, getTeamKeys, id),
    // Webview detail buttons (E2). The host passes the panel's cached id; the
    // edit/blocker commands re-check write access (no-op + prompt when missing).
    onEditIssue: async (id) => {
      await vscode.commands.executeCommand("linearLens.editIssue", { id });
    },
    onEditBlockers: async (id) => {
      await vscode.commands.executeCommand("linearLens.editBlockers", { id });
    },
  });
  context.subscriptions.push({ dispose: () => detail.dispose() });

  // Open (or retarget) the ticket-detail webview for a normalized id. Shows a
  // loading skeleton immediately, fetches the heavy detail off the client, and
  // renders it — or an actionable error pane. Never throws.
  const showTicket = async (id: string): Promise<void> => {
    const cfg = getCfg();
    const parsed = parseIssueId(id, { teamKeys: getTeamKeys() });
    if (!parsed) {
      detail.showError(id, `"${id}" is not a valid Linear issue id.`);
      return;
    }
    detail.showLoading(parsed.normalized);
    const issue = await fetchTicketMetadata(client, getTeamKeys, parsed.normalized);
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
      let id = resolveTicketId(arg, getCfg(), getTeamKeys());
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
        const parsed = parseIssueId(input, { teamKeys: getTeamKeys() });
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

  // `linearLens.editBlockers`: a thin chooser that dispatches to the three
  // granular blocker commands (add-blocks / add-blocked-by / remove). Gives the
  // hover, tree, webview, and palette a single "Edit Blockers…" entry point while
  // the underlying mutations (each WRITE-AUTH gated) live in `edit/blockers.ts`.
  // The chosen sub-command inherits the same `{ id }` / cursor argument resolution
  // and re-checks write access, so this dispatcher itself needs no gate. Never throws.
  context.subscriptions.push(
    vscode.commands.registerCommand("linearLens.editBlockers", async (arg?: unknown) => {
      interface BlockerAction extends vscode.QuickPickItem {
        readonly command: string;
      }
      const actions: BlockerAction[] = [
        {
          label: "$(arrow-left) Add a blocker (this issue is blocked by…)",
          command: "linearLens.addBlockedBy",
        },
        {
          label: "$(arrow-right) Add a 'blocks' relation (this issue blocks…)",
          command: "linearLens.addBlocker",
        },
        {
          label: "$(trash) Remove an existing blocker relation…",
          command: "linearLens.removeBlocker",
        },
      ];
      const choice = await vscode.window.showQuickPick(actions, {
        title: "Linear Lens: Edit Blockers",
        placeHolder: "Choose a blocker action",
        ignoreFocusOut: true,
      });
      if (!choice) {
        return;
      }
      await vscode.commands.executeCommand(choice.command, arg);
    }),
  );

  // Commands (search / navigation / view / auth / branch).
  registerCommands(context, {
    getCfg,
    getTeamKeys,
    getSlug,
    client,
    branch,
    diagnostics,
    refreshConfig,
    refreshUi,
    onAuthChanged: maybeRefreshDetection,
    secrets: context.secrets,
    views: { file: fileIssues, mine: myIssues, recent: recentIssues, fileTreeView },
  });

  // Copy-as-Markdown command (E1): read-only, no write-auth gate.
  registerCopyCommands(context, { getCfg, getTeamKeys, client });

  // Edit + blocker commands (E2). Every mutating command re-checks write access at
  // runtime via `ensureWriteAuth` (prompting / no-op when a write credential is
  // missing) before any write, so they degrade gracefully even when surfaced while
  // signed out. Menus additionally hide them behind `config.linearLens.edit.enable`
  // (+ `linearLens.authed`) to keep menus clean. Targeted `invalidate` + the refresh
  // callbacks repaint every surface after a successful write.
  const writeAuthDeps = { secrets: context.secrets };
  registerEditCommands(context, {
    getCfg,
    getTeamKeys,
    client,
    writeAuthDeps,
    refreshUi,
    refreshViews,
    refreshDetail,
    invalidate,
  });
  registerBlockerCommands(context, {
    getCfg,
    getTeamKeys,
    client,
    writeAuthDeps,
    refreshUi,
    refreshViews,
    refreshDetail,
    invalidate,
  });

  // Create-issue wizard (E3). The command re-checks write access at runtime
  // (`ensureWriteAuth`) before any read/write, refreshes the trees on success, and
  // offers to open the new issue. The menus hide it behind
  // `config.linearLens.create.enable`.
  registerCreateCommand(context, { getCfg, client, writeAuthDeps, refreshViews });

  // `linearLens.refreshTeams`: title-bar refresh for the Teams + Active Cycle
  // views (the shared `linearLens.refreshViews` only refreshes file/mine/recent).
  context.subscriptions.push(
    vscode.commands.registerCommand("linearLens.refreshTeams", () => {
      teams.refresh();
      cycle.refresh();
    }),
  );

  // Team board webview + active-cycle view (E3). The board's drag-to-status WRITE
  // is gated host-side (write-auth gate → `updateIssue`); no writes happen at
  // build time (the path is exercised only by unit tests with a mocked client).
  const board = new BoardPanel(context.extensionUri, {
    onOpenIssue: (id) => {
      void vscode.commands.executeCommand("linearLens.openTicket", { id });
    },
    onCopyAsMarkdown: (id) => {
      void vscode.commands.executeCommand("linearLens.copyIssueMarkdown", { id });
    },
    onRefresh: (): Promise<BoardData | null> | null => {
      const teamId = board.currentTeamId;
      return teamId ? buildBoardData(client, getCfg, writeAuthDeps, teamId) : null;
    },
    // [WRITE-AUTH GATE] then the single gated `updateIssue`. The host resolves the
    // issue UUID from its own render snapshot (never the webview), so a spoofed
    // `moveCard` cannot retarget the write.
    onMoveCard: async ({ issueUuid, toStateId }): Promise<BoardMoveOutcome> => {
      const gate = await ensureWriteAuth(writeAuthDeps);
      if (!gate.ok) {
        return { ok: false };
      }
      const result = await client.updateIssue(issueUuid, { stateId: toStateId });
      if (!result.ok) {
        void vscode.window.showWarningMessage(`Linear Lens: ${result.message}`);
        return { ok: false };
      }
      // Invalidate the moved issue + repaint every surface; re-fetch the board so
      // the optimistic move is reconciled with Linear's authoritative state.
      const moved = parseIssueId(result.value.identifier, { teamKeys: getTeamKeys() });
      if (moved) {
        invalidate(moved);
      }
      refreshViews();
      const teamId = board.currentTeamId;
      const fresh = teamId
        ? await buildBoardData(client, getCfg, writeAuthDeps, teamId)
        : null;
      return { ok: true, data: fresh ?? undefined };
    },
  });
  context.subscriptions.push({ dispose: () => board.dispose() });

  // `linearLens.openTeamBoard`: open the board for an explicit `{ teamId }` /
  // `{ team: { id } }` arg (tree node) or prompt for a team. Never throws.
  context.subscriptions.push(
    vscode.commands.registerCommand("linearLens.openTeamBoard", async (arg?: unknown) => {
      try {
        if (!getCfg().boardEnable) {
          void vscode.window.showInformationMessage(
            "Linear Lens: the team Board is disabled (linearLens.board.enable).",
          );
          return;
        }
        const team = await resolveTeamArg(client, arg);
        if (!team) {
          return;
        }
        board.showLoading();
        const data = await buildBoardData(client, getCfg, writeAuthDeps, team.id, team);
        if (data) {
          board.render(data);
        } else {
          board.showError(
            "Could not load the board. Sign in to Linear (or set a personal API key), then try again.",
          );
        }
      } catch {
        // The command handler must never throw.
      }
    }),
    // `linearLens.openCycle`: point the Active Cycle view at a team (explicit arg
    // or prompt) and reveal it. Never throws.
    vscode.commands.registerCommand("linearLens.openCycle", async (arg?: unknown) => {
      try {
        const team = await resolveTeamArg(client, arg);
        if (!team) {
          return;
        }
        cycle.setTeam(team);
        try {
          await vscode.commands.executeCommand("linearLens.viewCycle.focus");
        } catch {
          // Focusing the view is best-effort.
        }
      } catch {
        // The command handler must never throw.
      }
    }),
  );

  // Refresh when Linear's authentication sessions change (sign in/out).
  context.subscriptions.push(
    vscode.authentication.onDidChangeSessions((e) => {
      if (e.provider.id === "linear") {
        void client.refreshAuth().then(() => {
          setAuthedContext();
          refreshUi();
          inline.refresh();
          rail.refresh();
          comments.refreshActive();
          refreshViews();
          refreshDetail();
          // Re-detect the workspace's team keys / slug on sign-in / out.
          maybeRefreshDetection();
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
      rail.refresh();
      comments.refreshActive();
      refreshViews();
      refreshDetail();
      // The config override (teamKeys / workspaceSlug) takes effect immediately
      // via the effective getters; still refresh detection so the detected
      // fallback stays current (honoring `teams.autoDetect`).
      maybeRefreshDetection();
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
 * Resolve the active grouping/sort for the team + cycle trees from the configured
 * defaults (`linearLens.view.defaultGroupBy` / `defaultSortBy`). Both fields are
 * validated by {@link getConfig}; the sort direction follows Linear's
 * conventions (newest/highest-first) per key. Pure; never throws.
 *
 * @param cfg - The current resolved configuration.
 * @returns The grouping/sort the trees apply in `getChildren`.
 */
function resolveGrouping(cfg: LinearLensConfig): ViewGroupingState {
  const groupBy = cfg.viewDefaultGroupBy as GroupBy;
  const by = cfg.viewDefaultSortBy as SortBy;
  // Ascending only reads naturally for the title sort; everything else defaults
  // to descending (most-recent / highest-priority first), matching DEFAULT_SORT.
  const sort: IssueSort = by === "title" ? { by, dir: "asc" } : { by, dir: DEFAULT_SORT.dir };
  return { groupBy, sort };
}

/**
 * Resolve a {@link TeamOption} from a loosely-typed command argument, or prompt
 * the user to pick one. Accepts a bare team-UUID string, a `{ teamId }` object,
 * or a tree node's `{ team: { id } }`. Falls back to a QuickPick over the teams
 * the client can list. Returns `undefined` when the user cancels / no team is
 * available. Never throws.
 *
 * @param client - The Linear API client (degrades to an empty list).
 * @param arg - The loosely-typed command argument.
 * @returns The chosen team, or `undefined`.
 */
async function resolveTeamArg(
  client: LinearClient,
  arg: unknown,
): Promise<TeamOption | undefined> {
  try {
    const teams = await client.listTeams();
    const fromArg = teamFromArg(arg, teams);
    if (fromArg) {
      return fromArg;
    }
    if (teams.length === 0) {
      void vscode.window.showWarningMessage(
        "Linear Lens: no teams to show (sign in, set a personal API key, or check your access).",
      );
      return undefined;
    }
    if (teams.length === 1) {
      return teams[0];
    }
    interface TeamItem extends vscode.QuickPickItem {
      readonly team: TeamOption;
    }
    const items: TeamItem[] = teams.map((team) => ({
      label: team.key ? `${team.key} · ${team.name}` : team.name || team.key || team.id,
      description: team.name && team.key ? undefined : team.id,
      team,
    }));
    const picked = await vscode.window.showQuickPick(items, {
      title: "Linear Lens: Select a Team",
      placeHolder: "Pick a team",
      ignoreFocusOut: true,
      matchOnDescription: true,
    });
    return picked?.team;
  } catch {
    return undefined;
  }
}

/**
 * Extract a {@link TeamOption} from a command argument: a bare team-UUID string,
 * `{ teamId }`, or a tree node's `{ team: { id, key, name } }`. Returns a matching
 * team from `teams` when the id resolves, else (for a node carrying full team
 * fields) the node's own team. Pure; never throws.
 *
 * @param arg - The loosely-typed command argument.
 * @param teams - The known teams to match an id against.
 * @returns The resolved team, or `undefined`.
 */
function teamFromArg(arg: unknown, teams: readonly TeamOption[]): TeamOption | undefined {
  let id: string | undefined;
  let inlineTeam: TeamOption | undefined;
  if (typeof arg === "string") {
    id = arg.trim() || undefined;
  } else if (typeof arg === "object" && arg !== null) {
    const obj = arg as { teamId?: unknown; team?: unknown };
    if (typeof obj.teamId === "string") {
      id = obj.teamId.trim() || undefined;
    }
    if (typeof obj.team === "object" && obj.team !== null) {
      const t = obj.team as { id?: unknown; key?: unknown; name?: unknown };
      if (typeof t.id === "string") {
        id = id ?? (t.id.trim() || undefined);
        inlineTeam = {
          id: t.id,
          key: typeof t.key === "string" ? t.key : "",
          name: typeof t.name === "string" ? t.name : "",
        };
      }
    }
  }
  if (id) {
    const match = teams.find((t) => t.id === id);
    if (match) {
      return match;
    }
  }
  return inlineTeam;
}

/**
 * Assemble the {@link BoardData} for a team: its workflow states (columns), its
 * issues mapped to {@link BoardCard}s, and whether a write credential is present
 * (drives draggability). Returns `null` when the team's states/issues cannot be
 * loaded (so the caller can show an error pane). Never throws.
 *
 * @param client - The Linear API client (degrades gracefully).
 * @param getCfg - Accessor for the current configuration (list limit).
 * @param writeAuthDeps - Deps to detect whether a write credential is present.
 * @param teamId - The team UUID to load.
 * @param known - The team (when already resolved) for the heading; else fetched.
 * @returns The board payload, or `null` on failure.
 */
async function buildBoardData(
  client: LinearClient,
  getCfg: () => LinearLensConfig,
  writeAuthDeps: { secrets: vscode.SecretStorage },
  teamId: string,
  known?: TeamOption,
): Promise<BoardData | null> {
  try {
    const cfg = getCfg();
    if (!cfg.enableApi || !safeHasAuth(client)) {
      return null;
    }
    const limit = cfg.viewsRecentLimit;
    // `listTeamIssues` is provided by the foundation/board client step; read it
    // structurally so the board compiles + degrades (empty list) until it lands.
    const listable = client as Partial<{
      listTeamIssues: (id: string, n: number) => Promise<IssueListItem[]>;
    }>;
    const [states, issues] = await Promise.all([
      client.listWorkflowStates(teamId),
      typeof listable.listTeamIssues === "function"
        ? listable.listTeamIssues(teamId, limit)
        : Promise.resolve<IssueListItem[]>([]),
    ]);
    const canWrite = await hasWriteCredential(writeAuthDeps);
    const team = known ?? (await client.listTeams()).find((t) => t.id === teamId);
    return {
      teamName: teamHeading(team, teamId),
      teamId,
      states,
      cards: (issues ?? []).map(toBoardCard),
      canWrite,
    };
  } catch {
    return null;
  }
}

/** Whether a write credential (personal API key or write OAuth) is present. */
async function hasWriteCredential(deps: {
  secrets: vscode.SecretStorage;
}): Promise<boolean> {
  try {
    return await hasWriteAuth(deps);
  } catch {
    return false;
  }
}

/** Compose the board heading from a team ("KEY · Name") or fall back to its id. */
function teamHeading(team: TeamOption | undefined, teamId: string): string {
  if (!team) {
    return teamId;
  }
  if (team.key && team.name) {
    return `${team.key} · ${team.name}`;
  }
  return team.name || team.key || teamId;
}

/**
 * Map a (board-extended) {@link IssueListItem} to a {@link BoardCard}. The board
 * extra fields (`uuid`, `stateId`, priority, labels, …) are read structurally so
 * this compiles against the shipped, narrower `IssueListItem` and is populated
 * once the team/board list query selects them. Pure; never throws.
 *
 * @param item - The issue list item to project.
 * @returns The board-facing card.
 */
function toBoardCard(item: IssueListItem): BoardCard {
  const extra = item as IssueListItem & {
    uuid?: string;
    stateId?: string;
    assigneeAvatarUrl?: string;
    priority?: number;
    priorityLabel?: string;
    number?: number;
    labels?: { id?: string; name?: string; color?: string }[];
  };
  const labels = Array.isArray(extra.labels)
    ? extra.labels
        .filter((l): l is { name: string; color?: string } => Boolean(l && l.name))
        .map((l) => ({ name: l.name, color: l.color }))
    : undefined;
  return {
    id: item.id,
    uuid: extra.uuid,
    title: item.title,
    stateId: extra.stateId,
    assignee: item.assignee,
    assigneeAvatarUrl: extra.assigneeAvatarUrl,
    priority: extra.priority,
    priorityLabel: extra.priorityLabel,
    number: extra.number,
    labels,
  };
}

/**
 * Resolve the issue id to open in the detail webview from a command argument or,
 * failing that, the reference under the active editor's cursor. Accepts a bare
 * id string, an `{ id }` object (as tree nodes pass), or no argument (cursor).
 * Returns the normalized id, or `undefined` when none can be resolved.
 *
 * @param arg The loosely-typed command argument.
 * @param cfg The current resolved configuration (for markers).
 * @param teamKeys The effective team-key allowlist (auth-aware detection).
 */
function resolveTicketId(
  arg: unknown,
  cfg: LinearLensConfig,
  teamKeys: string[] | undefined,
): string | undefined {
  // 1. Explicit string / `{ id }` argument (palette input, tree selection).
  let raw: string | undefined;
  if (typeof arg === "string") {
    raw = arg.trim();
  } else if (typeof arg === "object" && arg !== null) {
    const candidate = (arg as { id?: unknown }).id;
    raw = typeof candidate === "string" ? candidate.trim() : undefined;
  }
  if (raw) {
    const parsed = parseIssueId(raw, { teamKeys });
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
      teamKeys,
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
 * Resolve the normalized issue id + canonical URL to open for the
 * `linearLens.openInTool` command. Reuses {@link resolveTicketId} for the id
 * (argument / tree node / cursor), then prefers the client's live canonical URL,
 * falling back to a slug-derived URL. Returns `undefined` when no id can be
 * resolved. Never throws.
 *
 * @param arg    The loosely-typed command argument.
 * @param client The Linear API client (degrades gracefully).
 * @param cfg    The current resolved configuration (markers).
 * @param teamKeys The effective team-key allowlist (auth-aware detection).
 * @param slug   The effective workspace slug (configured or detected).
 */
async function resolveOpenInTarget(
  arg: unknown,
  client: LinearClient,
  cfg: LinearLensConfig,
  teamKeys: string[] | undefined,
  slug: string,
): Promise<{ id: string; url?: string } | undefined> {
  const id = resolveTicketId(arg, cfg, teamKeys);
  if (!id) {
    return undefined;
  }
  const parsed = parseIssueId(id, { teamKeys });
  let url: string | undefined;
  if (parsed) {
    try {
      const meta = await client.fetchIssue(parsed);
      url = meta?.url;
    } catch {
      // Fall through to the slug-derived URL.
    }
    if (!url && slug) {
      url = issueUrl(parsed, slug);
    }
  }
  return { id, url };
}

/**
 * Fetch the full {@link TicketDetail} for a normalized id and adapt it to the
 * {@link IssueMetadata} shape the webview panel renders. Returns `null` when the
 * client cannot resolve the issue. Never throws.
 *
 * @param client The Linear API client (degrades gracefully).
 * @param getTeamKeys Accessor for the effective team-key allowlist.
 * @param id     The normalized issue id, e.g. "ENG-123".
 */
async function fetchTicketMetadata(
  client: { fetchTicketDetail(id: IssueId): Promise<TicketDetail | null> },
  getTeamKeys: () => string[] | undefined,
  id: string,
): Promise<IssueMetadata | null> {
  const parsed = parseIssueId(id, { teamKeys: getTeamKeys() });
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
 * @param cfg The current resolved configuration (for markers).
 * @param detection The auth-aware detection service (effective team keys).
 */
function computeSelectionContext(
  cfg: LinearLensConfig,
  detection: DetectionService,
): void {
  let hasRefs = false;
  let refUnderCursor = false;
  try {
    const editor = vscode.window.activeTextEditor;
    if (editor) {
      const document = editor.document;
      const refs = scanText(document.getText(), {
        teamKeys: detection.effectiveTeamKeys(),
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
