/**
 * Linear Lens — "Teams" + "Cycle" Activity Bar tree views.
 *
 * Two {@link vscode.TreeDataProvider}s live here:
 *
 *  - {@link TeamsProvider} backs `linearLens.viewTeams`: it lists the teams the
 *    user cares about (filtered by the `linearLens.teams.show` setting via the
 *    pure {@link filterTeams} helper), and lazily loads each team's issues when a
 *    team node is expanded. Grouping / sorting is applied through the pure
 *    {@link applyGrouping} helper, so an expanded team can show flat issues or
 *    grouped buckets (by status / assignee / priority / project / label).
 *
 *  - {@link CycleProvider} backs the active-cycle surface: a flat (or grouped)
 *    list of the current cycle's issues for a single team (chosen by the user,
 *    remembered on the provider). It reuses the same rendering + resilience.
 *
 * Resilience contract (mirrors {@link IssueListProvider}):
 *  - Requires auth: when `client.hasAuth()` is false, a single "Sign in to
 *    Linear" message node is shown — never an empty tree.
 *  - When `views.enable` (or `teams.enable`) is off, a disabled-message node.
 *  - `getChildren` fetches LAZILY and NEVER throws; on any error it yields a
 *    message node. Results are cached briefly in-memory; {@link TeamsProvider.refresh}
 *    clears the cache and re-fires.
 *
 * Only the rendering / provider glue imports `vscode`; the node shapes, team
 * filtering, and grouping/sorting live in the pure sibling modules.
 *
 * See board spec §2 (Teams tree) and §3 (Cycle).
 */

import * as vscode from "vscode";
import {
  IssueListItem,
  LinearClient,
  LinearLensConfig,
  TeamOption,
} from "../types";
import { applyGrouping, GroupBy, IssueGroup, IssueSort, DEFAULT_SORT } from "./grouping";
import { listLimit, viewsEnabled } from "./viewsConfig";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** How long a fetched list stays fresh before the next `getChildren` refetches. */
const LIST_CACHE_MS = 30_000;

/** Command run from the unauthenticated sign-in message node. */
const COMMAND_SIGN_IN = "linearLens.signIn";

/** Command run when an issue node is activated — opens the detail webview. */
const COMMAND_OPEN_TICKET = "linearLens.openTicket";

/** Context value applied to team nodes, driving `view/item/context` menus. */
const CONTEXT_VALUE_TEAM = "linearTeam";

/** Context value applied to issue-bearing nodes (matches the shipped convention). */
const CONTEXT_VALUE_ISSUE = "linearIssue";

/** Context value applied to group-header nodes. */
const CONTEXT_VALUE_GROUP = "linearGroup";

/** Context value applied to message / empty-state nodes. */
const CONTEXT_VALUE_MESSAGE = "linearMessage";

// ---------------------------------------------------------------------------
// Node model (local to this view; rendered by this provider's getTreeItem)
// ---------------------------------------------------------------------------

/** A team node — collapsible; children are its issues (lazily loaded). */
interface TeamNode {
  readonly kind: "team";
  readonly team: TeamOption;
}

/** A grouping-header node whose children are the issues in the bucket. */
interface GroupNode {
  readonly kind: "group";
  /** The team this group belongs to (so children can be re-derived on reveal). */
  readonly teamId?: string;
  readonly group: IssueGroup;
}

/** An issue summary node. */
interface IssueNode {
  readonly kind: "issue";
  readonly item: IssueListItem;
}

/** An informational placeholder (sign-in CTA / empty state). */
interface MessageNode {
  readonly kind: "message";
  readonly text: string;
  readonly command?: string;
}

/** Any node either tree can render. */
type TeamsTreeNode = TeamNode | GroupNode | IssueNode | MessageNode;

// ---------------------------------------------------------------------------
// Defensive client surface
// ---------------------------------------------------------------------------

