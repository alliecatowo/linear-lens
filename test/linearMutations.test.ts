import { describe, it, expect, vi } from "vitest";
import {
  addRelationMutation,
  buildBlockerView,
  buildCreateInput,
  buildUpdateInput,
  classifyGraphqlError,
  createIssueMutation,
  fetchEditContext,
  fetchTeams,
  mapCycleNode,
  mapIssueMutationResult,
  mapLabelNode,
  mapProjectNode,
  mapTeamNode,
  mapUserNode,
  mapWorkflowStateNode,
  MutationDeps,
  PickerDeps,
  removeRelationMutation,
  runMutation,
  updateIssueMutation,
  RawEditContextNode,
} from "../src/linearMutations";
import { AuthHeader, LinearLensConfig } from "../src/types";

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

/** Minimal config with the API enabled (only the fields the module reads matter). */
function cfg(overrides: Partial<LinearLensConfig> = {}): LinearLensConfig {
  return {
    workspaceSlug: "",
    teamKeys: [],
    markers: [],
    enableDiagnostics: false,
    diagnosticSeverity: "warning",
    enableLinks: true,
    enableHover: true,
    hoverShowAvatars: true,
    hoverShowLabels: true,
    hoverShowBranchActions: true,
    enableDecorations: true,
    enableStatusBar: true,
    enableApi: true,
    cacheTtlSeconds: 300,
    enableInlineStatus: true,
    inlineStatusStyle: "dot",
    enableViews: true,
    viewsRecentLimit: 50,
    enableGutter: true,
    ...overrides,
  } as LinearLensConfig;
}

const writeAuth: AuthHeader = { value: "lin_api_xxx", kind: "apiKey" };

/** Build a fake `fetch` returning the given JSON body with status 200. */
function fakeFetch(body: unknown): typeof fetch {
  return vi.fn(async () =>
    new Response(JSON.stringify(body), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    }),
  ) as unknown as typeof fetch;
}

/** Mutation deps with a fake fetch + write auth present. */
function mutDeps(
  fetchImpl: typeof fetch,
  overrides: Partial<MutationDeps> = {},
): MutationDeps {
  return {
    getCfg: () => cfg(),
    resolveWriteAuth: async () => writeAuth,
    fetchImpl,
    ...overrides,
  };
}

