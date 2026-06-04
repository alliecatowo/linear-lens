import * as vscode from "vscode";
import {
  IssueLabel,
  IssueMetadata,
  IssueRef,
  LinearClient,
  LinearLensConfig,
  Person,
} from "../types";
import { issueUrl } from "../config";
import { scanText } from "../parser";
import { stateEmoji, stateLabel } from "../format/state";

/** Pixel size of inline avatar images in the people row. */
const AVATAR_PX = 18;

/** Maximum number of avatars shown inline before collapsing into a "+N" suffix. */
const MAX_AVATARS = 6;

/**
 * Command ids the hover links to via `command:` URIs. These may be registered in
 * a later build phase; the markdown links are emitted regardless and become live
 * once the commands exist (and while {@link vscode.MarkdownString.isTrusted} is set).
 */
const COMMAND_CHECKOUT_BRANCH = "linearLens.checkoutBranch";
const COMMAND_VIEW_BRANCH_DIFF = "linearLens.openBranchDiff";

/** Command opening the V3 ticket-detail webview for an issue id. */
const COMMAND_OPEN_TICKET = "linearLens.openTicket";

/** Command copying an issue as Markdown to the clipboard (E1). */
const COMMAND_COPY_MARKDOWN = "linearLens.copyIssueMarkdown";

/** Command opening the field-edit dispatcher for an issue id (E2). */
const COMMAND_EDIT_ISSUE = "linearLens.editIssue";

/** Command opening the blocker add/remove chooser for an issue id (E2). */
const COMMAND_EDIT_BLOCKERS = "linearLens.editBlockers";

/** Command ids the hover is allowed to invoke; narrows the trusted-command surface. */
const TRUSTED_COMMANDS: readonly string[] = [
  "linearLens.configureWorkspace",
  COMMAND_CHECKOUT_BRANCH,
  COMMAND_VIEW_BRANCH_DIFF,
  COMMAND_OPEN_TICKET,
  COMMAND_COPY_MARKDOWN,
  COMMAND_EDIT_ISSUE,
  COMMAND_EDIT_BLOCKERS,
];

/**
 * Provides hovers for Linear issue references.
 *
 * A BASIC hover is always available: it links the issue id to its Linear URL
 * (when a workspace slug is configured), or prompts to configure the slug. When
 * the API client is authenticated and live metadata resolves, a RICH hover is
 * rendered instead — a linked title, a colored status line, stacked assignee and
 * collaborator avatars, colored label chips, the project, and the issue's git
 * branch with "Checkout branch" / "View diff" action links. It falls back to the
 * basic hover whenever the fetch yields no metadata.
 */
export class IssueHoverProvider implements vscode.HoverProvider {
  private readonly getCfg: () => LinearLensConfig;
  private readonly client: LinearClient;

  /**
   * Live accessor for the effective team-key allowlist (auth-aware detection).
   * Returns `undefined` for zero-config "match any".
   */
  private readonly getTeamKeys: () => string[] | undefined;

  /** Live accessor for the effective workspace slug (configured or detected). */
  private readonly getSlug: () => string;

  /**
   * @param getCfg Accessor for the current, validated extension configuration.
   * @param client Linear API client used to enrich hovers; degrades gracefully.
   * @param getTeamKeys Accessor for the effective team-key allowlist (from the
   *   auth-aware detection service). Defaults to `() => undefined` (match any).
   * @param getSlug Accessor for the effective workspace slug (configured or
   *   detected). Defaults to reading `cfg.workspaceSlug`, preserving back-compat.
   */
  constructor(
    getCfg: () => LinearLensConfig,
    client: LinearClient,
    getTeamKeys: () => string[] | undefined = () => undefined,
    getSlug?: () => string,
  ) {
    this.getCfg = getCfg;
    this.client = client;
    this.getTeamKeys = getTeamKeys;
    this.getSlug = getSlug ?? (() => getCfg().workspaceSlug);
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
    const refs = scanText(document.getText(), {
      teamKeys: this.getTeamKeys(),
      markers: cfg.markers,
    });
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

    const slug = this.getSlug();

    let markdown: vscode.MarkdownString | undefined;
    if (this.client.hasAuth()) {
      const metadata = await this.client.fetchIssue(ref.issue);
      // Hovers fire on mouse-move: bail if the user has moved on.
      if (token.isCancellationRequested) {
        return undefined;
      }
      if (metadata) {
        markdown = this.buildRichHover(ref, metadata, cfg, slug);
      }
    }

    if (!markdown) {
      markdown = this.buildBasicHover(ref, slug);
    }

    return new vscode.Hover(markdown, range);
  }

