/**
 * Linear Lens — blame-derived hover (fast rail surface).
 *
 * A SECOND, lightweight {@link vscode.HoverProvider} registered on the same
 * document selector as the rich {@link IssueHoverProvider}. VS Code merges the
 * hovers contributed by every matching provider, so this one coexists with the
 * rich card: it handles the case where the hovered line itself contains NO
 * direct Linear reference, but the line's LAST COMMIT (via `git blame`) mentions
 * one. For such lines it contributes a single, minimal entry —
 * `📋 <ID> — View in Linear · Open details` — and deliberately does NOT fetch or
 * render the full metadata card.
 *
 * Everything here is defensive: blaming shells out to git on mouse-hover, so the
 * provider is gated behind `linearLens.blameHover.enable` (default on), caches
 * results briefly per `(file, line, version)`, bounds the git call with a short
 * timeout, and NEVER throws out of {@link BlameHoverProvider.provideHover} (or
 * any async callback) — it returns `undefined` whenever there is no commit, no
 * ref, or anything goes wrong.
 */

import * as vscode from "vscode";
import { execFile } from "node:child_process";
import * as path from "node:path";
import type { IssueId, LinearLensConfig } from "../types";
import { issueUrl } from "../config";
import { scanText } from "../parser";

// ---------------------------------------------------------------------------
// Minimal typings for the built-in Git extension API (`vscode.git`)
// ---------------------------------------------------------------------------
//
// The Git extension does not ship its `git.d.ts` to consumers; we declare the
// tiny subset needed to resolve which repository contains a file, mirroring the
// narrow typings already used in `src/branchActions.ts` (kept intentionally
// minimal to satisfy `noImplicitAny` without `any`).

/** A single source-control repository managed by the Git extension. */
interface GitRepository {
  readonly rootUri: vscode.Uri;
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
// Tuning constants
// ---------------------------------------------------------------------------

/** Command opening the V3 ticket-detail webview for an issue id. */
const COMMAND_OPEN_TICKET = "linearLens.openTicket";

/** Hard cap on how long the `git blame` child process may run, in ms. */
const BLAME_TIMEOUT_MS = 1500;

/** Output cap for the `git blame` child process (porcelain for one line is tiny). */
const BLAME_MAX_BUFFER = 1 << 20; // 1 MiB

/** How long a blame lookup stays cached before it is re-shelled, in ms. */
const BLAME_CACHE_TTL_MS = 5_000;

/** Maximum number of blame entries retained (LRU eviction past this). */
const BLAME_CACHE_MAX = 200;

/**
 * An all-zero sha (any length) marks an uncommitted / working-tree line in git
 * blame porcelain output; such lines have no commit to read a message from.
 */
const ALL_ZERO_SHA = /^0+$/;

// ---------------------------------------------------------------------------
// Pure parse helper (vscode-free; safe to unit-test)
// ---------------------------------------------------------------------------

/**
 * Parse the FIRST commit out of `git blame --porcelain` output: the leading sha
 * (first whitespace-delimited token of the first line) and the commit `summary`
 * (subject line). Returns `null` for empty/garbage output or when the sha is the
 * all-zero (uncommitted) sentinel. PURE — no I/O, safe to unit-test.
 *
 * Porcelain shape (abridged):
 * ```
 * <40-hex-sha> <orig-line> <final-line> <num-lines-in-group>
 * author ...
 * summary <commit subject>
 * ...
 * \t<the source line>
 * ```
 *
 * @param stdout Raw stdout from `git blame -L <n>,<n> --porcelain`.
 * @returns The commit sha + summary, or `null` when unavailable.
 */
export function parseBlamePorcelain(
  stdout: string,
): { sha: string; summary: string } | null {
  if (!stdout) {
    return null;
  }
  const lines = stdout.split("\n");
  const header = lines[0] ?? "";
  const sha = header.split(/\s+/, 1)[0]?.trim() ?? "";
  // A valid blame header starts with a hex sha (>= 7 chars in practice).
  if (!/^[0-9a-f]{7,40}$/i.test(sha)) {
    return null;
  }
  if (ALL_ZERO_SHA.test(sha)) {
    return null;
  }

  let summary = "";
  for (const raw of lines) {
    if (raw.startsWith("summary ")) {
      summary = raw.slice("summary ".length).trim();
      break;
    }
  }
  return { sha, summary };
}

// ---------------------------------------------------------------------------
// LineBlame — a single line's responsible commit
// ---------------------------------------------------------------------------

/** A single line's blame result: the commit sha plus its message text. */
interface LineBlame {
  /** Abbreviated or full commit sha (never the all-zero/uncommitted sentinel). */
  readonly sha: string;
  /** The commit's subject (+ body when fetched) — scanned for a Linear ref. */
  readonly message: string;
}

/** A cached blame entry, tagged with the file version + insertion time for TTL. */
interface CacheEntry {
  /** The resolved blame, or `null` when this line has no usable commit. */
  readonly value: LineBlame | null;
  /** `performance`-independent insertion timestamp (Date.now()) for TTL. */
  readonly at: number;
}

// ---------------------------------------------------------------------------
// BlameHoverProvider
// ---------------------------------------------------------------------------

/**
 * Contributes a lightweight, blame-derived hover entry for lines whose Linear
 * reference lives in their LAST COMMIT rather than in the code itself.
 *
 * The entry is `📋 <ID> — View in Linear · Open details` (trusted command links,
 * no HTML). It is intentionally minimal and never fetches issue metadata — the
 * rich card is owned by {@link IssueHoverProvider}, and lines that already carry
 * a direct reference are skipped here so the two providers never duplicate.
 */
export class BlameHoverProvider implements vscode.HoverProvider {
  private readonly getCfg: () => LinearLensConfig;

