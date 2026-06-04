/**
 * Linear Lens — branch + agent actions.
 *
 * Implements the local, read-only "do something with this issue" command
 * handlers used by hovers, the detail view, and the tree:
 *
 *  - `linearLens.checkoutBranch`  — check out (creating if needed) the issue's
 *    Linear-suggested git branch in the active repository.
 *  - `linearLens.openBranchDiff`  — open a diff / SCM view for that branch.
 *  - `linearLens.openInAgent`     — best-effort: open the workspace's configured
 *    coding-tool deeplink for the issue when available, else the issue URL.
 *
 * Everything here is LOCAL/editor-side and never mutates Linear (no `write`
 * scope). Every exported function is defensive and NEVER throws; failures are
 * surfaced as clear error toasts, not exceptions.
 */

import * as vscode from "vscode";
import { execFile } from "node:child_process";
import type { LinearClient, LinearLensConfig } from "./types";
import { CONFIG_SECTION, issueUrl } from "./config";
import { parseIssueId } from "./parser";

// ---------------------------------------------------------------------------
// Minimal typings for the built-in Git extension API (`vscode.git`)
// ---------------------------------------------------------------------------
//
// The Git extension does not ship its `git.d.ts` to consumers, so we declare the
// small subset we depend on. This matches the stable public surface of
// `getAPI(1)` and is intentionally narrow to keep `noImplicitAny` happy without
// pulling in `any`.

/** A git ref (branch/tag) as returned by `Repository.getBranches`. */
interface GitRef {
  readonly name?: string;
  readonly remote?: string;
}

/** Filter passed to `Repository.getBranches`. */
interface GitBranchQuery {
  readonly remote?: boolean;
  readonly contains?: string;
}

/** A single source-control repository managed by the Git extension. */
interface GitRepository {
  readonly rootUri: vscode.Uri;
  readonly state: { readonly HEAD?: { readonly name?: string } };
  checkout(treeish: string): Promise<void>;
  createBranch(name: string, checkout: boolean, ref?: string): Promise<void>;
  getBranches(query: GitBranchQuery): Promise<GitRef[]>;
}

/** The object returned by `GitExtension.getAPI(1)`. */
interface GitApi {
  readonly repositories: GitRepository[];
}

/** Shape of the Git extension's `exports`. */
interface GitExtensionExports {
  getAPI(version: 1): GitApi;
}

// ---------------------------------------------------------------------------
// Public contracts
// ---------------------------------------------------------------------------

/** Arguments carried by the branch command links / tree-node invocations. */
export interface BranchCommandArgs {
  /** Normalized issue id, e.g. "ENG-123" (used in messages). */
  id: string;
  /** Linear's suggested git branch name for the issue. */
  branchName: string;
}

/** Argument accepted by the {@link openInAgent} command handler. */
export interface AgentCommandArgs {
  /** Normalized issue id, e.g. "ENG-123". */
  id: string;
  /** Pre-resolved canonical issue URL, when the caller already has it. */
  url?: string;
}

/**
 * Probes for an available coding-agent integration and runs "open in agent".
 * The probe is best-effort and feature-detected: availability is conservative
 * so a button is only offered when it will actually do something.
 */
export interface AgentBridge {
  /** Whether an "Open in <agent>" action should be offered. Cheap, sync-ish. */
  isAvailable(): boolean;
  /** Human label for the button, e.g. "Cursor" or "Coding Agent". */
  label(): string;
  /** Open the given issue in the configured agent. Never throws. */
  open(args: AgentCommandArgs): Promise<void>;
}

