/**
 * Linear Lens — "My Issues" / "Assigned · Recent" tree views.
 *
 * A single {@link vscode.TreeDataProvider} parameterized by {@link IssueListScope}
 * backs both the "My Issues" (`"mine"`) and "Recent" (`"recent"`) views, keeping
 * the rendering and resilience logic DRY (spec V2 §5).
 *
 * Resilience contract:
 *  - Requires auth: when `client.hasAuth()` is false, shows a single "Sign in to
 *    Linear" message node (command `linearLens.signIn`) — never an empty tree.
 *  - When `views.enable` is false, shows a "views disabled" message node.
 *  - `getChildren` does the network fetch LAZILY and NEVER throws; on any error
 *    it returns a message node. Results are cached briefly in-memory so the tree
 *    does not refetch on every reveal; {@link IssueListProvider.refresh} clears
 *    the cache and re-fires.
 */

import * as vscode from "vscode";
import { IssueListItem, IssueListScope, LinearClient, LinearLensConfig } from "../types";
import { IssueNode, LinearTreeNode } from "./issueTreeModel";
import { toTreeItem } from "./treeItem";
import { listLimit, viewsEnabled } from "./viewsConfig";
import { sortIssues } from "./grouping";
import { worktreeRelevance, type GitContext } from "../git/worktree";

/** How long a fetched list stays fresh before the next `getChildren` refetches. */
const LIST_CACHE_MS = 30_000;

/** Command run from the unauthenticated sign-in message node. */
const COMMAND_SIGN_IN = "linearLens.signIn";

/**
 * Optional list surface on the client (added by the V2 client step). Typed
 * structurally so this provider compiles against the current {@link LinearClient}
 * and degrades to an empty list if the method is absent.
 */
interface ListClient {
  listIssues?: (scope: IssueListScope, limit: number) => Promise<IssueListItem[]>;
}

/** A cached list fetch plus its expiry timestamp. */
interface ListCache {
  items: IssueListItem[];
  expiresAt: number;
}

/**
 * Tree of the viewer's issues for a given scope. Construct one per view, then
 * register with `vscode.window.registerTreeDataProvider`.
 */
export class IssueListProvider implements vscode.TreeDataProvider<LinearTreeNode> {
  private readonly emitter = new vscode.EventEmitter<void>();
  /** Fired whenever the tree should be recomputed (e.g. after refresh / auth). */
  public readonly onDidChangeTreeData: vscode.Event<void> = this.emitter.event;

  private readonly scope: IssueListScope;
  private readonly getCfg: () => LinearLensConfig;
  private readonly client: LinearClient;
  private readonly getGitContext: () => GitContext;
  private cache: ListCache | undefined;
  private disposed = false;

  /**
   * @param scope  Which working set this view targets (`"mine"` | `"recent"`).
   * @param getCfg Accessor for the current, validated extension configuration.
   * @param client Linear API client; used to fetch the list (defensive/never-throws).
   * @param getGitContext Optional accessor for the current git context, used to
   *   emphasize (sort-to-top) the issue matching the checked-out branch when
   *   `linearLens.worktree.filter` is enabled. Defaults to an empty context
   *   (no emphasis) so the view works without git plumbing.
   */
  constructor(
    scope: IssueListScope,
    getCfg: () => LinearLensConfig,
    client: LinearClient,
    getGitContext: () => GitContext = () => ({}),
  ) {
    this.scope = scope;
    this.getCfg = getCfg;
    this.client = client;
    this.getGitContext = getGitContext;
  }

  /** {@inheritDoc vscode.TreeDataProvider.getTreeItem} */
  public getTreeItem(node: LinearTreeNode): vscode.TreeItem {
    return toTreeItem(node);
  }

