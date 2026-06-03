import { describe, it, expect } from "vitest";
import { scanText, parseIssueId, issueIdFromBranch } from "../src/parser";
import type { IssueRef } from "../src/types";

/**
 * Helpers
 */

/** Assert that a ref's offsets actually slice back to its `raw` substring. */
function expectOffsetsMatchRaw(text: string, ref: IssueRef): void {
  expect(text.slice(ref.start, ref.end)).toBe(ref.raw);
}

/** Convenience: scan and return only refs, with a default empty options. */
function scan(text: string, teamKeys?: string[]): IssueRef[] {
  return teamKeys ? scanText(text, { teamKeys }) : scanText(text);
}

describe("parseIssueId", () => {
  it("parses an uppercase token", () => {
    const id = parseIssueId("ENG-123");
    expect(id).toEqual({ team: "ENG", number: 123, normalized: "ENG-123" });
  });

  it("normalizes a lowercase token to uppercase team", () => {
    const id = parseIssueId("eng-123");
    expect(id).toEqual({ team: "ENG", number: 123, normalized: "ENG-123" });
  });

  it("normalizes a mixed-case token", () => {
    const id = parseIssueId("EnG-123");
    expect(id).toEqual({ team: "ENG", number: 123, normalized: "ENG-123" });
  });

  it("tolerates surrounding whitespace", () => {
    expect(parseIssueId("  eng-123  ")).toEqual({
      team: "ENG",
      number: 123,
      normalized: "ENG-123",
    });
  });

  it("parses a single-digit number", () => {
    expect(parseIssueId("ENG-9")).toEqual({
      team: "ENG",
      number: 9,
      normalized: "ENG-9",
    });
  });

  it("parses a number with no leading-zero requirement", () => {
    expect(parseIssueId("ABC-007")).toEqual({
      team: "ABC",
      number: 7,
      normalized: "ABC-7",
    });
  });

  it("returns null for non-id input", () => {
    expect(parseIssueId("not an id")).toBeNull();
    expect(parseIssueId("")).toBeNull();
    expect(parseIssueId("123")).toBeNull();
    expect(parseIssueId("ENG")).toBeNull();
  });

  it("returns null for a single-letter key (below 2-letter minimum)", () => {
    expect(parseIssueId("A-1")).toBeNull();
  });

  it("returns null for an 8-letter key (above 7-letter maximum)", () => {
    expect(parseIssueId("ABCDEFGH-1")).toBeNull();
  });

  it("accepts the 2-letter and 7-letter key boundaries", () => {
    expect(parseIssueId("AB-1")).toEqual({
      team: "AB",
      number: 1,
      normalized: "AB-1",
    });
    expect(parseIssueId("ABCDEFG-1")).toEqual({
      team: "ABCDEFG",
      number: 1,
      normalized: "ABCDEFG-1",
    });
  });

  it("respects the teamKeys allowlist (case-insensitive)", () => {
    expect(parseIssueId("eng-123", { teamKeys: ["ENG"] })).toEqual({
      team: "ENG",
      number: 123,
      normalized: "ENG-123",
    });
    expect(parseIssueId("ENG-123", { teamKeys: ["eng"] })).toEqual({
      team: "ENG",
      number: 123,
      normalized: "ENG-123",
    });
  });

  it("returns null for a token not in the teamKeys allowlist", () => {
    expect(parseIssueId("abc-9", { teamKeys: ["ENG"] })).toBeNull();
  });
});

