/**
 * Unit tests for the pure (vscode-free) workspace-info mapper and the pure
 * detection precedence/merge helpers that power auth-aware detection.
 *
 * No VS Code mocking is needed — `mapWorkspaceInfo` and the `resolve*` helpers
 * are free of any `vscode` import.
 */

import { describe, expect, it } from "vitest";
import {
  mapWorkspaceInfo,
  WORKSPACE_INFO_QUERY,
  WORKSPACE_INFO_TEAM_LIMIT,
} from "../src/linear/workspaceQuery";
import {
  parseStoredWorkspaceInfo,
  resolveEffectiveSlug,
  resolveEffectiveTeamKeys,
} from "../src/detection";

// ---------------------------------------------------------------------------
// WORKSPACE_INFO_QUERY constant
// ---------------------------------------------------------------------------

describe("WORKSPACE_INFO_QUERY", () => {
  it("selects organization.urlKey + teams nodes (key/id/name)", () => {
    expect(WORKSPACE_INFO_QUERY).toContain("organization { urlKey }");
    expect(WORKSPACE_INFO_QUERY).toContain("teams(first: $first)");
    expect(WORKSPACE_INFO_QUERY).toContain("nodes { id key name }");
  });

  it("caps the team page size at a sane default", () => {
    expect(WORKSPACE_INFO_TEAM_LIMIT).toBe(250);
  });
});

// ---------------------------------------------------------------------------
// mapWorkspaceInfo
// ---------------------------------------------------------------------------

