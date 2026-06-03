/**
 * Linear Lens — tiny, dependency-free markdown → safe-HTML renderer (no `vscode`).
 *
 * This is the single source of truth for turning untrusted markdown (issue
 * descriptions and comment bodies) into a sanitized HTML string that the webview
 * inserts verbatim. It is deliberately:
 *
 *  - **Dependency-free.** No npm markdown library, so the bundle stays small and
 *    the webview's strict nonce CSP is never relaxed (no remote/eval'd code).
 *  - **`vscode`-free + pure.** It takes a string and returns a string, so it is
 *    unit-testable in plain Node (vitest) and can be reused by the host before it
 *    posts a payload to the webview.
 *  - **Escape-FIRST, format-SECOND.** Every byte of input is HTML-escaped before
 *    any markup is produced, so attacker-controlled text can never inject tags or
 *    attributes. Only a small allowlist of tags is ever emitted
 *    (`p, br, strong, em, code, pre, h1..h3, ul, ol, li, blockquote, a`), and the
 *    only attributes are `class` and, on links, `data-href` (a validated
 *    `http(s)` URL routed back through the webview's click delegation — never a
 *    live `href`/navigation).
 *  - **Newline-robust.** Bodies frequently arrive over the host→webview boundary
 *    with the two-character escape sequences `\n` / `\r\n` / `\t` instead of real
 *    control characters (the classic "newlines came across the wire escaped"
 *    case). {@link renderMarkdown} un-escapes those as its FIRST step so it is
 *    correct whether the source delivers real or escaped newlines — this is the
 *    fix for descriptions/comments that previously rendered literal `\n`.
 */

/** The tags this renderer is permitted to emit. Documented for auditing. */
export const ALLOWED_TAGS: readonly string[] = [
  "p",
  "br",
  "strong",
  "em",
  "code",
  "pre",
  "h1",
  "h2",
  "h3",
  "ul",
  "ol",
  "li",
  "blockquote",
  "a",
];

/**
 * HTML-escape a raw string so it is safe to place in element content or a
 * double-quoted attribute. Escapes `&`, `<`, `>`, `"`, and `'`.
 *
 * @param value - Arbitrary, possibly attacker-controlled text.
 * @returns The HTML-escaped string.
 */
