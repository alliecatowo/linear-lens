import { describe, it, expect } from "vitest";
import { escapeHtml, renderInline, renderMarkdown } from "../src/format/markdown";

describe("escapeHtml", () => {
  it("escapes the five HTML-significant characters", () => {
    expect(escapeHtml(`<a href="x">&'</a>`)).toBe(
      "&lt;a href=&quot;x&quot;&gt;&amp;&#39;&lt;/a&gt;",
    );
  });

  it("coerces non-strings", () => {
    expect(escapeHtml(123 as unknown as string)).toBe("123");
  });
});

describe("renderMarkdown — paragraphs and newlines", () => {
  it("splits blank-line-separated text into paragraphs", () => {
    const html = renderMarkdown("First paragraph.\n\nSecond paragraph.");
    expect(html).toBe("<p>First paragraph.</p><p>Second paragraph.</p>");
  });

  it("turns a single newline inside a paragraph into <br>", () => {
    const html = renderMarkdown("line one\nline two");
    expect(html).toBe("<p>line one<br>line two</p>");
  });

  it("normalizes real CRLF newlines", () => {
    const html = renderMarkdown("a\r\n\r\nb");
    expect(html).toBe("<p>a</p><p>b</p>");
  });

  it("returns empty string for empty / nullish input", () => {
    expect(renderMarkdown("")).toBe("");
    expect(renderMarkdown("   \n  ")).toBe("");
    expect(renderMarkdown(undefined)).toBe("");
    expect(renderMarkdown(null)).toBe("");
  });
});

describe("renderMarkdown — the escaped-\\n bug (BUG 2)", () => {
  it("treats LITERAL backslash-n as a real newline (paragraph breaks)", () => {
    // The two-character sequence backslash + n, as it arrives over the wire.
    const input =
      "Make UUID the canonical identifier.\\n\\nBlocked by MINI-114.\\n\\nParent spike: MINI-121";
    const html = renderMarkdown(input);
    expect(html).toBe(
      "<p>Make UUID the canonical identifier.</p>" +
        "<p>Blocked by MINI-114.</p>" +
        "<p>Parent spike: MINI-121</p>",
    );
    // No raw backslash-n must survive into the output.
    expect(html).not.toContain("\\n");
  });

  it("treats a single literal backslash-n as a <br>", () => {
    const html = renderMarkdown("alpha\\nbeta");
    expect(html).toBe("<p>alpha<br>beta</p>");
  });

  it("handles literal backslash-r-backslash-n", () => {
    const html = renderMarkdown("alpha\\r\\n\\r\\nbeta");
    expect(html).toBe("<p>alpha</p><p>beta</p>");
  });

  it("expands literal backslash-t to spaces (no raw tab escape survives)", () => {
    const html = renderMarkdown("a\\tb");
    expect(html).toBe("<p>a    b</p>");
    expect(html).not.toContain("\\t");
  });
});

describe("renderMarkdown — inline formatting", () => {
  it("renders bold", () => {
    expect(renderMarkdown("**bold**")).toBe("<p><strong>bold</strong></p>");
  });

  it("renders italic with asterisks and underscores", () => {
    expect(renderMarkdown("*em*")).toBe("<p><em>em</em></p>");
    expect(renderMarkdown("_em_")).toBe("<p><em>em</em></p>");
  });

  it("renders bold and italic together without clobbering", () => {
    expect(renderMarkdown("**b** and *i*")).toBe(
      "<p><strong>b</strong> and <em>i</em></p>",
    );
  });

  it("renders inline code and does not format inside it", () => {
    expect(renderMarkdown("use `a*b*c` here")).toBe(
      "<p>use <code>a*b*c</code> here</p>",
    );
  });
});

describe("renderMarkdown — links", () => {
  it("renders an http(s) link as a data-href anchor (no live href)", () => {
    const html = renderMarkdown("see [docs](https://example.com/x)");
    expect(html).toBe(
      '<p>see <a class="link" data-href="https://example.com/x">docs</a></p>',
    );
    expect(html).not.toContain(' href="https');
  });

  it("collapses non-http links to their plain label", () => {
    expect(renderMarkdown("[bad](javascript:alert(1))")).toBe("<p>bad</p>");
    expect(renderMarkdown("[rel](/local/path)")).toBe("<p>rel</p>");
  });
});

describe("renderMarkdown — block elements", () => {
  it("renders #/##/### headings", () => {
    expect(renderMarkdown("# Title")).toBe("<h1>Title</h1>");
    expect(renderMarkdown("## Sub")).toBe("<h2>Sub</h2>");
    expect(renderMarkdown("### Deep")).toBe("<h3>Deep</h3>");
  });

  it("renders an unordered list (-, *, +)", () => {
    const html = renderMarkdown("- one\n- two\n- three");
    expect(html).toBe("<ul><li>one</li><li>two</li><li>three</li></ul>");
    expect(renderMarkdown("* a\n+ b")).toBe("<ul><li>a</li><li>b</li></ul>");
  });

  it("renders an ordered list", () => {
    const html = renderMarkdown("1. first\n2. second");
    expect(html).toBe("<ol><li>first</li><li>second</li></ol>");
  });

  it("renders inline formatting inside list items", () => {
    expect(renderMarkdown("- **bold** item")).toBe(
      "<ul><li><strong>bold</strong> item</li></ul>",
    );
  });

  it("renders a fenced code block verbatim (no inline formatting)", () => {
    const html = renderMarkdown("```\nconst x = *y*;\n```");
    expect(html).toBe("<pre><code>const x = *y*;</code></pre>");
  });

  it("renders a fenced code block with the escaped-\\n bug input", () => {
    const html = renderMarkdown("```\\nlet a = 1;\\nlet b = 2;\\n```");
    expect(html).toBe("<pre><code>let a = 1;\nlet b = 2;</code></pre>");
  });

  it("renders a blockquote", () => {
    expect(renderMarkdown("> quoted line")).toBe(
      "<blockquote>quoted line</blockquote>",
    );
  });
});

describe("renderMarkdown — sanitization", () => {
  it("escapes HTML before formatting (no tag injection)", () => {
    const html = renderMarkdown('<img src=x onerror="alert(1)">');
    expect(html).toBe(
      "<p>&lt;img src=x onerror=&quot;alert(1)&quot;&gt;</p>",
    );
    expect(html).not.toContain("<img");
  });

  it("escapes inside code fences too", () => {
    const html = renderMarkdown("```\n<script>evil()</script>\n```");
    expect(html).toBe(
      "<pre><code>&lt;script&gt;evil()&lt;/script&gt;</code></pre>",
    );
  });

  it("does not let a crafted link label inject markup", () => {
    const html = renderMarkdown("[<b>x</b>](https://ok.test)");
    expect(html).toBe(
      '<p><a class="link" data-href="https://ok.test">&lt;b&gt;x&lt;/b&gt;</a></p>',
    );
  });
});

describe("renderInline", () => {
  it("operates on already-escaped text", () => {
    expect(renderInline("plain `code` and **b**")).toBe(
      "plain <code>code</code> and <strong>b</strong>",
    );
  });
});
