/**
 * Linear Lens — team BOARD webview panel.
 *
 * A kanban-style {@link vscode.WebviewPanel}: one column per workflow state,
 * cards = issues (id, title, assignee avatar, labels). Dragging a card to
 * another column changes its status — the headline EDITABLE action. The host
 * gates that write behind {@link ensureWriteAuth} ([WRITE-AUTH GATE]) and runs
 * it through the never-throwing {@link LinearClient.updateIssue}; the webview
 * itself never fetches or writes.
 *
 * Design notes (mirrors `webview/ticketPanel.ts`):
 *  - **Data flows in from the host.** This module owns the panel + the message
 *    protocol but takes its data + actions from caller-supplied handlers, so it
 *    stays decoupled and unit-friendly.
 *  - **Strict CSP + per-load nonce.** `default-src 'none'`, `connect-src 'none'`
 *    (the board never fetches; HTML5 drag-and-drop is DOM-only and needs no CSP
 *    relaxation), nonce-gated inline `<style>`/`<script>`, no `unsafe-inline` /
 *    `unsafe-eval`. Identical CSP shape to the ticket panel.
 *  - **Untrusted data.** Issue ids, titles, label/assignee names and colors are
 *    attacker-influenceable (any workspace member can file an issue). The webview
 *    builds every node with `createElement`/`textContent`, validates colors
 *    against `^#[0-9a-fA-F]{6}$`, and only routes intents back through
 *    `postMessage` — it never navigates or interprets HTML from the payload.
 *  - **Host trusts its own state, not the webview.** A `moveCard` message carries
 *    only the human identifier + target state id; the host re-derives the issue
 *    UUID (the {@link LinearClient.updateIssue} target) from its own last
 *    rendered snapshot via {@link resolveCardUuid} — a spoofed/unknown id is a
 *    no-op.
 *
 * HARD SAFETY RULE: no real Linear writes happen during build/test. The drag
 * write path runs only via the caller's `onMoveCard` handler, which is exercised
 * by unit tests with a MOCKED client. {@link buildBoard} / {@link isStatusChange}
 * / {@link resolveCardUuid} are PURE (no `vscode`) and independently testable.
 */

import { randomBytes } from "node:crypto";
import * as vscode from "vscode";

import type { WorkflowStateOption } from "../types";

// ---------------------------------------------------------------------------
// Card shape (pure)
// ---------------------------------------------------------------------------

/**
 * One label chip on a board card.
 */
export interface BoardCardLabel {
  /** Label name (shown as chip text). */
  readonly name: string;
  /** Hex color string like `#RRGGBB`, validated webview-side before use. */
  readonly color?: string;
}

/**
 * A single board card: the minimal, board-facing projection of an issue.
 *
 * The integrate step maps each (board-extended) `IssueListItem` into this shape.
 * Keeping the board's own contract here (rather than depending on optional
 * fields of `IssueListItem`) keeps this module self-contained and pure.
 */
export interface BoardCard {
  /** Human identifier, e.g. "ENG-123" — the stable key used in messages. */
  readonly id: string;
  /**
   * Linear's internal issue UUID — the {@link LinearClient.updateIssue} target
   * for a drag-to-status write. Cards lacking a UUID cannot be moved.
   */
  readonly uuid?: string;
  /** Issue title. */
  readonly title: string;
  /** Current workflow-state UUID — the card's home column key. */
  readonly stateId?: string;
  /** Assignee display name, if any (drives the avatar fallback initial). */
  readonly assignee?: string;
  /** Absolute assignee avatar image URL, if any. */
  readonly assigneeAvatarUrl?: string;
  /** Human priority label, e.g. "Urgent" (shown only when present). */
  readonly priorityLabel?: string;
  /** Numeric priority 0–4 (sort key; 0 = No priority). */
  readonly priority?: number;
  /** Issue number, for a stable secondary sort. */
  readonly number?: number;
  /** Labels with colors (empty when none). */
  readonly labels?: readonly BoardCardLabel[];
}

/** Ordering applied to cards within a column. `dir` defaults to `desc`. */
export interface BoardCardSort {
  /** Primary sort key. */
  readonly by: "priority" | "number" | "title" | "updated";
  /** Direction. */
  readonly dir?: "asc" | "desc";
}

// ---------------------------------------------------------------------------
// Board model (pure)
// ---------------------------------------------------------------------------

/** Sentinel column key for cards whose state is unknown/missing. */
export const NO_STATUS_COLUMN_ID = "__ll_no_status__";

/** A single board column (one workflow state) with its cards. */
export interface BoardColumn {
  /** Workflow-state UUID, or {@link NO_STATUS_COLUMN_ID} for the catch-all. */
  readonly stateId: string;
  /** Column header label, e.g. "In Progress" / "No status". */
  readonly name: string;
  /** State type: backlog|unstarted|started|completed|canceled|triage. */
  readonly type?: string;
  /** Hex color for the column dot/header accent. */
  readonly color?: string;
  /** Order position (states by `position`, then the trailing No-status). */
  readonly position: number;
  /** The issues in this column, already sorted. */
  readonly cards: BoardCard[];
}

/**
 * Compare two cards for in-column ordering. PURE; null-tolerant.
 *
 * Priority sort places 0 (No priority) last for `desc` (matching Linear's "no
 * priority sinks"); ties break by issue `number`. Other keys fall back to
 * `number`. Never throws.
 */
