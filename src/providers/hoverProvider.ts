import * as vscode from "vscode";
import { IssueMetadata, IssueRef, LinearClient, LinearLensConfig } from "../types";
import { issueUrl } from "../config";
import { scanText } from "../parser";

/**
 * Provides hovers for Linear issue references.
 *
 * A BASIC hover is always available: it links the issue id to its Linear URL
 * (when a workspace slug is configured) and notes whether the reference is
 * actionable (TODO-bound) or just a plain reference. When the API client is
 * authenticated, a RICH hover with live metadata (title, status, assignee,
 * priority, project) is rendered instead, gracefully falling back to the basic
 * hover if the fetch yields no metadata.
 */
export class IssueHoverProvider implements vscode.HoverProvider {
  private readonly getCfg: () => LinearLensConfig;
  private readonly client: LinearClient;

  /**
   * @param getCfg Accessor for the current, validated extension configuration.
   * @param client Optional Linear API client used to enrich hovers.
   */
  constructor(getCfg: () => LinearLensConfig, client: LinearClient) {
    this.getCfg = getCfg;
    this.client = client;
  }

  /**
   * Resolve the issue reference under `position` and build its hover.
   *
   * @returns A {@link vscode.Hover} for the reference, or `undefined` when no
   * reference sits under the cursor.
   */
  async provideHover(
    document: vscode.TextDocument,
    position: vscode.Position,
    token: vscode.CancellationToken,
  ): Promise<vscode.Hover | undefined> {
    const cfg = this.getCfg();
    if (!cfg.enableHover) {
      return undefined;
    }
    const offset = document.offsetAt(position);
    const refs = scanText(document.getText(), { teamKeys: cfg.teamKeys, markers: cfg.markers });
    const ref = refs.find((r) => offset >= r.start && offset < r.end);
    if (!ref) {
      return undefined;
    }

    if (token.isCancellationRequested) {
      return undefined;
    }

    const range = new vscode.Range(
      document.positionAt(ref.start),
      document.positionAt(ref.end),
    );

    let markdown: vscode.MarkdownString | undefined;
    if (this.client.hasAuth()) {
      const metadata = await this.client.fetchIssue(ref.issue);
      if (token.isCancellationRequested) {
        return undefined;
      }
      if (metadata) {
        markdown = this.buildRichHover(ref, metadata, cfg);
      }
    }

    if (!markdown) {
      markdown = this.buildBasicHover(ref, cfg);
    }

    return new vscode.Hover(markdown, range);
  }

  /**
   * Build the always-available basic hover: an id header (linked when a
   * workspace slug is set) plus a short note describing the reference kind.
   */
  private buildBasicHover(
    ref: IssueRef,
    cfg: LinearLensConfig,
  ): vscode.MarkdownString {
    const md = newTrustedMarkdown();
    const id = ref.issue.normalized;

    if (ref.kind === "url" && ref.url) {
      md.appendMarkdown(`[**${id}**](${ref.url})\n\n`);
    } else if (cfg.workspaceSlug) {
      const url = issueUrl(ref.issue, cfg.workspaceSlug);
      md.appendMarkdown(`[**${id}**](${url})\n\n`);
    } else {
      md.appendMarkdown(`**${id}**\n\n`);
      md.appendMarkdown(
        "_No workspace slug set._ " +
          "[Configure Workspace Slug](command:linearLens.configureWorkspace)\n\n",
      );
    }

    md.appendMarkdown(`_${describeKind(ref)}_`);
    return md;
  }

  /**
   * Build the rich hover from live Linear metadata, falling back to the basic
   * hover's slug/kind handling for the header and footer details.
   */
  private buildRichHover(
    ref: IssueRef,
    metadata: IssueMetadata,
    cfg: LinearLensConfig,
  ): vscode.MarkdownString {
    const md = newTrustedMarkdown();
    const id = metadata.id || ref.issue.normalized;
    const url = metadata.url || (ref.url ?? issueUrl(ref.issue, cfg.workspaceSlug));

    const titleText = metadata.title ? `: ${metadata.title}` : "";
    if (url) {
      md.appendMarkdown(`[**${id}**](${url})${escapeMd(titleText)}\n\n`);
    } else {
      md.appendMarkdown(`**${id}**${escapeMd(titleText)}\n\n`);
    }

    if (metadata.archived) {
      md.appendMarkdown("⚠ **Archived**\n\n");
    }

    const rows: string[] = [];
    if (metadata.state) {
      rows.push(`**Status:** ${escapeMd(metadata.state)}`);
    }
    if (metadata.assignee) {
      rows.push(`**Assignee:** ${escapeMd(metadata.assignee)}`);
    }
    if (metadata.priority) {
      rows.push(`**Priority:** ${escapeMd(metadata.priority)}`);
    }
    if (metadata.project) {
      rows.push(`**Project:** ${escapeMd(metadata.project)}`);
    }
    if (rows.length > 0) {
      md.appendMarkdown(rows.join("  \n") + "\n\n");
    }

    md.appendMarkdown(`_${describeKind(ref)}_`);
    return md;
  }
}

/** Create a trusted, command-link-capable {@link vscode.MarkdownString}. */
function newTrustedMarkdown(): vscode.MarkdownString {
  const md = new vscode.MarkdownString();
  md.isTrusted = true;
  return md;
}

/**
 * Describe a reference's kind for the hover footer, e.g. "Actionable · TODO"
 * for TODO-bound refs or "Reference" for plain/URL refs.
 */
function describeKind(ref: IssueRef): string {
  if (ref.kind === "todo") {
    return ref.marker ? `Actionable · ${ref.marker}` : "Actionable";
  }
  return "Reference";
}

/**
 * Escape markdown-significant characters in interpolated metadata text so issue
 * titles and other free-form values render literally.
 */
function escapeMd(text: string): string {
  return text.replace(/([\\`*_{}\[\]<>|])/g, "\\$1");
}
