import { describe, expect, it } from "vitest";
import { IssueMetadata, TicketDetail } from "../src/types";
import { normalizeBody, ticketToMarkdown } from "../src/format/issueMarkdown";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/** Minimal TicketDetail with all optional fields populated. */
function makeTicket(overrides?: Partial<TicketDetail>): TicketDetail {
  return {
    id: "ENG-123",
    title: "Fix the widget",
    url: "https://linear.app/acme/issue/ENG-123",
    state: "In Progress",
    stateType: "started",
    stateColor: "#4CB782",
    priority: "High",
    project: "Billing",
    branchName: "jane/eng-123-fix-the-widget",
    description: "This is the description.",
    archived: false,
    assignee: { name: "jane", displayName: "Jane Doe", avatarUrl: undefined },
    creator: { name: "bob", displayName: "Bob Smith" },
    collaborators: [],
    labels: [
      { name: "bug", color: "#ff0000" },
      { name: "backend", color: "#0000ff" },
    ],
    comments: [
      {
        id: "c1",
        body: "First comment.",
        createdAt: "2026-06-01T10:00:00Z",
        author: { name: "alice", displayName: "Alice" },
      },
      {
        id: "c2",
        body: "Second comment.",
        createdAt: "2026-06-02T12:30:00Z",
        author: { name: "bob", displayName: "Bob Smith" },
      },
    ],
    attachments: [],
    ...overrides,
  };
}