/**
 * The team/cycle list methods this view needs. Typed structurally (and
 * optional) so the providers compile against the current {@link LinearClient}
 * and degrade to an empty list if a method is not yet present on the client.
 */
interface TeamsListClient {
  listTeams?: () => Promise<TeamOption[]>;
  listViewerTeams?: () => Promise<TeamOption[]>;
  listTeamIssues?: (teamId: string, limit: number) => Promise<IssueListItem[]>;
  listCycleIssues?: (teamId: string, limit: number) => Promise<IssueListItem[]>;
}

/** A cached list fetch plus its expiry timestamp. */
interface ListCache<T> {
  value: T;
  expiresAt: number;
}

// ---------------------------------------------------------------------------
// Optional view-state accessor (grouping/sort per view)
// ---------------------------------------------------------------------------

/** The grouping/sort a tree currently applies. */
export interface ViewGroupingState {
  readonly groupBy: GroupBy;
  readonly sort: IssueSort;
}

/**
 * Resolve the active grouping/sort for a view. Supplied by the integrate step
 * (e.g. backed by the saved-view store / settings). Optional everywhere; when
 * absent the providers fall back to {@link defaultGrouping}.
 */
export type GroupingResolver = () => ViewGroupingState;

/** The default grouping/sort: flat list, newest-updated first. */
function defaultGrouping(): ViewGroupingState {
  return { groupBy: "none", sort: DEFAULT_SORT };
}

// ---------------------------------------------------------------------------
// Pure team filtering
// ---------------------------------------------------------------------------

/**
 * Filter the full team list to the teams the user wants in the sidebar, per the
 * `linearLens.teams.show` setting.
 *
 *  - `[]` (empty)    → show ALL teams the input contains (no filtering).
 *  - `["ENG","DES"]` → keep only teams whose KEY matches (case-insensitive).
 *
 * Pure: preserves input order, de-dups by team id, and never throws. Unknown
 * keys are simply dropped (they match no team).
 *
 * @param teams    The full team list from the client.
 * @param showKeys Team keys to keep; empty keeps everything.
 * @returns        The filtered, de-duplicated team list in input order.
 */
export function filterTeams(teams: TeamOption[], showKeys: string[]): TeamOption[] {
  const safeTeams = Array.isArray(teams) ? teams : [];
  const wanted = new Set(
    (Array.isArray(showKeys) ? showKeys : [])
      .filter((k): k is string => typeof k === "string")
      .map((k) => k.trim().toUpperCase())
      .filter((k) => k.length > 0),
  );

  const seen = new Set<string>();
  const result: TeamOption[] = [];
  for (const team of safeTeams) {
    if (!team || typeof team.id !== "string") {
      continue;
    }
    if (seen.has(team.id)) {
      continue;
    }
    if (wanted.size > 0) {
      const key = typeof team.key === "string" ? team.key.toUpperCase() : "";
      if (!wanted.has(key)) {
        continue;
      }
    }
    seen.add(team.id);
    result.push(team);
  }
  return result;
}

// ---------------------------------------------------------------------------
// Shared rendering
// ---------------------------------------------------------------------------

/** Map a workflow `stateType` to a theme color id for the state dot. */
function stateColorId(stateType: string | undefined): string {
  switch (stateType) {
    case "backlog":
      return "descriptionForeground";
    case "unstarted":
      return "charts.blue";
    case "started":
      return "charts.yellow";
    case "completed":
      return "charts.green";
    case "canceled":
      return "charts.red";
    default:
      return "foreground";
  }
}

/** Build the colored state-dot icon for an issue/group with a known type. */
function stateDot(stateType: string | undefined): vscode.ThemeIcon {
  return new vscode.ThemeIcon("circle-filled", new vscode.ThemeColor(stateColorId(stateType)));
}

/** Compose the `description` (state name + assignee) for an issue summary. */
function issueDescription(item: IssueListItem): string {
  const parts: string[] = [];
  if (item.state) {
    parts.push(item.state);
  }
  if (item.assignee) {
    parts.push(item.assignee);
  }
  return parts.join(" · ");
}

