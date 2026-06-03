# Linear Lens — Product Roadmap

Linear Lens **links the Linear tickets you already have**, everywhere they appear in your
editor. It never creates tickets, never writes to Linear (this run), and always degrades
gracefully when offline or signed out. This document is the committed plan: the product
principles, the phased rollout, and the full surface map (commands, settings, menus,
keybindings, views).

> Status legend: **Shipped** = in `main` today · **V1.1 / V2 / V3** = planned phases ·
> **Future** = explicitly deferred (e.g. write actions).

---

## 1. Product principles

These are load-bearing. Every feature below is judged against them.

1. **Link, never create.** Linear Lens connects references that already point at real
   issues. It does not turn TODOs into tickets and (this run) never mutates Linear.
2. **Read-only, for now.** We request only the `read` scope. Write actions (status
   changes, comments, assignment) are a *Future* phase that needs OAuth **write** scope —
   we scaffold the seams but ship nothing that writes.
3. **Never throw, always degrade.** Auth missing, network down, API disabled → fall back
   to basic link/hover/tree behavior. The editor is never blocked. The Linear client is
   defensive end to end and tolerates nulls in every GraphQL field.
4. **The Problems panel stays signal-rich.** Only marker-bound (`TODO`/`FIXME`/…/unchecked
   task) references become diagnostics. Raw prose references and URLs link + hover but are
   never reported. This is the single most important behavior in the product.
5. **Pure core stays pure.** `src/parser.ts` and `src/types.ts` import no `vscode` and are
   unit-tested in plain Node. All new pure logic (formatters, GraphQL mappers, tree models)
   lives in vscode-free modules so it stays testable.
6. **Single responsibility per module.** Providers, the client, the webview, and the tree
   each own one job and receive their dependencies via constructor injection (`getCfg`,
   `client`, …) — exactly as the existing modules do.
7. **Don't reinvent Linear's web UI.** We surface a focused, beautiful read view and quick
   actions; for anything deep we open Linear (or the configured coding agent).
8. **Tasteful ubiquity.** Expose Linear in many surfaces — palette, context menus,
   keybindings, status bar, Activity Bar, hovers — but each must earn its place and respect
   its enable/disable setting.
9. **Auth is layered and prominent.** OAuth via Linear's first-party *Linear Connect*
   provider is the headline path; the **personal API key** (user-scoped) path is solid,
   documented, and offered at every relevant fork.

---

## 2. Phased plan

### Shipped (today, v0.1.0)

Parser + classification, document links, basic & rich hovers, marker-bound diagnostics,
branch status bar, in-editor decorations, full settings surface, and authentication by
consuming Linear's first-party `linear` provider (`linear.linear-connect`) with a personal
API key fallback. The Linear client fetches `identifier/title/state{name,type}/assignee{name}/
priorityLabel/project{name}/url/archivedAt` by team key + number, cached with a TTL.

### V1.1 — The hover, elevated  *(spec: `.agent/specs/v1_1-hover.md`)*

Make the hover the best read-at-a-glance card in any editor, plus an inline status pill.

- **Extended metadata**: collaborators/subscribers, creator, labels (with hex colors),
  state color, description, branch name, comments + attachments (fetched once, reused by V3).
- **Multi-avatar stack**: assignee + subscribers rendered as small round avatars via
  markdown images (GitHub-style), with a `+N` overflow.
- **Status with its real color**: a colored dot/swatch built from `state.color`, then the
  state name; priority and project on a clean row; labels as colored chips.
- **Branch row**: show `issue.branchName` with **Checkout** and **View Diff** command links.
- **Open in coding agent**: an "Open in <agent>" button when Linear exposes the workspace's
  configured coding tool (best-effort; hidden when absent).
- **Remove the confusing "Reference" footer**; replace with a quiet, useful action row.
- **Inline status pill**: a small colored circle / state pill decoration rendered right
  after each highlighted id, reflecting the live state color (debounced, cache-backed).