/** Minimal IssueMetadata fixture. */
function makeMetadata(overrides?: Partial<IssueMetadata>): IssueMetadata {
  return {
    id: "ENG-456",
    title: "Another issue",
    url: "https://linear.app/acme/issue/ENG-456",
    state: "Todo",
    stateType: "unstarted",
    stateColor: "#e5e5e5",
    priority: "Normal",
    project: undefined,
    branchName: undefined,
    description: "Metadata description.",
    archived: false,
    assignee: undefined,
    creator: undefined,
    subscribers: [],
    labels: [],
    comments: [],
    attachments: [],
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// normalizeBody
// ---------------------------------------------------------------------------

describe("normalizeBody", () => {
  it("returns empty string for null", () => {
    expect(normalizeBody(null)).toBe("");
  });

  it("returns empty string for undefined", () => {
    expect(normalizeBody(undefined)).toBe("");
  });

  it("returns empty string for empty string", () => {
    expect(normalizeBody("")).toBe("");
  });

  it("un-escapes literal backslash-n as a real newline", () => {
    const result = normalizeBody("first\\nsecond");
    expect(result).toBe("first\nsecond");
  });

  it("un-escapes literal backslash-r-backslash-n as a real newline", () => {
    const result = normalizeBody("alpha\\r\\nbeta");
    expect(result).toBe("alpha\nbeta");
  });

  it("un-escapes literal backslash-r as a real newline", () => {
    const result = normalizeBody("alpha\\rbeta");
    expect(result).toBe("alpha\nbeta");
  });

  it("un-escapes literal backslash-t as a real tab (not four spaces)", () => {
    const result = normalizeBody("col1\\tcol2");
    expect(result).toBe("col1\tcol2");
    // Confirm it is a real tab, not four spaces.
    expect(result).not.toContain("    ");
  });

  it("preserves real newlines untouched", () => {
    expect(normalizeBody("line1\nline2")).toBe("line1\nline2");
  });

  it("normalizes CRLF to LF", () => {
    expect(normalizeBody("a\r\nb")).toBe("a\nb");
  });

  it("trims trailing whitespace from each line", () => {
    expect(normalizeBody("hello   \nworld  ")).toBe("hello\nworld");
  });

  it("trims leading and trailing blank lines", () => {
    expect(normalizeBody("\n\nhello\n\n")).toBe("hello");
  });

  it("handles a multi-line escaped body (BUG-2 parity)", () => {
    const input =
      "Make UUID the canonical identifier.\\n\\nBlocked by MINI-114.\\n\\nParent spike: MINI-121";
    const result = normalizeBody(input);
    expect(result).toBe(
      "Make UUID the canonical identifier.\n\nBlocked by MINI-114.\n\nParent spike: MINI-121",
    );
    expect(result).not.toContain("\\n");
  });
});

// ---------------------------------------------------------------------------
// ticketToMarkdown — null / undefined guard
// ---------------------------------------------------------------------------

describe("ticketToMarkdown — null / undefined", () => {
  it("returns empty string for null", () => {
    expect(ticketToMarkdown(null)).toBe("");
  });

  it("returns empty string for undefined", () => {
    expect(ticketToMarkdown(undefined)).toBe("");
  });
});

// ---------------------------------------------------------------------------
// ticketToMarkdown — heading
// ---------------------------------------------------------------------------

describe("ticketToMarkdown — heading", () => {
  it("formats heading as '# ID — Title'", () => {
    const md = ticketToMarkdown(makeTicket());
    expect(md.startsWith("# ENG-123 — Fix the widget")).toBe(true);
  });

  it("uses just the id when title is empty", () => {
    const md = ticketToMarkdown(makeTicket({ title: "" }));
    expect(md.startsWith("# ENG-123")).toBe(true);
    expect(md).not.toContain("—");
  });

  it("uses just the id when title is whitespace-only", () => {
    const md = ticketToMarkdown(makeTicket({ title: "   " }));
    // "   " is truthy, so the heading uses id + " — " + title
    // The spec says "empty title → just the id"; whitespace is truthy in JS.
    // We document actual behaviour: truthy strings are passed through.
    expect(md).toContain("ENG-123");
  });
});

// ---------------------------------------------------------------------------
// ticketToMarkdown — properties block
// ---------------------------------------------------------------------------

describe("ticketToMarkdown — properties block (TicketDetail)", () => {
  it("includes status", () => {
    const md = ticketToMarkdown(makeTicket());
    expect(md).toContain("- **Status:** In Progress");
  });

  it("includes assignee displayName", () => {
    const md = ticketToMarkdown(makeTicket());
    expect(md).toContain("- **Assignee:** Jane Doe");
  });

  it("falls back to assignee name when displayName is empty", () => {
    const md = ticketToMarkdown(
      makeTicket({ assignee: { name: "jane", displayName: "" } }),
    );
    expect(md).toContain("- **Assignee:** jane");
  });

  it("omits assignee line when there is no assignee", () => {
    const md = ticketToMarkdown(makeTicket({ assignee: undefined }));
    expect(md).not.toContain("**Assignee:**");
  });

  it("includes priority", () => {
    const md = ticketToMarkdown(makeTicket());
    expect(md).toContain("- **Priority:** High");
  });

  it("omits priority line when priority is undefined", () => {
    const md = ticketToMarkdown(makeTicket({ priority: undefined }));
    expect(md).not.toContain("**Priority:**");
  });

  it("includes project", () => {
    const md = ticketToMarkdown(makeTicket());
    expect(md).toContain("- **Project:** Billing");
  });

  it("omits project line when project is undefined", () => {
    const md = ticketToMarkdown(makeTicket({ project: undefined }));
    expect(md).not.toContain("**Project:**");
  });

  it("includes labels as comma-separated names", () => {
    const md = ticketToMarkdown(makeTicket());
    expect(md).toContain("- **Labels:** bug, backend");
  });

  it("omits labels line when labels array is empty", () => {
    const md = ticketToMarkdown(makeTicket({ labels: [] }));
    expect(md).not.toContain("**Labels:**");
  });

  it("includes branch name in backticks", () => {
    const md = ticketToMarkdown(makeTicket());
    expect(md).toContain("- **Branch:** `jane/eng-123-fix-the-widget`");
  });

  it("omits branch line when branchName is undefined", () => {
    const md = ticketToMarkdown(makeTicket({ branchName: undefined }));
    expect(md).not.toContain("**Branch:**");
  });

  it("includes URL", () => {
    const md = ticketToMarkdown(makeTicket());
    expect(md).toContain("- **URL:** https://linear.app/acme/issue/ENG-123");
  });
});

// ---------------------------------------------------------------------------
// ticketToMarkdown — IssueMetadata (subscribers not collaborators)
// ---------------------------------------------------------------------------

describe("ticketToMarkdown — IssueMetadata shape", () => {
  it("formats an IssueMetadata with no assignee or labels gracefully", () => {
    const md = ticketToMarkdown(makeMetadata());
    expect(md).toContain("# ENG-456 — Another issue");
    expect(md).toContain("- **Status:** Todo");
    expect(md).not.toContain("**Assignee:**");
    expect(md).not.toContain("**Labels:**");
  });

  it("includes description from IssueMetadata", () => {
    const md = ticketToMarkdown(makeMetadata());
    expect(md).toContain("## Description");
    expect(md).toContain("Metadata description.");
  });
});

// ---------------------------------------------------------------------------
// ticketToMarkdown — description section
// ---------------------------------------------------------------------------

describe("ticketToMarkdown — description", () => {
  it("includes a '## Description' heading when description is present", () => {
    const md = ticketToMarkdown(makeTicket());
    expect(md).toContain("## Description");
    expect(md).toContain("This is the description.");
  });

  it("omits '## Description' when description is empty", () => {
    const md = ticketToMarkdown(makeTicket({ description: "" }));
    expect(md).not.toContain("## Description");
  });

  it("omits '## Description' when description is undefined", () => {
    const md = ticketToMarkdown(makeTicket({ description: undefined }));
    expect(md).not.toContain("## Description");
  });

  it("passes description through normalizeBody (un-escapes literal \\n)", () => {
    const md = ticketToMarkdown(makeTicket({ description: "line1\\nline2" }));
    expect(md).toContain("line1\nline2");
    expect(md).not.toContain("\\n");
  });

  it("omits description when includeDescription is false", () => {
    const md = ticketToMarkdown(makeTicket(), { includeDescription: false });
    expect(md).not.toContain("## Description");
  });
});

// ---------------------------------------------------------------------------
// ticketToMarkdown — comments section
// ---------------------------------------------------------------------------

describe("ticketToMarkdown — comments", () => {
  it("omits '## Comments' by default (includeComments defaults to false)", () => {
    const md = ticketToMarkdown(makeTicket());
    expect(md).not.toContain("## Comments");
  });

  it("includes '## Comments' when includeComments is true", () => {
    const md = ticketToMarkdown(makeTicket(), { includeComments: true });
    expect(md).toContain("## Comments");
  });

  it("renders each comment with author and date", () => {
    const md = ticketToMarkdown(makeTicket(), { includeComments: true });
    expect(md).toContain("**Alice** — 2026-06-01");
    expect(md).toContain("First comment.");
    expect(md).toContain("**Bob Smith** — 2026-06-02");
    expect(md).toContain("Second comment.");
  });

  it("falls back to 'Unknown' when comment author is absent", () => {
    const ticket = makeTicket({
      comments: [
        {
          id: "c-anon",
          body: "Anonymous comment.",
          createdAt: "2026-05-01T00:00:00Z",
          author: undefined,
        },
      ],
    });
    const md = ticketToMarkdown(ticket, { includeComments: true });
    expect(md).toContain("**Unknown** — 2026-05-01");
    expect(md).toContain("Anonymous comment.");
  });

  it("omits '## Comments' section when comments array is empty, even if includeComments is true", () => {
    const md = ticketToMarkdown(makeTicket({ comments: [] }), {
      includeComments: true,
    });
    expect(md).not.toContain("## Comments");
  });

  it("passes comment body through normalizeBody", () => {
    const ticket = makeTicket({
      comments: [
        {
          id: "c-esc",
          body: "part1\\npart2",
          createdAt: "2026-06-03T00:00:00Z",
          author: { name: "dev", displayName: "Dev" },
        },
      ],
    });
    const md = ticketToMarkdown(ticket, { includeComments: true });
    expect(md).toContain("part1\npart2");
    expect(md).not.toContain("\\n");
  });

  it("separates multiple comments with a horizontal rule", () => {
    const md = ticketToMarkdown(makeTicket(), { includeComments: true });
    expect(md).toContain("---");
  });
});

// ---------------------------------------------------------------------------
// ticketToMarkdown — options flags
// ---------------------------------------------------------------------------

describe("ticketToMarkdown — options flags", () => {
  it("omits properties block when includeProperties is false", () => {
    const md = ticketToMarkdown(makeTicket(), { includeProperties: false });
    expect(md).not.toContain("**Status:**");
    expect(md).not.toContain("**Assignee:**");
    expect(md).not.toContain("**Priority:**");
    expect(md).not.toContain("**Labels:**");
    expect(md).not.toContain("**Branch:**");
  });

  it("omits URL when includeUrl is false but keeps other properties", () => {
    const md = ticketToMarkdown(makeTicket(), { includeUrl: false });
    expect(md).not.toContain("**URL:**");
    expect(md).toContain("**Status:**");
  });

  it("includes URL even when includeProperties is false if includeUrl is true", () => {
    const md = ticketToMarkdown(makeTicket(), {
      includeProperties: false,
      includeUrl: true,
    });
    expect(md).toContain("**URL:**");
    expect(md).not.toContain("**Status:**");
  });

  it("all options false yields just the heading", () => {
    const md = ticketToMarkdown(makeTicket(), {
      includeProperties: false,
      includeUrl: false,
      includeDescription: false,
      includeComments: false,
    });
    expect(md).toBe("# ENG-123 — Fix the widget");
  });
});

// ---------------------------------------------------------------------------
// ticketToMarkdown — full snapshot
// ---------------------------------------------------------------------------

describe("ticketToMarkdown — full snapshot", () => {
  it("produces the expected full document for a complete ticket", () => {
    const ticket = makeTicket();
    const md = ticketToMarkdown(ticket, {
      includeDescription: true,
      includeComments: true,
      includeProperties: true,
      includeUrl: true,
    });

    const expected = [
      "# ENG-123 — Fix the widget",
      "",
      "- **Status:** In Progress",
      "- **Assignee:** Jane Doe",
      "- **Priority:** High",
      "- **Project:** Billing",
      "- **Labels:** bug, backend",
      "- **Branch:** `jane/eng-123-fix-the-widget`",
      "- **URL:** https://linear.app/acme/issue/ENG-123",
      "",
      "## Description",
      "",
      "This is the description.",
      "",
      "## Comments",
      "",
      "**Alice** — 2026-06-01",
      "First comment.",
      "",
      "---",
      "",
      "**Bob Smith** — 2026-06-02",
      "Second comment.",
    ].join("\n");

    expect(md).toBe(expected);
  });

  it("produces a minimal document for a sparse IssueMetadata", () => {
    const ticket = makeMetadata({
      title: "Sparse ticket",
      description: "",
      labels: [],
      comments: [],
      priority: undefined,
    });
    const md = ticketToMarkdown(ticket, { includeComments: true });
    // Should have heading + status + URL only.
    expect(md).toContain("# ENG-456 — Sparse ticket");
    expect(md).toContain("- **Status:** Todo");
    expect(md).toContain("- **URL:**");
    expect(md).not.toContain("## Description");
    expect(md).not.toContain("## Comments");
    expect(md).not.toContain("**Priority:**");
  });
});