/** Build a compact markdown tooltip for an issue summary. */
function issueTooltip(item: IssueListItem): vscode.MarkdownString {
  const md = new vscode.MarkdownString();
  md.supportHtml = false;
  const header = item.title ? `**${item.id}** — ${item.title}` : `**${item.id}**`;
  md.appendMarkdown(header + "\n\n");
  const meta = issueDescription(item);
  if (meta) {
    md.appendMarkdown(meta);
  }
  return md;
}

/** Render a team node. */
function renderTeamNode(node: TeamNode): vscode.TreeItem {
  const { team } = node;
  const label = team.key ? `${team.key} · ${team.name}` : team.name || team.key || team.id;
  const treeItem = new vscode.TreeItem(label, vscode.TreeItemCollapsibleState.Collapsed);
  treeItem.iconPath = new vscode.ThemeIcon("organization");
  treeItem.contextValue = CONTEXT_VALUE_TEAM;
  treeItem.tooltip = team.name || label;
  // Stable id so reveal/expansion survives refreshes.
  treeItem.id = `team:${team.id}`;
  return treeItem;
}

/** Render a group-header node (state-colored dot / person icon + count). */
function renderGroupNode(node: GroupNode): vscode.TreeItem {
  const { group } = node;
  const treeItem = new vscode.TreeItem(
    group.label || "—",
    vscode.TreeItemCollapsibleState.Expanded,
  );
  treeItem.description = `${group.items.length}`;
  treeItem.contextValue = CONTEXT_VALUE_GROUP;
  if (group.stateType !== undefined || group.color !== undefined) {
    treeItem.iconPath = stateDot(group.stateType);
  } else {
    treeItem.iconPath = new vscode.ThemeIcon("circle-outline");
  }
  treeItem.id = node.teamId ? `group:${node.teamId}:${group.groupId}` : `group:${group.groupId}`;
  return treeItem;
}

/** Render an issue node. Opens the detail webview on click. */
function renderIssueNode(node: IssueNode): vscode.TreeItem {
  const { item } = node;
  const label = item.title ? `${item.id}  ${item.title}` : item.id;
  const treeItem = new vscode.TreeItem(label, vscode.TreeItemCollapsibleState.None);
  treeItem.description = issueDescription(item);
  treeItem.tooltip = issueTooltip(item);
  treeItem.iconPath = stateDot(item.stateType);
  treeItem.contextValue = CONTEXT_VALUE_ISSUE;
  treeItem.command = {
    command: COMMAND_OPEN_TICKET,
    title: "Open Issue Detail",
    arguments: [{ id: item.id, url: item.url }],
  };
  return treeItem;
}

/** Render a message / empty-state node. */
function renderMessageNode(node: MessageNode): vscode.TreeItem {
  const treeItem = new vscode.TreeItem(node.text, vscode.TreeItemCollapsibleState.None);
  treeItem.iconPath = new vscode.ThemeIcon("info");
  treeItem.contextValue = CONTEXT_VALUE_MESSAGE;
  if (node.command) {
    treeItem.command = { command: node.command, title: node.text };
  }
  return treeItem;
}

/** Convert any {@link TeamsTreeNode} into a {@link vscode.TreeItem}. */
function toTreeItem(node: TeamsTreeNode): vscode.TreeItem {
  switch (node.kind) {
    case "team":
      return renderTeamNode(node);
    case "group":
      return renderGroupNode(node);
    case "issue":
      return renderIssueNode(node);
    case "message":
      return renderMessageNode(node);
  }
}

/** Build a message node, optionally with a click command. */
function message(text: string, command?: string): MessageNode {
  return command ? { kind: "message", text, command } : { kind: "message", text };
}

/**
 * Map a grouping result to child nodes: a flat issue list, or group headers
 * (whose own children are produced later via {@link GroupNode.group}).
 */
