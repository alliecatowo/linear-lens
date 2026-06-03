/**
 * Linear Lens — open-in-preferred-tool resolution (pure, no `vscode` import).
 *
 * Resolves the concrete action to take for the "Open in Coding Tool" command
 * based on the `linearLens.openIn.tool` setting and whether a coding agent is
 * detected at runtime. Decision logic is PURE so it can be unit-tested in plain
 * Node via vitest without any VS Code mocking.
 *
 * The host (extension.ts / branchActions.ts) executes the returned action;
 * this module only decides WHAT to do, not HOW to do it.
 */

import type { OpenInTool } from "../types";

export type { OpenInTool };

// ---------------------------------------------------------------------------
// Action shapes
// ---------------------------------------------------------------------------

/** Open the issue's canonical URL in the system browser. */
export interface OpenUrlAction {
  readonly kind: "url";
}

/** Invoke a VS Code command id with the issue context. */
export interface OpenCommandAction {
  readonly kind: "command";
  /** The command id to execute. When `undefined` the host uses its auto-detected command. */
  readonly commandId?: string;
}

/** Delegate to the existing AgentBridge auto-detect path. */
export interface OpenAgentAction {
  readonly kind: "agent";
}

/** Tagged discriminated union of all possible "open in tool" actions. */
export type OpenInAction = OpenUrlAction | OpenCommandAction | OpenAgentAction;

// ---------------------------------------------------------------------------
// resolveOpenInAction — pure decision function
// ---------------------------------------------------------------------------

/**
 * Resolve which concrete action to take for "Open in preferred tool". PURE.
 *
 * Resolution:
 * - `"linear"`  → open the issue URL externally (`{ kind: "url" }`).
 * - `"vscode"`  → run the detected VS Code agent command, or fall back to URL.
 * - `"cursor"`  → run the detected Cursor agent command, or fall back to URL.
 * - `"custom"`  → run `customCommand` as a VS Code command id. Falls back to URL
 *                 when `customCommand` is empty.
 * - `"auto"`    → delegate to the existing AgentBridge auto-detect; URL fallback
 *                 when no agent is available (`agentAvailable === false`).
 *
 * @param tool            The configured `openIn.tool` value.
 * @param customCommand   The trimmed `openIn.customCommand` (may be "").
 * @param agentAvailable  Whether the AgentBridge reports an available agent.
 */
export function resolveOpenInAction(
  tool: OpenInTool,
  customCommand: string,
  agentAvailable: boolean,
): OpenInAction {
  switch (tool) {
    case "linear":
      return { kind: "url" };

    case "custom": {
      const cmd = customCommand.trim();
      if (!cmd) {
        // Empty custom command → fall back to URL.
        return { kind: "url" };
      }
      return { kind: "command", commandId: cmd };
    }

    case "vscode":
      // Named editor preference — use the agent bridge's detected VS Code command
      // when available, else open the URL. We pass `commandId: undefined` so the
      // bridge picks the best VS Code command it knows about.
      return agentAvailable ? { kind: "agent" } : { kind: "url" };

    case "cursor":
      // Same pattern as "vscode" — the AgentBridge already probes for Cursor.
      return agentAvailable ? { kind: "agent" } : { kind: "url" };

    case "auto":
    default:
      return agentAvailable ? { kind: "agent" } : { kind: "url" };
  }
}
