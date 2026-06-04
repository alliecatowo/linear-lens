import * as vscode from "vscode";
import { scanText } from "./parser";
import { DiagnosticSeverityName, LinearLensConfig } from "./types";

/** Document URI schemes this manager will process. All others are ignored. */
const SUPPORTED_SCHEMES: ReadonlySet<string> = new Set(["file", "untitled"]);

/**
 * Map a configured severity name to the corresponding `vscode.DiagnosticSeverity`.
 * Falls back to `Information` for any unrecognized value.
 */
function toDiagnosticSeverity(name: DiagnosticSeverityName): vscode.DiagnosticSeverity {
  switch (name) {
    case "error":
      return vscode.DiagnosticSeverity.Error;
    case "warning":
      return vscode.DiagnosticSeverity.Warning;
    case "hint":
      return vscode.DiagnosticSeverity.Hint;
    case "information":
      return vscode.DiagnosticSeverity.Information;
    default:
      return vscode.DiagnosticSeverity.Information;
  }
}

/**
 * Publishes Problems entries for TODO-bound Linear references only.
 *
 * THE CORE PRODUCT RULE: only references with `kind === "todo"` ever become
 * diagnostics. Raw prose references (e.g. "Fixed in ENG-123") and full Linear
 * URLs link and hover but are NEVER reported as diagnostics.
 */
export class DiagnosticsManager {
  private readonly collection: vscode.DiagnosticCollection;
  private readonly getCfg: () => LinearLensConfig;

  /**
   * Live accessor for the effective team-key allowlist (auth-aware detection) so
   * non-team tokens (e.g. `XYZ-123` for an unknown team) never become Problems
   * entries. Returns `undefined` for zero-config "match any".
   */
  private readonly getTeamKeys: () => string[] | undefined;

  /**
   * @param collection The diagnostic collection owned by the extension.
   * @param getCfg Accessor returning the current resolved configuration.
   * @param getTeamKeys Accessor for the effective team-key allowlist (from the
   *   auth-aware {@link DetectionService}). Defaults to `() => undefined`
   *   (zero-config "match any"), preserving back-compat.
   */
  public constructor(
    collection: vscode.DiagnosticCollection,
    getCfg: () => LinearLensConfig,
    getTeamKeys: () => string[] | undefined = () => undefined,
  ) {
    this.collection = collection;
    this.getCfg = getCfg;
    this.getTeamKeys = getTeamKeys;
  }

  /**
   * Recompute diagnostics for a single document.
   *
   * Skips documents whose URI scheme is not "file"/"untitled". When diagnostics
   * are disabled, clears any existing entries for the document. Only `"todo"`
   * references produce diagnostics.
   */
  public refresh(document: vscode.TextDocument): void {
    if (!SUPPORTED_SCHEMES.has(document.uri.scheme)) {
      return;
    }

    const cfg = this.getCfg();

    if (!cfg.enableDiagnostics) {
      this.collection.set(document.uri, []);
      return;
    }

    const severity = toDiagnosticSeverity(cfg.diagnosticSeverity);
    const refs = scanText(document.getText(), { teamKeys: this.getTeamKeys(), markers: cfg.markers });
    const diagnostics: vscode.Diagnostic[] = [];

    for (const ref of refs) {
      if (ref.kind !== "todo") {
        continue;
      }

      const range = new vscode.Range(
        document.positionAt(ref.start),
        document.positionAt(ref.end),
      );
      const label = ref.marker ?? "Tracked";
      const diagnostic = new vscode.Diagnostic(
        range,
        `${label} → Linear issue ${ref.issue.normalized}`,
        severity,
      );
      diagnostic.source = "Linear Lens";
      diagnostic.code = ref.issue.normalized;
      diagnostics.push(diagnostic);
    }

    this.collection.set(document.uri, diagnostics);
  }

  /**
   * Remove diagnostics for a closed (or otherwise gone) document.
   */
  public clear(uri: vscode.Uri): void {
    this.collection.delete(uri);
  }

  /**
   * Recompute diagnostics for many documents, e.g. on activation or after a
   * configuration change.
   */
  public refreshAll(documents: readonly vscode.TextDocument[]): void {
    for (const document of documents) {
      this.refresh(document);
    }
  }

  /**
   * Clear all published diagnostics and release the collection.
   */
  public dispose(): void {
    this.collection.clear();
    this.collection.dispose();
  }
}
