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

/** Pixel size of inline avatar images in the people row. */
const AVATAR_PX = 18;

/** Maximum number of avatars shown inline before collapsing into a "+N" suffix. */
const MAX_AVATARS = 6;

/** Diameter, in pixels, of the rendered status / label color dots. */
const DOT_PX = 10;

/**
 * Command ids the hover links to via `command:` URIs. These may be registered in
 * a later build phase; the markdown links are emitted regardless and become live
 * once the commands exist (and while {@link vscode.MarkdownString.isTrusted} is set).
 */
const COMMAND_CHECKOUT_BRANCH = "linearLens.checkoutIssueBranch";
const COMMAND_VIEW_BRANCH_DIFF = "linearLens.viewIssueBranchDiff";

/** Command opening the V3 ticket-detail webview for an issue id. */
const COMMAND_OPEN_TICKET = "linearLens.openTicket";

/** Command ids the hover is allowed to invoke; narrows the trusted-command surface. */
const TRUSTED_COMMANDS: readonly string[] = [
  "linearLens.configureWorkspace",
  COMMAND_CHECKOUT_BRANCH,
  COMMAND_VIEW_BRANCH_DIFF,
  COMMAND_OPEN_TICKET,
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
   * @param getCfg Accessor for the current, validated extension configuration.
   * @param client Linear API client used to enrich hovers; degrades gracefully.
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
    const refs = scanText(document.getText(), {
      teamKeys: cfg.teamKeys,
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

    let markdown: vscode.MarkdownString | undefined;
    if (this.client.hasAuth()) {
      const metadata = await this.client.fetchIssue(ref.issue);
      // Hovers fire on mouse-move: bail if the user has moved on.
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
   * Build the always-available basic hover: a linked id header (or a configure
   * prompt when no workspace slug is set). Used when unauthenticated or when no
   * live metadata could be fetched.
   */
  private buildBasicHover(
    ref: IssueRef,
    cfg: LinearLensConfig,
  ): vscode.MarkdownString {
    const md = newTrustedMarkdown();
    const id = ref.issue.normalized;

    if (ref.kind === "url" && ref.url) {
      md.appendMarkdown(`[**${escapeMd(id)}**](${ref.url})\n\n`);
      md.appendMarkdown(openDetailsLink(id));
    } else if (cfg.workspaceSlug) {
      const url = issueUrl(ref.issue, cfg.workspaceSlug);
      md.appendMarkdown(`[**${escapeMd(id)}**](${url})\n\n`);
      md.appendMarkdown(openDetailsLink(id));
    } else {
      md.appendMarkdown(`**${escapeMd(id)}**\n\n`);
      md.appendMarkdown(openDetailsLink(id) + "\n\n");
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
  ): vscode.MarkdownString {
    const md = newTrustedMarkdown();
    // Avatar / label images load via the markdown image path; HTML stays off to
    // keep issue-sourced text (titles, labels) off any HTML-injection surface.
    md.supportHtml = false;

    const id = meta.id || ref.issue.normalized;
    const url = meta.url || (ref.url ?? issueUrl(ref.issue, cfg.workspaceSlug));

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

    // 2. Status row: colored dot state, then priority, then project.
    const statusParts: string[] = [];
    if (meta.state) {
      const dot = colorDotImage(meta.stateColor, DOT_PX);
      statusParts.push(`${dot}**${escapeMd(meta.state)}**`);
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
    this.appendPeopleRow(md, meta);

    // 4. Labels row: each as a colored dot name chip.
    if (meta.labels.length > 0) {
      const chips = meta.labels.map((label) => labelChip(label)).join("  ");
      md.appendMarkdown(chips + "\n\n");
    }

    // 5. Branch row: the git branch with Checkout / View diff action links.
    if (meta.branchName) {
      const args = encodeCommandArg({ id, branchName: meta.branchName });
      const checkout = `[Checkout branch](command:${COMMAND_CHECKOUT_BRANCH}?${args})`;
      const diff = `[View diff](command:${COMMAND_VIEW_BRANCH_DIFF}?${args})`;
      md.appendMarkdown(`\`${escapeInlineCode(meta.branchName)}\`\n\n`);
      md.appendMarkdown(`${checkout} · ${diff}\n\n`);
    }

    // 6. Action row: open the in-editor detail webview, then the canonical issue.
    const actions: string[] = [openDetailsLink(id)];
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
  // avatarUrl is validated by the caller via isHttpUrl.
  return `![${alt}](${person.avatarUrl}|width=${px} height=${px})`;
}

/**
 * Render a label as a colored dot followed by its name. Markdown lacks true
 * background chips, so a small color swatch plus the name reads cleanly.
 */
function labelChip(label: IssueLabel): string {
  const dot = colorDotImage(label.color, DOT_PX);
  return `${dot}${escapeMd(label.name)}`;
}

/**
 * Build an inline colored-dot markdown image from a hex color, sized `px`.
 * Renders as a `data:` SVG so it is always reliable in trusted hover markdown
 * (no remote load). Returns an empty string when the color is unparseable.
 */
function colorDotImage(color: string | undefined, px: number): string {
  const uri = colorDotDataUri(color, px);
  if (!uri) {
    return "";
  }
  return `![●](${uri}|width=${px} height=${px}) `;
}

/**
 * Build a `data:image/svg+xml;base64,...` URI for a filled circle of the given
 * hex color, sized `px`. Returns an empty string when the color is invalid.
 */
function colorDotDataUri(color: string | undefined, px: number): string {
  const hex = normalizeHex(color);
  if (!hex) {
    return "";
  }
  const r = px / 2;
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" width="${px}" height="${px}" ` +
    `viewBox="0 0 ${px} ${px}"><circle cx="${r}" cy="${r}" r="${r}" ` +
    `fill="${hex}"/></svg>`;
  const base64 = Buffer.from(svg, "utf8").toString("base64");
  return `data:image/svg+xml;base64,${base64}`;
}

/**
 * Normalize a hex color to `#rrggbb` (lowercase), expanding `#rgb` shorthand.
 * Returns `undefined` when the value is missing or not a valid hex color.
 */
function normalizeHex(color: string | undefined): string | undefined {
  if (typeof color !== "string") {
    return undefined;
  }
  const value = color.trim().replace(/^#/, "").toLowerCase();
  if (/^[0-9a-f]{6}$/.test(value)) {
    return `#${value}`;
  }
  if (/^[0-9a-f]{3}$/.test(value)) {
    const [a, b, c] = value;
    return `#${a}${a}${b}${b}${c}${c}`;
  }
  return undefined;
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
