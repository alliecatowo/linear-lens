/**
 * Linear Lens — pure issue-to-Markdown formatter (no `vscode`).
 *
 * Turns an {@link IssueMetadata} or {@link TicketDetail} into a clean Markdown
 * document suitable for pasting into an agent/chat session. The output is plain
 * Markdown (not HTML); it is never HTML-escaped.
 *
 * Design notes:
 *  - Pure and deterministic: same input → same output, no side-effects.
 *  - `vscode`-free: unit-testable with plain Node / vitest, no extension host.
 *  - Body normalization (`normalizeBody`) maps the two-character escape sequences
 *    `\r\n` / `\n` / `\t` (backslash + letter) to their real control characters.
 *    Note: `\t` maps to a real tab here, which differs from `src/format/markdown.ts`
 *    (which maps `\t` → four spaces for HTML rendering). The two helpers are
 *    intentionally separate to avoid a markdown ↔ issueMarkdown import cycle.
 */

import { IssueComment, IssueLabel, IssueMetadata, TicketDetail } from "../types";

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

/** Options controlling {@link ticketToMarkdown} output. */
export interface IssueMarkdownOptions {
  /** Include the full description body. Default `true`. */
  readonly includeDescription?: boolean;
  /** Include the comment thread. Default `false` (terser for agents). */
  readonly includeComments?: boolean;
  /**
   * Include the properties block (state / assignee / priority / project /
   * labels / branch). Default `true`.
   */
  readonly includeProperties?: boolean;
  /** Include the canonical Linear URL line. Default `true`. */
  readonly includeUrl?: boolean;
}

// ---------------------------------------------------------------------------
// Body normalization
// ---------------------------------------------------------------------------

/**
 * Unescape the literal two-character sequences `\r\n`, `\n`, `\r`, and `\t`
 * (backslash followed by r / n / t) into real control characters, then trim
 * trailing whitespace from each line.
 *
 * This corrects descriptions and comment bodies that arrive over the Linear
 * API with escaped newlines instead of real ones. Real newlines / tabs already
 * present are left untouched.
 *
 * Note: `\t` is converted to a real tab character (U+0009), not four spaces.
 * This makes copy-as-Markdown output cleaner for agents that support tab
 * indentation. It deliberately diverges from the HTML renderer in
 * `src/format/markdown.ts`, which maps `\t` → four spaces for webview display.
 *
 * @param body - Raw body text (may contain real or escaped newlines/tabs).
 * @returns The normalized text, or `""` when the input is `null`/`undefined`.
 */