  /**
   * Build the always-available basic hover: a linked id header (or a configure
   * prompt when no workspace slug is available). Used when unauthenticated or
   * when no live metadata could be fetched. The "no workspace slug" nag is
   * dropped whenever a slug is available (configured OR detected from the
   * signed-in workspace).
   *
   * @param ref The recognized issue reference under the cursor.
   * @param slug The effective workspace slug (configured or detected); `""` when
   *   neither is available.
   */
  private buildBasicHover(
    ref: IssueRef,
    slug: string,
  ): vscode.MarkdownString {
    const md = newTrustedMarkdown();
    const id = ref.issue.normalized;

    const actionRow = `${openDetailsLink(id)} · ${copyMarkdownLink(id)}`;
    if (ref.kind === "url" && ref.url) {
      md.appendMarkdown(`[**${escapeMd(id)}**](${ref.url})\n\n`);
      md.appendMarkdown(actionRow);
    } else if (slug) {
      const url = issueUrl(ref.issue, slug);
      md.appendMarkdown(`[**${escapeMd(id)}**](${url})\n\n`);
      md.appendMarkdown(actionRow);
    } else {
      md.appendMarkdown(`**${escapeMd(id)}**\n\n`);
      md.appendMarkdown(actionRow + "\n\n");
      md.appendMarkdown(
        "_No workspace slug set._ " +
          "[Configure Workspace Slug](command:linearLens.configureWorkspace)",
      );
    }

    return md;
  }

  /**
   * Build the rich hover from live Linear metadata: a linked title, a colored
   * status line, stacked avatars, label chips, the project, and the issue's git
   * branch with Checkout / View diff action links.
   */
  private buildRichHover(
    ref: IssueRef,
    meta: IssueMetadata,
    cfg: LinearLensConfig,
    slug: string,
  ): vscode.MarkdownString {
    const md = newTrustedMarkdown();
    // Avatar / label images load via the markdown image path; HTML stays off to
    // keep issue-sourced text (titles, labels) off any HTML-injection surface.
    md.supportHtml = false;

    const id = meta.id || ref.issue.normalized;
    const url = meta.url || (ref.url ?? (slug ? issueUrl(ref.issue, slug) : ""));

    // 1. Title row: linked id em-dash title.
    const titleSuffix = meta.title ? ` — ${escapeMd(meta.title)}` : "";
    if (url) {
      md.appendMarkdown(`[**${escapeMd(id)}**](${url})${titleSuffix}`);
    } else {
      md.appendMarkdown(`**${escapeMd(id)}**${titleSuffix}`);
    }
    if (meta.archived) {
      md.appendMarkdown("  ⚠ _Archived_");
    }
    md.appendMarkdown("\n\n");

    // 2. Status row: emoji state glyph (renders in hovers where data: SVGs do
    //    not), then priority, then project.
    const statusParts: string[] = [];
    const label = stateLabel(meta);
    if (label) {
      statusParts.push(`${stateEmoji(meta.stateType)} **${escapeMd(label)}**`);
    }
    if (meta.priority) {
      statusParts.push(escapeMd(meta.priority));
    }
    if (meta.project) {
      statusParts.push(escapeMd(meta.project));
    }
    if (statusParts.length > 0) {
      md.appendMarkdown(statusParts.join(" · ") + "\n\n");
    }

    // 3. People row: stacked assignee + collaborator avatars (GitHub-style).
    if (cfg.hoverShowAvatars) {
      this.appendPeopleRow(md, meta);
    }

    // 4. Labels row: each as a bullet glyph + name chip.
    if (cfg.hoverShowLabels && meta.labels.length > 0) {
      const chips = meta.labels.map((label) => labelChip(label)).join("  ");
      md.appendMarkdown(chips + "\n\n");
    }

    // 5. Branch row: the git branch with Checkout / View diff action links.
    if (cfg.hoverShowBranchActions && meta.branchName) {
      const args = encodeCommandArg({ id, branchName: meta.branchName });
      const checkout = `[Checkout branch](command:${COMMAND_CHECKOUT_BRANCH}?${args})`;
      const diff = `[View diff](command:${COMMAND_VIEW_BRANCH_DIFF}?${args})`;
      md.appendMarkdown(`\`${escapeInlineCode(meta.branchName)}\`\n\n`);
      md.appendMarkdown(`${checkout} · ${diff}\n\n`);
    }

    // 6. Action row: open the in-editor detail webview, copy as Markdown, the
    //    write actions (Edit / Blockers — each re-checks write-auth at runtime and
    //    no-ops with a prompt when missing), then the canonical issue.
    const actions: string[] = [
      openDetailsLink(id),
      copyMarkdownLink(id),
      editIssueLink(id),
      editBlockersLink(id),
    ];
    if (url) {
      actions.push(`[Open in Linear](${url})`);
    }
    md.appendMarkdown(actions.join(" · "));

    return md;
  }

  /**
   * Append the stacked-avatar people row. Renders the assignee first, then any
   * collaborators (subscribers), as small inline avatar images in a single row.
   * Falls back to a plain text assignee line when avatars are unavailable.
   */
  private appendPeopleRow(md: vscode.MarkdownString, meta: IssueMetadata): void {
    const people: Person[] = [];
    if (meta.assignee) {
      people.push(meta.assignee);
    }
    for (const sub of meta.subscribers) {
      // Avoid showing the assignee twice if they also subscribe.
      if (meta.assignee && sub.name && sub.name === meta.assignee.name) {
        continue;
      }
      people.push(sub);
    }

    const withAvatars = people.filter((p) => isHttpUrl(p.avatarUrl));
    if (withAvatars.length > 0) {
      const shown = withAvatars.slice(0, MAX_AVATARS);
      const images = shown
        .map((p) => avatarImage(p, AVATAR_PX))
        .join(" ");
      const overflow = withAvatars.length - shown.length;
      const suffix = overflow > 0 ? ` +${overflow}` : "";
      md.appendMarkdown(`${images}${suffix}\n\n`);
      return;
    }

    // No usable avatars: fall back to a terse assignee name, never a broken image.
    if (meta.assignee) {
      md.appendMarkdown(`**Assignee:** ${escapeMd(personName(meta.assignee))}\n\n`);
    }
  }
}