function compareCards(a: BoardCard, b: BoardCard, sort: BoardCardSort): number {
  const dir = sort.dir === "asc" ? 1 : -1;
  let primary = 0;
  switch (sort.by) {
    case "priority": {
      // Treat "No priority" (0) as the lowest urgency: rank it (5) after 1–4.
      const rank = (p: number | undefined): number => {
        const v = typeof p === "number" && p >= 1 && p <= 4 ? p : 0;
        return v === 0 ? 5 : v;
      };
      // For priority, "desc" means most-urgent first → urgent (1) before low.
      primary = (rank(a.priority) - rank(b.priority)) * (sort.dir === "asc" ? -1 : 1);
      break;
    }
    case "title":
      primary = (a.title ?? "").localeCompare(b.title ?? "", undefined, { sensitivity: "base" }) * dir;
      break;
    case "number":
    case "updated":
    default:
      primary = ((a.number ?? 0) - (b.number ?? 0)) * dir;
      break;
  }
  if (primary !== 0) {
    return primary;
  }
  // Stable tiebreak by issue number (ascending) then identifier.
  const byNumber = (a.number ?? 0) - (b.number ?? 0);
  if (byNumber !== 0) {
    return byNumber;
  }
  return (a.id ?? "").localeCompare(b.id ?? "");
}

/**
 * Assemble board columns from a team's workflow states + its issue cards. PURE.
 *
 * - Columns are ordered by state `position` (then name); states with no
 *   `position` sort after positioned ones, preserving input order among equals.
 * - Each card lands in the column whose `stateId` matches the card's `stateId`;
 *   cards with an unknown/missing `stateId` go to a trailing "No status" column
 *   (only present when at least one such card exists).
 * - Cards within a column are ordered by `sort` (default: priority, then number).
 *
 * Never throws; tolerates `null`/`undefined` inputs.
 *
 * @param states - The team's workflow states (column definitions).
 * @param cards - The team's issue cards to place.
 * @param sort - Optional in-column ordering (default `{ by: "priority" }`).
 * @returns The ordered columns, each with its sorted cards.
 */
export function buildBoard(
  states: readonly WorkflowStateOption[] | null | undefined,
  cards: readonly BoardCard[] | null | undefined,
  sort: BoardCardSort = { by: "priority" },
): BoardColumn[] {
  const stateList = Array.isArray(states) ? states : [];
  const cardList = Array.isArray(cards) ? cards : [];

  // Ordered columns, preserving the input order of equally-positioned states.
  const indexed = stateList
    .filter((s): s is WorkflowStateOption => Boolean(s && typeof s.id === "string"))
    .map((s, i) => ({ s, i }));
  indexed.sort((x, y) => {
    const px = typeof x.s.position === "number" ? x.s.position : Number.POSITIVE_INFINITY;
    const py = typeof y.s.position === "number" ? y.s.position : Number.POSITIVE_INFINITY;
    if (px !== py) {
      return px - py;
    }
    const byName = (x.s.name ?? "").localeCompare(y.s.name ?? "");
    return byName !== 0 ? byName : x.i - y.i;
  });

  const buckets = new Map<string, BoardCard[]>();
  const columns: BoardColumn[] = indexed.map(({ s }, position) => {
    const bucket: BoardCard[] = [];
    buckets.set(s.id, bucket);
    return {
      stateId: s.id,
      name: s.name || "(unnamed)",
      type: s.type,
      color: s.color,
      position,
      cards: bucket,
    };
  });

  const orphans: BoardCard[] = [];
  for (const card of cardList) {
    if (!card || typeof card.id !== "string") {
      continue;
    }
    const bucket = card.stateId ? buckets.get(card.stateId) : undefined;
    (bucket ?? orphans).push(card);
  }

  if (orphans.length > 0) {
    columns.push({
      stateId: NO_STATUS_COLUMN_ID,
      name: "No status",
      type: undefined,
      color: undefined,
      position: columns.length,
      cards: orphans,
    });
  }

  for (const column of columns) {
    column.cards.sort((a, b) => compareCards(a, b, sort));
  }
  return columns;
}

/**
 * Whether moving card `issueId` to `toStateId` is a real status change. PURE.
 *
 * Returns `true` only when the card exists, has a UUID (i.e. is movable), and
 * its current `stateId` differs from the target. A no-op move (dropped on its
 * own column) or an unknown id returns `false`. Never throws.
 *
 * @param cards - The current rendered cards.
 * @param issueId - The human identifier of the dragged card.
 * @param toStateId - The destination column's state id.
 */
export function isStatusChange(
  cards: readonly BoardCard[] | null | undefined,
  issueId: string,
  toStateId: string,
): boolean {
  if (!Array.isArray(cards) || !issueId || !toStateId || toStateId === NO_STATUS_COLUMN_ID) {
    return false;
  }
  const card = cards.find((c) => c && c.id === issueId);
  if (!card || !card.uuid) {
    return false;
  }
  return card.stateId !== toStateId;
}