describe("scanText — bare ids and casing (raw, never todo)", () => {
  it("detects a bare uppercase id as raw", () => {
    const text = "ENG-123";
    const refs = scan(text);
    expect(refs).toHaveLength(1);
    expect(refs[0].kind).toBe("raw");
    expect(refs[0].kind).not.toBe("todo");
    expect(refs[0].marker).toBeUndefined();
    expect(refs[0].issue).toEqual({
      team: "ENG",
      number: 123,
      normalized: "ENG-123",
    });
    expect(refs[0].raw).toBe("ENG-123");
    expectOffsetsMatchRaw(text, refs[0]);
  });

  it("detects a lowercase id, normalizes the issue but preserves raw casing", () => {
    const text = "eng-123";
    const refs = scan(text);
    expect(refs).toHaveLength(1);
    expect(refs[0].kind).toBe("raw");
    expect(refs[0].raw).toBe("eng-123");
    expect(refs[0].issue.normalized).toBe("ENG-123");
    expect(refs[0].issue.team).toBe("ENG");
    expectOffsetsMatchRaw(text, refs[0]);
  });

  it('"Fixed in ENG-123" is raw and MUST NOT be a todo (no diagnostic)', () => {
    const text = "Fixed in ENG-123";
    const refs = scan(text);
    expect(refs).toHaveLength(1);
    expect(refs[0].kind).toBe("raw");
    expect(refs[0].kind).not.toBe("todo");
    expect(refs[0].marker).toBeUndefined();
    expect(refs[0].issue.normalized).toBe("ENG-123");
    expect(refs[0].raw).toBe("ENG-123");
    expectOffsetsMatchRaw(text, refs[0]);
  });
});

describe("scanText — TODO/FIXME/BUG/HACK markers", () => {
  it('"TODO: ENG-123 fix retry logic" => todo(TODO)', () => {
    const text = "TODO: ENG-123 fix retry logic";
    const refs = scan(text);
    expect(refs).toHaveLength(1);
    expect(refs[0].kind).toBe("todo");
    expect(refs[0].marker).toBe("TODO");
    expect(refs[0].issue.normalized).toBe("ENG-123");
    expectOffsetsMatchRaw(text, refs[0]);
  });

  it('"TODO ENG-123: fix retry logic" => todo(TODO)', () => {
    const text = "TODO ENG-123: fix retry logic";
    const refs = scan(text);
    expect(refs).toHaveLength(1);
    expect(refs[0].kind).toBe("todo");
    expect(refs[0].marker).toBe("TODO");
    expect(refs[0].issue.normalized).toBe("ENG-123");
    expectOffsetsMatchRaw(text, refs[0]);
  });

  it('"TODO: fix retry logic in ENG-123" => todo(TODO) even when id is after the keyword', () => {
    const text = "TODO: fix retry logic in ENG-123";
    const refs = scan(text);
    expect(refs).toHaveLength(1);
    expect(refs[0].kind).toBe("todo");
    expect(refs[0].marker).toBe("TODO");
    expect(refs[0].issue.normalized).toBe("ENG-123");
    expectOffsetsMatchRaw(text, refs[0]);
  });

  it('"FIXME ENG-124 handle null user" => todo(FIXME)', () => {
    const text = "FIXME ENG-124 handle null user";
    const refs = scan(text);
    expect(refs).toHaveLength(1);
    expect(refs[0].kind).toBe("todo");
    expect(refs[0].marker).toBe("FIXME");
    expect(refs[0].issue.normalized).toBe("ENG-124");
    expectOffsetsMatchRaw(text, refs[0]);
  });

  it('"// BUG ENG-9 leaks memory" => todo(BUG)', () => {
    const text = "// BUG ENG-9 leaks memory";
    const refs = scan(text);
    expect(refs).toHaveLength(1);
    expect(refs[0].kind).toBe("todo");
    expect(refs[0].marker).toBe("BUG");
    expect(refs[0].issue).toEqual({
      team: "ENG",
      number: 9,
      normalized: "ENG-9",
    });
    expectOffsetsMatchRaw(text, refs[0]);
  });

  it('"# HACK ABC-1 workaround" => todo(HACK)', () => {
    const text = "# HACK ABC-1 workaround";
    const refs = scan(text);
    expect(refs).toHaveLength(1);
    expect(refs[0].kind).toBe("todo");
    expect(refs[0].marker).toBe("HACK");
    expect(refs[0].issue.normalized).toBe("ABC-1");
    expectOffsetsMatchRaw(text, refs[0]);
  });

  it("matches markers case-insensitively but normalizes the marker to UPPERCASE", () => {
    const text = "todo ENG-1";
    const refs = scan(text);
    expect(refs).toHaveLength(1);
    expect(refs[0].kind).toBe("todo");
    expect(refs[0].marker).toBe("TODO");
  });

  it("does NOT treat substrings like 'debug' or 'hackathon' as markers (word boundaries)", () => {
    const debugText = "Running debug ENG-1 now";
    const debugRefs = scan(debugText);
    expect(debugRefs).toHaveLength(1);
    expect(debugRefs[0].kind).toBe("raw");
    expect(debugRefs[0].marker).toBeUndefined();

    const hackText = "hackathon project ENG-2";
    const hackRefs = scan(hackText);
    expect(hackRefs).toHaveLength(1);
    expect(hackRefs[0].kind).toBe("raw");
    expect(hackRefs[0].marker).toBeUndefined();
  });

  it("records the FIRST matched keyword as the marker when multiple appear", () => {
    const text = "TODO and FIXME ENG-5";
    const refs = scan(text);
    expect(refs).toHaveLength(1);
    expect(refs[0].kind).toBe("todo");
    expect(refs[0].marker).toBe("TODO");
  });

  it("makes ALL ids on an actionable line todo", () => {
    const text = "TODO ENG-1 and ENG-2 both";
    const refs = scan(text);
    expect(refs).toHaveLength(2);
    expect(refs.every((r) => r.kind === "todo")).toBe(true);
    expect(refs.every((r) => r.marker === "TODO")).toBe(true);
    expect(refs.map((r) => r.issue.normalized)).toEqual(["ENG-1", "ENG-2"]);
  });
});