  /**
   * Live accessor for the effective team-key allowlist (auth-aware detection).
   * Returns `undefined` for zero-config "match any".
   */
  private readonly getTeamKeys: () => string[] | undefined;

  /** Live accessor for the effective workspace slug (configured or detected). */
  private readonly getSlug: () => string;

  /**
   * Short-lived blame cache keyed by `fsPath:line:version`. Bounded to
   * {@link BLAME_CACHE_MAX} entries with simple LRU (Map insertion order);
   * entries also expire after {@link BLAME_CACHE_TTL_MS}. The key folds in the
   * document version so an edit invalidates stale blame, and the cached value
   * carries the resolving commit sha, satisfying per-(uri, line, commit) caching.
   */
  private readonly blameCache = new Map<string, CacheEntry>();

  /**
   * @param getCfg Accessor for the current, validated extension configuration.
   * @param getTeamKeys Accessor for the effective team-key allowlist (from the
   *   auth-aware detection service). `undefined` means "match any team key".
   * @param getSlug Accessor for the effective workspace slug (configured or
   *   detected). `""` when neither is available (the "View in Linear" link is
   *   then omitted).
   */
  constructor(
    getCfg: () => LinearLensConfig,
    getTeamKeys: () => string[] | undefined = () => undefined,
    getSlug: () => string = () => "",
  ) {
    this.getCfg = getCfg;
    this.getTeamKeys = getTeamKeys;
    this.getSlug = getSlug;
  }

  /**
   * Resolve the hovered line's last commit, parse it for a Linear reference, and
   * (when found) return a lightweight hover entry. Returns `undefined` when the
   * feature is disabled, the document is not a real file, the line already
   * carries a direct reference (owned by the rich hover), there is no commit, or
   * the commit mentions no allowlisted issue. NEVER throws.
   *
   * @param document The document being hovered.
   * @param position The hovered position.
   * @param token Cancellation token (hovers fire on mouse-move).
   * @returns A {@link vscode.Hover}, or `undefined`.
   */
  async provideHover(
    document: vscode.TextDocument,
    position: vscode.Position,
    token: vscode.CancellationToken,
  ): Promise<vscode.Hover | undefined> {
    try {
      const cfg = this.getCfg();
      if (!readBlameHoverEnabled(cfg)) {
        return undefined;
      }
      // Blame needs a real file on disk; skip untitled/virtual schemes.
      if (document.uri.scheme !== "file") {
        return undefined;
      }

      const teamKeys = this.getTeamKeys();

      // If the hovered line ALREADY contains a direct reference, defer to the
      // rich hover provider — blame hover is only for refs that live in the
      // commit, not the code. Scan just the one line to keep this cheap.
      const lineText = document.lineAt(position.line).text;
      const lineRefs = scanText(lineText, { teamKeys });
      if (lineRefs.length > 0) {
        return undefined;
      }

      const blame = await this.blameLine(document.uri, position.line, document.version);
      if (token.isCancellationRequested || !blame) {
        return undefined;
      }

      // Scan the commit message for any allowlisted ref (marker kind is
      // irrelevant here — a bare id in the commit is enough). First wins.
      const msgRefs = scanText(blame.message, { teamKeys });
      const ref = msgRefs[0];
      if (!ref) {
        return undefined;
      }

      const md = this.buildBlameHover(ref.issue, this.getSlug());
      return new vscode.Hover(md);
    } catch {
      // Hover providers must never surface errors to the host.
      return undefined;
    }
  }