/**
 * Resolve a card's issue UUID from the rendered columns snapshot by its human
 * identifier. PURE. NEVER trusts a webview-supplied UUID — the host re-derives
 * the {@link LinearClient.updateIssue} target from its own state.
 *
 * @param columns - The host's last rendered columns.
 * @param issueId - The human identifier from the inbound `moveCard` message.
 * @returns The card's UUID, or `undefined` when not found / not movable (so a
 *   spoofed `moveCard` is a no-op).
 */
export function resolveCardUuid(
  columns: readonly BoardColumn[] | null | undefined,
  issueId: string,
): string | undefined {
  if (!Array.isArray(columns) || !issueId) {
    return undefined;
  }
  for (const column of columns) {
    for (const card of column.cards) {
      if (card && card.id === issueId) {
        return card.uuid;
      }
    }
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Message protocol (host <-> webview)
// ---------------------------------------------------------------------------

/**
 * Messages sent FROM the host TO the board webview.
 */
export type BoardHostToWebview =
  /** Render (or re-render) the whole board. */
  | {
      readonly type: "render";
      /** Heading shown above the columns (e.g. "ENG · Engineering"). */
      readonly teamName: string;
      /** The assembled columns + cards. */
      readonly columns: BoardColumn[];
      /** When `false`, cards render NON-draggable + a "set a key" hint shows. */
      readonly canWrite: boolean;
    }
  /** Show a calm loading state while the host fetches. */
  | { readonly type: "loading" }
  /** Show an actionable error/empty state with a retry affordance. */
  | { readonly type: "error"; readonly message: string }
  /**
   * Result of a drag-to-status write: `ok:true` confirms the optimistic move,
   * `ok:false` tells the webview to snap the card back to its origin column.
   */
  | { readonly type: "moveResult"; readonly issueId: string; readonly ok: boolean };

/**
 * Messages sent FROM the board webview TO the host. The host validates every
 * inbound message with {@link isBoardMessage} and never `as`-casts raw payloads.
 */
export type BoardWebviewToHost =
  /** The webview finished loading and is ready for a `render`. */
  | { readonly type: "ready" }
  /** Open the detail webview for an issue (the host re-derives the action). */
  | { readonly type: "openIssue"; readonly id: string }
  /** Copy an issue as Markdown. */
  | { readonly type: "copyAsMarkdown"; readonly id: string }
  /** Re-fetch + re-render the board. */
  | { readonly type: "refresh" }
  /**
   * Drag-to-status [WRITE]: move card `issueId` to column `toStateId`. The host
   * re-derives the issue UUID from its own snapshot; the message is advisory.
   */
  | { readonly type: "moveCard"; readonly issueId: string; readonly toStateId: string };

/**
 * Type guard narrowing an unknown `postMessage` payload to a
 * {@link BoardWebviewToHost}. Rejects anything malformed so callers never act on
 * untyped input.
 *
 * @param value - The raw message received from the webview.
 * @returns `true` when `value` is a recognized board webview-to-host message.
 */
export function isBoardMessage(value: unknown): value is BoardWebviewToHost {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const record = value as Record<string, unknown>;
  switch (record.type) {
    case "ready":
    case "refresh":
      return true;
    case "openIssue":
    case "copyAsMarkdown":
      return typeof record.id === "string";
    case "moveCard":
      return typeof record.issueId === "string" && typeof record.toStateId === "string";
    default:
      return false;
  }
}

// ---------------------------------------------------------------------------
// Panel handlers
// ---------------------------------------------------------------------------

/**
 * The resolved board payload the host hands to {@link BoardPanel.render}: the
 * heading, the team's workflow states + cards (assembled here via
 * {@link buildBoard}), and whether the user can write (drag-to-status).
 */
export interface BoardData {
  /** Heading shown above the columns, e.g. "ENG · Engineering". */
  readonly teamName: string;
  /** Linear team UUID — used by the host to scope a re-fetch on refresh. */
  readonly teamId: string;
  /** The team's workflow states (column definitions). */
  readonly states: readonly WorkflowStateOption[];
  /** The team's issue cards to place. */
  readonly cards: readonly BoardCard[];
  /** Whether a write credential is present (controls draggability). */
  readonly canWrite: boolean;
}

/**
 * The outcome of a drag-to-status move attempt, returned by
 * {@link BoardPanelHandlers.onMoveCard}. `ok:true` confirms the move (the host
 * will repaint / leave the optimistic move in place); `ok:false` snaps the card
 * back. When `data` is provided the panel re-renders with the fresh board.
 */
export interface BoardMoveOutcome {
  /** Whether the status change succeeded. */
  readonly ok: boolean;
  /** Optional fresh board data to repaint (e.g. after a successful re-fetch). */
  readonly data?: BoardData;
}

/**
 * Caller-supplied collaborators for the board panel. Each handler is optional;
 * when absent the corresponding intent is ignored. Handlers may be async and may
 * throw — the panel swallows handler errors so the webview can never break the
 * host.
 */
export interface BoardPanelHandlers {
  /**
   * Open the detail webview for an issue id (typically runs `linearLens.openTicket`).
   * The id is the human identifier from the card the user activated.
   */
  readonly onOpenIssue?: (id: string) => void | Promise<void>;
  /** Copy an issue as Markdown (typically runs `linearLens.copyIssueMarkdown`). */
  readonly onCopyAsMarkdown?: (id: string) => void | Promise<void>;
  /** Re-fetch the board. Returning fresh {@link BoardData} re-renders it. */
  readonly onRefresh?: () => BoardData | null | Promise<BoardData | null>;
  /**
   * Perform the drag-to-status WRITE. The HOST is responsible for the
   * [WRITE-AUTH GATE] + running {@link LinearClient.updateIssue}; this handler
   * receives the re-derived issue UUID (resolved host-side from the last render
   * snapshot) — never a webview-supplied one.
   *
   * @param move - The validated move: the issue identifier, its host-resolved
   *   UUID, and the destination state id.
   * @returns The outcome ({@link BoardMoveOutcome}); `ok:false` snaps the card back.
   */
  readonly onMoveCard?: (move: {
    readonly id: string;
    readonly issueUuid: string;
    readonly toStateId: string;
  }) => BoardMoveOutcome | Promise<BoardMoveOutcome>;
}

// ---------------------------------------------------------------------------
// BoardPanel
// ---------------------------------------------------------------------------

/** The webview type id used by VS Code to identify this panel. */
const VIEW_TYPE = "linearLens.teamBoard";

/**
 * Manages the single "Linear Board" webview panel.
 *
 * Reuses one {@link vscode.WebviewPanel} across calls: a second {@link render}
 * retargets the existing panel rather than spawning a new tab. The panel keeps
 * its rendered columns as the authoritative snapshot for resolving a dragged
 * card's UUID (defense in depth — webview-supplied UUIDs are never trusted).
 */
export class BoardPanel {
  private panel: vscode.WebviewPanel | undefined;
  /** The last rendered columns — the host's trusted snapshot for `moveCard`. */
  private columns: BoardColumn[] = [];
  private lastData: BoardData | undefined;
  private cardSort: BoardCardSort = { by: "priority" };
  private readonly disposables: vscode.Disposable[] = [];

  /**
   * @param extensionUri - The extension's root URI (for `localResourceRoots`).
   * @param handlers - Caller-supplied action handlers; see {@link BoardPanelHandlers}.
   */
  public constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly handlers: BoardPanelHandlers = {},
  ) {}

  /** The team id of the board currently shown, or `undefined`. */
  public get currentTeamId(): string | undefined {
    return this.lastData?.teamId;
  }

  /**
   * Reveal (or create) the panel and render the board. Reuses one panel: a
   * second call retargets it. Never throws.
   *
   * @param data - The resolved board payload to display.
   */
  public render(data: BoardData): void {
    try {
      const panel = this.ensurePanel();
      this.lastData = data;
      this.columns = buildBoard(data.states, data.cards, this.cardSort);
      panel.title = data.teamName ? `Board · ${data.teamName}` : "Linear Board";
      void this.post({
        type: "render",
        teamName: data.teamName,
        columns: this.columns,
        canWrite: data.canWrite,
      });
    } catch {
      // Never let a render fault bubble into the host.
    }
  }

  /** Reveal (or create) the panel showing a calm loading state. */
  public showLoading(): void {
    try {
      this.ensurePanel();
      void this.post({ type: "loading" });
    } catch {
      // ignore
    }
  }

  /** Reveal (or create) the panel showing an actionable error/empty state. */
  public showError(message: string): void {
    try {
      this.ensurePanel();
      void this.post({ type: "error", message });
    } catch {
      // ignore
    }
  }

  /** Dispose the panel and all listeners. Safe to call multiple times. */
  public dispose(): void {
    this.panel?.dispose();
    this.panel = undefined;
    this.columns = [];
    this.lastData = undefined;
    while (this.disposables.length) {
      try {
        this.disposables.pop()?.dispose();
      } catch {
        // ignore
      }
    }
  }

  // -------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------

  /** Create the panel on first use, or reveal the existing one. */
  private ensurePanel(): vscode.WebviewPanel {
    if (this.panel) {
      this.panel.reveal(vscode.ViewColumn.Active, false);
      return this.panel;
    }

    const panel = vscode.window.createWebviewPanel(
      VIEW_TYPE,
      "Linear Board",
      { viewColumn: vscode.ViewColumn.Active, preserveFocus: false },
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [vscode.Uri.joinPath(this.extensionUri, "media")],
      },
    );

    panel.webview.html = buildHtml(panel.webview);

    panel.onDidDispose(
      () => {
        this.panel = undefined;
        this.columns = [];
        this.lastData = undefined;
      },
      undefined,
      this.disposables,
    );

    panel.webview.onDidReceiveMessage(
      (raw: unknown) => {
        void this.handleMessage(raw);
      },
      undefined,
      this.disposables,
    );

    this.panel = panel;
    return panel;
  }

  /** Post a host-to-webview message; tolerates a disposed panel. */
  private async post(message: BoardHostToWebview): Promise<void> {
    if (!this.panel) {
      return;
    }
    try {
      await this.panel.webview.postMessage(message);
    } catch {
      // Panel may have been disposed between checks; ignore.
    }
  }

  /**
   * Validate and dispatch an inbound webview message. Unknown/guard-failing
   * messages are ignored silently; handler errors are swallowed.
   */
  private async handleMessage(raw: unknown): Promise<void> {
    if (!isBoardMessage(raw)) {
      return;
    }
    try {
      switch (raw.type) {
        case "ready":
          // Re-send the last render so a reloaded webview repaints.
          if (this.lastData) {
            await this.post({
              type: "render",
              teamName: this.lastData.teamName,
              columns: this.columns,
              canWrite: this.lastData.canWrite,
            });
          }
          return;
        case "openIssue":
          await this.handlers.onOpenIssue?.(raw.id);
          return;
        case "copyAsMarkdown":
          await this.handlers.onCopyAsMarkdown?.(raw.id);
          return;
        case "refresh":
          await this.handleRefresh();
          return;
        case "moveCard":
          await this.handleMoveCard(raw.issueId, raw.toStateId);
          return;
      }
    } catch {
      // A misbehaving webview must never crash the host.
    }
  }

  /** Re-fetch the board via the caller's handler and re-render. */
  private async handleRefresh(): Promise<void> {
    if (!this.handlers.onRefresh) {
      return;
    }
    await this.post({ type: "loading" });
    const fresh = await this.handlers.onRefresh();
    if (fresh) {
      this.render(fresh);
    } else {
      await this.post({
        type: "error",
        message: "Could not refresh the board. Check your connection and Linear sign-in, then try again.",
      });
    }
  }

  /**
   * Handle a drag-to-status move. Re-derives the issue UUID from the host's
   * trusted snapshot (never the webview), confirms it is a real status change,
   * then delegates the [WRITE-AUTH GATE]'d write to `onMoveCard`. On failure (or
   * a no-op / unknown id) it tells the webview to snap the card back.
   */
  private async handleMoveCard(issueId: string, toStateId: string): Promise<void> {
    const snapshot = this.columns;
    const cards = snapshot.flatMap((c) => c.cards);

    // Re-derive the write target from our own state; reject spoofed ids.
    const issueUuid = resolveCardUuid(snapshot, issueId);
    if (!issueUuid || !isStatusChange(cards, issueId, toStateId) || !this.handlers.onMoveCard) {
      await this.post({ type: "moveResult", issueId, ok: false });
      return;
    }

    const outcome = await this.handlers.onMoveCard({ id: issueId, issueUuid, toStateId });
    if (outcome?.data) {
      // Fresh board supersedes the optimistic move.
      this.render(outcome.data);
      await this.post({ type: "moveResult", issueId, ok: Boolean(outcome.ok) });
      return;
    }
    await this.post({ type: "moveResult", issueId, ok: Boolean(outcome?.ok) });
  }
}