export function normalizeBody(body: string | undefined | null): string {
  if (body == null) {
    return "";
  }
  return (
    String(body)
      // Literal backslash-r-backslash-n first (before the single-\n pass).
      .replace(/\\r\\n/g, "\n")
      .replace(/\\n/g, "\n")
      .replace(/\\r/g, "\n")
      .replace(/\\t/g, "\t")
      // Normalize CRLF → LF.
      .replace(/\r\n/g, "\n")
      .replace(/\r/g, "\n")
      // Trim trailing whitespace from each line.
      .split("\n")
      .map((line) => line.trimEnd())
      .join("\n")
      // Remove leading/trailing blank lines.
      .trim()
  );
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Format an ISO-8601 timestamp as a short date string (YYYY-MM-DD).
 * Falls back to the raw value if parsing fails.
 *
 * @param iso - ISO-8601 timestamp string.
 * @returns A `YYYY-MM-DD` date string.
 */
function formatDate(iso: string): string {
  try {
    return new Date(iso).toISOString().slice(0, 10);
  } catch {
    return iso;
  }
}

/**
 * Render a single comment block.
 *
 * @param comment - The comment to render.
 * @returns A Markdown string for the comment.
 */
function renderComment(comment: IssueComment): string {
  const author = comment.author?.displayName ?? comment.author?.name ?? "Unknown";
  const date = formatDate(comment.createdAt);
  const body = normalizeBody(comment.body);
  const lines: string[] = [`**${author}** — ${date}`];
  if (body) {
    lines.push(body);
  }
  return lines.join("\n");
}

/**
 * Render a label list as a comma-separated string.
 *
 * @param labels - Array of {@link IssueLabel} objects.
 * @returns A comma-separated list of label names, or `""` when empty.
 */
function renderLabels(labels: IssueLabel[]): string {
  return labels.map((l) => l.name).join(", ");
}

// ---------------------------------------------------------------------------
// Main formatter
// ---------------------------------------------------------------------------

/**
 * Render a Linear issue as a clean Markdown document for pasting to an agent.
 *
 * Output shape (sections are omitted when empty or disabled by options):
 *
 * ```markdown
 * # ENG-123 — Title
 *
 * - **Status:** In Progress
 * - **Assignee:** Jane Doe
 * - **Priority:** High
 * - **Project:** Billing
 * - **Labels:** bug, backend
 * - **Branch:** `jane/eng-123-title`
 * - **URL:** https://linear.app/acme/issue/ENG-123
 *
 * ## Description
 *
 * <description body>
 *
 * ## Comments
 *
 * **Jane Doe** — 2026-06-01
 * <comment body>
 * ```
 *
 * Rules:
 *  - The heading uses `id + " — " + title`; when title is empty, just the id.
 *  - Property lines are omitted when their value is empty / undefined.
 *  - Description and comment bodies are passed through {@link normalizeBody}.
 *  - No HTML escaping — output is Markdown for an agent, not for a browser.
 *  - Returns `""` when the ticket is `null` / `undefined`.
 *
 * @param ticket - The issue to format. Accepts either {@link IssueMetadata} or
 *   {@link TicketDetail}; both shapes are handled defensively.
 * @param options - Controls which sections are included.
 * @returns A Markdown string, or `""` for a null/undefined ticket.
 */
export function ticketToMarkdown(
  ticket: TicketDetail | IssueMetadata | null | undefined,
  options?: IssueMarkdownOptions,
): string {
  if (ticket == null) {
    return "";
  }

  const includeDescription = options?.includeDescription ?? true;
  const includeComments = options?.includeComments ?? false;
  const includeProperties = options?.includeProperties ?? true;
  const includeUrl = options?.includeUrl ?? true;

  const parts: string[] = [];

  // ---- Heading ----
  const heading = ticket.title
    ? `# ${ticket.id} — ${ticket.title}`
    : `# ${ticket.id}`;
  parts.push(heading);

  // ---- Properties block ----
  if (includeProperties || includeUrl) {
    const props: string[] = [];

    if (includeProperties) {
      if (ticket.state) {
        props.push(`- **Status:** ${ticket.state}`);
      }

      const assigneeName =
        ticket.assignee?.displayName || ticket.assignee?.name || "";
      if (assigneeName) {
        props.push(`- **Assignee:** ${assigneeName}`);
      }

      if (ticket.priority) {
        props.push(`- **Priority:** ${ticket.priority}`);
      }

      if (ticket.project) {
        props.push(`- **Project:** ${ticket.project}`);
      }

      const labelStr = renderLabels(ticket.labels ?? []);
      if (labelStr) {
        props.push(`- **Labels:** ${labelStr}`);
      }

      if (ticket.branchName) {
        props.push(`- **Branch:** \`${ticket.branchName}\``);
      }
    }

    if (includeUrl && ticket.url) {
      props.push(`- **URL:** ${ticket.url}`);
    }

    if (props.length > 0) {
      parts.push(props.join("\n"));
    }
  }

  // ---- Description ----
  if (includeDescription) {
    const description = normalizeBody(ticket.description);
    if (description) {
      parts.push("## Description\n\n" + description);
    }
  }

  // ---- Comments ----
  if (includeComments) {
    const comments: IssueComment[] = ticket.comments ?? [];
    if (comments.length > 0) {
      const commentBlocks = comments.map(renderComment);
      parts.push("## Comments\n\n" + commentBlocks.join("\n\n---\n\n"));
    }
  }

  return parts.join("\n\n");
}
