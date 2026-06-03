# Changelog

All notable changes to the Linear Lens extension are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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

[0.1.0]: https://github.com/linear-lens/linear-lens/releases/tag/v0.1.0