export function escapeHtml(value: string): string {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/**
 * Replace the literal two-character escape sequences `\r\n`, `\n`, and `\t`
 * (backslash followed by `r`/`n`/`t`) with the real control characters, so a
 * body that arrived with escaped newlines renders identically to one with real
 * newlines. Real newlines/tabs already present are left untouched.
 *
 * @param text - The raw body text (may contain escaped or real newlines).
 * @returns The text with literal `\r\n` / `\n` / `\t` converted to real chars.
 */
function unescapeNewlines(text: string): string {
  return text
    .replace(/\\r\\n/g, "\n")
    .replace(/\\n/g, "\n")
    .replace(/\\r/g, "\n")
    .replace(/\\t/g, "    ");
}

/** Matches an `http`/`https` URL (the only schemes permitted in links). */
const HTTP_URL = /^https?:\/\//i;

/**
 * Inline formatting on ALREADY-ESCAPED text. Renders, in order, inline
 * `` `code` ``, `**bold**`, `*italic*` / `_italic_`, and
 * `[label](http(s)://…)` links. Links become `<a class="link" data-href="…">`
 * (no live `href`) so the webview routes the click via `postMessage`; non-http
 * links collapse to their plain label.
 *
 * Operates on text that has been through {@link escapeHtml}, so `<`, `>`, `&`,
 * `"`, `'` are already entities and cannot break out of the emitted markup.
 *
 * @param escaped - HTML-escaped text (the output of {@link escapeHtml}).
 * @returns The text with the inline allowlist markup applied.
 */
export function renderInline(escaped: string): string {
  // Inline code is processed FIRST and its contents are held out of every other
  // pass, so `*`/`_`/`[` inside `` `code` `` are emitted verbatim. We split the
  // input into code spans and the gaps between them, format only the gaps, and
  // re-join — a placeholder/round-trip would be re-scanned and is fragile.
  const CODE_SPAN = /`([^`]+)`/g;
  let result = "";
  let last = 0;
  for (let m = CODE_SPAN.exec(escaped); m !== null; m = CODE_SPAN.exec(escaped)) {
    result += formatInlineNonCode(escaped.slice(last, m.index));
    result += `<code>${m[1]}</code>`;
    last = m.index + m[0].length;
  }
  result += formatInlineNonCode(escaped.slice(last));
  return result;
}

/**
 * Apply the non-code inline markup (bold, italic, links) to a run of escaped
 * text that contains no inline-code spans. Split out of {@link renderInline} so
 * code-span contents are never subjected to these passes.
 */
function formatInlineNonCode(escaped: string): string {
  let s = escaped;
  // Bold before italic so `**x**` is not eaten by the single-`*` rule.
  s = s.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
  s = s.replace(/(^|[^*])\*([^*\s][^*]*?)\*/g, "$1<em>$2</em>");
  s = s.replace(/(^|[^_\w])_([^_\s][^_]*?)_(?![_\w])/g, "$1<em>$2</em>");
  // Links: the href may contain balanced parens (e.g. `javascript:alert(1)`),
  // so match a parenthesized group that allows one level of nesting and consume
  // it whole; only http(s) becomes an anchor, anything else collapses to label.
  s = s.replace(
    /\[([^\]]+)\]\((?:[^()\s]|\([^()\s]*\))*\)/g,
    (match, label: string) => {
      const href = match.slice(match.indexOf("](") + 2, -1);
      if (!HTTP_URL.test(href)) {
        return label;
      }
      // href came from escaped text; re-escape any stray quote for the attribute.
      const safeHref = href.replace(/"/g, "&quot;");
      return `<a class="link" data-href="${safeHref}">${label}</a>`;
    },
  );
  return s;
}

/** True for a blank (whitespace-only) line. */
function isBlank(line: string): boolean {
  return /^\s*$/.test(line);
}

/** True for the start/end of a fenced code block (``` …). */
function isFence(line: string): boolean {
  return /^\s*```/.test(line);
}

/** Parse a heading line into its level (1–3) and text, or `null`. */
function parseHeading(line: string): { level: number; text: string } | null {
  const m = /^(#{1,3})\s+(.*)$/.exec(line);
  return m ? { level: m[1].length, text: m[2] } : null;
}

/** True for a blockquote line (`> …`). */
function isBlockquote(line: string): boolean {
  return /^\s*>\s?/.test(line);
}

/** True for an unordered (`-`/`*`/`+`) list item line. */
function isUnordered(line: string): boolean {
  return /^\s*[-*+]\s+/.test(line);
}

/** True for an ordered (`1.`) list item line. */
function isOrdered(line: string): boolean {
  return /^\s*\d+\.\s+/.test(line);
}

/** True for any line that starts a non-paragraph block. */
function isBlockStart(line: string): boolean {
  return (
    isBlank(line) ||
    isFence(line) ||
    parseHeading(line) !== null ||
    isBlockquote(line) ||
    isUnordered(line) ||
    isOrdered(line)
  );
}

/**
 * Render a markdown string to a sanitized HTML string.
 *
 * Pipeline (each step builds on the previous):
 *  1. Coerce to string and un-escape literal `\r\n` / `\n` / `\t` → real chars.
 *  2. Normalize real `\r\n` → `\n` and split into lines.
 *  3. Block pass: blank lines separate paragraphs; ```fenced``` code blocks
 *     (verbatim, escaped); `#`/`##`/`###` headings; `>` blockquotes; `-`/`*`/`+`
 *     and `1.` lists.
 *  4. Paragraph pass: join consecutive non-block lines, then a single newline
 *     within a paragraph becomes `<br>`.
 *  5. Inline pass via {@link renderInline} on ALREADY-ESCAPED text.
 *
 * The output uses only {@link ALLOWED_TAGS}; all dynamic text is escaped before
 * any markup is applied, and links carry a validated `data-href` rather than a
 * live `href`. An empty/whitespace-only input yields `""`.
 *
 * @param md - The raw markdown (may contain real or escaped newlines).
 * @returns A sanitized HTML string safe to assign to `innerHTML`.
 */
export function renderMarkdown(md: string | undefined | null): string {
  const text = unescapeNewlines(String(md ?? ""));
  const lines = text.replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n");
  const out: string[] = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];

    if (isBlank(line)) {
      i++;
      continue;
    }

    // Fenced code block: contents are verbatim + escaped, no inline formatting.
    if (isFence(line)) {
      const buf: string[] = [];
      i++;
      while (i < lines.length && !isFence(lines[i])) {
        buf.push(lines[i]);
        i++;
      }
      i++; // consume the closing fence (if any)
      out.push(`<pre><code>${escapeHtml(buf.join("\n"))}</code></pre>`);
      continue;
    }

    // Heading.
    const heading = parseHeading(line);
    if (heading) {
      const tag = `h${heading.level}`;
      out.push(`<${tag}>${renderInline(escapeHtml(heading.text))}</${tag}>`);
      i++;
      continue;
    }

    // Blockquote (consecutive `>` lines joined with a space).
    if (isBlockquote(line)) {
      const buf: string[] = [];
      while (i < lines.length && isBlockquote(lines[i])) {
        buf.push(lines[i].replace(/^\s*>\s?/, ""));
        i++;
      }
      out.push(`<blockquote>${renderInline(escapeHtml(buf.join(" ")))}</blockquote>`);
      continue;
    }

    // Lists (a run of same-family items; first item picks ordered vs unordered).
    if (isUnordered(line) || isOrdered(line)) {
      const ordered = isOrdered(line);
      const items: string[] = [];
      while (i < lines.length && (isUnordered(lines[i]) || isOrdered(lines[i]))) {
        const item = lines[i].replace(/^\s*(?:[-*+]|\d+\.)\s+/, "");
        items.push(`<li>${renderInline(escapeHtml(item))}</li>`);
        i++;
      }
      const tag = ordered ? "ol" : "ul";
      out.push(`<${tag}>${items.join("")}</${tag}>`);
      continue;
    }

    // Paragraph: gather consecutive non-block lines; single newline → <br>.
    const buf: string[] = [];
    while (i < lines.length && !isBlockStart(lines[i])) {
      buf.push(lines[i]);
      i++;
    }
    const inner = renderInline(escapeHtml(buf.join("\n"))).replace(/\n/g, "<br>");
    out.push(`<p>${inner}</p>`);
  }

  return out.join("");
}