describe("scanText — markdown checkbox actionability", () => {
  it('unchecked "- [ ] ENG-123: fix auth redirect" => todo with undefined marker', () => {
    const text = "- [ ] ENG-123: fix auth redirect";
    const refs = scan(text);
    expect(refs).toHaveLength(1);
    expect(refs[0].kind).toBe("todo");
    expect(refs[0].marker).toBeUndefined();
    expect(refs[0].issue.normalized).toBe("ENG-123");
    expectOffsetsMatchRaw(text, refs[0]);
  });

  it('checked "- [x] ENG-200 done" => raw (not actionable)', () => {
    const text = "- [x] ENG-200 done";
    const refs = scan(text);
    expect(refs).toHaveLength(1);
    expect(refs[0].kind).toBe("raw");
    expect(refs[0].kind).not.toBe("todo");
    expect(refs[0].marker).toBeUndefined();
    expect(refs[0].issue.normalized).toBe("ENG-200");
    expectOffsetsMatchRaw(text, refs[0]);
  });

  it('checked "- [X] ENG-201 done" (uppercase X) => raw', () => {
    const text = "- [X] ENG-201 done";
    const refs = scan(text);
    expect(refs).toHaveLength(1);
    expect(refs[0].kind).toBe("raw");
    expect(refs[0].issue.normalized).toBe("ENG-201");
  });

  it("recognizes other bullet markers (* and +) for unchecked boxes", () => {
    for (const bullet of ["*", "+"]) {
      const text = `${bullet} [ ] ENG-3 task`;
      const refs = scan(text);
      expect(refs).toHaveLength(1);
      expect(refs[0].kind).toBe("todo");
      expect(refs[0].marker).toBeUndefined();
    }
  });

  it("recognizes an indented unchecked box", () => {
    const text = "    - [ ] ENG-4 nested task";
    const refs = scan(text);
    expect(refs).toHaveLength(1);
    expect(refs[0].kind).toBe("todo");
    expect(refs[0].marker).toBeUndefined();
  });
});

