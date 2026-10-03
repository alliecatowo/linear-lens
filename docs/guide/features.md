# Features

Linear Lens **links the tickets you already have**. It scans the text you are reading and
makes every recognized issue reference actionable:

- **Clickable links** — `ENG-123` becomes a document link straight to your Linear workspace.
- **Hovers** — hover any reference to see the issue at a glance. When authenticated, hovers
  show live title, a color-coded workflow status dot, assignee and subscriber avatars, labels
  (with their colors), git branch name with one-click Checkout and View Diff actions, priority,
  and project.
- **In-editor decorations** — recognized references are subtly highlighted (dotted underline)
  directly in the editor so they stand out at a glance.
- **Problems integration** — actionable `TODO`/`FIXME`/`BUG`/`HACK` references that mention a
  Linear issue are surfaced in the Problems panel so they never get lost.
- **Current-branch awareness** — a status bar item shows the issue encoded in your git branch
  (e.g. `allie/eng-123-...`) and opens it in one click.
- **Quick commands** — open or copy an issue link from anywhere via the command palette.

## The key distinction

**Linear Lens links your existing tickets. It does NOT create tickets from your TODOs.**

This is the opposite of "TODO → ticket" tools. Linear Lens never generates issues from your
code, and it never writes to Linear on its own. Scanning only ever *connects* references that
already point at real issues in Linear. Writes happen only when you run an explicit edit or
**Create Issue…** command (or drag a card on the team board). `linearLens.edit.enable`,
`linearLens.create.enable` and `linearLens.board.enable` hide those actions, and destructive
ones ask first (`linearLens.write.confirmDestructive`).

Because of this, the Problems panel stays quiet and signal-rich:

- A **raw reference** in prose — like `Fixed in ENG-123` — gets a link and a hover, but is
  **never** reported as a Problem.
- Only references **bound to a marker keyword** (configurable via `linearLens.markers`,
  defaulting to `TODO`/`FIXME`/`BUG`/`HACK`) or an unchecked Markdown task
  (`- [ ] ENG-123 ...`) appear in Problems, because those represent outstanding work.

In short: every reference links and hovers; only actionable, marker-bound references become
diagnostics.

## Feature list

- Detects `ABC-123`-shaped issue IDs (2–7 letter team key, 1–6 digit number), case-insensitive.
- Recognizes full `linear.app` issue URLs and links them directly.
- Classifies each reference as actionable (`todo`) or informational (`raw`/`url`).
- Clickable `DocumentLink`s for every reference.
- In-editor decorations that visibly highlight all issue references.
- Hover cards with basic info always; rich live metadata when authenticated (personal API key
  or Linear Connect), including a color-coded workflow-state dot, assignee and subscriber
  avatars, colored label chips, the issue's suggested git branch name, one-click Checkout /
  View Diff branch actions, priority, and project name.
- **Rail** — a GitLens / Error-Lens-style muted end-of-line annotation
  (`ENG-123 · In Progress · Fix the parser`) plus status-colored ticks on the scrollbar
  overview ruler. Reads cached metadata, so it never blocks typing. Shows on the active line
  by default (configurable to every reference line or off).
- **Blame hover** — hover a line whose Linear reference lives in its *last commit* (not the
  code) and Linear Lens blames the line, then surfaces a lightweight
  `📋 ENG-123 · View in Linear · Open details` hover entry.
- Problems-panel diagnostics for marker-bound references only, with configurable severity and
  custom marker keywords.
- Status bar item for the current branch's issue, with a one-click open command.
- Optional team-key allowlist to eliminate false positives in zero-config mode.
- **Personal API key** as the first-class, no-extra-extension way to enable rich hovers:
  generate one in Linear → Settings → Security & access → Personal API keys, then run
  **Linear Lens: Set Personal API Key**. Stored in VS Code's encrypted `SecretStorage`.
- Sign in via Linear's official *Linear Connect* extension (no OAuth app, no hosted redirect)
  as an alternative OAuth path; both methods **degrade gracefully** when unavailable.
- **Opt-in editing** — explicit commands to set status, assignee, labels, priority, project,
  team and cycle, edit blocking relations, or create an issue, plus team-board and active-cycle
  views. Each surface has its own toggle (`linearLens.edit.enable`, `linearLens.create.enable`,
  `linearLens.board.enable`), and writes need a personal API key or a write-capable sign-in.

## Activity Bar views

Linear Lens contributes a dedicated **Linear Lens** container in the Activity Bar with these views:

- **Issues in This File** — every Linear reference in the active editor, with a state dot when known. Click to jump to the line.
- **My Issues** — issues assigned to you (requires sign-in or a personal API key).
- **Assigned / Recent** — your recently updated issues (requires sign-in or a personal API key).
- **Teams** — the teams you can access and their issues (toggle with `linearLens.teams.enable`).
- **Active Cycle** — the current cycle's issues for a chosen team (toggle with `linearLens.teams.enable`).

Right-click an issue to open it, copy its link or ID, check out its branch, or open it in your preferred coding tool.
