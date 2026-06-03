/**
 * Linear Lens — text parser (pure, no `vscode` import).
 *
 * Detects Linear issue references in arbitrary text and classifies each as:
 *  - `"todo"`: bound to a TODO/FIXME/BUG/HACK marker or an unchecked markdown
 *    checkbox on the same line — actionable, eligible for diagnostics.
 *  - `"raw"`:  a bare id in prose (e.g. "Fixed in ENG-123") — link/hover only.
 *  - `"url"`:  a full linear.app issue URL — link/hover only.
 *
 * All offsets returned are absolute, zero-based character indexes into the
 * EXACT string passed in, so callers can map them with `document.positionAt`.
 */

import { IssueId, IssueRef, ScanOptions, TodoMarker, TODO_MARKERS } from "./types";

// ---------------------------------------------------------------------------
// Regex building blocks
// ---------------------------------------------------------------------------

/**
 * Body of an issue-id token: a 2–7 letter team key, a hyphen, then 1–6 digits.
 * Used both standalone (zero-config) and as the shape inside URLs.
 */
const ID_BODY = "([A-Za-z]{2,7})-(\\d{1,6})";

/**
 * Full linear.app issue URL. Captures the team key + number from the
 * `/issue/<KEY>-<NUMBER>` segment, and tolerates an optional `/slug-text` tail
 * (and an optional trailing slash). Matched case-insensitively for the host.
 *
 * Example: https://linear.app/acme/issue/ENG-123/fix-auth
 */
const URL_REGEX =
  /https?:\/\/linear\.app\/[^\s/]+\/issue\/([A-Za-z]{2,7})-(\d{1,6})(?:\/[A-Za-z0-9._~-]*)?/g;

/**
 * Markers that make a line actionable, matched as whole words,
 * case-insensitively. Word boundaries prevent false hits like
 * `debug` → BUG or `hackathon` → HACK.
 */
const MARKER_REGEX = /\b(TODO|FIXME|BUG|HACK)\b/i;

/**
 * An unchecked markdown task item: `- [ ] `, `* [ ] `, or `+ [ ] ` at the
 * start of the line (allowing leading whitespace). A checked box (`[x]`/`[X]`)
 * deliberately does NOT match — it is considered done, hence not actionable.
 */
const UNCHECKED_CHECKBOX_REGEX = /^\s*[-*+]\s+\[ \]\s/;

/**
 * Build a regex that matches a standalone bare id token, honoring the
 * teamKeys allowlist when provided.
 *
 * Standalone means: not immediately preceded by `[A-Za-z0-9_-]` and not
 * immediately followed by `[A-Za-z0-9_]`. A following `-` IS allowed, so
 * `ENG-123-foo` still matches `ENG-123`.
 */
function buildIdRegex(teamKeys: string[] | undefined): RegExp {
  // Key alternation: either the explicit allowlist, or any 2–7 letter key.
  const keyPattern =
    teamKeys && teamKeys.length > 0
      ? `(?:${teamKeys.map(escapeRegExp).join("|")})`
      : "[A-Za-z]{2,7}";

  // Lookbehind/lookahead enforce token standalone-ness. `\d` is excluded from
  // the trailing lookahead so `ENG-12` inside `ENG-123` cannot partial-match —
  // but since we anchor the full digit run greedily this is naturally handled;
  // the lookahead still blocks `ENG-123abc`.
  const source = `(?<![A-Za-z0-9_-])(${keyPattern})-(\\d{1,6})(?![A-Za-z0-9_])`;
  return new RegExp(source, "gi");
}