/**
 * Convenience factory: create a {@link BoardPanel} and immediately render the
 * board. Returns the panel so callers can keep it for reuse/refresh.
 *
 * @param extensionUri - The extension's root URI.
 * @param data - The resolved board payload to display.
 * @param handlers - Optional action handlers.
 * @returns The created (and now-visible) {@link BoardPanel}.
 */
export function openBoardPanel(
  extensionUri: vscode.Uri,
  data: BoardData,
  handlers: BoardPanelHandlers = {},
): BoardPanel {
  const panel = new BoardPanel(extensionUri, handlers);
  panel.render(data);
  return panel;
}

// ---------------------------------------------------------------------------
// HTML / CSP / nonce
// ---------------------------------------------------------------------------

/**
 * Generate a 32-character base62 nonce for the CSP. Uses `crypto.randomBytes`
 * when available, falling back to `Math.random` (the nonce only needs to be
 * unguessable enough to gate inline `<script>` execution per load).
 */
function createNonce(): string {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  let bytes: Uint8Array | undefined;
  try {
    bytes = randomBytes(32);
  } catch {
    bytes = undefined;
  }
  let out = "";
  for (let i = 0; i < 32; i++) {
    const value = bytes ? bytes[i] : Math.floor(Math.random() * 256);
    out += alphabet[value % alphabet.length];
  }
  return out;
}

