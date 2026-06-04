import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  buildBatchIssuesQuery,
  chunkIds,
  classifyForSwr,
  createLinearClient,
  dedupeIds,
  mapBatchResponse,
  MAX_BATCH,
  NEGATIVE_TTL_MS,
  STORE_PREFIX,
  toMetadata,
  type BatchIssuesResponse,
  type RawBatchNode,
} from "../src/linearClient";
import type {
  AuthHeader,
  CachedEntry,
  IssueId,
  LinearLensConfig,
  MetadataStore,
} from "../src/types";

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

/** Build an {@link IssueId} from a normalized "TEAM-NUMBER" string. */
function id(normalized: string): IssueId {
  const [team, num] = normalized.split("-");
  return { team, number: Number(num), normalized };
}

/** Minimal config with the API enabled (only the fields the client reads matter). */
function cfg(overrides: Partial<LinearLensConfig> = {}): LinearLensConfig {
  return {
    enableApi: true,
    cacheTtlSeconds: 300,
    ...overrides,
  } as LinearLensConfig;
}

const auth: AuthHeader = { value: "lin_api_xxx", kind: "apiKey" };
const resolveAuth = async (): Promise<AuthHeader | undefined> => auth;

/** A minimal raw issue node the batch query would return for a given identifier. */
function node(identifier: string, title = `title ${identifier}`): RawBatchNode {
  return {
    identifier,
    title,
    url: `https://linear.app/acme/issue/${identifier}`,
    state: { name: "In Progress", type: "started", color: "#000" },
    labels: { nodes: [] },
    subscribers: { nodes: [] },
    comments: { nodes: [] },
    attachments: { nodes: [] },
  };
}

/**
 * A controllable fake `fetch` that parses the GraphQL body, returns a batch
 * `issues.nodes` response for whichever ids it recognizes, and records every call
 * (so tests can assert request count + the variables of each request).
 */
function makeFetch(known: Set<string>) {
  const calls: Array<{ query: string; variables: Record<string, unknown> }> = [];
  const fn = vi.fn(async (_url: string, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body ?? "{}")) as {
      query: string;
      variables: Record<string, unknown>;
    };
    calls.push(body);
    // Reconstruct the requested identifiers from the t0/n0… variables.
    const nodes: RawBatchNode[] = [];
    for (let i = 0; `t${i}` in body.variables; i += 1) {
      const ident = `${body.variables[`t${i}`]}-${body.variables[`n${i}`]}`;
      if (known.has(ident)) {
        nodes.push(node(ident));
      }
    }
    return new Response(JSON.stringify({ data: { issues: { nodes } } }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  });
  return { fn: fn as unknown as typeof fetch, calls, mock: fn };
}

/** A simple in-memory {@link MetadataStore} (Memento-like) for persistence tests. */
function makeStore(seed: Record<string, unknown> = {}): MetadataStore & {
  data: Map<string, unknown>;
} {
  const data = new Map<string, unknown>(Object.entries(seed));
  return {
    data,
    get<T>(key: string): T | undefined {
      return data.get(key) as T | undefined;
    },
    set(key: string, value: unknown): void {
      if (value === undefined) {
        data.delete(key);
      } else {
        data.set(key, value);
      }
    },
    keys(): readonly string[] {
      return [...data.keys()];
    },
  };
}

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

describe("buildBatchIssuesQuery", () => {
  it("parameterizes N ids into t0/n0 … t{N-1}/n{N-1}, sets first: N, emits N or-clauses", () => {
    const { query, variables } = buildBatchIssuesQuery([id("ENG-1"), id("DES-42")]);
    expect(variables).toEqual({ t0: "ENG", n0: 1, t1: "DES", n1: 42 });
    expect(query).toContain("$t0: String!");
    expect(query).toContain("$n0: Float!");
    expect(query).toContain("$t1: String!");
    expect(query).toContain("$n1: Float!");
    expect(query).toContain("first: 2");
    // Two or-clauses, parameterized (never interpolated).
    expect(query.match(/team: \{ key: \{ eq: \$t\d \} \}/g)).toHaveLength(2);
    expect(query).not.toContain("ENG"); // team key is in variables, not the string
  });

  it("caps first at ids.length for a single id", () => {
    const { query, variables } = buildBatchIssuesQuery([id("ENG-7")]);
    expect(variables).toEqual({ t0: "ENG", n0: 7 });
    expect(query).toContain("first: 1");
  });
});