/** Picker deps with a fake fetch + read auth present. */
function pickDeps(
  fetchImpl: typeof fetch,
  overrides: Partial<PickerDeps> = {},
): PickerDeps {
  return {
    getCfg: () => cfg(),
    resolveAuth: async () => writeAuth,
    fetchImpl,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Pure mappers
// ---------------------------------------------------------------------------

describe("picker node mappers", () => {
  it("mapTeamNode fills empty strings for null fields", () => {
    expect(mapTeamNode({})).toEqual({ id: "", key: "", name: "" });
    expect(mapTeamNode({ id: "t1", key: "ENG", name: "Engineering" })).toEqual({
      id: "t1",
      key: "ENG",
      name: "Engineering",
    });
  });

  it("mapWorkflowStateNode passes through type/color/position", () => {
    expect(
      mapWorkflowStateNode({
        id: "s1",
        name: "In Progress",
        type: "started",
        color: "#abc",
        position: 2.5,
      }),
    ).toEqual({
      id: "s1",
      name: "In Progress",
      type: "started",
      color: "#abc",
      position: 2.5,
    });
    expect(mapWorkflowStateNode({})).toEqual({
      id: "",
      name: "",
      type: undefined,
      color: undefined,
      position: undefined,
    });
  });

  it("mapUserNode falls back displayName -> name", () => {
    expect(mapUserNode({ id: "u1", name: "alice", active: true })).toEqual({
      id: "u1",
      name: "alice",
      displayName: "alice",
      avatarUrl: undefined,
      active: true,
    });
    expect(
      mapUserNode({ id: "u2", name: "bob", displayName: "Bob B", avatarUrl: "a.png" }),
    ).toEqual({
      id: "u2",
      name: "bob",
      displayName: "Bob B",
      avatarUrl: "a.png",
      active: undefined,
    });
  });

  it("mapLabelNode tolerates nulls", () => {
    expect(mapLabelNode({})).toEqual({ id: "", name: "", color: undefined });
    expect(mapLabelNode({ id: "l1", name: "bug", color: "#f00" })).toEqual({
      id: "l1",
      name: "bug",
      color: "#f00",
    });
  });

  it("mapProjectNode tolerates nulls", () => {
    expect(mapProjectNode({})).toEqual({ id: "", name: "", state: undefined });
  });

  it("mapCycleNode leaves name undefined when null and keeps the number for fallback", () => {
    expect(mapCycleNode({ id: "c1", number: 7 })).toEqual({
      id: "c1",
      name: undefined,
      number: 7,
      startsAt: undefined,
      endsAt: undefined,
    });
  });

  it("mapIssueMutationResult tolerates null/undefined node", () => {
    expect(mapIssueMutationResult(null)).toEqual({
      id: "",
      identifier: "",
      url: undefined,
    });
    expect(mapIssueMutationResult({ id: "x", identifier: "ENG-1", url: "u" })).toEqual({
      id: "x",
      identifier: "ENG-1",
      url: "u",
    });
  });
});

// ---------------------------------------------------------------------------
// buildBlockerView
// ---------------------------------------------------------------------------

describe("buildBlockerView", () => {
  it("splits relations (blocks) and inverseRelations (blocks) by direction", () => {
    const node: RawEditContextNode = {
      id: "uuid-self",
      identifier: "ENG-100",
      team: { id: "t1", key: "ENG", name: "Engineering" },
      state: { id: "state-1" },
      assignee: { id: "user-1" },
      project: { id: "proj-1" },
      cycle: { id: "cycle-1" },
      priority: 2,
      labels: { nodes: [{ id: "l1", name: "bug", color: "#f00" }, null] },
      relations: {
        nodes: [
          {
            id: "rel-1",
            type: "blocks",
            relatedIssue: { id: "u-200", identifier: "ENG-200", title: "Other", url: "x" },
          },
          // A non-blocks relation must be ignored.
          { id: "rel-2", type: "related", relatedIssue: { id: "u-300" } },
        ],
      },
      inverseRelations: {
        nodes: [
          {
            id: "rel-3",
            type: "blocks",
            issue: { id: "u-400", identifier: "ENG-400", title: "Blocker", url: "y" },
          },
        ],
      },
    };

    const view = buildBlockerView(node);
    expect(view.issueUuid).toBe("uuid-self");
    expect(view.identifier).toBe("ENG-100");
    expect(view.team).toEqual({ id: "t1", key: "ENG", name: "Engineering" });
    expect(view.labels).toEqual([{ id: "l1", name: "bug", color: "#f00" }]);

    // this issue blocks ENG-200
    expect(view.blocks).toHaveLength(1);
    expect(view.blocks[0]).toEqual({
      id: "rel-1",
      type: "blocks",
      relatedIssue: { id: "u-200", identifier: "ENG-200", title: "Other", url: "x" },
    });

    // ENG-400 blocks this issue
    expect(view.blockedBy).toHaveLength(1);
    expect(view.blockedBy[0].relatedIssue.identifier).toBe("ENG-400");

    // current values surfaced for pre-select
    expect(view.currentStateId).toBe("state-1");
    expect(view.currentAssigneeId).toBe("user-1");
    expect(view.currentProjectId).toBe("proj-1");
    expect(view.currentCycleId).toBe("cycle-1");
    expect(view.currentPriority).toBe(2);
  });

  it("returns empty arrays for null/empty connections and undefined current values", () => {
    const view = buildBlockerView({ id: "u", identifier: "ENG-1" });
    expect(view.blocks).toEqual([]);
    expect(view.blockedBy).toEqual([]);
    expect(view.labels).toEqual([]);
    expect(view.team).toBeUndefined();
    expect(view.currentStateId).toBeUndefined();
    expect(view.currentPriority).toBeUndefined();
  });

  it("coerces an out-of-range or float priority", () => {
    expect(buildBlockerView({ priority: 3.0 }).currentPriority).toBe(3);
    expect(buildBlockerView({ priority: 9 }).currentPriority).toBeUndefined();
    expect(buildBlockerView({ priority: 0 }).currentPriority).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// classifyGraphqlError
// ---------------------------------------------------------------------------

describe("classifyGraphqlError", () => {
  it("classifies permission errors", () => {
    expect(classifyGraphqlError([{ message: "access denied" }]).kind).toBe("permission");
    expect(
      classifyGraphqlError([
        { message: "boom", extensions: { type: "AUTHENTICATION" } },
      ]).kind,
    ).toBe("permission");
  });

  it("classifies notFound errors", () => {
    expect(classifyGraphqlError([{ message: "Entity not found" }]).kind).toBe("notFound");
  });

  it("classifies validation errors", () => {
    expect(
      classifyGraphqlError([{ message: "Variable $input got invalid value" }]).kind,
    ).toBe("validation");
    expect(classifyGraphqlError([{ message: "title is required" }]).kind).toBe(
      "validation",
    );
  });

  it("falls back to unknown and surfaces the first message", () => {
    const r = classifyGraphqlError([{ message: "something weird happened" }]);
    expect(r.kind).toBe("unknown");
    expect(r.message).toBe("something weird happened");
  });

  it("tolerates non-array / empty input", () => {
    expect(classifyGraphqlError(undefined).kind).toBe("unknown");
    expect(classifyGraphqlError([]).message).toMatch(/rejected/i);
  });
});

// ---------------------------------------------------------------------------
// runMutation (mocked fetch only)
// ---------------------------------------------------------------------------

describe("runMutation", () => {
  const select = (data: unknown) => {
    const d = data as { issueUpdate?: { success?: boolean; issue?: unknown } };
    return { value: d?.issueUpdate?.issue, success: d?.issueUpdate?.success === true };
  };

  it("returns apiDisabled without calling fetch when API is off", async () => {
    const f = vi.fn() as unknown as typeof fetch;
    const res = await runMutation(
      "Op",
      "q",
      {},
      mutDeps(f, { getCfg: () => cfg({ enableApi: false }) }),
      select,
    );
    expect(res).toEqual({
      ok: false,
      kind: "apiDisabled",
      message: expect.any(String),
    });
    expect(f).not.toHaveBeenCalled();
  });

  it("returns noAuth without calling fetch when write auth is absent", async () => {
    const f = vi.fn() as unknown as typeof fetch;
    const res = await runMutation(
      "Op",
      "q",
      {},
      mutDeps(f, { resolveWriteAuth: async () => undefined }),
      select,
    );
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.kind).toBe("noAuth");
    }
    expect(f).not.toHaveBeenCalled();
  });

  it("maps a successful issueUpdate and POSTs the right query + variables", async () => {
    const f = fakeFetch({
      data: { issueUpdate: { success: true, issue: { id: "U", identifier: "ENG-9" } } },
    });
    const res = await updateIssueMutation(
      "U",
      buildUpdateInput({ priority: 2, labelIds: ["l1", "l2"], stateId: "s1" }),
      mutDeps(f),
    );
    expect(res).toEqual({ ok: true, value: { id: "U", identifier: "ENG-9", url: undefined } });

    // Inspect the POSTed body.
    const call = (f as unknown as ReturnType<typeof vi.fn>).mock.calls[0];
    const init = call[1] as RequestInit;
    const sent = JSON.parse(init.body as string);
    expect(sent.query).toContain("issueUpdate");
    expect(sent.variables.id).toBe("U");
    // priority must be an Int, labelIds an array.
    expect(sent.variables.input.priority).toBe(2);
    expect(Array.isArray(sent.variables.input.labelIds)).toBe(true);
    expect(sent.variables.input.labelIds).toEqual(["l1", "l2"]);
    expect(sent.variables.input.stateId).toBe("s1");
    // Authorization header is the raw key value.
    expect((init.headers as Record<string, string>).Authorization).toBe("lin_api_xxx");
  });

  it("maps success:false to a validation error", async () => {
    const f = fakeFetch({ data: { issueUpdate: { success: false, issue: null } } });
    const res = await runMutation("Op", "q", {}, mutDeps(f), select);
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.kind).toBe("validation");
    }
  });

  it("maps GraphQL access-denied errors to permission", async () => {
    const f = fakeFetch({ errors: [{ message: "access denied" }] });
    const res = await runMutation("Op", "q", {}, mutDeps(f), select);
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.kind).toBe("permission");
      expect(res.message).toBe("access denied");
    }
  });

  it("returns network (and never throws) when fetch throws", async () => {
    const f = vi.fn(async () => {
      throw new Error("offline");
    }) as unknown as typeof fetch;
    const res = await runMutation("Op", "q", {}, mutDeps(f), select);
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.kind).toBe("network");
    }
  });

  it("returns network on a non-OK HTTP response", async () => {
    const f = vi.fn(async () => new Response("nope", { status: 500 })) as unknown as typeof fetch;
    const res = await runMutation("Op", "q", {}, mutDeps(f), select);
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.kind).toBe("network");
    }
  });

  it("logs the operation name + sanitized message but never the token", async () => {
    const lines: string[] = [];
    const f = fakeFetch({ errors: [{ message: "access denied" }] });
    await runMutation("IssueUpdate", "q", {}, mutDeps(f, { logDebug: (l) => lines.push(l) }), select);
    expect(lines).toContain("IssueUpdate: access denied");
    expect(lines.join("\n")).not.toContain("lin_api_xxx");
  });
});

