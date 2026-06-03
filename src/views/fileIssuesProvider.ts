/**
 * Linear Lens — "Issues in This File" tree view.
 *
 * Lists every Linear reference found in the ACTIVE editor's document as a
 * TODO-style tree: each node shows the code context (the source line) plus
 * Linear primitives (a colored state dot + title when a live summary is
 * available from the client's sync cache). Clicking a node reveals the line.
 *
 * Resilience contract (spec V2 §5):
 *  - `getChildren` NEVER throws; on any failure it returns a single message node.
 *  - When `views.enable` is false, it returns a "views disabled" message node so
 *    the container stays stable (content is gated, not registration).
 *  - It does NO blocking network work: live summaries come only from a sync
 *    cache peek when the client offers one (`peekIssue`), avoiding an await storm.
 *  - Refresh is debounced (~200 ms) and follows the active editor.
 */

import * as vscode from "vscode";
import { IssueId, IssueListItem, LinearClient, LinearLensConfig } from "../types";
import { parseIssueId, scanText } from "../parser";
import { buildFileRefNodes, FileRefNode, LinearTreeNode } from "./issueTreeModel";
import { toTreeItem } from "./treeItem";
import { viewsEnabled } from "./viewsConfig";

/** Debounce window for `refresh()` so rapid edits coalesce into one update. */
const REFRESH_DEBOUNCE_MS = 200;

/** Command id used by the empty/disabled message node CTA. */
const COMMAND_CONFIGURE_WORKSPACE = "linearLens.configureWorkspace";

/** URI schemes considered "real" text editors (file + untitled). */
const SUPPORTED_SCHEMES = new Set(["file", "untitled"]);

/**
 * Optional sync cache-peek surface on the client. `peekIssue` returns a
 * cached {@link IssueMetadata}-like value synchronously when present, or
 * `undefined` — letting the file view show live state dots without awaiting.
 * Typed structurally so this provider compiles whether or not the client
 * implements it (it degrades to id-only nodes when absent).
 */
interface PeekableClient {
  peekIssue?: (id: IssueId) => { id?: string; title?: string; state?: string; stateType?: string; stateColor?: string; url?: string; assignee?: { displayName?: string; name?: string } } | null | undefined;
}

/**
 * Provides the "Issues in This File" tree. Construct once, register with
 * `vscode.window.registerTreeDataProvider` (or `createTreeView`), and call
 * {@link FileIssuesProvider.refresh} on active-editor / document changes.
 */
export class FileIssuesProvider implements vscode.TreeDataProvider<LinearTreeNode> {
  private readonly emitter = new vscode.EventEmitter<void>();
  /** Fired (debounced) whenever the tree's contents should be recomputed. */
  public readonly onDidChangeTreeData: vscode.Event<void> = this.emitter.event;

  private readonly getCfg: () => LinearLensConfig;
  private readonly client: LinearClient;
  private debounceTimer: ReturnType<typeof setTimeout> | undefined;
  private disposed = false;
  /**
   * The most recently seen supported text editor (file/untitled). Preserved as a
   * fallback when `vscode.window.activeTextEditor` becomes `undefined` because a
   * non-text view (webview panel, Output, etc.) takes focus — so the file tree
   * does not blank out while browsing a ticket detail panel.
   *
   * Reset to `undefined` only when the provider is disposed. Starts as `undefined`
   * ("never seen a supported editor") so the empty placeholder is correct on cold
   * start before any editor is opened.
   */
  private lastSupportedEditor: vscode.TextEditor | undefined;

  /**
   * @param getCfg Accessor for the current, validated extension configuration.
   * @param client Linear API client (used only for a non-blocking sync peek).
   */
  constructor(getCfg: () => LinearLensConfig, client: LinearClient) {
    this.getCfg = getCfg;
    this.client = client;
    // Seed the fallback with whichever editor is active when we are constructed so
    // the very first `getChildren` call already has something to render.
    const current = vscode.window.activeTextEditor;
    if (current && SUPPORTED_SCHEMES.has(current.document.uri.scheme)) {
      this.lastSupportedEditor = current;
    }
  }

  /** {@inheritDoc vscode.TreeDataProvider.getTreeItem} */
  public getTreeItem(node: LinearTreeNode): vscode.TreeItem {
    return toTreeItem(node);
  }

