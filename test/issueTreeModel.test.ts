import { describe, it, expect } from "vitest";
import { buildFileRefNodes, lineOf } from "../src/views/issueTreeModel";
import { scanText } from "../src/parser";
import type { IssueRef } from "../src/types";

/**
 * Build a 0-based line-text accessor over `text` (split on "\n"), matching how
 * the provider's `document.lineAt(line).text` behaves.
 */
function lineAtFor(text: string): (line: number) => string {
  const lines = text.split("\n");
  return (line) => lines[line] ?? "";
}

/** Map each ref to its 0-based line using the pure `lineOf` helper. */
function lineOfFor(text: string): (ref: IssueRef) => number {
  return (ref) => lineOf(text, ref.start);
}

describe("lineOf", () => {
  it("returns line 0 for an offset on the first line", () => {
    expect(lineOf("ENG-1 here", 0)).toBe(0);
    expect(lineOf("ENG-1 here", 5)).toBe(0);
  });

  it("counts newlines strictly before the offset", () => {
    const text = "a\nb\nc";
    expect(lineOf(text, 0)).toBe(0); // 'a'
    expect(lineOf(text, 1)).toBe(0); // the first "\n" is not yet passed
    expect(lineOf(text, 2)).toBe(1); // 'b'
    expect(lineOf(text, 4)).toBe(2); // 'c'
  });

  it("treats the newline char as belonging to the preceding line", () => {
    const text = "x\ny";
    // offset 1 is the "\n" itself: nothing before it counts → line 0.
    expect(lineOf(text, 1)).toBe(0);
  });

  it("clamps a negative offset to line 0", () => {
    expect(lineOf("a\nb", -10)).toBe(0);
  });

  it("clamps an out-of-range offset to the last line", () => {
    const text = "a\nb\nc";
    expect(lineOf(text, 999)).toBe(2);
  });

  it("handles empty text", () => {
    expect(lineOf("", 0)).toBe(0);
    expect(lineOf("", 5)).toBe(0);
  });
});

describe("buildFileRefNodes", () => {
  it("maps each ref to a fileRef node with id, refKind, line and trimmed context", () => {
    const text = "    // TODO ENG-123 fix this";
    const refs = scanText(text);
    const nodes = buildFileRefNodes(refs, lineOfFor(text), lineAtFor(text));

    expect(nodes).toHaveLength(1);
    expect(nodes[0]).toMatchObject({
      kind: "fileRef",
      id: "ENG-123",
      refKind: "todo",
      marker: "TODO",
      line: 0,
      context: "// TODO ENG-123 fix this",
    });
    // No live summary attached at the model layer.
    expect(nodes[0].item).toBeUndefined();
  });

  it("classifies a bare prose reference as raw with no marker", () => {
    const text = "Fixed in ENG-9 yesterday";
    const refs = scanText(text);
    const nodes = buildFileRefNodes(refs, lineOfFor(text), lineAtFor(text));

    expect(nodes).toHaveLength(1);
    expect(nodes[0].refKind).toBe("raw");
    expect(nodes[0].marker).toBeUndefined();
  });

  it("preserves document order across multiple lines", () => {
    const text = ["// TODO ABC-1", "see ABC-2", "// FIXME ABC-3"].join("\n");
    const refs = scanText(text);
    const nodes = buildFileRefNodes(refs, lineOfFor(text), lineAtFor(text));

    expect(nodes.map((n) => n.id)).toEqual(["ABC-1", "ABC-2", "ABC-3"]);
    expect(nodes.map((n) => n.line)).toEqual([0, 1, 2]);
  });

  it("dedupes by id + line (same id twice on one line collapses)", () => {
    const text = "// TODO ENG-5 and again ENG-5";
    const refs = scanText(text);
    expect(refs.length).toBeGreaterThan(1);
    const nodes = buildFileRefNodes(refs, lineOfFor(text), lineAtFor(text));

    expect(nodes).toHaveLength(1);
    expect(nodes[0].id).toBe("ENG-5");
    // First occurrence wins, keeping the actionable marker.
    expect(nodes[0].marker).toBe("TODO");
  });

  it("keeps the same id on different lines as distinct nodes", () => {
    const text = ["ENG-7 first", "ENG-7 second"].join("\n");
    const refs = scanText(text);
    const nodes = buildFileRefNodes(refs, lineOfFor(text), lineAtFor(text));

    expect(nodes).toHaveLength(2);
    expect(nodes.map((n) => n.line)).toEqual([0, 1]);
  });

  it("trims surrounding whitespace from the context line", () => {
    const text = "\t\t  ENG-2  \t";
    const refs = scanText(text);
    const nodes = buildFileRefNodes(refs, lineOfFor(text), lineAtFor(text));

    expect(nodes[0].context).toBe("ENG-2");
  });

  it("tolerates a throwing lineAt accessor by yielding empty context", () => {
    const text = "// TODO ENG-1";
    const refs = scanText(text);
    const nodes = buildFileRefNodes(
      refs,
      lineOfFor(text),
      () => {
        throw new Error("boom");
      },
    );

    expect(nodes).toHaveLength(1);
    expect(nodes[0].context).toBe("");
  });

  it("returns an empty array when there are no refs", () => {
    const text = "nothing to see here";
    const refs = scanText(text);
    expect(buildFileRefNodes(refs, lineOfFor(text), lineAtFor(text))).toEqual([]);
  });
});
