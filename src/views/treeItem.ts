/**
 * Linear Lens — shared `TreeItem` rendering for the Activity Bar views.
 *
 * Centralizes how every {@link LinearTreeNode} becomes a {@link vscode.TreeItem}
 * so the file / mine / recent providers render consistently. Imports `vscode`
 * (not a pure module). The node shapes themselves live in the pure
 * `issueTreeModel` module.
 *
 * State dots use a built-in {@link vscode.ThemeIcon} (`circle-filled`) tinted by
 * a small fixed palette of `--vscode-*` theme color ids chosen from the issue's
 * `stateType`. This stays theme-correct in light / dark / high-contrast and
 * needs NO generated SVG assets (spec V2 §9.2).
 */

import * as vscode from "vscode";
import { IssueListItem } from "../types";
import { FileRefNode, IssueNode, LinearTreeNode, MessageNode } from "./issueTreeModel";

/**
 * Internal command (palette-hidden, arg-only) that reveals a file reference by
 * opening the active document at a given 0-based line. Registered by the command
 * layer; the tree item wires the `command` so a single click jumps to the line.
 */
const COMMAND_REVEAL_FILE_REF = "linearLens.revealFileRef";

/** Command run when an issue node is activated — opens the detail webview. */
const COMMAND_OPEN_TICKET = "linearLens.openTicket";

/** Context value applied to issue-bearing nodes, driving `view/item/context`. */
const CONTEXT_VALUE_ISSUE = "linearIssue";

/**
 * Map an issue workflow `stateType` to a theme color id for the state dot.
 * Falls back to a neutral foreground when the type is unknown/missing.
 */
function stateColorId(stateType: string | undefined): string {
  switch (stateType) {
    case "backlog":
      return "descriptionForeground";
    case "unstarted":
      return "charts.blue";
    case "started":
      return "charts.yellow";
    case "completed":
      return "charts.green";
    case "canceled":
      return "charts.red";
    default:
      return "foreground";
  }
}

/** Build the colored state-dot icon for an issue with a known `stateType`. */
function stateDot(stateType: string | undefined): vscode.ThemeIcon {
  return new vscode.ThemeIcon("circle-filled", new vscode.ThemeColor(stateColorId(stateType)));
}

/** Pick the reference-kind icon for a file-ref node lacking a resolved state. */
function refKindIcon(refKind: FileRefNode["refKind"]): vscode.ThemeIcon {
  switch (refKind) {
    case "todo":
      return new vscode.ThemeIcon("checklist");
    case "url":
      return new vscode.ThemeIcon("globe");
    case "raw":
    default:
      return new vscode.ThemeIcon("link");
  }
}

/** Compose the `description` (state name + assignee) for an issue summary. */
function issueDescription(item: IssueListItem): string {
  const parts: string[] = [];
  if (item.state) {
    parts.push(item.state);
  }
  if (item.assignee) {
    parts.push(item.assignee);
  }
  return parts.join(" · ");
}

/** Build a compact markdown tooltip for an issue summary. */
function issueTooltip(item: IssueListItem): vscode.MarkdownString {
  const md = new vscode.MarkdownString();
  md.supportHtml = false;
  const header = item.title ? `**${item.id}** — ${item.title}` : `**${item.id}**`;
  md.appendMarkdown(header + "\n\n");
  const meta = issueDescription(item);
  if (meta) {
    md.appendMarkdown(meta);
  }
  return md;
}

/**
 * Build the `command` that opens an issue node in the V3 detail webview. Passes
 * an `{ id, url }` arg so {@link COMMAND_OPEN_TICKET} resolves the issue directly
 * from the node without re-parsing or relying on the editor cursor.
 */
function openIssueCommand(item: IssueListItem): vscode.Command {
  return {
    command: COMMAND_OPEN_TICKET,
    title: "Open Issue Detail",
    arguments: [{ id: item.id, url: item.url }],
  };
}

/** Render an {@link IssueNode} (My Issues / Recent) as a tree item. */
function renderIssueNode(node: IssueNode): vscode.TreeItem {
  const { item } = node;
  const label = item.title ? `${item.id}  ${item.title}` : item.id;
  const treeItem = new vscode.TreeItem(label, vscode.TreeItemCollapsibleState.None);
  treeItem.description = issueDescription(item);
  treeItem.tooltip = issueTooltip(item);
  treeItem.iconPath = stateDot(item.stateType);
  treeItem.contextValue = CONTEXT_VALUE_ISSUE;
  treeItem.command = openIssueCommand(item);
  return treeItem;
}

/** Render a {@link FileRefNode} (Issues in This File) as a tree item. */
function renderFileRefNode(node: FileRefNode): vscode.TreeItem {
  // Primary label is the id; when a live summary resolved, append its title.
  const title = node.item?.title;
  const label = title ? `${node.id}  ${title}` : node.id;
  const treeItem = new vscode.TreeItem(label, vscode.TreeItemCollapsibleState.None);

  // Description shows the code context (and the line number for orientation).
  const lineNo = node.line + 1;
  treeItem.description = node.context ? `${node.context}  ·  L${lineNo}` : `L${lineNo}`;

  const tip = new vscode.MarkdownString();
  tip.supportHtml = false;
  if (node.item) {
    tip.appendMarkdown(issueTooltip(node.item).value + "\n\n");
  } else {
    tip.appendMarkdown(`**${node.id}**\n\n`);
  }
  if (node.marker) {
    tip.appendMarkdown(`\`${node.marker}\` on line ${lineNo}`);
  } else {
    tip.appendMarkdown(`Line ${lineNo}`);
  }
  treeItem.tooltip = tip;

  // Prefer the live state dot; fall back to a ref-kind icon when unresolved.
  treeItem.iconPath = node.item ? stateDot(node.item.stateType) : refKindIcon(node.refKind);
  treeItem.contextValue = CONTEXT_VALUE_ISSUE;

  // Single click reveals the line in the active editor (arg-only command).
  treeItem.command = {
    command: COMMAND_REVEAL_FILE_REF,
    title: "Reveal File Reference",
    arguments: [{ line: node.line }],
  };
  return treeItem;
}

/** Render a {@link MessageNode} (sign-in CTA / empty state) as a tree item. */
function renderMessageNode(node: MessageNode): vscode.TreeItem {
  const treeItem = new vscode.TreeItem(node.text, vscode.TreeItemCollapsibleState.None);
  treeItem.iconPath = new vscode.ThemeIcon("info");
  if (node.command) {
    treeItem.command = { command: node.command, title: node.text };
  }
  // Distinct context value so message nodes never match `viewItem == linearIssue`.
  treeItem.contextValue = "linearMessage";
  return treeItem;
}

/**
 * Convert any {@link LinearTreeNode} into a {@link vscode.TreeItem}.
 *
 * Shared by all Linear tree providers so issues, file references, and message
 * placeholders render identically. Never throws.
 *
 * @param node The tree-model node to render.
 * @returns    The corresponding `TreeItem`.
 */
export function toTreeItem(node: LinearTreeNode): vscode.TreeItem {
  switch (node.kind) {
    case "issue":
      return renderIssueNode(node);
    case "fileRef":
      return renderFileRefNode(node);
    case "message":
      return renderMessageNode(node);
  }
}
