# Changelog

All notable changes to the Linear Lens extension are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- **Granular per-feature enable toggles** — every major surface now has its own on/off switch:
  `linearLens.edit.enable`, `linearLens.create.enable`, `linearLens.teams.enable`,
  `linearLens.board.enable`. The `when:` clauses on all menus and views are reactive (no
  window reload needed) and the runtime commands re-check the setting before acting.
- **`linearLens.teams.show`** (string[], default `[]`) — allowlist of team keys to show in
  the Teams view. Empty = all teams (or the viewer's teams when `teams.viewerOnly` is on).
- **`linearLens.teams.viewerOnly`** (boolean, default `true`) — when `teams.show` is empty,
  show only teams you are a member of (vs. every workspace team).
- **`linearLens.view.defaultGroupBy` / `linearLens.view.defaultSortBy`** — configure the
  default grouping and sort order for the issue tree views without opening the view menu.
- **`linearLens.worktree.filter`** (`"off" | "currentRepo" | "currentWorktree"`, default
  `"off"`) — how issue lists relate to the current git checkout. When set to `currentRepo`
  or `currentWorktree`, the issue matching the checked-out branch is sorted to the top of
  the list. Issues are never hidden — the behavior is sort-emphasis only.
- **`linearLens.openIn.tool`** (`"auto" | "vscode" | "cursor" | "linear" | "custom"`,
  default `"auto"`) — controls where **Open in Coding Tool** opens an issue. `auto` reuses
  the existing agent auto-detect; `linear` always opens the issue URL in the browser;
  `custom` runs the command id in `linearLens.openIn.customCommand`.
- **`linearLens.openIn.customCommand`** (string, default `""`) — VS Code command id run by
  **Open in Coding Tool** when `openIn.tool` is `custom`. Receives `{ id, url }`.
- **`linearLens.write.confirmDestructive`** (boolean, default `true`) — when enabled, a
  confirmation dialog is shown before destructive write actions (removing a blocker relation,
  moving an issue to another team).
- **`linearLens.debug`** (boolean, default `false`) — emit verbose diagnostic output to the
  Linear Lens output channel.
- **`linearLens.openInTool` command** — "Open in Coding Tool" replaces the legacy
  `linearLens.openInAgent` command (which is kept registered as a back-compat alias so
  existing menus and hover links continue to work).

- **`linearLens.hover.showAvatars` / `linearLens.hover.showLabels` /
  `linearLens.hover.showBranchActions`** settings (all default `true`) are now contributed
  in `package.json` and honored by the hover renderer, so each rich-hover section can be
  toggled independently. These were previously documented but not wired up.

### Fixed

- **Rich-hover branch actions now work.** The hover's **Checkout branch** / **View diff**
  links pointed at non-existent command ids (`linearLens.checkoutIssueBranch` /
  `linearLens.viewIssueBranchDiff`); they now invoke the registered
  `linearLens.checkoutBranch` / `linearLens.openBranchDiff` commands.
- **Personal API key set/clear now updates the views immediately.** Setting or clearing a
  key re-publishes the `linearLens.authed` context key, so the sign-in welcome view, the
  view-title Sign in/out actions, and the issue lists refresh without a window reload.
- **Sign-out and API-key changes now show confirmation toasts and refresh the tree views**,
  matching sign-in.
- **"Go to Linear Issue" honors `linearLens.views.recent.limit`** for its seed/search result
  count, as the setting description states.
- **Editor right-click menu** now offers **Copy Issue Link**, and **Open Issue** /
  **Copy Issue Link** resolve the reference under the cursor instead of always prompting.

## [1.1.0] — Elevated hovers + inline status

### Added

- **Rich hover cards** — authenticated hovers now display a full at-a-glance Linear card:
  a color-coded workflow-state dot (using the state's actual hex color), assignee and
  subscriber avatars, issue labels rendered with colored dots, the issue's suggested git
  branch name, and one-click **Checkout** / **View Diff** branch-action links directly from
  the hover.
- **Inline status indicators** (`linearLens.inlineStatus.enable`, default `true`) — a small
  colored dot (or labeled pill, configurable via `linearLens.inlineStatus.style`) appears
  immediately after each issue reference in the editor, reflecting its live workflow-state
  color. Renders nothing when unauthenticated; never shows a misleading neutral dot.
- **Personal API key — first-class authentication path** — the README now prominently
  documents generating a personal key in Linear → Settings → Security & access → Personal
  API keys as the fastest, no-extra-extension way to unlock rich hovers. The key is stored
  in VS Code's encrypted `SecretStorage` and sent only to `api.linear.app`.
- **Hover avatar support** (`linearLens.hover.showAvatars`, default `true`) — stacked
  assignee and subscriber avatars inline in the hover. Falls back to the display name when
  the avatar URL is unavailable or the setting is off.
- **Hover label support** (`linearLens.hover.showLabels`, default `true`) — issue labels
  rendered with a colored dot beside each label name.
- **Hover branch actions** (`linearLens.hover.showBranchActions`, default `true`) — the
  issue's suggested git branch name shown in backticks, with Checkout and View Diff command
  links. Branch names containing `/`, `#`, and `?` are correctly encoded in command URIs.
- **Open in Coding Agent** action (`linearLens.agent.command`) — an optional command id or
  auto-detected Cursor/VS Code agent command, exposed via the **Open in Coding Agent**
  command and the issue tree's context menu.
- **Sign in via Linear Connect** — authenticate with your Linear account by consuming
  Linear's official *Linear Connect* extension (`linear.linear-connect`). No OAuth app to
  register, no client secret, no hosted redirect. Run **Linear Lens: Sign in to Linear**;
  if Linear Connect isn't installed yet, Linear Lens offers to install it (one click), then
  you approve in your browser. Linear Connect is Linear's first-party extension and provides
  the OAuth token — Linear Lens never sees a client secret and hosts no redirect URI.
- **Sign in / Sign out / Show Authentication Status** commands (`linearLens.signIn`,
  `linearLens.signOut`, `linearLens.showAuthStatus`) — manage Linear authentication without
  leaving the editor. **Show Authentication Status** displays whether Linear Connect is
  installed, your current sign-in state, and whether a personal API key is configured.
- **In-editor decorations** — all recognized issue references are now visibly highlighted with
  a dotted underline in the link color, making them stand out at a glance. Controlled by the
  new `linearLens.decorations.enable` setting (default `true`).
- **Custom marker keywords** via `linearLens.markers` (default `["TODO","FIXME","BUG","HACK"]`)
  — the set of actionable marker keywords is now fully configurable. Set custom markers such as
  `["TASK","NOTE"]` and only those keywords will make references actionable; the defaults no
  longer apply unless explicitly included. Markers are matched case-insensitively with word
  boundaries.
- **`linearLens.links.enable`** setting (default `true`) — toggle clickable document links.
- **`linearLens.hover.enable`** setting (default `true`) — toggle hover cards.
- **`linearLens.statusBar.enable`** setting (default `true`) — toggle the branch status bar
  item.
- **`linearLens.api.enable`** now defaults to `true` (was `false`). Acts as a master
  kill-switch: when off, hovers stay basic even when authenticated.

### Changed

- **`linearLens.setApiKey` / `linearLens.clearApiKey`** commands renamed to
  **Set Personal API Key** / **Clear Personal API Key** in the command palette title to
  distinguish them from Linear Connect sign-in.
- The `resolveAuth` callback in the Linear client now supports both OAuth Bearer tokens and
  raw personal API keys transparently — callers do not need to differentiate.
- Hover layout updated: the issue id links to its Linear URL and the ticket title is shown on
  its own line (em-dash separator); the old "Reference" footer text is removed.

### Removed

- **Self-hosted PKCE flow** — sign-in via Linear Connect replaces the previous loopback
  OAuth 2.0 PKCE flow. No OAuth app needs to be registered and no loopback server is run.
- **`linearLens.auth.clientId`** setting — no longer needed; Linear Connect provides the
  OAuth token through Linear's own app.
- **`linearLens.auth.redirectPort`** setting — no longer needed; there is no loopback
  redirect URI to register.

## [0.1.0] - 2026-06-02

Initial release. Linear Lens makes Linear issue IDs like `ENG-123` clickable, hoverable, and
useful inside VS Code. It links the tickets you already have — it does not create tickets from
your TODOs.

### Added

- **Reference detection** for `ABC-123`-shaped issue IDs (2–7 letter team key, 1–6 digit
  number), case-insensitive and normalized to uppercase, plus full `linear.app` issue URLs.
- **Clickable document links** for every detected reference, resolving to your workspace via
  `linearLens.workspaceSlug`.
- **Hovers** with basic issue info always available, and rich live metadata (title, status,
  assignee, priority, project, archived indicator) when a Linear API key is configured.
- **Problems-panel diagnostics for TODO-bound references only** — `TODO`/`FIXME`/`BUG`/`HACK`
  markers and unchecked Markdown tasks (`- [ ] ENG-123 ...`). Raw references such as
  `Fixed in ENG-123` link and hover but are never reported as Problems.
- **Configurable diagnostic severity** via `linearLens.diagnostics.severity`, and a toggle via
  `linearLens.diagnostics.enable`.
- **Current-branch status bar item** that detects the issue ID in your git branch (e.g.
  `allie/eng-123-...`) and opens it in one click.
- **Optional team-key allowlist** (`linearLens.teamKeys`) to eliminate false positives in
  zero-config mode.
- **Optional Linear API integration** (`linearLens.api.enable`) with secure API-key storage in
  VS Code `SecretStorage`, in-memory metadata caching (`linearLens.cache.ttlSeconds`), and
  graceful degradation to basic link/hover behavior when unavailable.
- **Commands:** Configure Workspace Slug, Open Issue…, Copy Issue Link…, Refresh Issue Cache,
  Open Current Branch Issue, Set Linear API Key, and Clear Linear API Key.

[Unreleased]: https://github.com/linear-lens/linear-lens/compare/v1.1.0...HEAD
[1.1.0]: https://github.com/linear-lens/linear-lens/compare/v0.1.0...v1.1.0
[0.1.0]: https://github.com/linear-lens/linear-lens/releases/tag/v0.1.0