describe("mapBatchResponse", () => {
  it("maps multiple nodes keyed by normalized (uppercased) id", () => {
    const json: BatchIssuesResponse = {
      data: { issues: { nodes: [node("ENG-1"), node("des-2")] } },
    };
    const map = mapBatchResponse(json);
    expect([...map.keys()].sort()).toEqual(["DES-2", "ENG-1"]);
    expect(map.get("ENG-1")?.title).toBe("title ENG-1");
  });

  it("tolerates null nodes and nodes missing an identifier", () => {
    const json = {
      data: { issues: { nodes: [null, { title: "no id" }, node("ENG-3")] } },
    } as unknown as BatchIssuesResponse;
    const map = mapBatchResponse(json);
    expect([...map.keys()]).toEqual(["ENG-3"]);
  });

  it("returns an empty map when errors are present or data is absent", () => {
    expect(mapBatchResponse({ errors: [{ message: "boom" }] }).size).toBe(0);
    expect(mapBatchResponse({ data: null }).size).toBe(0);
    expect(mapBatchResponse({} as BatchIssuesResponse).size).toBe(0);
  });
});

describe("chunkIds", () => {
  it("splits into chunks of at most MAX_BATCH", () => {
    const ids = Array.from({ length: MAX_BATCH * 2 + 3 }, (_, i) => id(`ENG-${i}`));
    const chunks = chunkIds(ids);
    expect(chunks).toHaveLength(3);
    expect(chunks[0]).toHaveLength(MAX_BATCH);
    expect(chunks[1]).toHaveLength(MAX_BATCH);
    expect(chunks[2]).toHaveLength(3);
  });

  it("returns [] for empty input", () => {
    expect(chunkIds([])).toEqual([]);
  });
});

describe("dedupeIds", () => {
  it("removes duplicate normalized ids, preserving first-seen order", () => {
    const out = dedupeIds([id("ENG-1"), id("DES-2"), id("ENG-1")]);
    expect(out.map((i) => i.normalized)).toEqual(["ENG-1", "DES-2"]);
  });
});

describe("classifyForSwr", () => {
  it("buckets ids into fresh / stale / missing against the cache + now", () => {
    const now = 1_000;
    const cache = new Map<string, CachedEntry>([
      ["ENG-1", { value: toMetadata(node("ENG-1")), expiresAt: now + 100 }], // fresh
      ["ENG-2", { value: toMetadata(node("ENG-2")), expiresAt: now - 1 }], // stale
    ]);
    const { fresh, stale, missing } = classifyForSwr(
      [id("ENG-1"), id("ENG-2"), id("ENG-3")],
      cache,
      now,
    );
    expect(fresh.map((i) => i.normalized)).toEqual(["ENG-1"]);
    expect(stale.map((i) => i.normalized)).toEqual(["ENG-2"]);
    expect(missing.map((i) => i.normalized)).toEqual(["ENG-3"]);
  });
});

// ---------------------------------------------------------------------------
// Batching
// ---------------------------------------------------------------------------

describe("fetchIssues batching", () => {
  it("fetches many ids in ONE GraphQL request", async () => {
    const { fn, calls } = makeFetch(new Set(["ENG-1", "ENG-2", "ENG-3"]));
    const client = createLinearClient(cfg, resolveAuth, resolveAuth, fn);

    const result = await client.fetchIssues([id("ENG-1"), id("ENG-2"), id("ENG-3")]);

    expect(calls).toHaveLength(1);
    expect([...result.keys()].sort()).toEqual(["ENG-1", "ENG-2", "ENG-3"]);
    expect(result.get("ENG-2")?.title).toBe("title ENG-2");
  });

  it("de-duplicates repeated ids before the request", async () => {
    const { fn, calls } = makeFetch(new Set(["ENG-1"]));
    const client = createLinearClient(cfg, resolveAuth, resolveAuth, fn);

    await client.fetchIssues([id("ENG-1"), id("ENG-1"), id("ENG-1")]);

    expect(calls).toHaveLength(1);
    expect(calls[0].variables).toEqual({ t0: "ENG", n0: 1 });
  });

  it("chunks more than MAX_BATCH ids into multiple bounded requests", async () => {
    const idents = Array.from({ length: MAX_BATCH + 5 }, (_, i) => `ENG-${i}`);
    const { fn, calls } = makeFetch(new Set(idents));
    const client = createLinearClient(cfg, resolveAuth, resolveAuth, fn);

    const result = await client.fetchIssues(idents.map(id));

    expect(calls).toHaveLength(2);
    expect(result.size).toBe(MAX_BATCH + 5);
  });

  it("serves a second fetch from cache without another request", async () => {
    const { fn, calls } = makeFetch(new Set(["ENG-1"]));
    const client = createLinearClient(cfg, resolveAuth, resolveAuth, fn);

    await client.fetchIssues([id("ENG-1")]);
    const second = await client.fetchIssues([id("ENG-1")]);

    expect(calls).toHaveLength(1); // cache hit, no second request
    expect(second.get("ENG-1")?.title).toBe("title ENG-1");
  });

  it("returns an empty map when the API is disabled or auth is absent", async () => {
    const { fn, calls } = makeFetch(new Set(["ENG-1"]));
    const disabled = createLinearClient(
      () => cfg({ enableApi: false }),
      resolveAuth,
      resolveAuth,
      fn,
    );
    expect((await disabled.fetchIssues([id("ENG-1")])).size).toBe(0);

    const noAuth = createLinearClient(cfg, async () => undefined, undefined, fn);
    expect((await noAuth.fetchIssues([id("ENG-1")])).size).toBe(0);
    expect(calls).toHaveLength(0);
  });
});