describe("scanText — URL detection (kind url)", () => {
  it("detects a full linear.app issue URL with slug text", () => {
    const text = "See https://linear.app/acme/issue/ENG-123/fix-auth";
    const refs = scan(text);
    expect(refs).toHaveLength(1);
    expect(refs[0].kind).toBe("url");
    expect(refs[0].issue.normalized).toBe("ENG-123");
    expect(refs[0].url).toBe("https://linear.app/acme/issue/ENG-123/fix-auth");
    expect(refs[0].raw).toBe("https://linear.app/acme/issue/ENG-123/fix-auth");
    expectOffsetsMatchRaw(text, refs[0]);
  });

  it("detects a URL without the trailing slug segment", () => {
    const text = "https://linear.app/acme/issue/ENG-123";
    const refs = scan(text);
    expect(refs).toHaveLength(1);
    expect(refs[0].kind).toBe("url");
    expect(refs[0].url).toBe("https://linear.app/acme/issue/ENG-123");
    expectOffsetsMatchRaw(text, refs[0]);
  });

  it("detects an http (non-https) URL", () => {
    const text = "http://linear.app/acme/issue/ABC-7";
    const refs = scan(text);
    expect(refs).toHaveLength(1);
    expect(refs[0].kind).toBe("url");
    expect(refs[0].issue.normalized).toBe("ABC-7");
  });

  it("covers the WHOLE url with start/end, not just the id segment", () => {
    const text = "x https://linear.app/acme/issue/ENG-123/fix-auth y";
    const refs = scan(text);
    expect(refs).toHaveLength(1);
    const ref = refs[0];
    expect(ref.start).toBe(text.indexOf("https://"));
    expect(ref.end).toBe(
      text.indexOf("https://") + "https://linear.app/acme/issue/ENG-123/fix-auth".length,
    );
    expectOffsetsMatchRaw(text, ref);
  });

  it("does NOT also emit a bare-id ref for the id inside a URL", () => {
    const text = "https://linear.app/acme/issue/ENG-123/fix-auth";
    const refs = scan(text);
    expect(refs).toHaveLength(1);
    expect(refs[0].kind).toBe("url");
  });

  it("URLs are not subject to the teamKeys allowlist (authoritative)", () => {
    const text = "https://linear.app/acme/issue/ABC-9";
    const refs = scan(text, ["ENG"]);
    expect(refs).toHaveLength(1);
    expect(refs[0].kind).toBe("url");
    expect(refs[0].issue.normalized).toBe("ABC-9");
  });

  it("emits a URL as url kind even on an actionable line", () => {
    const text = "TODO see https://linear.app/acme/issue/ENG-123";
    const refs = scan(text);
    expect(refs).toHaveLength(1);
    expect(refs[0].kind).toBe("url");
  });
});

describe("scanText — offsets and document order", () => {
  it("produces offsets that slice back to raw across multiple lines", () => {
    const text = [
      "First line ENG-1 here",
      "TODO ENG-2 second line",
      "See https://linear.app/acme/issue/ENG-3/x",
    ].join("\n");
    const refs = scan(text);
    expect(refs).toHaveLength(3);
    for (const ref of refs) {
      expectOffsetsMatchRaw(text, ref);
    }
  });

  it("keeps global offsets correct after newlines (per-line base offset)", () => {
    const text = "line one\nTODO ENG-42 here";
    const refs = scan(text);
    expect(refs).toHaveLength(1);
    expect(refs[0].issue.normalized).toBe("ENG-42");
    expect(text.slice(refs[0].start, refs[0].end)).toBe("ENG-42");
    // Offset must be in the second line, after the newline.
    expect(refs[0].start).toBeGreaterThan(text.indexOf("\n"));
  });

  it("emits refs sorted by start offset", () => {
    const text = "ENG-1 ENG-2 ENG-3";
    const refs = scan(text);
    const starts = refs.map((r) => r.start);
    expect(starts).toEqual([...starts].sort((a, b) => a - b));
    expect(refs.map((r) => r.issue.normalized)).toEqual(["ENG-1", "ENG-2", "ENG-3"]);
  });

  it("returns an empty array for text with no references", () => {
    expect(scan("just some prose with no ids")).toEqual([]);
    expect(scan("")).toEqual([]);
  });
});

