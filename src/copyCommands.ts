/**
 * Linear Lens — "Copy as Markdown" command (E1).
 *
 * Registers `linearLens.copyIssueMarkdown`: resolve an issue id (from a tree-node
 * `{ id }` / webview / string argument, the reference under the editor cursor, or
 * an input-box prompt), fetch its full {@link TicketDetail}, format it through the
 * pure {@link ticketToMarkdown} formatter, write the result to the clipboard, and
 * show a confirmation toast.
 *
 * This command is READ-ONLY (it triggers no write mutation), so it intentionally
 * has NO write-auth gate. The Linear client never throws, so the only failure
 * surface here is a missing / unresolvable issue, which yields a warning toast.
 */

import * as vscode from "vscode";

import { ticketToMarkdown } from "./format/issueMarkdown";
import { parseIssueId, scanText } from "./parser";
import type { LinearClient, LinearLensConfig } from "./types";

/** Dependencies injected into {@link registerCopyCommands} by `extension.ts`. */
export interface CopyCommandDeps {
  /** Returns the current, validated extension configuration. */
  readonly getCfg: () => LinearLensConfig;
  /**
   * Returns the effective team-key allowlist (auth-aware detection); `undefined`
   * for zero-config "match any". Optional; defaults to the configured `teamKeys`.
   */
  readonly getTeamKeys?: () => string[] | undefined;
  /** Linear API client (read path; degrades gracefully, never throws). */
  readonly client: LinearClient;
}

/**
 * Resolve a normalized issue id from a loosely-typed command argument: a bare id
 * string or an `{ id }` object (as tree nodes and the webview pass). Returns the
 * normalized id when parseable, the trimmed raw id as a fallback, or `undefined`.
 *
 * @param arg - The loosely-typed command argument.
 * @param teamKeys - The effective team-key allowlist (for team-key parsing).
 * @returns The resolved issue id, or `undefined` when the argument carries none.
 */
function idFromArg(arg: unknown, teamKeys: string[] | undefined): string | undefined {
  let raw: string | undefined;
  if (typeof arg === "string") {
    raw = arg.trim();
  } else if (typeof arg === "object" && arg !== null) {
    const candidate = (arg as { id?: unknown }).id;
    raw = typeof candidate === "string" ? candidate.trim() : undefined;
  }
  if (!raw) {
    return undefined;
  }
  const parsed = parseIssueId(raw, { teamKeys });
  return parsed?.normalized ?? raw;
}

/**
 * Resolve the normalized issue id under the active editor's cursor, or
 * `undefined` when there is no editor or no reference at the caret. Never throws.
 *
 * @param cfg - The current resolved configuration (markers).
 * @param teamKeys - The effective team-key allowlist (auth-aware detection).
 * @returns The normalized issue id at the cursor, or `undefined`.
 */
function idUnderCursor(
  cfg: LinearLensConfig,
  teamKeys: string[] | undefined,
): string | undefined {
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
 * Register the `linearLens.copyIssueMarkdown` command. Its disposable is pushed
 * onto `context.subscriptions` for cleanup on deactivation.
 *
 * @param context - The extension context owning the command disposable.
 * @param deps - The injected configuration accessor and Linear client.
 */
export function registerCopyCommands(
  context: vscode.ExtensionContext,
  deps: CopyCommandDeps,
): void {
  const { getCfg, client } = deps;
  const getTeamKeys = deps.getTeamKeys ?? (() => getCfg().teamKeys);

  const copyIssueMarkdown = vscode.commands.registerCommand(
    "linearLens.copyIssueMarkdown",
    async (arg?: unknown) => {
      const cfg = getCfg();
      const teamKeys = getTeamKeys();

      // 1. Resolve the id: explicit arg → cursor ref → input-box prompt.
      let id = idFromArg(arg, teamKeys) ?? idUnderCursor(cfg, teamKeys);
      if (!id) {
        const input = await vscode.window.showInputBox({
          title: "Linear Lens: Copy as Markdown",
          prompt: "Enter a Linear issue id to copy as Markdown.",
          placeHolder: "ENG-123",
          ignoreFocusOut: true,
        });
        if (input === undefined) {
          return;
        }
        const parsed = parseIssueId(input, { teamKeys });
        if (!parsed) {
          void vscode.window.showWarningMessage(
            `Linear Lens: "${input.trim()}" is not a valid Linear issue id.`,
          );
          return;
        }
        id = parsed.normalized;
      }

      const parsed = parseIssueId(id, { teamKeys });
      if (!parsed) {
        void vscode.window.showWarningMessage(
          `Linear Lens: "${id}" is not a valid Linear issue id.`,
        );
        return;
      }

      // 2. Fetch the full detail (READ — no write-auth gate).
      const detail = await client.fetchTicketDetail(parsed);
      if (!detail) {
        void vscode.window.showWarningMessage(
          `Linear Lens: could not load ${parsed.normalized}. Sign in to Linear (or set a personal API key) and check your connection, then retry.`,
        );
        return;
      }

      // 3. Format via the pure formatter and write to the clipboard.
      const md = ticketToMarkdown(detail, {
        includeComments: cfg.copyMarkdownIncludeComments,
      });
      await vscode.env.clipboard.writeText(md);
      void vscode.window.showInformationMessage(
        `Linear Lens: copied ${detail.id || parsed.normalized} as Markdown.`,
      );
    },
  );

  context.subscriptions.push(copyIssueMarkdown);
}