/** Escape a string for safe inclusion in a RegExp source. */
function escapeRegExp(input: string): string {
  return input.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// ---------------------------------------------------------------------------
// IssueId construction
// ---------------------------------------------------------------------------

/**
 * Construct an `IssueId` from a raw team key and numeric string. The team is
 * normalized to uppercase; `normalized` is the canonical `TEAM-NUMBER` form.
 */
function makeIssueId(rawTeam: string, rawNumber: string): IssueId {
  const team = rawTeam.toUpperCase();
  const num = parseInt(rawNumber, 10);
  return { team, number: num, normalized: `${team}-${num}` };
}

/**
 * Check whether a team key passes the optional allowlist. URLs bypass this
 * (handled by callers) since a real Linear URL is authoritative.
 */
function teamAllowed(team: string, teamKeys: string[] | undefined): boolean {
  if (!teamKeys || teamKeys.length === 0) {
    return true;
  }
  const upper = team.toUpperCase();
  return teamKeys.some((k) => k.toUpperCase() === upper);
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Scan a whole document's text and return every reference found, in document
 * order (sorted by `start`), with absolute offsets.
 *
 * URLs are detected first and their spans masked so the same id embedded in a
 * URL is not also emitted as a bare ref. Bare ids are classified per line:
 * actionable lines (TODO-family marker anywhere, or an unchecked checkbox)
 * yield `"todo"` refs; all other lines yield `"raw"` refs.
 *
 * @param text    The exact document text to scan.
 * @param options Optional scan options (notably the `teamKeys` allowlist).
 * @returns       All detected references, sorted by start offset.
 */
export function scanText(text: string, options?: ScanOptions): IssueRef[] {
  const teamKeys = options?.teamKeys;
  const refs: IssueRef[] = [];

  // --- Pass 1: URLs (authoritative, allowlist-exempt) ----------------------
  // Track covered [start,end) spans so bare-id scanning can skip them.
  const urlSpans: Array<[number, number]> = [];
  URL_REGEX.lastIndex = 0;
  for (const m of text.matchAll(URL_REGEX)) {
    const start = m.index;
    const end = start + m[0].length;
    urlSpans.push([start, end]);
    refs.push({
      issue: makeIssueId(m[1], m[2]),
      kind: "url",
      start,
      end,
      raw: m[0],
      url: m[0],
    });
  }

  // --- Pass 2: bare ids, classified per line -------------------------------
  const idRegex = buildIdRegex(teamKeys);
  let lineStart = 0;
  // Split manually to preserve exact offsets (including the consumed "\n").
  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const base = lineStart;
    // Advance lineStart past this line and its trailing newline for next iter.
    lineStart += line.length + 1;

    const { actionable, marker } = classifyLine(line);

    idRegex.lastIndex = 0;
    for (const m of line.matchAll(idRegex)) {
      const inLineIndex = m.index;
      const start = base + inLineIndex;
      const end = start + m[0].length;

      // Skip ids that fall inside an already-emitted URL span.
      if (isWithinAnySpan(start, end, urlSpans)) {
        continue;
      }

      // Enforce the teamKeys allowlist for bare ids.
      if (!teamAllowed(m[1], teamKeys)) {
        continue;
      }

      const ref: IssueRef = {
        issue: makeIssueId(m[1], m[2]),
        kind: actionable ? "todo" : "raw",
        start,
        end,
        raw: m[0],
      };
      if (actionable && marker) {
        ref.marker = marker;
      }
      refs.push(ref);
    }
  }

  // Emit in document order.
  refs.sort((a, b) => a.start - b.start);
  return refs;
}

/**
 * Parse a single token like `"eng-123"` or `" ENG-123 "` into an `IssueId`,
 * or `null` if it is not a standalone issue id. Surrounding whitespace is
 * tolerated. Respects the `teamKeys` allowlist when provided.
 *
 * @param token   The candidate token (typically user input).
 * @param options Optional scan options (notably the `teamKeys` allowlist).
 * @returns       The parsed `IssueId`, or `null`.
 */
export function parseIssueId(token: string, options?: ScanOptions): IssueId | null {
  const trimmed = token.trim();
  // Anchored full-token match: nothing but a single id is allowed.
  const m = new RegExp(`^${ID_BODY}$`).exec(trimmed);
  if (!m) {
    return null;
  }
  if (!teamAllowed(m[1], options?.teamKeys)) {
    return null;
  }
  return makeIssueId(m[1], m[2]);
}

/**
 * Extract the FIRST issue id embedded anywhere in a git branch name, or `null`.
 * Branch segments are commonly lowercase, which is expected and normalized.
 *
 * Example: `allie/eng-123-auth-redirect` → `{ team: "ENG", number: 123, ... }`.
 *
 * @param branch  The branch name (e.g. from `.git/HEAD`).
 * @param options Optional scan options (notably the `teamKeys` allowlist).
 * @returns       The first matching `IssueId`, or `null`.
 */
export function issueIdFromBranch(branch: string, options?: ScanOptions): IssueId | null {
  const teamKeys = options?.teamKeys;
  const idRegex = buildIdRegex(teamKeys);
  for (const m of branch.matchAll(idRegex)) {
    if (teamAllowed(m[1], teamKeys)) {
      return makeIssueId(m[1], m[2]);
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Determine whether a line is actionable and, if so, which marker (if any)
 * bound it. A line is actionable if it contains a TODO-family marker keyword
 * (whole-word, case-insensitive) OR is an unchecked markdown checkbox.
 *
 * The checkbox case has no keyword, so `marker` is `undefined` there. When a
 * marker keyword is present, it is normalized to uppercase. If multiple markers
 * appear on the line, we record the FIRST one (left-most) the regex finds.
 */
function classifyLine(line: string): { actionable: boolean; marker?: TodoMarker } {
  const markerMatch = MARKER_REGEX.exec(line);
  if (markerMatch) {
    const upper = markerMatch[1].toUpperCase();
    // Narrow to the TodoMarker union via the canonical list.
    const marker = TODO_MARKERS.find((k) => k === upper);
    return { actionable: true, marker };
  }
  if (UNCHECKED_CHECKBOX_REGEX.test(line)) {
    return { actionable: true };
  }
  return { actionable: false };
}

/** Return true if `[start,end)` overlaps any span in `spans`. */
function isWithinAnySpan(
  start: number,
  end: number,
  spans: ReadonlyArray<readonly [number, number]>,
): boolean {
  for (const [s, e] of spans) {
    // Overlap test (half-open intervals).
    if (start < e && end > s) {
      return true;
    }
  }
  return false;
}
