# Linear Lens

Make Linear issue IDs like `ENG-123` clickable, hoverable, and useful inside VS Code.

Linear Lens recognizes Linear issue references wherever they appear — in code comments,
commit-message buffers, Markdown, and even your current git branch name — and turns them
into rich, clickable links with informative hovers. Stop copy-pasting issue IDs into your
browser; just click them where you already are.

## What it does

Linear Lens **links the tickets you already have**. It scans the text you are reading and
makes every recognized issue reference actionable:

- **Clickable links** — `ENG-123` becomes a document link straight to your Linear workspace.
- **Hovers** — hover any reference to see the issue at a glance. With an optional Linear API
  key, hovers show live title, status, assignee, priority, and project.
- **Problems integration** — actionable `TODO`/`FIXME`/`BUG`/`HACK` references that mention a
  Linear issue are surfaced in the Problems panel so they never get lost.
- **Current-branch awareness** — a status bar item shows the issue encoded in your git branch
  (e.g. `allie/eng-123-...`) and opens it in one click.
- **Quick commands** — open or copy an issue link from anywhere via the command palette.

### The key distinction

**Linear Lens links your existing tickets. It does NOT create tickets from your TODOs.**

This is the opposite of "TODO → ticket" tools. Linear Lens never writes to Linear and never
generates issues from your code. It only ever *connects* references that already point at real
issues you created in Linear.

Because of this, the Problems panel stays quiet and signal-rich:

- A **raw reference** in prose — like `Fixed in ENG-123` — gets a link and a hover, but is
  **never** reported as a Problem.
- Only references **bound to a `TODO`/`FIXME`/`BUG`/`HACK` marker** (or an unchecked Markdown
  task, `- [ ] ENG-123 ...`) appear in Problems, because those represent outstanding work.

In short: every reference links and hovers; only actionable, TODO-bound references become
diagnostics.

## Features

- Detects `ABC-123`-shaped issue IDs (2–7 letter team key, 1–6 digit number), case-insensitive.
- Recognizes full `linear.app` issue URLs and links them directly.
- Classifies each reference as actionable (`todo`) or informational (`raw`/`url`).
- Clickable `DocumentLink`s for every reference.
- Hover cards with basic info always; rich live metadata when a Linear API key is configured.
- Problems-panel diagnostics for TODO-bound references only, with configurable severity.
- Status bar item for the current branch's issue, with a one-click open command.
- Optional team-key allowlist to eliminate false positives in zero-config mode.
- Optional Linear API integration that **degrades gracefully** — no key, no problem; you still
  get links and basic hovers.

## Supported syntax

Linear Lens recognizes all of the following:

| Example | What happens |
|---|---|
| `ENG-123` | Linked + hover (raw reference) |
| `eng-123` | Linked + hover; normalized to `ENG-123` |
| `Fixed in ENG-123` | Linked + hover only — **never** a Problem |
| `TODO: ENG-123 fix retry logic` | Linked + hover + Problem (`TODO`) |
| `TODO ENG-123: fix retry logic` | Linked + hover + Problem (`TODO`) |
| `TODO: fix retry logic in ENG-123` | Linked + hover + Problem (`TODO`) |
| `FIXME ENG-124 handle null user` | Linked + hover + Problem (`FIXME`) |
| `// BUG ENG-9 leaks memory` | Linked + hover + Problem (`BUG`) |
| `# HACK ABC-1 workaround` | Linked + hover + Problem (`HACK`) |
| `- [ ] ENG-123 fix auth redirect` | Linked + hover + Problem (unchecked task) |
| `- [x] ENG-200 done` | Linked + hover only — checked task is not actionable |
| `https://linear.app/acme/issue/ENG-123/fix-auth` | Linked + hover (URL reference) |
| Branch `allie/eng-123-auth-redirect` | Detected in the status bar as `ENG-123` |

A marker keyword anywhere on a line makes the IDs on that line actionable, whether the ID comes
before or after the keyword. Word boundaries are respected, so `debug` is not treated as `BUG`
and `hackathon` is not treated as `HACK`.