function toChildNodes(
  items: IssueListItem[],
  grouping: ViewGroupingState,
  teamId: string | undefined,
  emptyText: string,
): TeamsTreeNode[] {
  if (items.length === 0) {
    return [message(emptyText)];
  }
  const result = applyGrouping(items, grouping.groupBy, grouping.sort);
  if (!result.grouped) {
    return result.items.map((item): IssueNode => ({ kind: "issue", item }));
  }
  return result.groups.map((group): GroupNode => ({ kind: "group", teamId, group }));
}

// ---------------------------------------------------------------------------
// Teams provider
// ---------------------------------------------------------------------------

/**
 * Tree of the user's teams; expanding a team lazily loads + groups its issues.
 * Construct one and register with `vscode.window.createTreeView`.
 */
export class TeamsProvider implements vscode.TreeDataProvider<TeamsTreeNode> {
  private readonly emitter = new vscode.EventEmitter<TeamsTreeNode | undefined>();
  /** Fired whenever the tree (or a subtree) should be recomputed. */
  public readonly onDidChangeTreeData: vscode.Event<TeamsTreeNode | undefined> = this.emitter.event;

  private readonly getCfg: () => LinearLensConfig;
  private readonly client: LinearClient;
  private readonly getGrouping: GroupingResolver;

  private teamsCache: ListCache<TeamOption[]> | undefined;
  private readonly issuesCache = new Map<string, ListCache<IssueListItem[]>>();
  private disposed = false;

  /**
   * @param getCfg      Accessor for the current, validated extension configuration.
   * @param client      Linear API client (defensive; never throws).
   * @param getGrouping Optional active grouping/sort resolver for the view;
   *                    defaults to a flat, newest-updated list.
   */
  constructor(
    getCfg: () => LinearLensConfig,
    client: LinearClient,
    getGrouping: GroupingResolver = defaultGrouping,
  ) {
    this.getCfg = getCfg;
    this.client = client;
    this.getGrouping = getGrouping;
  }

  /** {@inheritDoc vscode.TreeDataProvider.getTreeItem} */
  public getTreeItem(node: TeamsTreeNode): vscode.TreeItem {
    return toTreeItem(node);
  }

  /** {@inheritDoc vscode.TreeDataProvider.getChildren} */
  public async getChildren(node?: TeamsTreeNode): Promise<TeamsTreeNode[]> {
    try {
      if (!node) {
        return await this.rootChildren();
      }
      if (node.kind === "team") {
        return await this.teamChildren(node.team);
      }
      if (node.kind === "group") {
        return node.group.items.map((item): IssueNode => ({ kind: "issue", item }));
      }
      return [];
    } catch {
      return [message("Could not load Linear teams.")];
    }
  }

  /** Resolve the parent of a node so `reveal` can walk up the tree. */
  public getParent(node: TeamsTreeNode): TeamsTreeNode | undefined {
    // Groups/issues are reconstructed lazily; without a stored back-link the
    // safest contract is "no parent" (reveal still works for top-level teams).
    void node;
    return undefined;
  }

  /**
   * Clear all caches and fire a full change event so the view refetches on its
   * next `getChildren`. Call after sign-in/out, config change, or a successful
   * edit (so a status change repaints).
   */
  public refresh(): void {
    if (this.disposed) {
      return;
    }
    this.teamsCache = undefined;
    this.issuesCache.clear();
    this.emitter.fire(undefined);
  }

  /** Dispose the change emitter and drop all caches. */
  public dispose(): void {
    this.disposed = true;
    this.teamsCache = undefined;
    this.issuesCache.clear();
    this.emitter.dispose();
  }