/** Dependencies the branch-action command handlers need from the integrate step. */
export interface BranchActionDeps {
  /** Returns the current, validated extension configuration. */
  getCfg: () => LinearLensConfig;
  /**
   * Returns the effective team-key allowlist (auth-aware detection); `undefined`
   * for zero-config "match any". Optional; defaults to the configured `teamKeys`.
   */
  getTeamKeys?: () => string[] | undefined;
  /**
   * Returns the effective workspace slug (configured or detected). Optional;
   * defaults to the configured `workspaceSlug`.
   */
  getSlug?: () => string;
  /** Linear API client (degrades gracefully; used to resolve URLs/branches). */
  client: LinearClient;
  /** The coding-agent bridge (built via {@link createAgentBridge}). */
  agent: AgentBridge;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/** Prefix used by all user-facing toasts from this module. */
const TOAST_PREFIX = "Linear Lens:";

/**
 * Read the optional `linearLens.agent.command` setting (a command id invoked by
 * "Open in Coding Agent"). Read directly from VS Code config so this module does
 * not depend on a not-yet-added {@link LinearLensConfig} field; defensive and
 * never throws. Returns the trimmed id, or "" when unset/invalid.
 */
function readAgentCommandSetting(): string {
  try {
    const value = vscode.workspace
      .getConfiguration(CONFIG_SECTION)
      .get("agent.command");
    return typeof value === "string" ? value.trim() : "";
  } catch {
    return "";
  }
}

/**
 * Validate the loosely-typed command argument into {@link BranchCommandArgs}.
 * Returns `null` when either field is missing or not a non-empty string —
 * these args arrive from command links / tree nodes and cannot be trusted.
 */
function asBranchArgs(raw: unknown): BranchCommandArgs | null {
  if (typeof raw !== "object" || raw === null) {
    return null;
  }
  const candidate = raw as { id?: unknown; branchName?: unknown };
  const id = typeof candidate.id === "string" ? candidate.id.trim() : "";
  const branchName =
    typeof candidate.branchName === "string" ? candidate.branchName.trim() : "";
  if (!branchName) {
    return null;
  }
  return { id: id || branchName, branchName };
}

/** Validate the loosely-typed agent command argument. */
function asAgentArgs(raw: unknown): AgentCommandArgs | null {
  if (typeof raw === "string") {
    const id = raw.trim();
    return id ? { id } : null;
  }
  if (typeof raw !== "object" || raw === null) {
    return null;
  }
  const candidate = raw as { id?: unknown; url?: unknown };
  const id = typeof candidate.id === "string" ? candidate.id.trim() : "";
  if (!id) {
    return null;
  }
  const url = typeof candidate.url === "string" ? candidate.url.trim() : undefined;
  return { id, url: url || undefined };
}

/**
 * Resolve the built-in Git extension API, activating the extension if needed.
 * Returns `undefined` when the extension is missing or its export shape is
 * unexpected. Never throws.
 */
async function resolveGitApi(): Promise<GitApi | undefined> {
  try {
    const extension =
      vscode.extensions.getExtension<GitExtensionExports>("vscode.git");
    if (!extension) {
      return undefined;
    }
    const exports = extension.isActive
      ? extension.exports
      : await extension.activate();
    if (!exports || typeof exports.getAPI !== "function") {
      return undefined;
    }
    return exports.getAPI(1);
  } catch {
    return undefined;
  }
}

/**
 * Pick the repository whose root contains the active editor's file, falling
 * back to the first repository. Returns `undefined` when there are none.
 */
function pickRepository(api: GitApi): GitRepository | undefined {
  const repos = api.repositories;
  if (repos.length === 0) {
    return undefined;
  }
  const activeUri = vscode.window.activeTextEditor?.document.uri;
  if (activeUri && activeUri.scheme === "file") {
    const activePath = activeUri.fsPath;
    // Prefer the deepest (longest root) repo that contains the active file, so
    // nested submodules/worktrees resolve to the most specific repository.
    let best: GitRepository | undefined;
    for (const repo of repos) {
      const root = repo.rootUri.fsPath;
      if (isWithin(activePath, root)) {
        if (!best || root.length > best.rootUri.fsPath.length) {
          best = repo;
        }
      }
    }
    if (best) {
      return best;
    }
  }
  return repos[0];
}

/** Whether `childPath` is inside (or equal to) `rootPath`. */
function isWithin(childPath: string, rootPath: string): boolean {
  if (childPath === rootPath) {
    return true;
  }
  const normalizedRoot = rootPath.endsWith("/") ? rootPath : `${rootPath}/`;
  return childPath.startsWith(normalizedRoot);
}

/** Whether a local branch with `name` already exists in `repo`. */
async function localBranchExists(
  repo: GitRepository,
  name: string,
): Promise<boolean> {
  try {
    const branches = await repo.getBranches({ remote: false });
    return branches.some((b) => b.name === name);
  } catch {
    return false;
  }
}

/** Whether a remote branch with `name` exists (so we can track it on create). */
async function remoteBranchExists(
  repo: GitRepository,
  name: string,
): Promise<boolean> {
  try {
    const branches = await repo.getBranches({ remote: true });
    // Remote refs surface as e.g. "origin/<name>" or with a `remote` field.
    return branches.some(
      (b) => b.name === name || (b.name?.endsWith(`/${name}`) ?? false),
    );
  } catch {
    return false;
  }
}

/** Show a clear error toast. Never throws. */
function showError(message: string): void {
  void vscode.window.showErrorMessage(`${TOAST_PREFIX} ${message}`);
}

/** Show an informational toast. Never throws. */
function showInfo(message: string): void {
  void vscode.window.showInformationMessage(`${TOAST_PREFIX} ${message}`);
}

// ---------------------------------------------------------------------------
// checkoutBranch
// ---------------------------------------------------------------------------

/**
 * Check out the issue's git branch, creating it if it does not exist locally.
 *
 * Prefers the built-in Git extension API (`vscode.git`) for the repository that
 * contains the active editor's file (else the first repository). When the API
 * is unavailable, falls back to running `git checkout` via `execFile` (argv
 * form, no shell) in the first workspace folder.
 *
 * Branch resolution:
 *  - If a local branch already exists, simply check it out.
 *  - Else if a matching remote branch exists, create a local branch tracking it.
 *  - Else create a fresh local branch off the current HEAD (after confirming).
 *
 * Never throws; surfaces a clear error toast on failure.
 *
 * @param raw The loosely-typed {@link BranchCommandArgs} from the command link.
 */
export async function checkoutBranch(raw: unknown): Promise<void> {
  try {
    const args = asBranchArgs(raw);
    if (!args) {
      showError("Cannot check out — no branch name was provided for this issue.");
      return;
    }
    const { branchName } = args;

    const api = await resolveGitApi();
    if (api) {
      const repo = pickRepository(api);
      if (!repo) {
        await checkoutViaCli(branchName);
        return;
      }
      await checkoutViaApi(repo, branchName);
      return;
    }

    // No Git extension API available — fall back to the CLI.
    await checkoutViaCli(branchName);
  } catch {
    // Absolute backstop: never throw out of a command handler.
    showError("Failed to check out the issue branch.");
  }
}

/** Check out (or create) `branchName` using the Git extension API. */
async function checkoutViaApi(
  repo: GitRepository,
  branchName: string,
): Promise<void> {
  if (repo.state.HEAD?.name === branchName) {
    showInfo(`Already on branch "${branchName}".`);
    return;
  }

  if (await localBranchExists(repo, branchName)) {
    try {
      await repo.checkout(branchName);
      showInfo(`Checked out branch "${branchName}".`);
    } catch {
      showError(
        `Could not switch to "${branchName}". Resolve uncommitted changes and try again.`,
      );
    }
    return;
  }

  // The branch is not local yet — create it (tracking the remote when present).
  const tracksRemote = await remoteBranchExists(repo, branchName);
  if (!tracksRemote) {
    const choice = await vscode.window.showInformationMessage(
      `${TOAST_PREFIX} Branch "${branchName}" does not exist. Create it from the current branch?`,
      { modal: false },
      "Create Branch",
    );
    if (choice !== "Create Branch") {
      return;
    }
  }

  try {
    // `createBranch(name, checkout=true)` checks out the new branch. When a
    // remote branch exists, the Git extension links tracking on first push;
    // creating off HEAD is the safe, always-available behavior.
    await repo.createBranch(branchName, true);
    showInfo(
      tracksRemote
        ? `Created and checked out "${branchName}" (tracking remote).`
        : `Created and checked out "${branchName}".`,
    );
  } catch {
    // The API create can fail if the name already exists in a racy state; try a
    // plain checkout as a last resort before reporting failure.
    try {
      await repo.checkout(branchName);
      showInfo(`Checked out branch "${branchName}".`);
    } catch {
      showError(`Could not create or check out "${branchName}".`);
    }
  }
}

/**
 * Fallback checkout via the git CLI using `execFile` (no shell, argv form, so
 * branch names with `/`, `#`, `?` are passed literally and cannot inject).
 */
async function checkoutViaCli(branchName: string): Promise<void> {
  const folders = vscode.workspace.workspaceFolders;
  const folder = folders?.[0];
  if (!folder || folder.uri.scheme !== "file") {
    showError("No local git repository is open to check out the branch.");
    return;
  }
  const cwd = folder.uri.fsPath;

  // `git checkout <branch>` switches to an existing local branch; if it does not
  // exist, retry with `-b` to create it. Both run without a shell.
  const switched = await runGit(cwd, ["checkout", branchName]);
  if (switched.ok) {
    showInfo(`Checked out branch "${branchName}".`);
    return;
  }
  const created = await runGit(cwd, ["checkout", "-b", branchName]);
  if (created.ok) {
    showInfo(`Created and checked out "${branchName}".`);
    return;
  }
  showError(
    `git checkout failed for "${branchName}": ${created.message || switched.message}`,
  );
}

/** Result of a CLI git invocation. */
interface GitCliResult {
  ok: boolean;
  message: string;
}

/** Run `git <args>` in `cwd` via `execFile` (no shell). Never throws. */
function runGit(cwd: string, args: string[]): Promise<GitCliResult> {
  return new Promise<GitCliResult>((resolve) => {
    try {
      execFile(
        "git",
        args,
        { cwd, timeout: 30_000, windowsHide: true },
        (error, _stdout, stderr) => {
          if (error) {
            const message = (stderr || error.message || "").trim();
            resolve({ ok: false, message });
            return;
          }
          resolve({ ok: true, message: "" });
        },
      );
    } catch {
      resolve({ ok: false, message: "git is not available on PATH." });
    }
  });
}

// ---------------------------------------------------------------------------
// openBranchDiff
// ---------------------------------------------------------------------------

/**
 * Open a diff / SCM view for the issue's branch. Best-effort:
 *  - Selects the repository that owns the active file (else the first).
 *  - If the branch is not the current HEAD, attempts to check it out first so
 *    the SCM view reflects it (silent — the user already asked to see it).
 *  - Reveals the Source Control view and, when available, the changes view.
 *
 * Never throws; surfaces a clear error toast when no repository is available.
 *
 * @param raw The loosely-typed {@link BranchCommandArgs} from the command link.
 */
export async function openBranchDiff(raw: unknown): Promise<void> {
  try {
    const args = asBranchArgs(raw);
    if (!args) {
      showError("Cannot open a diff — no branch name was provided for this issue.");
      return;
    }

    const api = await resolveGitApi();
    const repo = api ? pickRepository(api) : undefined;
    if (!repo) {
      // No Git extension repo — still try to reveal the SCM view as a courtesy.
      await revealSourceControl();
      showError("No git repository is available to diff this branch.");
      return;
    }

    // Make the SCM view reflect the requested branch when it is not current.
    if (
      repo.state.HEAD?.name !== args.branchName &&
      (await localBranchExists(repo, args.branchName))
    ) {
      try {
        await repo.checkout(args.branchName);
      } catch {
        // Non-fatal — show whatever the current working tree has instead.
      }
    }

    await revealSourceControl();
  } catch {
    showError("Failed to open the branch diff.");
  }
}

/**
 * Reveal the Source Control view, preferring the richer incoming/outgoing
 * changes view when the running VS Code build exposes it. Never throws.
 */
async function revealSourceControl(): Promise<void> {
  const candidates = [
    // Preferred: the dedicated changes/graph view when present.
    "git.viewChanges",
    // Stable fallbacks: focus the Source Control viewlet.
    "workbench.view.scm",
    "workbench.scm.focus",
  ];
  for (const command of candidates) {
    try {
      await vscode.commands.executeCommand(command);
      return;
    } catch {
      // Try the next candidate.
    }
  }
}

// ---------------------------------------------------------------------------
// openInAgent + AgentBridge
// ---------------------------------------------------------------------------

/**
 * Known editor "coding agent" command ids, in preference order. Kept tiny and
 * heuristic — only ids that, when present, reliably open an agent/chat surface.
 * The `linearLens.agent.command` setting always overrides this list.
 */
const KNOWN_AGENT_COMMANDS: ReadonlyArray<{ id: string; label: string }> = [
  // Cursor's composer / chat surfaces.
  { id: "composer.startComposerPrompt", label: "Cursor" },
  { id: "aichat.newchataction", label: "Cursor" },
  // GitHub Copilot Chat.
  { id: "workbench.action.chat.open", label: "Copilot Chat" },
  { id: "github.copilot.chat.focus", label: "Copilot Chat" },
];

/** Cache of the resolved command set, refreshed lazily on a short interval. */
interface CommandProbe {
  /** The detected agent command + label, or undefined when none. */
  detected?: { id: string; label: string };
  /** Epoch ms at which this probe goes stale. */
  expiresAt: number;
}

/** How long a command-availability probe is trusted before re-running. */
const PROBE_TTL_MS = 30_000;

/**
 * Build the default coding-agent bridge. Availability is determined by, in
 * order: (1) the `linearLens.agent.command` setting, (2) a detected editor
 * agent command from {@link KNOWN_AGENT_COMMANDS}. When neither exists the
 * bridge is unavailable and {@link openInAgent} falls back to the issue URL.
 *
 * Detection is cached briefly so it never blocks hover rendering on a slow
 * `getCommands` probe.
 *
 * @param _getCfg Accessor for the current resolved configuration. Reserved for
 *   future config-driven behavior; the agent-command override is read directly
 *   from VS Code settings so this module needs no `LinearLensConfig` field.
 */
export function createAgentBridge(
  _getCfg: () => LinearLensConfig,
): AgentBridge {
  let probe: CommandProbe = { expiresAt: 0 };
  /** Whether a refresh is already in flight (avoid stampede). */
  let probing = false;

  /** Kick a background refresh of the detected-command probe. Never throws. */
  const refreshProbe = (): void => {
    if (probing || Date.now() < probe.expiresAt) {
      return;
    }
    probing = true;
    void (async () => {
      try {
        const all = new Set(await vscode.commands.getCommands(true));
        const detected = KNOWN_AGENT_COMMANDS.find((c) => all.has(c.id));
        probe = {
          detected: detected ? { id: detected.id, label: detected.label } : undefined,
          expiresAt: Date.now() + PROBE_TTL_MS,
        };
      } catch {
        probe = { expiresAt: Date.now() + PROBE_TTL_MS };
      } finally {
        probing = false;
      }
    })();
  };

  return {
    isAvailable(): boolean {
      if (readAgentCommandSetting()) {
        return true;
      }
      refreshProbe();
      return probe.detected !== undefined;
    },

    label(): string {
      const configured = readAgentCommandSetting();
      if (configured) {
        return "Coding Agent";
      }
      return probe.detected?.label ?? "Coding Agent";
    },

    async open(args: AgentCommandArgs): Promise<void> {
      try {
        const configured = readAgentCommandSetting();
        const url = args.url;
        if (configured) {
          await vscode.commands.executeCommand(configured, {
            issueId: args.id,
            id: args.id,
            url,
          });
          return;
        }

        refreshProbe();
        const detected = probe.detected;
        if (detected) {
          // Seed the agent with a prompt referencing the issue. Different agents
          // accept different argument shapes; pass a permissive object plus a
          // positional prompt string so at least one is honored.
          const prompt = url
            ? `Work on Linear issue ${args.id}: ${url}`
            : `Work on Linear issue ${args.id}`;
          await vscode.commands.executeCommand(detected.id, {
            query: prompt,
            prompt,
            issueId: args.id,
            url,
          });
          return;
        }

        // No agent available — fall back to opening the issue itself.
        if (url) {
          await vscode.env.openExternal(vscode.Uri.parse(url));
        } else {
          showInfo("No coding agent is configured. Opened nothing — no issue URL available.");
        }
      } catch {
        showError("Could not open the issue in a coding agent.");
      }
    },
  };
}

/**
 * Command handler for `linearLens.openInAgent`.
 *
 * Best-effort: opens the workspace's configured coding-tool deeplink for the
 * issue when an agent bridge reports availability; otherwise opens the issue URL
 * in the browser. The issue URL is resolved (in order) from the supplied arg,
 * the Linear client's live metadata, then a slug-derived fallback. Never throws.
 *
 * @param raw  The loosely-typed {@link AgentCommandArgs} (or a bare id string).
 * @param deps Injected config / client / agent bridge.
 */
export async function openInAgent(
  raw: unknown,
  deps: BranchActionDeps,
): Promise<void> {
  try {
    const args = asAgentArgs(raw);
    if (!args) {
      showError("Cannot open in agent — no issue id was provided.");
      return;
    }

    const url = await resolveIssueUrl(args, deps);
    const enriched: AgentCommandArgs = { id: args.id, url };

    if (deps.agent.isAvailable()) {
      await deps.agent.open(enriched);
      return;
    }

    // No agent — fall back to the issue URL.
    if (url) {
      await vscode.env.openExternal(vscode.Uri.parse(url));
      return;
    }
    showError(
      `Could not resolve a URL for ${args.id}. Set a workspace slug to open it in Linear.`,
    );
  } catch {
    showError("Failed to open the issue in a coding agent.");
  }
}

/**
 * Resolve the canonical issue URL for an agent action: prefer the caller's URL,
 * then the client's live metadata (which also carries any future coding-tool
 * deeplink), then a slug-derived best effort. Returns "" when none is possible.
 */
async function resolveIssueUrl(
  args: AgentCommandArgs,
  deps: BranchActionDeps,
): Promise<string | undefined> {
  if (args.url) {
    return args.url;
  }
  const teamKeys = deps.getTeamKeys ? deps.getTeamKeys() : deps.getCfg().teamKeys;
  const parsed = parseIssueId(args.id, { teamKeys });

  // Try live metadata first (authoritative canonical URL).
  if (parsed) {
    try {
      const meta = await deps.client.fetchIssue(parsed);
      if (meta?.url) {
        return meta.url;
      }
    } catch {
      // Fall through to slug-derived URL.
    }
    const slug = deps.getSlug ? deps.getSlug() : deps.getCfg().workspaceSlug;
    if (slug) {
      return issueUrl(parsed, slug);
    }
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Registration helper (called by the integrate step)
// ---------------------------------------------------------------------------

/**
 * Register the branch + agent command handlers and push their disposables onto
 * `context.subscriptions`. The integrate step calls this from `extension.ts`.
 *
 * Registered command ids:
 *  - `linearLens.checkoutBranch`
 *  - `linearLens.openBranchDiff`
 *  - `linearLens.openInAgent`
 *
 * @param context The extension context owning the disposables.
 * @param deps    Injected config / client / agent bridge.
 */
export function registerBranchActions(
  context: vscode.ExtensionContext,
  deps: BranchActionDeps,
): void {
  context.subscriptions.push(
    vscode.commands.registerCommand("linearLens.checkoutBranch", (args: unknown) =>
      checkoutBranch(args),
    ),
    vscode.commands.registerCommand("linearLens.openBranchDiff", (args: unknown) =>
      openBranchDiff(args),
    ),
    vscode.commands.registerCommand("linearLens.openInAgent", (args: unknown) =>
      openInAgent(args, deps),
    ),
  );
}