describe("mapWorkspaceInfo", () => {
  it("maps slug + team keys + team rows from a full response", () => {
    const info = mapWorkspaceInfo({
      data: {
        organization: { urlKey: "acme" },
        teams: {
          nodes: [
            { id: "t1", key: "ENG", name: "Engineering" },
            { id: "t2", key: "DES", name: "Design" },
          ],
        },
      },
    });
    expect(info).not.toBeNull();
    expect(info?.slug).toBe("acme");
    expect(info?.teamKeys).toEqual(["ENG", "DES"]);
    expect(info?.teams).toEqual([
      { id: "t1", key: "ENG", name: "Engineering" },
      { id: "t2", key: "DES", name: "Design" },
    ]);
  });

  it("uppercases and trims team keys", () => {
    const info = mapWorkspaceInfo({
      data: {
        organization: { urlKey: "acme" },
        teams: { nodes: [{ id: "t1", key: " eng ", name: "Engineering" }] },
      },
    });
    expect(info?.teamKeys).toEqual(["ENG"]);
    expect(info?.teams[0].key).toBe("ENG");
  });

  it("de-dupes repeated keys while preserving first-seen order", () => {
    const info = mapWorkspaceInfo({
      data: {
        organization: { urlKey: "acme" },
        teams: {
          nodes: [
            { id: "t1", key: "ENG", name: "Engineering" },
            { id: "t2", key: "eng", name: "Eng duplicate" },
            { id: "t3", key: "DES", name: "Design" },
          ],
        },
      },
    });
    expect(info?.teamKeys).toEqual(["ENG", "DES"]);
  });

  it("tolerates null nodes and null/empty keys (drops them)", () => {
    const info = mapWorkspaceInfo({
      data: {
        organization: { urlKey: "acme" },
        teams: {
          nodes: [
            null,
            { id: "t1", key: null, name: "No key" },
            { id: "t2", key: "  ", name: "Blank key" },
            { id: "t3", key: "OPS", name: "Operations" },
          ],
        },
      },
    });
    expect(info?.teamKeys).toEqual(["OPS"]);
    expect(info?.teams).toEqual([{ id: "t3", key: "OPS", name: "Operations" }]);
  });

  it("defaults missing urlKey to an empty slug (still non-null)", () => {
    const info = mapWorkspaceInfo({
      data: {
        organization: {},
        teams: { nodes: [{ id: "t1", key: "ENG", name: "Engineering" }] },
      },
    });
    expect(info).not.toBeNull();
    expect(info?.slug).toBe("");
    expect(info?.teamKeys).toEqual(["ENG"]);
  });

  it("defaults missing organization to an empty slug", () => {
    const info = mapWorkspaceInfo({
      data: { teams: { nodes: [{ id: "t1", key: "ENG", name: "Engineering" }] } },
    });
    expect(info?.slug).toBe("");
  });

  it("defaults missing id/name on a team row to empty strings", () => {
    const info = mapWorkspaceInfo({
      data: {
        organization: { urlKey: "acme" },
        teams: { nodes: [{ key: "ENG" }] },
      },
    });
    expect(info?.teams).toEqual([{ id: "", key: "ENG", name: "" }]);
  });

  it("returns null when GraphQL errors are present", () => {
    expect(
      mapWorkspaceInfo({
        data: { organization: { urlKey: "acme" }, teams: { nodes: [] } },
        errors: [{ message: "boom" }],
      }),
    ).toBeNull();
  });

  it("returns null when data is entirely absent", () => {
    expect(mapWorkspaceInfo({})).toBeNull();
    expect(mapWorkspaceInfo({ data: null })).toBeNull();
  });

  it("returns null for non-object / nullish input", () => {
    expect(mapWorkspaceInfo(null)).toBeNull();
    expect(mapWorkspaceInfo(undefined)).toBeNull();
    expect(mapWorkspaceInfo("not json")).toBeNull();
    expect(mapWorkspaceInfo(42)).toBeNull();
  });

  it("yields empty teamKeys (non-null) when teams connection is empty/missing", () => {
    const info = mapWorkspaceInfo({
      data: { organization: { urlKey: "acme" }, teams: { nodes: [] } },
    });
    expect(info).not.toBeNull();
    expect(info?.slug).toBe("acme");
    expect(info?.teamKeys).toEqual([]);
    expect(info?.teams).toEqual([]);

    const info2 = mapWorkspaceInfo({ data: { organization: { urlKey: "acme" } } });
    expect(info2?.teamKeys).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// resolveEffectiveTeamKeys (pure precedence)
// ---------------------------------------------------------------------------

describe("resolveEffectiveTeamKeys", () => {
  it("prefers configured team keys when non-empty (override wins)", () => {
    expect(
      resolveEffectiveTeamKeys(["PROD"], {
        slug: "acme",
        teamKeys: ["ENG", "DES"],
        teams: [],
      }),
    ).toEqual(["PROD"]);
  });

  it("falls back to detected team keys when config is empty", () => {
    expect(
      resolveEffectiveTeamKeys([], {
        slug: "acme",
        teamKeys: ["ENG", "DES"],
        teams: [],
      }),
    ).toEqual(["ENG", "DES"]);
  });

  it("returns undefined (not []) when nothing is configured or detected", () => {
    expect(resolveEffectiveTeamKeys([], null)).toBeUndefined();
  });

  it("returns undefined when detected info has an empty key set", () => {
    expect(
      resolveEffectiveTeamKeys([], { slug: "acme", teamKeys: [], teams: [] }),
    ).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// resolveEffectiveSlug (pure precedence)
// ---------------------------------------------------------------------------

describe("resolveEffectiveSlug", () => {
  it("prefers a configured slug when non-empty", () => {
    expect(
      resolveEffectiveSlug("myco", { slug: "acme", teamKeys: [], teams: [] }),
    ).toBe("myco");
  });

  it("trims a configured slug", () => {
    expect(resolveEffectiveSlug("  myco  ", null)).toBe("myco");
  });

  it("falls back to the detected slug when config is blank", () => {
    expect(
      resolveEffectiveSlug("   ", { slug: "acme", teamKeys: [], teams: [] }),
    ).toBe("acme");
  });

  it("returns empty string when neither configured nor detected", () => {
    expect(resolveEffectiveSlug("", null)).toBe("");
    expect(resolveEffectiveSlug("   ", null)).toBe("");
  });
});

// ---------------------------------------------------------------------------
// parseStoredWorkspaceInfo (defensive rehydrate)
// ---------------------------------------------------------------------------

describe("parseStoredWorkspaceInfo", () => {
  it("accepts a well-formed stored entry", () => {
    const stored = {
      slug: "acme",
      teamKeys: ["ENG"],
      teams: [{ id: "t1", key: "ENG", name: "Engineering" }],
    };
    expect(parseStoredWorkspaceInfo(stored)).toEqual(stored);
  });

  it("rejects non-object / nullish values", () => {
    expect(parseStoredWorkspaceInfo(null)).toBeNull();
    expect(parseStoredWorkspaceInfo(undefined)).toBeNull();
    expect(parseStoredWorkspaceInfo("acme")).toBeNull();
  });

  it("rejects entries missing required fields", () => {
    expect(parseStoredWorkspaceInfo({ teamKeys: [], teams: [] })).toBeNull();
    expect(parseStoredWorkspaceInfo({ slug: "acme", teams: [] })).toBeNull();
    expect(parseStoredWorkspaceInfo({ slug: "acme", teamKeys: [] })).toBeNull();
  });

  it("filters out non-string team keys", () => {
    const parsed = parseStoredWorkspaceInfo({
      slug: "acme",
      teamKeys: ["ENG", 42, null, "DES"],
      teams: [],
    });
    expect(parsed?.teamKeys).toEqual(["ENG", "DES"]);
  });

  it("filters out malformed team rows", () => {
    const parsed = parseStoredWorkspaceInfo({
      slug: "acme",
      teamKeys: ["ENG"],
      teams: [
        { id: "t1", key: "ENG", name: "Engineering" },
        { id: "t2", key: "DES" },
        null,
        "nope",
      ],
    });
    expect(parsed?.teams).toEqual([{ id: "t1", key: "ENG", name: "Engineering" }]);
  });
});