  /** Root: the filtered team list (or a message node). */
  private async rootChildren(): Promise<TeamsTreeNode[]> {
    const cfg = this.getCfg();
    if (!viewsEnabled(cfg) || !teamsEnabled(cfg)) {
      return [message("The Teams view is disabled (linearLens.teams.enable).")];
    }
    if (!this.safeHasAuth()) {
      return [message("Sign in to Linear", COMMAND_SIGN_IN)];
    }

    const teams = await this.loadTeams(cfg);
    const filtered = filterTeams(teams, teamsShow(cfg));
    if (filtered.length === 0) {
      return [
        message(
          teams.length === 0
            ? "No teams found."
            : "No teams match linearLens.teams.show.",
        ),
      ];
    }
    return filtered.map((team): TeamNode => ({ kind: "team", team }));
  }

  /** A team's issues, grouped/sorted per the active view state. */
  private async teamChildren(team: TeamOption): Promise<TeamsTreeNode[]> {
    const cfg = this.getCfg();
    const items = await this.loadTeamIssues(team.id, listLimit(cfg));
    return toChildNodes(items, this.getGrouping(), team.id, "No issues in this team.");
  }

  /** Load (and briefly cache) the team list per the viewerOnly setting. */
  private async loadTeams(cfg: LinearLensConfig): Promise<TeamOption[]> {
    const now = Date.now();
    if (this.teamsCache && now < this.teamsCache.expiresAt) {
      return this.teamsCache.value;
    }
    const listable = this.client as unknown as TeamsListClient;
    // When teams.show is empty and viewerOnly is on, prefer the viewer's teams.
    const preferViewer = teamsShow(cfg).length === 0 && teamsViewerOnly(cfg);
    let teams: TeamOption[] = [];
    try {
      if (preferViewer && typeof listable.listViewerTeams === "function") {
        teams = await listable.listViewerTeams();
      } else if (typeof listable.listTeams === "function") {
        teams = await listable.listTeams();
      } else if (typeof listable.listViewerTeams === "function") {
        teams = await listable.listViewerTeams();
      }
    } catch {
      teams = [];
    }
    const safe = Array.isArray(teams) ? teams : [];
    this.teamsCache = { value: safe, expiresAt: now + LIST_CACHE_MS };
    return safe;
  }