/**
 * Build the static HTML shell for the board panel: a strict CSP (nonce-gated
 * script/style, no `connect-src`, no `unsafe-inline`/`unsafe-eval`), the inline
 * stylesheet, the root container, and the inline render script. Identical CSP
 * shape to the ticket panel; HTML5 drag-and-drop needs no CSP relaxation.
 */
function buildHtml(webview: vscode.Webview): string {
  const nonce = createNonce();
  const cspSource = webview.cspSource;
  const csp = [
    "default-src 'none'",
    `img-src https: data: ${cspSource}`,
    `style-src 'nonce-${nonce}' ${cspSource}`,
    `font-src ${cspSource}`,
    `script-src 'nonce-${nonce}'`,
    "connect-src 'none'",
  ].join("; ");

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta http-equiv="Content-Security-Policy" content="${csp}" />
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <style nonce="${nonce}">${BOARD_CSS}</style>
  <title>Linear Board</title>
</head>
<body>
  <div id="root" aria-live="polite"></div>
  <script nonce="${nonce}">${BOARD_SCRIPT}</script>
</body>
</html>`;
}

// ---------------------------------------------------------------------------
// CSS — calm kanban columns using --vscode-* tokens only
// ---------------------------------------------------------------------------

/** Theme-driven stylesheet. Chrome uses only `--vscode-*` variables. */
const BOARD_CSS = `
:root {
  --ll-gap: 12px;
  --ll-radius: 6px;
  --ll-col-width: 280px;
}
* { box-sizing: border-box; }
html, body { height: 100%; }
body {
  margin: 0;
  padding: 0;
  font-family: var(--vscode-font-family);
  font-size: var(--vscode-font-size, 13px);
  color: var(--vscode-foreground);
  background: var(--vscode-editor-background);
  line-height: 1.4;
}
#root { display: flex; flex-direction: column; height: 100vh; }

/* Toolbar */
.toolbar {
  display: flex;
  align-items: center;
  gap: var(--ll-gap);
  padding: 10px var(--ll-gap);
  border-bottom: 1px solid var(--vscode-panel-border);
  flex: 0 0 auto;
}
.toolbar .title { font-weight: 600; font-size: 1.05em; }
.toolbar .spacer { flex: 1 1 auto; }
.toolbar .hint { color: var(--vscode-descriptionForeground); font-size: 0.85em; }

button {
  font-family: inherit;
  font-size: 0.92em;
  color: var(--vscode-button-secondaryForeground, var(--vscode-button-foreground));
  background: var(--vscode-button-secondaryBackground, var(--vscode-button-background));
  border: 1px solid transparent;
  border-radius: var(--ll-radius);
  padding: 4px 12px;
  cursor: pointer;
}
button:hover { background: var(--vscode-button-secondaryHoverBackground, var(--vscode-button-hoverBackground)); }
button:focus-visible { outline: 1px solid var(--vscode-focusBorder); outline-offset: 2px; }

/* Columns */
.board {
  display: flex;
  gap: var(--ll-gap);
  padding: var(--ll-gap);
  overflow-x: auto;
  overflow-y: hidden;
  flex: 1 1 auto;
  align-items: stretch;
}
.column {
  display: flex;
  flex-direction: column;
  flex: 0 0 var(--ll-col-width);
  width: var(--ll-col-width);
  min-height: 0;
  background: var(--vscode-sideBar-background, var(--vscode-editorWidget-background));
  border: 1px solid var(--vscode-panel-border);
  border-radius: var(--ll-radius);
}
.column-head {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 10px;
  font-weight: 600;
  border-bottom: 1px solid var(--vscode-panel-border);
}
.column-head .count {
  margin-left: auto;
  color: var(--vscode-foreground);
  background: var(--vscode-badge-background);
  border-radius: 999px;
  padding: 0 8px;
  font-size: 0.8em;
  font-weight: 500;
}
.column-cards {
  padding: 8px;
  overflow-y: auto;
  flex: 1 1 auto;
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.column.drop-target { outline: 2px dashed var(--vscode-focusBorder); outline-offset: -2px; }
.column-empty { color: var(--vscode-descriptionForeground); font-size: 0.85em; padding: 8px 4px; text-align: center; }

/* Cards */
.card {
  background: var(--vscode-editor-background);
  border: 1px solid var(--vscode-panel-border);
  border-radius: var(--ll-radius);
  padding: 8px 10px;
  cursor: pointer;
}
.card[draggable="true"] { cursor: grab; }
.card.dragging { opacity: 0.5; }
.card:hover { border-color: var(--vscode-focusBorder); }
.card:focus-visible { outline: 1px solid var(--vscode-focusBorder); outline-offset: 1px; }
.card-top { display: flex; align-items: center; gap: 6px; margin-bottom: 4px; }
.card-id { color: var(--vscode-descriptionForeground); font-size: 0.82em; font-variant-numeric: tabular-nums; }
.card-priority { margin-left: auto; color: var(--vscode-descriptionForeground); font-size: 0.78em; }
.card-title { font-size: 0.95em; word-break: break-word; margin-bottom: 6px; }
.card-foot { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; }
.card-foot .spacer { flex: 1 1 auto; }

/* Labels */
.chips { display: flex; flex-wrap: wrap; gap: 4px; }
.chip {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 1px 8px;
  border-radius: 999px;
  font-size: 0.78em;
  white-space: nowrap;
  color: var(--vscode-foreground);
  background: var(--vscode-badge-background);
  border: 1px solid transparent;
}
.dot { width: 8px; height: 8px; border-radius: 50%; flex: 0 0 auto; background: var(--vscode-descriptionForeground); }

/* Avatars */
.avatar {
  width: 20px; height: 20px; border-radius: 50%;
  object-fit: cover;
  background: var(--vscode-badge-background);
  flex: 0 0 auto;
}
.avatar-fallback {
  display: inline-flex; align-items: center; justify-content: center;
  width: 20px; height: 20px; border-radius: 50%;
  font-size: 0.7em; font-weight: 600;
  color: var(--vscode-badge-foreground);
  background: var(--vscode-badge-background);
  flex: 0 0 auto;
}

/* High-contrast: outline chips instead of filled. */
.vscode-high-contrast .chip,
.vscode-high-contrast-light .chip {
  background: transparent;
  border: 1px solid var(--vscode-contrastBorder, var(--vscode-foreground));
}
.vscode-high-contrast .card,
.vscode-high-contrast-light .card,
.vscode-high-contrast .column,
.vscode-high-contrast-light .column {
  border-color: var(--vscode-contrastBorder, var(--vscode-foreground));
}

/* States */
.state-wrap { margin: auto; padding: 40px 16px; text-align: center; color: var(--vscode-descriptionForeground); }
.spinner {
  width: 24px; height: 24px; margin: 0 auto 16px;
  border: 3px solid var(--vscode-panel-border);
  border-top-color: var(--vscode-progressBar-background, var(--vscode-focusBorder));
  border-radius: 50%;
}
@media (prefers-reduced-motion: no-preference) {
  .spinner { animation: ll-spin 0.9s linear infinite; }
}
@keyframes ll-spin { to { transform: rotate(360deg); } }
`;

// ---------------------------------------------------------------------------
// Webview script — vanilla JS, DOM via createElement/textContent
// ---------------------------------------------------------------------------

/**
 * The inline webview script. Acquires the VS Code API, signals `ready`, and
 * renders inbound `render`/`loading`/`error`/`moveResult` payloads. All
 * issue-derived text is inserted via `textContent`; no `innerHTML` is ever used.
 * Colors are validated against `^#[0-9a-fA-F]{6}$` and applied with
 * `style.setProperty`. Drag-and-drop is HTML5 DnD (DOM-only — no CSP relaxation):
 * on drop the webview optimistically moves the card and posts `moveCard`; a
 * `moveResult ok:false` snaps it back to its origin column.
 */
const BOARD_SCRIPT = `
(function () {
  "use strict";
  const vscode = acquireVsCodeApi();
  const root = document.getElementById("root");

  const HEX = /^#[0-9a-fA-F]{6}$/;
  const NO_STATUS = ${JSON.stringify(NO_STATUS_COLUMN_ID)};

  let canWrite = false;
  // Remember each card's origin column so we can snap it back on failure.
  const originById = Object.create(null);

  function post(msg) { vscode.postMessage(msg); }
  function clear(el) { while (el.firstChild) el.removeChild(el.firstChild); }

  function el(tag, props, children) {
    const node = document.createElement(tag);
    if (props) {
      for (const k in props) {
        if (k === "class") node.className = props[k];
        else if (k === "text") node.textContent = props[k];
        else if (k === "title") node.title = props[k];
        else node.setAttribute(k, props[k]);
      }
    }
    if (children) for (const c of children) { if (c) node.appendChild(c); }
    return node;
  }

  function validColor(c) { return typeof c === "string" && HEX.test(c) ? c : null; }
  function isHttp(u) { return typeof u === "string" && /^https?:\\/\\//i.test(u); }

  function contrastOn(hex) {
    const r = parseInt(hex.slice(1, 3), 16);
    const g = parseInt(hex.slice(3, 5), 16);
    const b = parseInt(hex.slice(5, 7), 16);
    const lum = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
    return lum > 0.6 ? "#111111" : "#ffffff";
  }
  function setDot(node, hex) { const v = validColor(hex); if (v) node.style.setProperty("background-color", v); }
  function setChipBg(node, hex) {
    const v = validColor(hex);
    if (v) { node.style.setProperty("background-color", v); node.style.setProperty("color", contrastOn(v)); }
  }

  function avatar(name, url) {
    const label = name || "Unassigned";
    if (isHttp(url)) {
      const img = el("img", { class: "avatar", alt: label, title: label });
      img.src = url;
      img.addEventListener("error", function () {
        const fb = fallbackAvatar(label);
        if (img.parentNode) img.parentNode.replaceChild(fb, img);
      });
      return img;
    }
    return fallbackAvatar(label);
  }
  function fallbackAvatar(name) {
    const initial = (name || "?").trim().charAt(0).toUpperCase() || "?";
    return el("span", { class: "avatar-fallback", title: name, text: initial });
  }

  /* ------------------------------ Drag & drop ----------------------------- */

  function findColumnBody(stateId) {
    return root.querySelector('[data-col="' + cssAttr(stateId) + '"] .column-cards');
  }
  /* Escape a value for use inside a CSS attribute selector. */
  function cssAttr(v) { return String(v).replace(/["\\\\]/g, "\\\\$&"); }

  function onDragStart(ev) {
    const card = ev.currentTarget;
    originById[card.getAttribute("data-id")] = card.parentNode;
    card.classList.add("dragging");
    try {
      ev.dataTransfer.setData("text/plain", card.getAttribute("data-id"));
      ev.dataTransfer.effectAllowed = "move";
    } catch (e) { /* some hosts restrict dataTransfer; the DOM move still works */ }
  }
  function onDragEnd(ev) { ev.currentTarget.classList.remove("dragging"); }

  function onColumnDragOver(ev) {
    if (!canWrite) return;
    ev.preventDefault();
    try { ev.dataTransfer.dropEffect = "move"; } catch (e) {}
    ev.currentTarget.classList.add("drop-target");
  }
  function onColumnDragLeave(ev) { ev.currentTarget.classList.remove("drop-target"); }
  function onColumnDrop(ev) {
    const column = ev.currentTarget;
    column.classList.remove("drop-target");
    if (!canWrite) return;
    ev.preventDefault();
    const dragging = root.querySelector(".card.dragging");
    if (!dragging) return;
    const toStateId = column.getAttribute("data-col");
    const body = column.querySelector(".column-cards");
    if (!body || !toStateId || toStateId === NO_STATUS) return;
    const id = dragging.getAttribute("data-id");
    if (dragging.parentNode === body) return; // no-op: same column
    const emptyNote = body.querySelector(".column-empty");
    if (emptyNote) emptyNote.remove();
    body.appendChild(dragging); // optimistic move
    post({ type: "moveCard", issueId: id, toStateId: toStateId });
  }

  /* Snap a card back to its origin column on a failed move. */
  function snapBack(issueId) {
    const card = root.querySelector('.card[data-id="' + cssAttr(issueId) + '"]');
    const origin = originById[issueId];
    if (card && origin && card.parentNode !== origin) origin.appendChild(card);
  }

  /* ------------------------------ Renderers ------------------------------- */

  function renderStateScreen(msg) {
    clear(root);
    const wrap = el("div", { class: "state-wrap" });
    if (msg.type === "loading") {
      wrap.appendChild(el("div", { class: "spinner", "aria-hidden": "true" }));
      wrap.appendChild(el("div", { text: "Loading board…" }));
    } else {
      wrap.appendChild(el("div", { text: msg.message || "Something went wrong." }));
      const retry = el("button", { text: "Retry" });
      retry.style.marginTop = "12px";
      retry.addEventListener("click", function () { post({ type: "refresh" }); });
      wrap.appendChild(retry);
    }
    root.appendChild(wrap);
  }

  function priorityShort(card) {
    if (typeof card.priorityLabel === "string" && card.priorityLabel && card.priorityLabel !== "No priority") {
      return card.priorityLabel;
    }
    return "";
  }

  function cardNode(card) {
    const node = el("div", { class: "card", "data-id": card.id, tabindex: "0" });
    if (canWrite && card.uuid) {
      node.setAttribute("draggable", "true");
      node.addEventListener("dragstart", onDragStart);
      node.addEventListener("dragend", onDragEnd);
    }
    // Open detail on click / Enter; Cmd/Ctrl+click copies as markdown.
    node.addEventListener("click", function (ev) {
      if (ev.metaKey || ev.ctrlKey) post({ type: "copyAsMarkdown", id: card.id });
      else post({ type: "openIssue", id: card.id });
    });
    node.addEventListener("keydown", function (ev) {
      if (ev.key === "Enter" || ev.key === " ") { ev.preventDefault(); post({ type: "openIssue", id: card.id }); }
    });

    const top = el("div", { class: "card-top" });
    top.appendChild(el("span", { class: "card-id", text: card.id || "" }));
    const pr = priorityShort(card);
    if (pr) top.appendChild(el("span", { class: "card-priority", text: pr }));
    node.appendChild(top);

    node.appendChild(el("div", { class: "card-title", text: card.title || "(untitled)" }));

    const labels = (card.labels || []).filter(function (l) { return l && l.name; });
    if (labels.length) {
      const chips = el("div", { class: "chips" });
      labels.slice(0, 6).forEach(function (l) {
        const chip = el("span", { class: "chip" });
        const dot = el("span", { class: "dot" });
        setDot(dot, l.color);
        chip.appendChild(dot);
        chip.appendChild(el("span", { text: l.name }));
        chips.appendChild(chip);
      });
      node.appendChild(chips);
    }

    const foot = el("div", { class: "card-foot" });
    foot.appendChild(el("span", { class: "spacer" }));
    foot.appendChild(avatar(card.assignee, card.assigneeAvatarUrl));
    node.appendChild(foot);
    return node;
  }

  function columnNode(col) {
    const column = el("div", { class: "column", "data-col": col.stateId });
    column.addEventListener("dragover", onColumnDragOver);
    column.addEventListener("dragleave", onColumnDragLeave);
    column.addEventListener("drop", onColumnDrop);

    const head = el("div", { class: "column-head" });
    const dot = el("span", { class: "dot" });
    setDot(dot, col.color);
    head.appendChild(dot);
    head.appendChild(el("span", { text: col.name || "(unnamed)" }));
    head.appendChild(el("span", { class: "count", text: String((col.cards || []).length) }));
    column.appendChild(head);

    const body = el("div", { class: "column-cards" });
    const cards = col.cards || [];
    if (!cards.length) {
      body.appendChild(el("div", { class: "column-empty", text: "No issues" }));
    } else {
      cards.forEach(function (c) { body.appendChild(cardNode(c)); });
    }
    column.appendChild(body);
    return column;
  }

  function renderBoard(msg) {
    canWrite = !!msg.canWrite;
    clear(root);
    for (const k in originById) delete originById[k];

    const toolbar = el("div", { class: "toolbar" });
    toolbar.appendChild(el("span", { class: "title", text: msg.teamName || "Board" }));
    toolbar.appendChild(el("span", { class: "spacer" }));
    if (!canWrite) {
      toolbar.appendChild(el("span", { class: "hint", text: "Set a personal API key to move cards" }));
    }
    const refresh = el("button", { text: "Refresh" });
    refresh.addEventListener("click", function () { post({ type: "refresh" }); });
    toolbar.appendChild(refresh);
    root.appendChild(toolbar);

    const board = el("div", { class: "board" });
    (msg.columns || []).forEach(function (col) { board.appendChild(columnNode(col)); });
    root.appendChild(board);
  }

  window.addEventListener("message", function (event) {
    const msg = event.data;
    if (!msg || typeof msg.type !== "string") return;
    if (msg.type === "render") renderBoard(msg);
    else if (msg.type === "loading" || msg.type === "error") renderStateScreen(msg);
    else if (msg.type === "moveResult") { if (!msg.ok) snapBack(msg.issueId); }
  });

  post({ type: "ready" });
})();
`;
