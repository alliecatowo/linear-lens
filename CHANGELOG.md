# Changelog

All notable changes to the Linear Lens extension are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- **OAuth 2.0 PKCE sign-in** — authenticate with Linear directly from the editor using a
  loopback redirect (`http://localhost:<port>/callback`). No client secret is ever needed or
  stored; the PKCE flow handles security. Configure your Linear OAuth app's Client ID via
  `linearLens.auth.clientId` and run **Linear Lens: Sign in to Linear**.
- **`linearLens.auth.clientId`** setting — your Linear OAuth application's Client ID.
- **`linearLens.auth.redirectPort`** setting (default `7982`) — local port for the OAuth
  loopback callback. Register `http://localhost:<port>/callback` as a redirect URI in your
  Linear OAuth app (exact match required).
- **Sign in / Sign out / Show Authentication Status** commands (`linearLens.signIn`,
  `linearLens.signOut`, `linearLens.showAuthStatus`) — manage Linear authentication without
  leaving the editor. **Show Authentication Status** displays the exact redirect URI to
  register and your current sign-in state.
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
  distinguish them from OAuth sign-in.
- The `resolveAuth` callback in the Linear client now supports both OAuth Bearer tokens and
  raw personal API keys transparently — callers do not need to differentiate.

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

[Unreleased]: https://github.com/linear-lens/linear-lens/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/linear-lens/linear-lens/releases/tag/v0.1.0