describe("scanText — token boundary rules", () => {
  it("matches ENG-123 within ENG-123-foo (trailing dash is allowed)", () => {
    const text = "branch ENG-123-foo done";
    const refs = scan(text);
    expect(refs).toHaveLength(1);
    expect(refs[0].issue.normalized).toBe("ENG-123");
    expect(refs[0].raw).toBe("ENG-123");
    expectOffsetsMatchRaw(text, refs[0]);
  });

  it("does NOT match when immediately followed by a letter or digit", () => {
    expect(scan("ENG-123abc")).toEqual([]);
    expect(scan("ENG-1234567")).toEqual([]); // 7 digits exceeds 1-6 -> not a clean token
  });

  it("does NOT match when immediately preceded by a non-letter identifier char", () => {
    // `_` and a digit cannot be part of a team key, and the lookbehind blocks a
    // token that abuts one, so these are not recognized.
    expect(scan("_ENG-123")).toEqual([]);
    expect(scan("9ENG-123")).toEqual([]);
  });

  it("treats a leading letter as part of the team key (zero-config grammar)", () => {
    // Without a teamKeys allowlist, the key is any 2–7 letters, so "xENG-123"
    // parses as the 4-letter key XENG — there is no way to tell the `x` was not
    // intended as part of the team. A configured `teamKeys: ["ENG"]` rejects it.
    expect(scan("xENG-123").map((r) => r.issue.normalized)).toEqual(["XENG-123"]);
    expect(scanText("xENG-123", { teamKeys: ["ENG"] })).toEqual([]);
  });

  it("does NOT match when immediately followed by an underscore", () => {
    expect(scan("ENG-123_foo")).toEqual([]);
  });

  it("matches an id surrounded by punctuation/parentheses", () => {
    const text = "(ENG-5)";
    const refs = scan(text);
    expect(refs).toHaveLength(1);
    expect(refs[0].issue.normalized).toBe("ENG-5");
    expectOffsetsMatchRaw(text, refs[0]);
  });
});

describe("scanText — teamKeys allowlist", () => {
  it('"ENG-123 and ABC-9" with teamKeys ["ENG"] detects only ENG-123', () => {
    const text = "ENG-123 and ABC-9";
    const refs = scan(text, ["ENG"]);
    expect(refs).toHaveLength(1);
    expect(refs[0].issue.normalized).toBe("ENG-123");
  });

  it('"abc-9" with teamKeys ["ENG"] detects nothing', () => {
    const refs = scan("abc-9", ["ENG"]);
    expect(refs).toEqual([]);
  });

  it("compares teamKeys case-insensitively", () => {
    const refs = scan("eng-1", ["eng"]);
    expect(refs).toHaveLength(1);
    expect(refs[0].issue.normalized).toBe("ENG-1");
  });

  it("with empty teamKeys, any 2-7 letter key matches (documented false positives)", () => {
    // `debug-1` IS a token => DEBUG-1 raw. Acceptable w/o allowlist.
    const text = "let x = debug-1;";
    const refs = scan(text);
    expect(refs).toHaveLength(1);
    expect(refs[0].kind).toBe("raw");
    expect(refs[0].issue.normalized).toBe("DEBUG-1");
    expect(refs[0].raw).toBe("debug-1");
    expectOffsetsMatchRaw(text, refs[0]);
  });

  it("setting a teamKeys allowlist removes the false positive", () => {
    const refs = scan("let x = debug-1;", ["ENG"]);
    expect(refs).toEqual([]);
  });

  it("treats an empty teamKeys array as zero-config (matches any key)", () => {
    const refs = scanText("ABC-9", { teamKeys: [] });
    expect(refs).toHaveLength(1);
    expect(refs[0].issue.normalized).toBe("ABC-9");
  });
});

describe("issueIdFromBranch", () => {
  it('"allie/eng-123-auth-redirect" => ENG-123', () => {
    expect(issueIdFromBranch("allie/eng-123-auth-redirect")).toEqual({
      team: "ENG",
      number: 123,
      normalized: "ENG-123",
    });
  });

  it('"eng-124" => ENG-124', () => {
    expect(issueIdFromBranch("eng-124")).toEqual({
      team: "ENG",
      number: 124,
      normalized: "ENG-124",
    });
  });

  it('"main" => null', () => {
    expect(issueIdFromBranch("main")).toBeNull();
  });

  it('"feature/no-ticket" => null', () => {
    expect(issueIdFromBranch("feature/no-ticket")).toBeNull();
  });

  it("returns the FIRST id when several appear", () => {
    expect(issueIdFromBranch("eng-1-then-abc-2")).toEqual({
      team: "ENG",
      number: 1,
      normalized: "ENG-1",
    });
  });

  it("respects the teamKeys allowlist", () => {
    expect(
      issueIdFromBranch("allie/abc-9-thing", { teamKeys: ["ENG"] }),
    ).toBeNull();
    expect(
      issueIdFromBranch("allie/eng-9-thing", { teamKeys: ["ENG"] }),
    ).toEqual({ team: "ENG", number: 9, normalized: "ENG-9" });
  });

  it("returns null for an empty branch string", () => {
    expect(issueIdFromBranch("")).toBeNull();
  });
});