  /**
   * Compute the children for the list view. Flat tree, so children are produced
   * only for the (undefined) root. Performs the fetch lazily and never throws.
   */
  public async getChildren(node?: LinearTreeNode): Promise<LinearTreeNode[]> {
    if (node) {
      return [];
    }

    try {
      const cfg = this.getCfg();
      if (!viewsEnabled(cfg)) {
        return [message("Linear views are disabled (linearLens.views.enable).")];
      }

      // Auth gate: never show an empty tree to a signed-out user.
      if (!this.safeHasAuth()) {
        return [message("Sign in to Linear", COMMAND_SIGN_IN)];
      }

      const items = await this.loadItems(listLimit(cfg));
      if (items.length === 0) {
        return [message(this.scope === "mine" ? "No issues assigned to you." : "No recent issues.")];
      }

      const ordered = this.orderItems(items, cfg);
      return ordered.map((item): IssueNode => ({ kind: "issue", item }));
    } catch {
      // Absolute backstop — surface a node, never throw.
      return [message("Could not load Linear issues.")];
    }
  }

  /**
   * Clear the in-memory list cache and fire a change event so the view refetches
   * on its next `getChildren`. Call after sign-in/out, cache refresh, or manual
   * refresh.
   */
  public refresh(): void {
    if (this.disposed) {
      return;
    }
    this.cache = undefined;
    this.emitter.fire();
  }

  /** Dispose the change emitter and drop the cache. */
  public dispose(): void {
    this.disposed = true;
    this.cache = undefined;
    this.emitter.dispose();
  }

  /**
   * Order the loaded items for display: sort by the configured
   * `linearLens.view.defaultSortBy`, then (when `linearLens.worktree.filter` is
   * not `"off"`) stably move the issue matching the current branch to the top.
   * Pure transform over a copy; never throws.
   *
   * @param items The freshly loaded issue summaries (not mutated).
   * @param cfg   The current resolved configuration.
   * @returns     A new, ordered array.
   */
  private orderItems(items: IssueListItem[], cfg: LinearLensConfig): IssueListItem[] {
    // Sort by the configured key (descending for everything but title, matching
    // the tree views' DEFAULT_SORT direction convention).
    const dir = cfg.viewDefaultSortBy === "title" ? "asc" : "desc";
    let ordered = sortIssues(items, { by: cfg.viewDefaultSortBy, dir });

    if (cfg.worktreeFilter !== "off") {
      try {
        const ctx = this.getGitContext();
        const emphasized: IssueListItem[] = [];
        const rest: IssueListItem[] = [];
        for (const item of ordered) {
          if (worktreeRelevance(item, cfg.worktreeFilter, ctx).emphasize) {
            emphasized.push(item);
          } else {
            rest.push(item);
          }
        }
        if (emphasized.length > 0) {
          ordered = [...emphasized, ...rest];
        }
      } catch {
        // Worktree emphasis is best-effort; fall back to the sorted order.
      }
    }
    return ordered;
  }

  /**
   * Load the scoped list, using the short-lived in-memory cache when fresh.
   * Returns `[]` on any failure (disabled API / no auth / network / error).
   */
  private async loadItems(limit: number): Promise<IssueListItem[]> {
    const now = Date.now();
    if (this.cache && now < this.cache.expiresAt) {
      return this.cache.items;
    }

    const listable = this.client as unknown as ListClient;
    if (typeof listable.listIssues !== "function") {
      return [];
    }

    let items: IssueListItem[];
    try {
      items = await listable.listIssues(this.scope, limit);
    } catch {
      // The client is contractually never-throwing, but guard anyway.
      return [];
    }
    const safe = Array.isArray(items) ? items : [];
    this.cache = { items: safe, expiresAt: now + LIST_CACHE_MS };
    return safe;
  }

  /** Read `client.hasAuth()` without ever throwing. */
  private safeHasAuth(): boolean {
    try {
      return this.client.hasAuth();
    } catch {
      return false;
    }
  }
}

/** Build a {@link MessageNode} with an optional click command. */
function message(text: string, command?: string): LinearTreeNode {
  return command ? { kind: "message", text, command } : { kind: "message", text };
}