  /**
   * Build the lightweight, trusted hover markdown for a blame-derived ref:
   * `📋 <ID> — View in Linear · Open details`. The "View in Linear" link is
   * omitted when no workspace slug is available. Trust is narrowed to the single
   * `linearLens.openTicket` command; HTML is disabled.
   *
   * @param issue The Linear id parsed from the commit message.
   * @param slug The effective workspace slug, or `""` to omit the Linear link.
   */
  private buildBlameHover(issue: IssueId, slug: string): vscode.MarkdownString {
    const md = new vscode.MarkdownString();
    md.isTrusted = { enabledCommands: [COMMAND_OPEN_TICKET] };
    md.supportHtml = false;

    const id = issue.normalized;
    const parts: string[] = [`📋 **${escapeMd(id)}**`];
    if (slug) {
      parts.push(`[View in Linear](${issueUrl(issue, slug)})`);
    }
    const args = encodeURIComponent(JSON.stringify({ id }));
    parts.push(`[Open details](command:${COMMAND_OPEN_TICKET}?${args})`);

    md.appendMarkdown(parts.join(" · "));
    return md;
  }

  /**
   * Blame one line and return its commit's sha + message, or `null` when
   * unavailable (not a repo, uncommitted line, git missing, timeout, any error).
   * Results are cached briefly per `(fsPath, line, version)`; the cached value
   * carries the commit sha so repeated hovers on the same line never re-shell.
   * Never throws.
   *
   * @param fileUri The document URI (caller guarantees `file` scheme).
   * @param line Zero-based line number.
   * @param version The document version, folded into the cache key for invalidation.
   */
  private async blameLine(
    fileUri: vscode.Uri,
    line: number,
    version: number,
  ): Promise<LineBlame | null> {
    const fsPath = fileUri.fsPath;
    const key = `${fsPath}:${line}:${version}`;

    const cached = this.blameCache.get(key);
    if (cached && Date.now() - cached.at < BLAME_CACHE_TTL_MS) {
      // Touch for LRU recency.
      this.blameCache.delete(key);
      this.blameCache.set(key, cached);
      return cached.value;
    }

    const value = await this.resolveBlame(fsPath, line);
    this.storeCache(key, value);
    return value;
  }

  /**
   * Run the git blame (and, when the subject carries no ref, one extra `git log`
   * for the body) for a single line. All git invocation lives here; callers
   * handle caching. Returns `null` on any failure. Never throws.
   *
   * @param fsPath Absolute path to the blamed file.
   * @param line Zero-based line number (converted to git's 1-based `-L`).
   */
  private async resolveBlame(
    fsPath: string,
    line: number,
  ): Promise<LineBlame | null> {
    const cwd = await resolveRepoCwd(fsPath);
    const oneBased = line + 1;

    // -L <n>,<n> blames exactly one line; --porcelain gives sha + summary.
    const porcelain = await runGit(
      ["blame", "-L", `${oneBased},${oneBased}`, "--porcelain", "--", fsPath],
      cwd,
    );
    if (porcelain === null) {
      return null;
    }
    const parsed = parseBlamePorcelain(porcelain);
    if (!parsed) {
      return null;
    }

    // The porcelain summary alone usually carries the ref. Only when it does not
    // do we spend a second cheap call to pull the full body (subject + body).
    let message = parsed.summary;
    if (!hasLinearishToken(message)) {
      const body = await runGit(["log", "-1", "--format=%B", parsed.sha], cwd);
      if (body && body.trim()) {
        message = body;
      }
    }

    return { sha: parsed.sha, message };
  }