  /** Load (and briefly cache) a team's issues. */
  private async loadTeamIssues(teamId: string, limit: number): Promise<IssueListItem[]> {
    const now = Date.now();
    const cached = this.issuesCache.get(teamId);
    if (cached && now < cached.expiresAt) {
      return cached.value;
    }
    const listable = this.client as unknown as TeamsListClient;
    if (typeof listable.listTeamIssues !== "function") {
      return [];
    }
    let items: IssueListItem[];
    try {
      items = await listable.listTeamIssues(teamId, limit);
    } catch {
      return [];
    }
    const safe = Array.isArray(items) ? items : [];
    this.issuesCache.set(teamId, { value: safe, expiresAt: now + LIST_CACHE_MS });
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

// ---------------------------------------------------------------------------
// Cycle provider
// ---------------------------------------------------------------------------

/**
 * Tree of the active cycle's issues for a single team. The team is chosen by the
 * `linearLens.openCycle` command (which calls {@link CycleProvider.setTeam}); the
 * view shows a prompt node until a team is selected. Reuses the same rendering,
 * grouping, and resilience as {@link TeamsProvider}.
 */
export class CycleProvider implements vscode.TreeDataProvider<TeamsTreeNode> {
  private readonly emitter = new vscode.EventEmitter<void>();
  /** Fired whenever the cycle tree should be recomputed. */
  public readonly onDidChangeTreeData: vscode.Event<void> = this.emitter.event;

  private readonly getCfg: () => LinearLensConfig;
  private readonly client: LinearClient;
  private readonly getGrouping: GroupingResolver;

  private team: TeamOption | undefined;
  private cache: ListCache<IssueListItem[]> | undefined;
  private disposed = false;

  /**
   * @param getCfg      Accessor for the current, validated extension configuration.
   * @param client      Linear API client (defensive; never throws).
   * @param getGrouping Optional active grouping/sort resolver; defaults to flat.
   */
  constructor(
    getCfg: () => LinearLensConfig,
    client: LinearClient,
    getGrouping: GroupingResolver = defaultGrouping,
  ) {
    this.getCfg = getCfg;
    this.client = client;
    this.getGrouping = getGrouping;
  }

  /** {@inheritDoc vscode.TreeDataProvider.getTreeItem} */
  public getTreeItem(node: TeamsTreeNode): vscode.TreeItem {
    return toTreeItem(node);
  }

  /** {@inheritDoc vscode.TreeDataProvider.getChildren} */
  public async getChildren(node?: TeamsTreeNode): Promise<TeamsTreeNode[]> {
    try {
      if (node) {
        return node.kind === "group"
          ? node.group.items.map((item): IssueNode => ({ kind: "issue", item }))
          : [];
      }
      return await this.rootChildren();
    } catch {
      return [message("Could not load the active cycle.")];
    }
  }

  /**
   * Point the view at a team's active cycle and refresh. Pass `undefined` to
   * reset to the "pick a team" prompt.
   *
   * @param team The team whose active cycle to show, or `undefined` to clear.
   */
  public setTeam(team: TeamOption | undefined): void {
    this.team = team;
    this.cache = undefined;
    this.emitter.fire();
  }

  /** The team currently shown, if any. */
  public get currentTeam(): TeamOption | undefined {
    return this.team;
  }

  /** Clear the cache and re-fire so the cycle refetches. */
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

  /** Root: the active-cycle issues (or a prompt / message node). */
  private async rootChildren(): Promise<TeamsTreeNode[]> {
    const cfg = this.getCfg();
    if (!viewsEnabled(cfg)) {
      return [message("Linear views are disabled (linearLens.views.enable).")];
    }
    if (!this.safeHasAuth()) {
      return [message("Sign in to Linear", COMMAND_SIGN_IN)];
    }
    if (!this.team) {
      return [message("Pick a team to view its active cycle.", "linearLens.openCycle")];
    }

    const items = await this.loadCycleIssues(this.team.id, listLimit(cfg));
    return toChildNodes(
      items,
      this.getGrouping(),
      this.team.id,
      "No issues in the active cycle (or no active cycle).",
    );
  }

  /** Load (and briefly cache) the active cycle's issues for the current team. */
  private async loadCycleIssues(teamId: string, limit: number): Promise<IssueListItem[]> {
    const now = Date.now();
    if (this.cache && now < this.cache.expiresAt) {
      return this.cache.value;
    }
    const listable = this.client as unknown as TeamsListClient;
    if (typeof listable.listCycleIssues !== "function") {
      return [];
    }
    let items: IssueListItem[];
    try {
      items = await listable.listCycleIssues(teamId, limit);
    } catch {
      return [];
    }
    const safe = Array.isArray(items) ? items : [];
    this.cache = { value: safe, expiresAt: now + LIST_CACHE_MS };
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

// ---------------------------------------------------------------------------
// Defensive config readers (the settings land in the integrate step)
// ---------------------------------------------------------------------------

/** Whether the Teams view is enabled (`linearLens.teams.enable`, default true). */
function teamsEnabled(cfg: LinearLensConfig): boolean {
  const value = (cfg as { teamsEnable?: unknown }).teamsEnable;
  return typeof value === "boolean" ? value : true;
}

/** The `linearLens.teams.show` team-key allowlist (default `[]` → all teams). */
function teamsShow(cfg: LinearLensConfig): string[] {
  const value = (cfg as { teamsShow?: unknown }).teamsShow;
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : [];
}

/** Whether to prefer viewer teams when `teams.show` is empty (default true). */
function teamsViewerOnly(cfg: LinearLensConfig): boolean {
  const value = (cfg as { teamsViewerOnly?: unknown }).teamsViewerOnly;
  return typeof value === "boolean" ? value : true;
}
