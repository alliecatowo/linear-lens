/**
 * Linear Lens — configuration reader.
 *
 * Reads and validates every `linearLens.*` VS Code setting into a strongly
 * typed {@link LinearLensConfig}. All reads are defensive: malformed or missing
 * values are coerced to safe defaults and this module NEVER throws.
 */

import * as vscode from "vscode";
import { DiagnosticSeverityName, IssueId, LinearLensConfig } from "./types";

/** The configuration section name used by every `linearLens.*` setting. */
export const CONFIG_SECTION = "linearLens";

/** Default metadata cache TTL, in seconds, when the setting is invalid. */
const DEFAULT_CACHE_TTL_SECONDS = 300;

/** Default diagnostic severity when the setting is missing/invalid. */
const DEFAULT_DIAGNOSTIC_SEVERITY: DiagnosticSeverityName = "information";

/** The valid `linearLens.diagnostics.severity` enum values. */
const DIAGNOSTIC_SEVERITIES: readonly DiagnosticSeverityName[] = [
  "error",
  "warning",
  "information",
  "hint",
];

/**
 * Coerce an unknown value to a string, returning `fallback` when it is not a
 * non-empty string after trimming.
 */
function toStringOr(value: unknown, fallback: string): string {
  return typeof value === "string" ? value : fallback;
}

/**
 * Coerce an unknown value to a boolean, returning `fallback` for non-booleans.
 */
function toBooleanOr(value: unknown, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback;
}

/**
 * Normalize an unknown `teamKeys` value into an array of trimmed, uppercased,
 * non-empty, de-duplicated team keys. Non-arrays and non-string entries are
 * dropped.
 */
function normalizeTeamKeys(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  const seen = new Set<string>();
  const result: string[] = [];
  for (const entry of value) {
    if (typeof entry !== "string") {
      continue;
    }
    const key = entry.trim().toUpperCase();
    if (key.length === 0 || seen.has(key)) {
      continue;
    }
    seen.add(key);
    result.push(key);
  }
  return result;
}

/**
 * Validate an unknown value against the diagnostic-severity enum, falling back
 * to {@link DEFAULT_DIAGNOSTIC_SEVERITY} when it is not a recognized name.
 */
function normalizeSeverity(value: unknown): DiagnosticSeverityName {
  if (
    typeof value === "string" &&
    (DIAGNOSTIC_SEVERITIES as readonly string[]).includes(value)
  ) {
    return value as DiagnosticSeverityName;
  }
  return DEFAULT_DIAGNOSTIC_SEVERITY;
}

/**
 * Coerce an unknown value to a finite, non-negative number of seconds, falling
 * back to {@link DEFAULT_CACHE_TTL_SECONDS} when it is not a usable number.
 */
function normalizeCacheTtlSeconds(value: unknown): number {
  if (typeof value === "number" && Number.isFinite(value) && value >= 0) {
    return value;
  }
  return DEFAULT_CACHE_TTL_SECONDS;
}

/**
 * Read and validate all `linearLens.*` settings into a {@link LinearLensConfig}.
 *
 * Every field is coerced to a safe default if missing or malformed; this
 * function never throws.
 */
export function getConfig(): LinearLensConfig {
  const cfg = vscode.workspace.getConfiguration(CONFIG_SECTION);
  return {
    workspaceSlug: toStringOr(cfg.get("workspaceSlug"), "").trim(),
    teamKeys: normalizeTeamKeys(cfg.get("teamKeys")),
    enableDiagnostics: toBooleanOr(cfg.get("diagnostics.enable"), true),
    diagnosticSeverity: normalizeSeverity(cfg.get("diagnostics.severity")),
    enableApi: toBooleanOr(cfg.get("api.enable"), false),
    cacheTtlSeconds: normalizeCacheTtlSeconds(cfg.get("cache.ttlSeconds")),
  };
}

/**
 * Build the canonical Linear URL for an issue:
 * `https://linear.app/<slug>/issue/<NORMALIZED-ID>`.
 *
 * @example
 * issueUrl({ team: "ENG", number: 123, normalized: "ENG-123" }, "acme")
 * // => "https://linear.app/acme/issue/ENG-123"
 *
 * If `slug` is empty, still returns a best-effort URL using `""` — callers are
 * expected to guard against an empty slug before opening the link.
 */
export function issueUrl(issue: IssueId, slug: string): string {
  return `https://linear.app/${slug}/issue/${issue.normalized}`;
}
