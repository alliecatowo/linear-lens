import * as vscode from "vscode";
import { IssueId, LinearLensConfig } from "./types";
import { issueIdFromBranch } from "./parser";

/** Status bar priority for the branch issue item (Left). */
const STATUS_BAR_PRIORITY = 100;

/** Command id invoked when the status bar item is clicked. */
const OPEN_BRANCH_ISSUE_COMMAND = "linearLens.openCurrentBranchIssue";

/** Glob watched for branch switches across workspace folders. */
const HEAD_GLOB = "**/.git/HEAD";

/** Prefix written by git when HEAD points at a branch ref. */
const HEAD_REF_PREFIX = "ref: refs/heads/";

/**
 * Detects the current git branch's issue id and shows a status bar item.
 *
 * Reads `.git/HEAD` of the first workspace folder, extracts the branch name,
 * and runs `issueIdFromBranch` to find an embedded Linear issue id. The last
 * known id is cached so `current()` can return synchronously while reads and
 * watcher callbacks happen asynchronously.
 */
export class BranchStatusBar {
  private readonly getCfg: () => LinearLensConfig;
  private readonly item: vscode.StatusBarItem;
  private readonly disposables: vscode.Disposable[] = [];
  private watcher: vscode.FileSystemWatcher | undefined;
  private currentId: IssueId | null = null;

  /**
   * @param getCfg Accessor for the current resolved configuration.
   */
  constructor(getCfg: () => LinearLensConfig) {
    this.getCfg = getCfg;
    this.item = vscode.window.createStatusBarItem(
      vscode.StatusBarAlignment.Left,
      STATUS_BAR_PRIORITY,
    );
    this.item.command = OPEN_BRANCH_ISSUE_COMMAND;
    this.disposables.push(this.item);
  }

  /**
   * Begin watching `.git/HEAD` across workspace folders and render the item.
   */
  start(): void {
    this.watcher = vscode.workspace.createFileSystemWatcher(HEAD_GLOB);
    this.watcher.onDidChange(() => this.refresh(), this, this.disposables);
    this.watcher.onDidCreate(() => this.refresh(), this, this.disposables);
    this.watcher.onDidDelete(() => this.refresh(), this, this.disposables);
    this.disposables.push(this.watcher);

    vscode.workspace.onDidChangeWorkspaceFolders(
      () => this.refresh(),
      this,
      this.disposables,
    );

    this.refresh();
  }

  /**
   * The issue id detected in the current branch, or `null`.
   * Returns the last value resolved by `refresh()` synchronously.
   */
  current(): IssueId | null {
    return this.currentId;
  }

  /**
   * Re-read the branch and re-render (e.g. after a config change).
   * Fire-and-forget: the underlying read is async and updates state + UI when done.
   */
  refresh(): void {
    void this.reread();
  }

  /** Dispose the status bar item, watcher, and registered listeners. */
  dispose(): void {
    for (const d of this.disposables) {
      d.dispose();
    }
    this.disposables.length = 0;
    this.watcher = undefined;
  }

  /**
   * Read `.git/HEAD` of the first workspace folder, resolve the branch's issue
   * id, update the cached value, and re-render the status bar item.
   */
  private async reread(): Promise<void> {
    const branch = await this.readBranch();
    const id =
      branch === null
        ? null
        : issueIdFromBranch(branch, { teamKeys: this.getCfg().teamKeys });
    this.currentId = id;
    this.render(id);
  }

  /**
   * Read and parse the current branch name from `.git/HEAD` of the first
   * workspace folder. Returns `null` when there is no folder, no HEAD file,
   * or HEAD is detached.
   */
  private async readBranch(): Promise<string | null> {
    const folders = vscode.workspace.workspaceFolders;
    if (!folders || folders.length === 0) {
      return null;
    }
    const headUri = vscode.Uri.joinPath(folders[0].uri, ".git", "HEAD");
    try {
      const bytes = await vscode.workspace.fs.readFile(headUri);
      const content = Buffer.from(bytes).toString("utf8").trim();
      if (content.startsWith(HEAD_REF_PREFIX)) {
        return content.slice(HEAD_REF_PREFIX.length).trim() || null;
      }
      // Detached HEAD (a raw commit sha) or unknown format → no branch.
      return null;
    } catch {
      // No .git/HEAD (not a repo, or worktree layout we don't read) → no branch.
      return null;
    }
  }

  /** Render the status bar item for the given issue id (or hide when none). */
  private render(id: IssueId | null): void {
    if (id === null) {
      this.item.hide();
      return;
    }
    this.item.text = `$(git-branch) ${id.normalized}`;
    this.item.tooltip = `Open ${id.normalized} in Linear`;
    this.item.show();
  }
}