### V2 — Surfaces everywhere  *(spec: `.agent/specs/v2-surfaces.md`)*

Put Linear where the developer already is.

- **Activity Bar view container** ("Linear") with tree views:
  - **Issues in This File** — the file-found references as a TODO-style tree showing code
    context (line text) + Linear primitives (state dot, title, assignee).
  - **My Issues** — issues assigned to the signed-in viewer.
  - **Assigned / Recent** — recently updated / created issues (the "recent" working set).
- Clicking a node opens the issue (V2: external/Linear; V3: the detail webview).
- **Quick-pick search / go-to / jump**: a fuzzy issue picker (`linearLens.searchIssues`)
  and "jump to next/previous reference in file".
- **Context menus, keybindings, and palette** wired for the common actions (open, copy,
  checkout branch, reveal in tree).
- **Branch checkout / diff** plumbing (a thin git module) shared by the hover and the tree.

### V3 — The webview "panel of panes" + AI-light  *(spec: `.agent/specs/v3-webview.md`)*

A clean, split read view — like the GitHub Pull Requests extension, but calmer.

- **Detail webview** with panes: description (rendered markdown), properties (state, assignee,
  priority, project, labels, dates), comments (author avatars + bodies), attachments/images.
- **Typed message protocol** between the extension host and the webview (CSP-locked, nonce'd).
- **AI-light**: "Open in <coding agent>" and branch checkout/diff promoted into the webview
  header; deep-link into Cursor/VS Code agent surfaces where available.
- Reuses the V1.1 extended metadata fetch — no new query shapes beyond comments/attachments.

### Future — Write actions  *(flagged, not built this run)*

Status changes, assignment, comments, creating sub-tasks. **Requires OAuth `write` scope**
(we request only `read` today) and personal API keys with write capability. We scaffold:
- a `LinearWriteClient` interface stub (no implementation),
- a `linearLens.write.enable` setting (default `false`, hidden behind a "preview"),
- a centralized `requiresWriteScope()` guard that explains the missing scope and offers to
  re-authenticate. Nothing in V1.1–V3 calls it.

---

## 3. Surface map

### 3.1 Commands

| Command id | Title | Phase | Notes |
|---|---|---|---|
| `linearLens.configureWorkspace` | Configure Workspace Slug | Shipped | |
| `linearLens.openIssue` | Open Issue… | Shipped | |
| `linearLens.copyIssueLink` | Copy Issue Link… | Shipped | |
| `linearLens.refreshCache` | Refresh Issue Cache | Shipped | also refreshes trees in V2 |
| `linearLens.openCurrentBranchIssue` | Open Current Branch Issue | Shipped | |
| `linearLens.signIn` | Sign in to Linear | Shipped | |
| `linearLens.signOut` | Sign out of Linear | Shipped | |
| `linearLens.showAuthStatus` | Show Authentication Status | Shipped | |
| `linearLens.setApiKey` | Set Personal API Key | Shipped | personal, user-scoped |
| `linearLens.clearApiKey` | Clear Personal API Key | Shipped | |
| `linearLens.checkoutIssueBranch` | Checkout Issue Branch | V1.1 | arg: `{ id, branchName }` |
| `linearLens.viewIssueBranchDiff` | View Issue Branch Diff | V1.1 | arg: `{ id, branchName }` |
| `linearLens.openInAgent` | Open in Coding Agent | V1.1 | arg: `{ id }`; hidden if none |
| `linearLens.searchIssues` | Search Issues… | V2 | fuzzy quick-pick |
| `linearLens.jumpToNextReference` | Jump to Next Reference | V2 | active editor |
| `linearLens.jumpToPreviousReference` | Jump to Previous Reference | V2 | active editor |
| `linearLens.revealInLinearView` | Reveal in Linear View | V2 | context menu |
| `linearLens.refreshViews` | Refresh Linear Views | V2 | tree title bar |
| `linearLens.openIssueDetail` | Open Issue Detail | V3 | arg: `{ id }`; opens webview |
| `linearLens.copyIssueId` | Copy Issue ID | V2 | tree/editor context |
| `linearLens.revealFileRef` | Reveal File Reference | V2 | arg-only `{ line }`; palette-hidden |

### 3.2 Settings (`linearLens.*`)

| Setting | Type | Default | Phase |
|---|---|---|---|
| `workspaceSlug` | string | `""` | Shipped |
| `teamKeys` | string[] | `[]` | Shipped |
| `markers` | string[] | `["TODO","FIXME","BUG","HACK"]` | Shipped |
| `diagnostics.enable` | boolean | `true` | Shipped |
| `diagnostics.severity` | enum | `information` | Shipped |
| `links.enable` | boolean | `true` | Shipped |
| `hover.enable` | boolean | `true` | Shipped |
| `decorations.enable` | boolean | `true` | Shipped |
| `statusBar.enable` | boolean | `true` | Shipped |
| `api.enable` | boolean | `true` | Shipped |
| `cache.ttlSeconds` | number | `300` | Shipped |
| `hover.showAvatars` | boolean | `true` | V1.1 |
| `hover.showLabels` | boolean | `true` | V1.1 |
| `hover.showBranchActions` | boolean | `true` | V1.1 |
| `inlineStatus.enable` | boolean | `true` | V1.1 |
| `inlineStatus.style` | enum `dot`/`pill` | `dot` | V1.1 |
| `views.enable` | boolean | `true` | V2 |
| `views.recent.limit` | number | `25` | V2 |
| `agent.command` | string | `""` | V1.1 | optional override for "Open in agent" |
| `detail.openOn` | enum `webview`/`linear` | `linear` until V3, then `webview` | V3 | see note below |
| `detail.openColumn` | enum `active`/`beside` | `active` | V3 | optional; where the detail panel opens |
| `debug` | boolean | `false` | V1.1 | log GraphQL `errors`/auth diagnostics to a "Linear Lens" output channel |
| `write.enable` | boolean | `false` | Future | preview; no effect until write scope ships |

> **`detail.openOn` default rule:** the contributed default in `package.json` is `"webview"`,
> but until V3 ships there is no webview, so the command layer MUST treat any value as `"linear"`
> (open the URL) in V1.1/V2. Document this so an early-set default does not point at a missing
> panel. Do NOT contribute the `webview` enum value before V3, or settings UI offers a dead option.

### 3.3 Menus

| Menu | Item(s) | Phase |
|---|---|---|
| `editor/context` (gated `editorTextFocus && linearLens.refUnderCursor`) | Open Issue, Copy Issue ID, Reveal in Linear View | V2 |
| `view/title` (Linear views) | Refresh Linear Views, Search Issues; Sign in (`!authed`) / Sign out (`authed`) | V2 |
| `view/item/context` (tree node `viewItem == linearIssue`) | Open in Linear, Open Issue Detail (V3), Copy Issue Link, Checkout Issue Branch | V2 |
| `commandPalette` | hide arg-only commands (checkout/diff/openInAgent/openIssueDetail/revealFileRef) via `when: false` | V1.1+ |

### 3.4 Keybindings (defaults; all `when: editorTextFocus`)

| Key (mac / win-linux) | Command | Phase |
|---|---|---|
| `cmd+alt+l` / `ctrl+alt+l` | `linearLens.openIssue` | V2 |
| `cmd+alt+]` / `ctrl+alt+]` | `linearLens.jumpToNextReference` | V2 |
| `cmd+alt+[` / `ctrl+alt+[` | `linearLens.jumpToPreviousReference` | V2 |
| `cmd+alt+f` / `ctrl+alt+f` | `linearLens.searchIssues` | V2 |

### 3.5 Views & view containers

| Contribution | id | Phase |
|---|---|---|
| `viewsContainers.activitybar` | `linearLens` (icon `media/linear.svg`, title "Linear") | V2 |
| view: Issues in This File | `linearLens.viewFile` | V2 |
| view: My Issues | `linearLens.viewMine` | V2 |
| view: Assigned / Recent | `linearLens.viewRecent` | V2 |
| webview panel (detail) | `linearLens.issueDetail` (created on demand, not a contribution) | V3 |

### 3.6 `viewsWelcome` (empty/unauth states)

| View | When | Content | Phase |
|---|---|---|---|
| `linearLens.viewMine` | `!linearLens.authed` | "Sign in to Linear…" + Sign in / Set API key links | V2 |
| `linearLens.viewRecent` | `!linearLens.authed` | "Sign in to Linear…" + Sign in link | V2 |
| `linearLens.viewFile` | (always; empty file) | "No Linear references found…" + configure-slug link | V2 |

### 3.7 Context keys (custom, set via `setContext`)

| Key | Meaning | Set on | Phase |
|---|---|---|---|
| `linearLens.authed` | a credential is present & API enabled | activation, refreshAuth, session change, key set/clear | V2 |
| `linearLens.refUnderCursor` | primary selection is on a reference | selection/active-editor change (debounced) | V2 |
| `linearLens.hasRefs` | active doc has ≥1 reference | active-editor/document change (debounced) | V2 |

These drive the `viewsWelcome` prompts, the view/title Sign in/out toggle, the `editor/context`
gating, and the jump keybindings. Without them, signed-out users see empty trees and the
right-click menu is cluttered/inert — the "unfinished" failure mode.

---

## 4. Architecture deltas at a glance

- **Pure additions** (no `vscode`): `src/format/hover.ts` (markdown builders),
  `src/format/color.ts` (hex → contrast/swatch helpers), `src/linear/issueMapper.ts`
  (GraphQL node → `IssueMetadata`), `src/views/issueTreeModel.ts` (tree node shapes).
- **vscode modules**: extend `linearClient.ts` (richer query + viewer/list queries + `peekIssue`
  sync cache peek + `invalidate(id)`), `providers/hoverProvider.ts`; add `log.ts` (shared
  output channel, gated by `linearLens.debug`), `decorations/inlineStatus.ts`,
  `git/branchActions.ts`, `agent/openInAgent.ts` (V1.1); `views/*TreeProvider.ts`,
  `views/treeItem.ts`, `search/issueQuickPick.ts` (V2); `webview/issueDetailPanel.ts`,
  `webview/nonce.ts`, `linear/writeClient.ts` (stub) + `media/*` (V3). Context keys
  (`linearLens.authed`/`refUnderCursor`/`hasRefs`) are set from `extension.ts` via `setContext`.
- **types.ts** grows `IssueMetadata` (collaborators, labels, branchName, comments,
  attachments, stateColor, description, creator), plus `IssueListItem`, `IssueComment`,
  `IssueLabel`, `Avatar`, and a `LinearListClient` extension. All optional/nullable-tolerant.
- **Single new GraphQL query** for the detail/hover fetch; two list queries + one search query
  for V2 (viewer-assigned + recently-updated + full-text). All defensive; all map through
  `issueMapper.ts`. **Use `searchIssues(term:)` — `issueSearch(query:)` is deprecated.** Validate
  every selected field against the live schema before merge; a single wrong field nulls the whole
  response and the client returns `[]`/`null`, so regressions are SILENT (gate a one-line
  diagnostic behind `linearLens.debug`).
- **Failure-reason seam (recommended, not blocking):** `fetchIssue`/`listIssues` currently
  collapse every failure to `null`/`[]`. V3's error states want to distinguish noAuth /
  apiDisabled / notFound / network. V3 computes this host-side from config+auth without changing
  signatures; a cleaner future refactor is a typed result (`{ ok }` | `{ reason }`) — see the
  per-phase specs + ADDENDUM.

See the per-phase specs for exact file contracts and signatures:
`.agent/specs/v1_1-hover.md`, `.agent/specs/v2-surfaces.md`, `.agent/specs/v3-webview.md`.