  /**
   * Compute the children for the file view. The tree is flat, so `getChildren`
   * only returns children for the (undefined) root. Never throws.
   */
  public getChildren(node?: LinearTreeNode): vscode.ProviderResult<LinearTreeNode[]> {
    // Flat tree: only the root has children.
    if (node) {
      return [];
    }

    try {
      const cfg = this.getCfg();
      if (!viewsEnabled(cfg)) {
        return [message("Linear views are disabled (linearLens.views.enable).")];
      }

      // Prefer the active editor; fall back to the last known supported editor so
      // the tree does not blank when a webview panel or Output channel takes focus.
      // Show the empty placeholder only when we have genuinely never seen a
      // supported editor (cold start or all editors closed).
      const active = vscode.window.activeTextEditor;
      if (active && SUPPORTED_SCHEMES.has(active.document.uri.scheme)) {
        this.lastSupportedEditor = active;
      }
      const editor = active && SUPPORTED_SCHEMES.has(active.document.uri.scheme)
        ? active
        : this.lastSupportedEditor;
      if (!editor) {
        return [message("Open a file to see its Linear references.")];
      }

      const document = editor.document;
      const text = document.getText();
      const refs = scanText(text, { teamKeys: cfg.teamKeys, markers: cfg.markers });
      if (refs.length === 0) {
        return [
          message(
            "No Linear references in this file.",
            cfg.workspaceSlug ? undefined : COMMAND_CONFIGURE_WORKSPACE,
          ),
        ];
      }

      // Derive line numbers via the document (authoritative) and trim line text.
      const nodes = buildFileRefNodes(
        refs,
        (ref) => document.positionAt(ref.start).line,
        (line) => safeLineText(document, line),
      );

      // Enrich with a sync cache peek when the client offers one. No awaits.
      for (const fileRef of nodes) {
        const item = this.peek(fileRef.id, cfg.teamKeys);
        if (item) {
          fileRef.item = item;
        }
      }

      return nodes;
    } catch {
      // Absolute backstop: a flat informational node, never a thrown error.
      return [message("Could not read Linear references in this file.")];
    }
  }

  /**
   * Recompute the tree for the current active editor and fire a change event.
   * Debounced (~200 ms) so a burst of edits collapses into a single refresh.
   */
  public refresh(): void {
    if (this.disposed) {
      return;
    }
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
    }
    this.debounceTimer = setTimeout(() => {
      this.debounceTimer = undefined;
      if (!this.disposed) {
        this.emitter.fire();
      }
    }, REFRESH_DEBOUNCE_MS);
  }

  /** Dispose the change emitter and cancel any pending debounce. */
  public dispose(): void {
    this.disposed = true;
    this.lastSupportedEditor = undefined;
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = undefined;
    }
    this.emitter.dispose();
  }

  /**
   * Synchronously peek a cached summary for `id` via the client's optional
   * `peekIssue`, normalizing it into an {@link IssueListItem}. Returns undefined
   * when the client has no peek, the cache misses, or anything goes wrong.
   */
  private peek(id: string, teamKeys: string[]): IssueListItem | undefined {
    const peekable = this.client as unknown as PeekableClient;
    if (typeof peekable.peekIssue !== "function") {
      return undefined;
    }
    const parsed = parseIssueId(id, { teamKeys });
    if (!parsed) {
      return undefined;
    }
    try {
      const meta = peekable.peekIssue(parsed);
      if (!meta) {
        return undefined;
      }
      return {
        id: meta.id || id,
        title: meta.title ?? "",
        state: meta.state ?? "",
        stateType: meta.stateType ?? undefined,
        stateColor: meta.stateColor ?? undefined,
        assignee: meta.assignee?.displayName || meta.assignee?.name || undefined,
        url: meta.url ?? "",
      };
    } catch {
      return undefined;
    }
  }
}

/** Build a {@link MessageNode} with an optional click command. */
function message(text: string, command?: string): LinearTreeNode {
  return command ? { kind: "message", text, command } : { kind: "message", text };
}

/** Read a document line's text, tolerating an out-of-range index. */
function safeLineText(document: vscode.TextDocument, line: number): string {
  if (line < 0 || line >= document.lineCount) {
    return "";
  }
  return document.lineAt(line).text;
}

// Re-export for callers that want the concrete node type alongside the provider.
export type { FileRefNode };
