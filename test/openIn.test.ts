/**
 * Unit tests for `src/branch/openIn.ts`.
 *
 * All tested functions are pure (no `vscode` import) and can run in plain Node
 * via vitest without any VS Code mocking.
 */

import { describe, expect, it } from "vitest";
import { resolveOpenInAction } from "../src/branch/openIn";

// ---------------------------------------------------------------------------
// resolveOpenInAction
// ---------------------------------------------------------------------------

describe("resolveOpenInAction", () => {
  // -------------------------------------------------------------------------
  // "linear" — always opens the URL
  // -------------------------------------------------------------------------
  describe("linear", () => {
    it("returns url action regardless of agentAvailable", () => {
      expect(resolveOpenInAction("linear", "", true)).toEqual({ kind: "url" });
      expect(resolveOpenInAction("linear", "", false)).toEqual({ kind: "url" });
      expect(resolveOpenInAction("linear", "my.command", true)).toEqual({ kind: "url" });
    });
  });

  // -------------------------------------------------------------------------
  // "custom" — run the configured command id or fall back to URL
  // -------------------------------------------------------------------------
  describe("custom", () => {
    it("returns command action with configured commandId when set", () => {
      expect(resolveOpenInAction("custom", "myExtension.openIssue", false)).toEqual({
        kind: "command",
        commandId: "myExtension.openIssue",
      });
    });

    it("falls back to url when customCommand is empty", () => {
      expect(resolveOpenInAction("custom", "", true)).toEqual({ kind: "url" });
      expect(resolveOpenInAction("custom", "   ", true)).toEqual({ kind: "url" });
    });

    it("trims whitespace from the commandId", () => {
      const result = resolveOpenInAction("custom", "  my.cmd  ", false);
      expect(result).toEqual({ kind: "command", commandId: "my.cmd" });
    });
  });

  // -------------------------------------------------------------------------
  // "vscode" — agent when available, else URL
  // -------------------------------------------------------------------------
  describe("vscode", () => {
    it("returns agent action when agent is available", () => {
      expect(resolveOpenInAction("vscode", "", true)).toEqual({ kind: "agent" });
    });

    it("falls back to url when agent is not available", () => {
      expect(resolveOpenInAction("vscode", "", false)).toEqual({ kind: "url" });
    });
  });

  // -------------------------------------------------------------------------
  // "cursor" — agent when available, else URL
  // -------------------------------------------------------------------------
  describe("cursor", () => {
    it("returns agent action when agent is available", () => {
      expect(resolveOpenInAction("cursor", "", true)).toEqual({ kind: "agent" });
    });

    it("falls back to url when agent is not available", () => {
      expect(resolveOpenInAction("cursor", "", false)).toEqual({ kind: "url" });
    });
  });

  // -------------------------------------------------------------------------
  // "auto" — agent when available, else URL
  // -------------------------------------------------------------------------
  describe("auto", () => {
    it("returns agent action when agent is available", () => {
      expect(resolveOpenInAction("auto", "", true)).toEqual({ kind: "agent" });
    });

    it("falls back to url when agent is not available", () => {
      expect(resolveOpenInAction("auto", "", false)).toEqual({ kind: "url" });
    });
  });

  // -------------------------------------------------------------------------
  // Unknown / fallback — treated as "auto"
  // -------------------------------------------------------------------------
  describe("unknown tool value (fallback)", () => {
    it("treats unknown value as auto — agent when available", () => {
      // Cast to bypass TS to simulate a misconfigured setting.
      expect(resolveOpenInAction("bogus" as never, "", true)).toEqual({ kind: "agent" });
    });

    it("treats unknown value as auto — url when no agent", () => {
      expect(resolveOpenInAction("bogus" as never, "", false)).toEqual({ kind: "url" });
    });
  });
});