// ---------------------------------------------------------------------------
// Mutation entry points (echo mapping)
// ---------------------------------------------------------------------------

describe("mutation entry points", () => {
  it("createIssueMutation wraps input in { input } and maps the echo", async () => {
    const f = fakeFetch({
      data: { issueCreate: { success: true, issue: { id: "N", identifier: "ENG-1", url: "u" } } },
    });
    const res = await createIssueMutation(
      buildCreateInput({ title: "Hi", teamId: "t1", assigneeId: null }),
      mutDeps(f),
    );
    expect(res).toEqual({ ok: true, value: { id: "N", identifier: "ENG-1", url: "u" } });
    const sent = JSON.parse(
      ((f as unknown as ReturnType<typeof vi.fn>).mock.calls[0][1] as RequestInit).body as string,
    );
    expect(sent.variables.input.title).toBe("Hi");
    expect(sent.variables.input.teamId).toBe("t1");
    // explicit null assignee is preserved (clears the field)
    expect(sent.variables.input.assigneeId).toBeNull();
    // description was undefined → omitted
    expect("description" in sent.variables.input).toBe(false);
  });

  it("addRelationMutation returns the relation id", async () => {
    const f = fakeFetch({
      data: { issueRelationCreate: { success: true, issueRelation: { id: "rel-9" } } },
    });
    const res = await addRelationMutation(
      { issueId: "B", relatedIssueId: "A", type: "blocks" },
      mutDeps(f),
    );
    expect(res).toEqual({ ok: true, value: { id: "rel-9" } });
  });

  it("removeRelationMutation returns an empty id on success", async () => {
    const f = fakeFetch({ data: { issueRelationDelete: { success: true } } });
    const res = await removeRelationMutation("rel-9", mutDeps(f));
    expect(res).toEqual({ ok: true, value: { id: "" } });
  });
});