> **Zero-config note:** when no team-key allowlist is set, any `ABC-123`-shaped token is treated
> as an issue ID. This can occasionally produce false positives (for example `self-2` would be
> read as `SELF-2`). Set `linearLens.teamKeys` to your real team keys to remove them.

## Setup

This project uses [mise](https://mise.jdx.dev/) to pin the toolchain and
[pnpm](https://pnpm.io/) for dependencies.

```sh
mise install     # install the pinned toolchain (Node, pnpm, etc.)
pnpm install     # install dependencies
pnpm build       # bundle the extension
```

Then press **F5** in VS Code to launch the Extension Development Host with Linear Lens loaded.

To use it, set your workspace slug so links resolve to the right Linear workspace: run
**Linear Lens: Configure Workspace Slug** from the command palette, or set
`linearLens.workspaceSlug` in your settings. Your slug is the segment in your Linear URL,
e.g. the `acme` in `https://linear.app/acme/...`.

## Configuration

All settings live under the `linearLens.*` namespace.

| Setting | Type | Default | Description |
|---|---|---|---|
| `linearLens.workspaceSlug` | `string` | `""` | Your Linear workspace slug, used to build issue URLs like `https://linear.app/<slug>/issue/ENG-123`. Find it in your Linear URL. |
| `linearLens.teamKeys` | `string[]` | `[]` | Optional allowlist of team keys to recognize (e.g. `["ENG", "DESIGN"]`). When empty, any `ABC-123`-shaped token (2–7 uppercase letters) is treated as an issue ID. |
| `linearLens.diagnostics.enable` | `boolean` | `true` | Surface `TODO`/`FIXME`/`BUG`/`HACK`-bound Linear references in the Problems panel. Raw references in prose are never reported. |
| `linearLens.diagnostics.severity` | `"error" \| "warning" \| "information" \| "hint"` | `"information"` | Severity used for TODO-bound Linear references in the Problems panel. |
| `linearLens.api.enable` | `boolean` | `false` | Fetch live issue metadata (title, status, assignee, priority, project) from the Linear API for richer hovers. Requires an API key set via **Linear Lens: Set Linear API Key**. Falls back to basic link/hover when disabled or unavailable. |
| `linearLens.cache.ttlSeconds` | `number` | `300` | How long (in seconds) to cache fetched issue metadata before refetching. |

## Commands

Available from the command palette:

| Command | Title |
|---|---|
| `linearLens.configureWorkspace` | Linear Lens: Configure Workspace Slug |
| `linearLens.openIssue` | Linear Lens: Open Issue… |
| `linearLens.copyIssueLink` | Linear Lens: Copy Issue Link… |
| `linearLens.refreshCache` | Linear Lens: Refresh Issue Cache |
| `linearLens.openCurrentBranchIssue` | Linear Lens: Open Current Branch Issue |
| `linearLens.setApiKey` | Linear Lens: Set Linear API Key |
| `linearLens.clearApiKey` | Linear Lens: Clear Linear API Key |

## Optional: Linear API key for rich hovers

Linear Lens works fully without any credentials — you get clickable links and basic hovers out
of the box. To enrich hovers with live issue metadata (title, workflow status, assignee,
priority, project, and an archived indicator):

1. Set `linearLens.api.enable` to `true`.
2. Run **Linear Lens: Set Linear API Key** and paste a Linear personal API key. The key is
   stored securely in VS Code's `SecretStorage` and sent only to `api.linear.app`.

If the API is disabled, no key is set, or a request fails for any reason, Linear Lens **degrades
gracefully** to basic link/hover behavior — it never throws and never blocks your editor. Run
**Linear Lens: Clear Linear API Key** to remove a stored key, and **Linear Lens: Refresh Issue
Cache** to drop cached metadata and re-read auth.

## Development

```sh
pnpm watch       # rebuild on change (run alongside F5)
pnpm test        # run the unit tests (vitest)
pnpm typecheck   # strict TypeScript type checking
```

The parser (`src/parser.ts`) and shared types (`src/types.ts`) are intentionally free of any
`vscode` import so the detection logic can be unit-tested in plain Node.

## License

MIT.
