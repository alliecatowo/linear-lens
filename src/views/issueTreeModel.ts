/**
 * Linear Lens — pure tree-node models for the Activity Bar views.
 *
 * This module is intentionally `vscode`-free so the node shapes and the
 * file-scan → node mapping can be unit-tested in plain Node (vitest). The
 * `TreeDataProvider` classes that consume these shapes (and that DO import
 * `vscode`) live alongside in `src/views/*Provider.ts`.
 *
 * See spec V2 §4.
 */

import { IssueListItem, IssueRef } from "../types";

// ---------------------------------------------------------------------------
// Node union
// ---------------------------------------------------------------------------

/** A node in any Linear tree view. */
export type LinearTreeNode = IssueNode | FileRefNode | MessageNode;

/** An issue summary node (My Issues / Recent). */
export interface IssueNode {
  /** Discriminant. */
  kind: "issue";
  /** The resolved live summary backing this node. */
  item: IssueListItem;
}

/** A file-found reference node (Issues in This File), TODO-style. */
export interface FileRefNode {
  /** Discriminant. */
  kind: "fileRef";
  /** Normalized issue id, e.g. "ENG-123". */
  id: string;
  /** The reference's classification (todo/raw/url), used to pick the icon. */
  refKind: IssueRef["kind"];
  /** Marker keyword when actionable (e.g. "TODO"), else undefined. */
  marker?: string;
  /** 0-based line number of the reference in the active document. */
  line: number;
  /** Trimmed source line text — the "code context" shown under the id. */
  context: string;
  /** Resolved live summary when available (drives label/state dot), else undefined. */
  item?: IssueListItem;
}

/**
 * An informational placeholder node, e.g. "Sign in to Linear" or
 * "No references in this file". May carry a command id run on click.
 */
export interface MessageNode {
  /** Discriminant. */
  kind: "message";
  /** Human-readable label rendered for the node. */
  text: string;
  /** Optional command id to run when the node is activated (e.g. sign in). */
  command?: string;
}

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

/**
 * Compute the 0-based line number containing `offset` in `text`.
 *
 * Counts the number of `"\n"` characters strictly before `offset`. Offsets at
 * or past the end of `text` resolve to the last line; negative offsets clamp to
 * line 0. Pure — does not allocate per-line strings.
 *
 * @param text   The full text the offset indexes into.
 * @param offset An absolute, zero-based character offset.
 * @returns      The zero-based line number containing `offset`.
 */
export function lineOf(text: string, offset: number): number {
  const limit = Math.max(0, Math.min(offset, text.length));
  let line = 0;
  for (let i = 0; i < limit; i++) {
    if (text.charCodeAt(i) === 10 /* "\n" */) {
      line++;
    }
  }
  return line;
}

/**
 * Build file-ref nodes from parser refs plus a line-text accessor.
 *
 * The provider is responsible for deriving each ref's 0-based line number from
 * its offset (e.g. via {@link lineOf} or `TextDocument.positionAt`) and for
 * supplying a `lineAt` accessor that returns the raw text of a given line; this
 * keeps the model pure and free of `vscode`.
 *
 * Behavior:
 *  - Refs are mapped to {@link FileRefNode} preserving document order.
 *  - Duplicates are removed: at most one node per unique `id`+`line` pair, so a
 *    line mentioning the same id twice (or a URL + bare id on one line) collapses
 *    to a single entry. The FIRST occurrence wins (it keeps its marker).
 *  - `context` is the trimmed text of the ref's line.
 *
 * @param refs   Parser references, already carrying absolute offsets.
 * @param lineOfRef Maps a ref to its 0-based line number (provider-supplied).
 * @param lineAt  Returns the raw text of a 0-based line.
 * @returns       The deduped file-ref nodes, in document order. Never throws.
 */
export function buildFileRefNodes(
  refs: IssueRef[],
  lineOfRef: (ref: IssueRef) => number,
  lineAt: (line: number) => string,
): FileRefNode[] {
  const seen = new Set<string>();
  const nodes: FileRefNode[] = [];

  for (const ref of refs) {
    const line = lineOfRef(ref);
    const id = ref.issue.normalized;
    const key = `${id}@${line}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);

    let context = "";
    try {
      context = (lineAt(line) ?? "").trim();
    } catch {
      // A misbehaving accessor must never break node construction.
      context = "";
    }

    const node: FileRefNode = {
      kind: "fileRef",
      id,
      refKind: ref.kind,
      line,
      context,
    };
    if (ref.marker) {
      node.marker = ref.marker;
    }
    nodes.push(node);
  }

  return nodes;
}