// ---------------------------------------------------------------------------
// Variable builders
// ---------------------------------------------------------------------------

describe("variable builders", () => {
  it("buildUpdateInput drops undefined keys but keeps explicit null", () => {
    expect(buildUpdateInput({ stateId: "s1", assigneeId: null })).toEqual({
      stateId: "s1",
      assigneeId: null,
    });
    expect(buildUpdateInput({})).toEqual({});
  });

  it("buildCreateInput keeps required fields and drops undefined", () => {
    expect(buildCreateInput({ title: "T", teamId: "t1" })).toEqual({
      title: "T",
      teamId: "t1",
    });
  });
});

// ---------------------------------------------------------------------------
// Picker reads (mocked fetch)
// ---------------------------------------------------------------------------

describe("picker reads", () => {
  it("fetchTeams maps nodes and drops nulls", async () => {
    const f = fakeFetch({
      data: { teams: { nodes: [{ id: "t1", key: "ENG", name: "Eng" }, null] } },
    });
    const teams = await fetchTeams(pickDeps(f));
    expect(teams).toEqual([{ id: "t1", key: "ENG", name: "Eng" }]);
  });

  it("fetchTeams returns [] (never throws) on a thrown fetch", async () => {
    const f = vi.fn(async () => {
      throw new Error("offline");
    }) as unknown as typeof fetch;
    expect(await fetchTeams(pickDeps(f))).toEqual([]);
  });

  it("fetchTeams returns [] when API disabled without calling fetch", async () => {
    const f = vi.fn() as unknown as typeof fetch;
    expect(await fetchTeams(pickDeps(f, { getCfg: () => cfg({ enableApi: false }) }))).toEqual([]);
    expect(f).not.toHaveBeenCalled();
  });

  it("fetchTeams returns [] when read auth is absent", async () => {
    const f = vi.fn() as unknown as typeof fetch;
    expect(await fetchTeams(pickDeps(f, { resolveAuth: async () => undefined }))).toEqual([]);
    expect(f).not.toHaveBeenCalled();
  });

  it("fetchEditContext returns the normalized view, or null when not found", async () => {
    const node: RawEditContextNode = { id: "u", identifier: "ENG-1" };
    const ok = await fetchEditContext(
      { team: "ENG", number: 1, normalized: "ENG-1" },
      pickDeps(fakeFetch({ data: { issues: { nodes: [node] } } })),
    );
    expect(ok?.issueUuid).toBe("u");

    const miss = await fetchEditContext(
      { team: "ENG", number: 2, normalized: "ENG-2" },
      pickDeps(fakeFetch({ data: { issues: { nodes: [] } } })),
    );
    expect(miss).toBeNull();
  });
});
