/**
 * Linear Lens — defensive accessors for the V2 "views" settings.
 *
 * `linearLens.views.enable` and `linearLens.views.recent.limit` are contributed
 * by the V2 config step. These helpers read them off the resolved config without
 * hard-coupling the view providers to the exact `LinearLensConfig` field names,
 * so the providers stay resilient if a field is missing and fall back to safe
 * defaults (views enabled, a sensible list limit). Pure; never throws.
 */

import { LinearLensConfig } from "../types";

/** Default list limit when `views.recent.limit` is unset/invalid. */
const DEFAULT_LIST_LIMIT = 25;

/** Lowest sensible list limit. */
const MIN_LIST_LIMIT = 1;

/** Highest list limit we will request. */
const MAX_LIST_LIMIT = 100;

/**
 * Whether the Linear Activity Bar views are enabled. Defaults to `true` when the
 * setting is absent so the container always has content unless explicitly off.
 *
 * @param cfg The resolved extension configuration.
 * @returns   `true` when views are enabled.
 */
export function viewsEnabled(cfg: LinearLensConfig): boolean {
  const value = (cfg as { enableViews?: unknown }).enableViews;
  return typeof value === "boolean" ? value : true;
}

/**
 * How many issues to load in the My Issues / Recent / search views, clamped to
 * `[1, 100]`. Defaults to {@link DEFAULT_LIST_LIMIT} when unset/invalid.
 *
 * @param cfg The resolved extension configuration.
 * @returns   A clamped, finite integer list limit.
 */
export function listLimit(cfg: LinearLensConfig): number {
  const raw = (cfg as { viewsRecentLimit?: unknown }).viewsRecentLimit;
  if (typeof raw === "number" && Number.isFinite(raw)) {
    return Math.min(MAX_LIST_LIMIT, Math.max(MIN_LIST_LIMIT, Math.floor(raw)));
  }
  return DEFAULT_LIST_LIMIT;
}