/**
 * Create a trusted {@link vscode.MarkdownString} whose command-link trust is
 * narrowed to this extension's own command ids, shrinking the command-injection
 * surface from issue-sourced text (titles, labels, branch names).
 */
function newTrustedMarkdown(): vscode.MarkdownString {
  const md = new vscode.MarkdownString();
  md.isTrusted = { enabledCommands: [...TRUSTED_COMMANDS] };
  md.supportHtml = false;
  return md;
}

/**
 * Encode a single command-link argument object as a `command:` URI query string.
 * The whole object is JSON-stringified then `encodeURIComponent`-encoded so that
 * branch names containing `/`, `#`, or `?` survive the round-trip.
 */
function encodeCommandArg(arg: { id: string; branchName: string }): string {
  return encodeURIComponent(JSON.stringify(arg));
}

/**
 * Build the "Open details" command link that opens the V3 ticket-detail webview
 * for `id`. The `{ id }` argument is JSON-stringified then `encodeURIComponent`-
 * encoded so it round-trips through the `command:` URI.
 */
function openDetailsLink(id: string): string {
  const args = encodeURIComponent(JSON.stringify({ id }));
  return `[Open details](command:${COMMAND_OPEN_TICKET}?${args})`;
}

/**
 * Build the "Copy as Markdown" command link that copies `id` to the clipboard as
 * a Markdown document (E1). The `{ id }` argument is JSON-stringified then
 * `encodeURIComponent`-encoded so it round-trips through the `command:` URI.
 */
function copyMarkdownLink(id: string): string {
  const args = encodeURIComponent(JSON.stringify({ id }));
  return `[Copy as Markdown](command:${COMMAND_COPY_MARKDOWN}?${args})`;
}

/**
 * Build the "Edit" command link that opens the field-edit dispatcher for `id`
 * (E2). The `{ id }` argument is JSON-stringified then `encodeURIComponent`-
 * encoded so it round-trips through the `command:` URI. The command re-checks
 * write access at runtime, prompting (and no-opping) when none is present.
 */
function editIssueLink(id: string): string {
  const args = encodeURIComponent(JSON.stringify({ id }));
  return `[Edit](command:${COMMAND_EDIT_ISSUE}?${args})`;
}

/**
 * Build the "Blockers" command link that opens the blocker add/remove chooser for
 * `id` (E2). The `{ id }` argument is JSON-stringified then `encodeURIComponent`-
 * encoded so it round-trips through the `command:` URI. The chosen sub-command
 * re-checks write access at runtime.
 */
function editBlockersLink(id: string): string {
  const args = encodeURIComponent(JSON.stringify({ id }));
  return `[Blockers](command:${COMMAND_EDIT_BLOCKERS}?${args})`;
}

/** The preferred display name for a person, falling back to the internal name. */
function personName(person: Person): string {
  return person.displayName || person.name || "Unknown";
}

/** Whether a value is a non-empty `http(s)` URL safe to use as an image source. */
function isHttpUrl(value: string | undefined): value is string {
  return (
    typeof value === "string" && /^https?:\/\/\S+$/.test(value.trim())
  );
}

/**
 * Build a small inline avatar image using VS Code's `MarkdownString` image-size
 * syntax. Alt text is the person's name so a failed remote load shows the name
 * rather than an empty box.
 */
function avatarImage(person: Person, px: number): string {
  const alt = escapeMd(personName(person));
  // avatarUrl is validated by the caller via isHttpUrl. VS Code's MarkdownString
  // image-size syntax requires a COMMA between dimensions, not a space.
  return `![${alt}](${person.avatarUrl}|width=${px},height=${px})`;
}

/**
 * Render a label as a plain bullet glyph followed by its name. Hover
 * `MarkdownString`s cannot render `data:` SVG color swatches, so the dot uses a
 * reliable unicode bullet rather than a tinted image.
 */
function labelChip(label: IssueLabel): string {
  return `• ${escapeMd(label.name)}`;
}

/**
 * Escape markdown-significant characters (including image/link/`command:` chars)
 * in interpolated free-form text so issue titles, labels, and names render
 * literally and cannot inject markup or links.
 */
function escapeMd(text: string): string {
  return text.replace(/([\\`*_{}\[\]()<>#+\-.!|~])/g, "\\$1");
}

/** Escape backticks in a value rendered inside an inline-code span. */
function escapeInlineCode(text: string): string {
  return text.replace(/`/g, "ˋ");
}
