/**
 * Linear Lens — in-editor issue reference decorations.
 *
 * Adds a subtle dotted underline (using the editor's textLink colour) under
 * every detected issue reference — raw, todo, and url alike — so developers
 * can see at a glance where Linear issues are mentioned.  The decorator
 * respects the `linearLens.decorations.enable` setting and only operates on
 * `file` and `untitled` document schemes.
 */

import * as vscode from "vscode";
import { scanText } from "./parser";
import type { LinearLensConfig } from "./types";

/**
 * Manages a single {@link vscode.TextEditorDecorationType} and applies it to
 * editors on demand.
 *
 * Lifecycle: construct once (e.g. during extension activation), call
 * `applyToVisible()` after config changes or document edits, and call
 * `dispose()` when the extension deactivates.
 */
export class IssueDecorator {
  /** The single decoration type shared across all editors. */
  private readonly _type: vscode.TextEditorDecorationType;

  /** Live accessor so the decorator always uses the current configuration. */
  private readonly _getCfg: () => LinearLensConfig;

  /**
   * Create an `IssueDecorator`.
   *
   * @param getCfg A function that returns the current resolved configuration.
   *               Called on every `apply` / `applyToVisible` invocation so
   *               the decorator reacts to setting changes without being
   *               recreated.
   */
  constructor(getCfg: () => LinearLensConfig) {
    this._getCfg = getCfg;

    // One decoration type for the extension's lifetime.  Dotted underline in
    // the editor's link colour keeps the visual weight low while still making
    // every ref discoverable.  The overview ruler gutter entry lets users
    // quickly locate refs in long files without scrolling.
    this._type = vscode.window.createTextEditorDecorationType({
      textDecoration: "underline dotted",
      color: new vscode.ThemeColor("textLink.foreground"),
      rangeBehavior: vscode.DecorationRangeBehavior.ClosedClosed,
      overviewRulerColor: new vscode.ThemeColor("textLink.foreground"),
      overviewRulerLane: vscode.OverviewRulerLane.Right,
    });
  }

  /**
   * (Re)apply decorations to one editor.
   *
   * When `editor` is omitted the active text editor is used.  If there is no
   * editor, or the document scheme is not `file` / `untitled`, the method
   * returns immediately without touching anything.
   *
   * When `linearLens.decorations.enable` is `false`, existing decorations are
   * cleared (empty array) so the type is not left visually stale.
   *
   * @param editor The editor to decorate; defaults to the active editor.
   */
  apply(editor?: vscode.TextEditor): void {
    const target = editor ?? vscode.window.activeTextEditor;
    if (!target) {
      return;
    }

    const scheme = target.document.uri.scheme;
    if (scheme !== "file" && scheme !== "untitled") {
      return;
    }

    const cfg = this._getCfg();

    // Always call setDecorations — with an empty array when disabled — so VS
    // Code removes any decorations that were applied during a previous pass.
    if (!cfg.enableDecorations) {
      target.setDecorations(this._type, []);
      return;
    }

    const text = target.document.getText();
    const refs = scanText(text, {
      teamKeys: cfg.teamKeys,
      markers: cfg.markers,
    });

    // Build a Range for every ref regardless of kind (todo, raw, url).
    const ranges: vscode.Range[] = refs.map((ref) =>
      new vscode.Range(
        target.document.positionAt(ref.start),
        target.document.positionAt(ref.end),
      ),
    );

    target.setDecorations(this._type, ranges);
  }

  /**
   * Apply decorations to every currently visible editor.
   *
   * Intended to be called after a configuration change or after the set of
   * visible editors changes (e.g. `onDidChangeVisibleTextEditors`).
   */
  applyToVisible(): void {
    for (const editor of vscode.window.visibleTextEditors) {
      this.apply(editor);
    }
  }

  /**
   * Release the underlying {@link vscode.TextEditorDecorationType}.
   *
   * After disposal, VS Code automatically removes the decoration from every
   * editor that was using it.  No further calls to `apply` or `applyToVisible`
   * should be made.
   */
  dispose(): void {
    this._type.dispose();
  }
}
