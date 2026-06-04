/**
 * Linear Lens — background-sync status-bar indicator.
 *
 * Shows a subtle `$(sync~spin) Linear…` spinner in the status bar while one or
 * more background Linear fetches are in flight. Hidden completely when idle so it
 * does not clutter the bar between syncs.
 *
 * ### Usage
 *
 * The integrate step constructs one `SyncStatusIndicator`, passes `(n) => sync.set(n)`
 * as the `onActivity` callback to `createLinearClient`, and registers the indicator
 * on `context.subscriptions`.
 *
 * ```ts
 * const sync = new SyncStatusIndicator();
 * context.subscriptions.push({ dispose: () => sync.dispose() });
 * const client = createLinearClient(getCfg, resolveAuth, ..., (n) => sync.set(n));
 * ```
 *
 * ### ref-count API
 *
 * Callers may also drive the indicator directly via {@link SyncStatusIndicator.start}
 * and {@link SyncStatusIndicator.end} when wiring fetch lifecycles that do not go
 * through `onActivity`:
 *
 * ```ts
 * sync.start();
 * try { await doNetworkThing(); } finally { sync.end(); }
 * ```
 */

import * as vscode from "vscode";

/** Debounce window (ms) between a count change and the status-bar re-render. */
const DEBOUNCE_MS = 150;

/**
 * A lazy, ref-counted status-bar "syncing…" indicator shown while background
 * Linear fetches are in flight.
 *
 * The indicator is created on first use (lazy) and hidden automatically when the
 * in-flight count drops back to zero. It is cheap when idle: no timers, no DOM,
 * no VS Code object until the first `start()` / `set(n > 0)` call.
 *
 * @example
 * ```ts
 * const sync = new SyncStatusIndicator();
 * context.subscriptions.push({ dispose: () => sync.dispose() });
 * // Wire into the client:
 * const client = createLinearClient(getCfg, resolveAuth, ..., (n) => sync.set(n));
 * // Or drive manually:
 * sync.start();
 * try { await fetchSomething(); } finally { sync.end(); }
 * ```
 */
export class SyncStatusIndicator {
  /** Current in-flight ref-count. */
  private _count = 0;

  /**
   * Lazily-created status-bar item. Allocated on the first `set(n > 0)` call and
   * reused for the lifetime of the indicator. Positioned on the left at the lowest
   * priority so it never displaces more important items.
   */
  private _item: vscode.StatusBarItem | undefined;

  /**
   * Pending debounce timer handle. Typed as `ReturnType<typeof setTimeout>` so
   * the declaration is portable between browser and Node environments (VS Code
   * extensions run in both Electron and remote-server contexts).
   */
  private _timer: ReturnType<typeof setTimeout> | undefined;

  // -------------------------------------------------------------------------
  // ref-count API
  // -------------------------------------------------------------------------

  /**
   * Increment the in-flight counter by one.
   *
   * Call once per operation started; pair every `start()` with a `end()` in a
   * `finally` block to guarantee the counter returns to zero.
   */
  public start(): void {
    this.set(this._count + 1);
  }

  /**
   * Decrement the in-flight counter by one, floored at zero.
   *
   * Safe to call even when already at zero (defensive against mismatched calls).
   */
  public end(): void {
    this.set(Math.max(0, this._count - 1));
  }

  /**
   * Set the in-flight count to an absolute value (as delivered by the client's
   * `onActivity(n)` callback). The display is updated after a short debounce so
   * a rapid batch of fetches does not cause visible flicker.
   *
   * @param count The new absolute in-flight count. Values below 0 are treated as 0.
   */
  public set(count: number): void {
    this._count = Math.max(0, count);
    this._scheduleRender();
  }

  // -------------------------------------------------------------------------
  // Lifecycle
  // -------------------------------------------------------------------------

  /**
   * Release the underlying VS Code `StatusBarItem` and cancel any pending timer.
   * Safe to call multiple times.
   */
  public dispose(): void {
    if (this._timer !== undefined) {
      clearTimeout(this._timer);
      this._timer = undefined;
    }
    this._item?.dispose();
    this._item = undefined;
  }

  // -------------------------------------------------------------------------
  // Private helpers
  // -------------------------------------------------------------------------

  /**
   * Schedule a debounced render pass. Cancels any already-pending timer so only
   * the final state in a burst of `set()` calls is rendered.
   */
  private _scheduleRender(): void {
    if (this._timer !== undefined) {
      clearTimeout(this._timer);
    }
    this._timer = setTimeout(() => {
      this._timer = undefined;
      this._render();
    }, DEBOUNCE_MS);
  }

  /**
   * Apply the current count to the status-bar item. Creates the item lazily on
   * the first call where `_count > 0` so no VS Code object is allocated until
   * needed. Hides (but does not destroy) the item when idle so it vanishes from
   * the bar without releasing the allocation for the next burst.
   *
   * Never throws.
   */
  private _render(): void {
    try {
      if (this._count > 0) {
        // Lazy allocation: only create the item once we actually need it.
        if (!this._item) {
          this._item = vscode.window.createStatusBarItem(
            vscode.StatusBarAlignment.Left,
            // Lowest-priority Left item — sits at the far right of the left cluster.
            Number.MIN_SAFE_INTEGER,
          );
          this._item.tooltip = "Linear Lens: fetching issue metadata in the background";
        }
        this._item.text = "$(sync~spin) Linear…";
        this._item.show();
      } else {
        // Hide rather than destroy: the item is reused for the next in-flight burst.
        this._item?.hide();
      }
    } catch {
      // Rendering must never throw — best-effort visual only.
    }
  }
}