describe("fetchIssue delegates to the batch path", () => {
  it("returns the single mapped issue and caches it", async () => {
    const { fn, calls } = makeFetch(new Set(["ENG-9"]));
    const client = createLinearClient(cfg, resolveAuth, resolveAuth, fn);

    const meta = await client.fetchIssue(id("ENG-9"));
    expect(meta?.id).toBe("ENG-9");
    expect(client.peekIssue(id("ENG-9"))?.title).toBe("title ENG-9");
    await client.fetchIssue(id("ENG-9"));
    expect(calls).toHaveLength(1);
  });

  it("caches a negative lookup with the short TTL and returns null", async () => {
    const { fn } = makeFetch(new Set()); // resolves no ids
    const client = createLinearClient(cfg, resolveAuth, resolveAuth, fn);

    expect(await client.fetchIssue(id("XYZ-9999"))).toBeNull();
    // Negative lookup is cached: peek returns null (no positive value).
    expect(client.peekIssue(id("XYZ-9999"))).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// In-flight dedupe
// ---------------------------------------------------------------------------

describe("in-flight dedupe", () => {
  it("coalesces concurrent fetches of the same id into ONE request", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const slow = vi.fn(async (_url: string, init?: RequestInit) => {
      await gate;
      const body = JSON.parse(String(init?.body ?? "{}")) as {
        variables: Record<string, unknown>;
      };
      const ident = `${body.variables.t0}-${body.variables.n0}`;
      return new Response(JSON.stringify({ data: { issues: { nodes: [node(ident)] } } }), {
        status: 200,
      });
    });
    const client = createLinearClient(cfg, resolveAuth, resolveAuth, slow as unknown as typeof fetch);

    const a = client.fetchIssue(id("ENG-1"));
    const b = client.fetchIssue(id("ENG-1"));
    const c = client.fetchIssues([id("ENG-1")]);
    release();
    const [ra, rb, rc] = await Promise.all([a, b, c]);

    expect(slow).toHaveBeenCalledTimes(1); // all three coalesced
    expect(ra?.id).toBe("ENG-1");
    expect(rb?.id).toBe("ENG-1");
    expect(rc.get("ENG-1")?.id).toBe("ENG-1");
  });

  it("coalesces overlapping id sets across concurrent batch fetches", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const known = new Set(["ENG-1", "ENG-2", "ENG-3"]);
    const slow = vi.fn(async (_url: string, init?: RequestInit) => {
      await gate;
      const body = JSON.parse(String(init?.body ?? "{}")) as {
        variables: Record<string, unknown>;
      };
      const nodes: RawBatchNode[] = [];
      for (let i = 0; `t${i}` in body.variables; i += 1) {
        const ident = `${body.variables[`t${i}`]}-${body.variables[`n${i}`]}`;
        if (known.has(ident)) nodes.push(node(ident));
      }
      return new Response(JSON.stringify({ data: { issues: { nodes } } }), { status: 200 });
    });
    const client = createLinearClient(cfg, resolveAuth, resolveAuth, slow as unknown as typeof fetch);

    const first = client.fetchIssues([id("ENG-1"), id("ENG-2")]);
    const second = client.fetchIssues([id("ENG-2"), id("ENG-3")]); // ENG-2 overlaps
    release();
    const [r1, r2] = await Promise.all([first, second]);

    // ENG-2 was in-flight from the first call → the second batch only requests ENG-3.
    expect(slow).toHaveBeenCalledTimes(2);
    expect(r1.get("ENG-2")?.id).toBe("ENG-2");
    expect(r2.get("ENG-2")?.id).toBe("ENG-2"); // coalesced from the first request
    expect(r2.get("ENG-3")?.id).toBe("ENG-3");
  });
});

// ---------------------------------------------------------------------------
// Stale-while-revalidate (SWR)
// ---------------------------------------------------------------------------

describe("stale-while-revalidate", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("peekIssue returns a STALE value (never deletes on expiry)", async () => {
    const { fn } = makeFetch(new Set(["ENG-1"]));
    const client = createLinearClient(
      () => cfg({ cacheTtlSeconds: 1 }),
      resolveAuth,
      resolveAuth,
      fn,
    );

    await client.fetchIssue(id("ENG-1"));
    vi.advanceTimersByTime(5_000); // entry is now well past its 1s TTL
    // SWR: the stale value is still painted instantly by peekIssue.
    expect(client.peekIssue(id("ENG-1"))?.title).toBe("title ENG-1");
  });

  it("fetchIssue returns the stale value immediately AND refreshes in the background", async () => {
    const known = new Set(["ENG-1"]);
    let version = 1;
    const fn = vi.fn(async (_url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body ?? "{}")) as {
        variables: Record<string, unknown>;
      };
      const ident = `${body.variables.t0}-${body.variables.n0}`;
      const nodes = known.has(ident) ? [node(ident, `title v${version}`)] : [];
      return new Response(JSON.stringify({ data: { issues: { nodes } } }), { status: 200 });
    }) as unknown as typeof fetch;

    const client = createLinearClient(
      () => cfg({ cacheTtlSeconds: 1 }),
      resolveAuth,
      resolveAuth,
      fn,
    );

    const first = await client.fetchIssue(id("ENG-1"));
    expect(first?.title).toBe("title v1");
    expect(fn).toHaveBeenCalledTimes(1);

    version = 2;
    vi.advanceTimersByTime(5_000); // entry is stale

    // SWR: returns the STALE v1 immediately and fires a background refresh.
    const stale = await client.fetchIssue(id("ENG-1"));
    expect(stale?.title).toBe("title v1");

    // Drain the fire-and-forget background refresh.
    await vi.runAllTimersAsync();
    expect(fn).toHaveBeenCalledTimes(2);
    // The background refresh wrote v2 through to the cache.
    expect(client.peekIssue(id("ENG-1"))?.title).toBe("title v2");
  });
});