  /** Insert a cache entry, evicting the oldest when over the bound. */
  private storeCache(key: string, value: LineBlame | null): void {
    this.blameCache.delete(key);
    this.blameCache.set(key, { value, at: Date.now() });
    while (this.blameCache.size > BLAME_CACHE_MAX) {
      const oldest = this.blameCache.keys().next().value;
      if (oldest === undefined) {
        break;
      }
      this.blameCache.delete(oldest);
    }
  }
}

// ---------------------------------------------------------------------------
// Git extension / repo-root resolution
// ---------------------------------------------------------------------------

/**
 * Resolve the working directory to run git in for `fsPath`: the deepest
 * repository root (from the built-in Git extension) that contains the file, so
 * nested submodules/worktrees pick the most specific repo. Falls back to the
 * file's own directory when the Git extension is absent or no repo matches.
 * Never throws.
 *
 * @param fsPath Absolute path to the blamed file.
 */
async function resolveRepoCwd(fsPath: string): Promise<string> {
  const api = await resolveGitApi();
  if (api) {
    let best: string | undefined;
    for (const repo of api.repositories) {
      const root = repo.rootUri.fsPath;
      if (isWithin(fsPath, root) && (!best || root.length > best.length)) {
        best = root;
      }
    }
    if (best) {
      return best;
    }
  }
  return path.dirname(fsPath);
}

/**
 * Resolve the built-in Git extension API, activating the extension if needed.
 * Returns `undefined` when the extension is missing or its export shape is
 * unexpected. Never throws. Mirrors `src/branchActions.ts`.
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

/** Whether `childPath` is inside (or equal to) `rootPath`. */
function isWithin(childPath: string, rootPath: string): boolean {
  if (childPath === rootPath) {
    return true;
  }
  const sep = path.sep;
  const normalizedRoot = rootPath.endsWith(sep) ? rootPath : `${rootPath}${sep}`;
  return childPath.startsWith(normalizedRoot);
}

// ---------------------------------------------------------------------------
// git child-process helper
// ---------------------------------------------------------------------------

/**
 * Run `git <args>` in `cwd`, returning stdout on success or `null` on any
 * failure (non-zero exit, missing git, timeout, buffer overflow). Bounded by a
 * short timeout + maxBuffer so a hover never hangs. Never throws.
 *
 * @param args Git arguments (the leading `git` is implicit).
 * @param cwd Working directory (a repo root or the file's directory).
 */
function runGit(args: readonly string[], cwd: string): Promise<string | null> {
  return new Promise((resolve) => {
    try {
      execFile(
        "git",
        args as string[],
        { cwd, timeout: BLAME_TIMEOUT_MS, maxBuffer: BLAME_MAX_BUFFER, windowsHide: true },
        (error, stdout) => {
          if (error) {
            resolve(null);
            return;
          }
          // The string-encoding `execFile` overload (no buffer `encoding` in the
          // options above) types `stdout` as `string`, so it can be resolved as-is.
          resolve(stdout);
        },
      );
    } catch {
      resolve(null);
    }
  });
}

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

/**
 * Read `linearLens.blameHover.enable` (default `true`) defensively. The field is
 * added to {@link LinearLensConfig} by the foundation/integrate step; until then
 * this tolerates its absence without a hard type dependency, and treats only an
 * explicit `false` as "disabled".
 */
function readBlameHoverEnabled(cfg: LinearLensConfig): boolean {
  const value = (cfg as { enableBlameHover?: unknown }).enableBlameHover;
  return value !== false;
}

/**
 * Cheap pre-check: does `text` contain anything shaped like a Linear id
 * (`ABC-123`)? Used to decide whether the porcelain summary alone is enough or a
 * second `git log` for the body is warranted. Allowlist filtering happens later
 * in {@link scanText}; this only avoids the extra call when clearly pointless.
 */
function hasLinearishToken(text: string): boolean {
  return /[A-Za-z]{2,7}-\d{1,6}/.test(text);
}

/**
 * Escape markdown-significant characters in interpolated text so an issue id
 * renders literally and cannot inject markup or links.
 */
function escapeMd(text: string): string {
  return text.replace(/([\\`*_{}\[\]()<>#+\-.!|~])/g, "\\$1");
}
