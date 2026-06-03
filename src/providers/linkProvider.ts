import * as vscode from "vscode";
import { LinearLensConfig } from "../types";
import { scanText } from "../parser";
import { issueUrl } from "../config";

/**
 * Turns Linear issue references found in a document into clickable
 * {@link vscode.DocumentLink}s.
 *
 * Detection is delegated to the pure `scanText` parser; targets are built with
 * `issueUrl` for bare/TODO refs and taken verbatim for `url` refs. References
 * with no resolvable target (a non-url ref while the workspace slug is unset)
 * are skipped, since a link without a target is meaningless.
 */
export class IssueLinkProvider implements vscode.DocumentLinkProvider {
  /** Reads the current, validated extension configuration on demand. */
  private readonly getCfg: () => LinearLensConfig;

  /**
   * @param getCfg Accessor for the latest {@link LinearLensConfig}; read fresh
   * on each call so config changes take effect without re-registration.
   */
  constructor(getCfg: () => LinearLensConfig) {
    this.getCfg = getCfg;
  }

  /**
   * Scan `document` and return a {@link vscode.DocumentLink} for every issue
   * reference that has a valid target.
   *
   * @param document The document to scan.
   * @param token Cancellation token; honored cooperatively.
   * @returns The clickable links, in document order.
   */
  public provideDocumentLinks(
    document: vscode.TextDocument,
    token: vscode.CancellationToken,
  ): vscode.DocumentLink[] {
    const cfg = this.getCfg();
    if (!cfg.enableLinks) {
      return [];
    }
    const refs = scanText(document.getText(), { teamKeys: cfg.teamKeys, markers: cfg.markers });
    const links: vscode.DocumentLink[] = [];

    for (const ref of refs) {
      if (token.isCancellationRequested) {
        break;
      }

      let target: string | undefined;
      if (ref.kind === "url") {
        target = ref.url;
      } else if (cfg.workspaceSlug) {
        target = issueUrl(ref.issue, cfg.workspaceSlug);
      }

      // Skip refs with no valid target: a non-url ref while the workspace slug
      // is unset (issueUrl would yield a slug-less, useless URL), or a url ref
      // somehow missing its url.
      if (!target) {
        continue;
      }

      const range = new vscode.Range(
        document.positionAt(ref.start),
        document.positionAt(ref.end),
      );
      const link = new vscode.DocumentLink(range, vscode.Uri.parse(target));
      link.tooltip = "Open " + ref.issue.normalized + " in Linear";
      links.push(link);
    }

    return links;
  }
}