// ---------------------------------------------------------------------------
// Negative-lookup TTL
// ---------------------------------------------------------------------------

describe("negative lookup TTL", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("re-fetches a missing id after NEGATIVE_TTL_MS but not before", async () => {
    const known = new Set<string>();
    const { fn, calls } = makeFetch(known);
    const client = createLinearClient(
      () => cfg({ cacheTtlSeconds: 3600 }),
      resolveAuth,
      resolveAuth,
      fn,
    );

    expect(await client.fetchIssue(id("ENG-404"))).toBeNull();
    expect(calls).toHaveLength(1);

    // Within the negative TTL: still cached, no new request.
    vi.advanceTimersByTime(NEGATIVE_TTL_MS - 1_000);
    expect(await client.fetchIssue(id("ENG-404"))).toBeNull();
    expect(calls).toHaveLength(1);

    // Past the negative TTL: the entry is stale → SWR refetches in the background.
    known.add("ENG-404");
    vi.advanceTimersByTime(2_000);
    await client.fetchIssue(id("ENG-404"));
    await vi.runAllTimersAsync();
    expect(calls.length).toBeGreaterThanOrEqual(2);
  });
});

// ---------------------------------------------------------------------------
// Prefetch
// ---------------------------------------------------------------------------

describe("prefetch", () => {
  it("warms the cache so a later peek/fetch needs no network", async () => {
    const { fn, calls } = makeFetch(new Set(["ENG-1", "ENG-2"]));
    const client = createLinearClient(cfg, resolveAuth, resolveAuth, fn);

    await client.prefetch([id("ENG-1"), id("ENG-2")]);
    expect(calls).toHaveLength(1);
    expect(client.peekIssue(id("ENG-1"))?.id).toBe("ENG-1");

    // Already-fresh ids are skipped (no new request).
    await client.prefetch([id("ENG-1"), id("ENG-2")]);
    expect(calls).toHaveLength(1);
  });

  it("no-ops when api disabled / no auth / empty input (never throws)", async () => {
    const { fn, calls } = makeFetch(new Set(["ENG-1"]));
    await createLinearClient(() => cfg({ enableApi: false }), resolveAuth, resolveAuth, fn).prefetch([
      id("ENG-1"),
    ]);
    await createLinearClient(cfg, async () => undefined, undefined, fn).prefetch([id("ENG-1")]);
    await createLinearClient(cfg, resolveAuth, resolveAuth, fn).prefetch([]);
    expect(calls).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Persistence (Memento-like store)
// ---------------------------------------------------------------------------

describe("persistence", () => {
  it("rehydrates the cache from the store on construction (survives reload)", async () => {
    const store = makeStore({
      [STORE_PREFIX + "ENG-1"]: {
        value: toMetadata(node("ENG-1", "persisted")),
        expiresAt: Date.now() + 60_000,
      } satisfies CachedEntry,
      // An unrelated key must be ignored.
      "some.other.key": 42,
    });
    const { fn, calls } = makeFetch(new Set(["ENG-1"]));
    const client = createLinearClient(cfg, resolveAuth, resolveAuth, fn, undefined, store);

    // peek returns the rehydrated value with no network at all.
    expect(client.peekIssue(id("ENG-1"))?.title).toBe("persisted");
    // fetch is served from the rehydrated (fresh) cache → no request.
    expect((await client.fetchIssue(id("ENG-1")))?.title).toBe("persisted");
    expect(calls).toHaveLength(0);
  });

  it("writes positive entries through to the store; never persists negatives", async () => {
    const store = makeStore();
    const { fn } = makeFetch(new Set(["ENG-1"])); // ENG-1 resolves, ENG-2 does not
    const client = createLinearClient(cfg, resolveAuth, resolveAuth, fn, undefined, store);

    await client.fetchIssues([id("ENG-1"), id("ENG-2")]);

    const keys = [...store.data.keys()];
    expect(keys).toContain(STORE_PREFIX + "ENG-1");
    expect(keys).not.toContain(STORE_PREFIX + "ENG-2"); // negative lookup not persisted
    const persisted = store.data.get(STORE_PREFIX + "ENG-1") as CachedEntry;
    expect(persisted.value?.title).toBe("title ENG-1");
  });

  it("clearCache removes every namespaced key from the store", async () => {
    const store = makeStore();
    const { fn } = makeFetch(new Set(["ENG-1"]));
    const client = createLinearClient(cfg, resolveAuth, resolveAuth, fn, undefined, store);

    await client.fetchIssue(id("ENG-1"));
    expect([...store.data.keys()]).toContain(STORE_PREFIX + "ENG-1");

    client.clearCache();
    expect([...store.data.keys()].some((k) => k.startsWith(STORE_PREFIX))).toBe(false);
    expect(client.peekIssue(id("ENG-1"))).toBeNull();
  });

  it("drops store entries with an invalid shape on rehydrate (never throws)", () => {
    const store = makeStore({
      [STORE_PREFIX + "BAD-1"]: { value: null }, // missing expiresAt → invalid
      [STORE_PREFIX + "BAD-2"]: "not an object",
    });
    const { fn } = makeFetch(new Set());
    const client = createLinearClient(cfg, resolveAuth, resolveAuth, fn, undefined, store);
    expect(client.peekIssue(id("BAD-1"))).toBeNull();
    expect(client.peekIssue(id("BAD-2"))).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Activity sink + never-throw guarantees
// ---------------------------------------------------------------------------

describe("activity sink + resilience", () => {
  it("reports in-flight count up then back to 0", async () => {
    const { fn } = makeFetch(new Set(["ENG-1"]));
    const counts: number[] = [];
    const client = createLinearClient(
      cfg,
      resolveAuth,
      resolveAuth,
      fn,
      undefined,
      undefined,
      (n) => counts.push(n),
    );

    await client.fetchIssue(id("ENG-1"));
    expect(Math.max(...counts)).toBeGreaterThanOrEqual(1);
    expect(counts[counts.length - 1]).toBe(0); // settles to idle
  });

  it("never throws when fetch rejects; resolves with an empty/partial result", async () => {
    const boom = vi.fn(async () => {
      throw new Error("network down");
    }) as unknown as typeof fetch;
    const client = createLinearClient(cfg, resolveAuth, resolveAuth, boom);

    await expect(client.fetchIssues([id("ENG-1")])).resolves.toEqual(new Map());
    await expect(client.fetchIssue(id("ENG-1"))).resolves.toBeNull();
    await expect(client.prefetch([id("ENG-1")])).resolves.toBeUndefined();
  });

  it("never throws when the response JSON is malformed", async () => {
    const bad = vi.fn(async () => new Response("not json", { status: 200 })) as unknown as typeof fetch;
    const client = createLinearClient(cfg, resolveAuth, resolveAuth, bad);
    await expect(client.fetchIssue(id("ENG-1"))).resolves.toBeNull();
  });
});
