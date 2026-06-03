# Linear Lens — Product Roadmap

Linear Lens connects the Linear tickets you already have, everywhere they appear in your
editor — and now lets you **act on them**: copy a ticket as Markdown for an agent, edit
issue fields, manage blockers, create issues, and work a team board. It always degrades
gracefully when offline or signed out. This document is the committed plan: the product
principles, the phased rollout, and the full surface map (commands, settings, menus,
keybindings, views).

> **Editable update (this run):** the earlier "read-only, never write" rule is REVERSED.
> Writes are now in scope. Mutations require write access; the reliable write path is a
> **personal API key** (full-access by default) because the `linear.linear-connect` OAuth
> session grants only `read`. See §2 "Editable" and the per-phase specs
> `.agent/specs/editable-*.md`.

> Status legend: **Shipped** = in `main` today · **V1.1 / V2 / V3** = earlier planned phases ·
> **Editable** = the current write-enabled phase · **Future** = explicitly deferred.

---

## 1. Product principles

These are load-bearing. Every feature below is judged against them.

1. **Connect first; act deliberately.** Linear Lens connects references that already point
   at real issues, and now also creates/edits them. Every write is explicit and user-initiated
   (a command/menu/drag), never a silent side effect of reading.
2. **Writes require write access, surfaced honestly.** Reads use the `read` OAuth session (or a
   personal key). WRITES require full access: a **personal API key** is the reliable path because
   `linear.linear-connect` grants only `read`; we also opportunistically try an OAuth
   `["read","write"]` session when the user opts in. Every write command calls `ensureWriteAuth()`
   first and, if absent, prompts to set a key or try write sign-in — and aborts gracefully if
   declined. The Linear client NEVER throws; mutations return a typed result or `null` and surface
   Linear permission/errors as toasts.
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

### Editable — Write actions  *(current run; specs: `.agent/specs/editable-*.md`)*

Make Linear Lens act on issues, keeping the codebase LEAN: extend the existing GraphQL client
with mutations (do **NOT** add `@linear/sdk`); no VS Code agentic/AI features.

- **Copy ticket as Markdown** (READ): from hover, tree, webview, palette → clipboard, ready to
  paste into an agent. Pure, tested formatter (`src/format/copyMarkdown.ts`).
- **Edit issues**: status, assignee, labels, team, project, priority, cycle — via QuickPick
  flows backed by picker read queries + `issueUpdate`.
- **Blockers**: add/remove blocking / blocked-by relations (`issueRelationCreate`/`Delete`;
  "blocked by" is modeled as the other issue `blocks` this one).
- **Create issues**: title, description, team, project, priority, labels, assignee, cycle
  (`issueCreate`), via a stepwise wizard.
- **Teams sidebar** (filterable by `linearLens.teams.show`) + a team's issues; a **team Board
  webview** (columns by workflow state; drag a card to change status — a gated write).
- **Cycle view** (the active cycle's issues for a team).
- **Grouping / filtering / sorting / saved views** in the trees (pure transform pipeline,
  persisted to `globalState`).
- **Granular settings**: which teams to show, per-feature enable toggles
  (`edit`/`create`/`teams`/`board`), worktree filtering behavior, open-in-preferred-tool.
- **Open in preferred coding tool** (best-effort; Linear may not expose it — URL fallback).

**Write-auth model (critical):** `hasWriteAuth()` = (a personal API key is set) OR (an OAuth
session whose scopes include `write`). `ensureWriteAuth()` prompts to set a key or try write
sign-in when absent. Mutations use a write-preferring auth resolver (personal key first).

**Hard safety rule:** no real Linear mutations during implementation/verification — mutation code
paths are unit-tested with MOCKED clients only (injected `fetch`). Live write testing is the
user's. Every write command is `ensureWriteAuth()`-gated and flagged in the specs.

**No AI/agentic features in the extension.** "Open in agent" and "Copy as Markdown" hand off to
external tools; Linear Lens itself runs no models and adds no chat surfaces.

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
| `linearLens.checkoutBranch` | Checkout Issue Branch | V1.1 | arg: `{ id, branchName }` (SHIPPED id; was drafted as `checkoutIssueBranch`) |
| `linearLens.openBranchDiff` | Open Issue Branch Diff | V1.1 | arg: `{ id, branchName }` (SHIPPED id; was drafted as `viewIssueBranchDiff`) |
| `linearLens.openInAgent` | Open in Coding Agent | V1.1 | arg: `{ id }`; hidden if none |
| `linearLens.searchIssues` | Go to Linear Issue… | V2 | fuzzy quick-pick (SHIPPED title; drafted as "Search Issues…") |
| `linearLens.jumpToNextReference` | Jump to Next Reference | V2 | active editor |
| `linearLens.jumpToPreviousReference` | Jump to Previous Reference | V2 | active editor |
| `linearLens.revealInLinearView` | Reveal in Linear View | V2 | context menu |
| `linearLens.refreshViews` | Refresh Linear Views | V2 | tree title bar |
| `linearLens.openTicket` | Open Issue Detail | V3 | arg: `{ id }`; opens webview (SHIPPED id; was drafted as `openIssueDetail`) |
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

> **`write.enable` is RETIRED.** The old Future "preview" stub is replaced by the granular
> Editable toggles `edit.enable` / `create.enable` / `board.enable` / `teams.enable` (see §5.2 and
> `editable-settings.md §1`). Do NOT contribute a `linearLens.write.enable` setting — there is no
> single master write toggle; `api.enable` already gates all network (writes included).

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
| `commandPalette` | hide arg-only commands (checkoutBranch/openBranchDiff/openInAgent/revealFileRef) via `when: false`. NOTE: shipped `package.json` hides checkoutBranch/openBranchDiff/openInAgent/revealFileRef; `openTicket` is palette-visible (it prompts for an id). | V1.1+ |

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
| webview panel (detail) | `linearLens.ticketDetail` (SHIPPED webview type id in `webview/ticketPanel.ts`; created on demand, not a contribution) | V3 |

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

---

## 5. Editable phase — surface map + architecture (specs: `.agent/specs/editable-*.md`)

### 5.1 New commands

| Command id | Title | Write? | Spec |
|---|---|---|---|
| `linearLens.copyAsMarkdown` | Copy as Markdown | read | foundation |
| `linearLens.createIssue` | Create Issue… | **write** | foundation/edit |
| `linearLens.editIssue` | Edit Issue… | **write** | edit |
| `linearLens.setStatus` / `setAssignee` / `editLabels` / `setTeam` / `setProject` / `setPriority` / `setCycle` | (field sub-flows) | **write** | edit |
| `linearLens.editBlockers` | Edit Blockers… | **write** | edit |
| `linearLens.openTeamBoard` | Open Team Board | read (drag = write) | board |
| `linearLens.openCycle` | Open Active Cycle | read | board |
| `linearLens.view.groupBy` / `sortBy` / `filter` / `clearFilter` / `saveAs` / `openSaved` / `deleteSaved` | view controls | read | board |
| `linearLens.openInTool` | Open in Coding Tool | read | settings |

Every **write** command calls `ensureWriteAuth()` first (foundation §1) and aborts gracefully if
declined. `setStatus`…`setCycle` are dispatched from `editIssue` and hidden from the palette via
`when:false` (open decision).

### 5.2 New settings (`linearLens.*`)

`edit.enable` (true), `create.enable` (true), `copyMarkdown.includeComments` (false), `debug`
(false), `teams.enable` (true), `teams.show` (`[]`), `teams.viewerOnly` (true), `board.enable`
(true), `view.defaultGroupBy` (`none`), `view.defaultSortBy` (`updated`), `worktree.filter`
(`off`), `openIn.tool` (`auto`), `openIn.customCommand` (`""`), `write.confirmDestructive` (true).
Full table + JSON in `editable-settings.md §1/§5`.

### 5.3 New views

`linearLens.viewTeams` ("Teams", filterable). Team Board + Cycle are command-driven
`WebviewPanel`s, not view contributions.

### 5.4 GraphQL operations (NO `@linear/sdk` — extend the existing client)

- **Mutations:** `issueCreate(IssueCreateInput!)`, `issueUpdate(id, IssueUpdateInput!)` with
  `stateId`/`assigneeId`/`labelIds`/`teamId`/`projectId`/`priority`/`cycleId`,
  `issueRelationCreate(IssueRelationCreateInput!)` (type `blocks`), `issueRelationDelete(id)`.
  `labelIds` is a FULL REPLACE; "blocked by" = the other issue `blocks` this one.
- **Picker reads:** `teams`, `viewer.teamMemberships`, `workflowStates(team)`, `issueLabels(team)`,
  `users(active)`, `cycles(team)`, `projects`, plus an `IssueEditContext` query
  (uuid + team + labels + relations/inverseRelations) and `TeamIssues`/`CycleIssues` list queries.
  All paginated `first:`-capped, defensive, mapped through pure mappers.
- **Every selected field MUST be validated against the live schema before merge** — a single wrong
  field nulls the whole response, and the client collapses to `null`/error (gate a one-line
  diagnostic behind `linearLens.debug`).

### 5.5 Architecture deltas (editable)

- **Pure (no `vscode`), unit-tested:** `src/linearMutations.ts` (mutations + picker queries +
  mappers + `classifyGraphqlError` + `runMutation` with injected `fetch`), `src/format/copyMarkdown.ts`,
  `src/edit/editFlow.ts`, `src/edit/blockerFlow.ts`, `src/edit/createFlow.ts`,
  `src/board/boardModel.ts`, `src/board/boardProtocol.ts`, `src/views/viewState.ts`,
  `src/views/teamsConfig.ts`, `src/git/worktree.ts`, `src/branch/openIn.ts`, plus the four
  `normalize*` config validators.
- **`vscode` modules:** `src/writeAuth.ts` (`hasWriteAuth`/`ensureWriteAuth`), `src/writeFeedback.ts`
  (`showWriteError`/`showWriteSuccess`/`confirmDestructive`), `src/log.ts` (debug channel),
  `src/commands/{copyCommands,editCommands,createCommand}.ts`, `src/views/teamsProvider.ts`,
  `src/views/savedViews.ts`, `src/board/boardPanel.ts`; deltas to `linearClient.ts` (new client
  methods + `invalidate(id)` + `resolveWriteAuth`), `extension.ts` (resolver + registrars),
  `auth.ts` (`getLinearWriteOAuthHeader`), `config.ts`/`types.ts` (settings + result types),
  `hoverProvider.ts`/`ticketPanel.ts`/`treeItem.ts` (copy/edit entry points).
- **`@linear/sdk` is explicitly NOT added.** **No AI/agentic features.**

### 5.6 Write-auth gate checklist (do not ship without)

1. `ensureWriteAuth()` called FIRST in every write command; declined → abort, no toast spam.
2. Mutations use the write-preferring resolver (personal key first); reads keep current priority.
3. Client never throws; `LinearWriteResult` carries `permission`/`validation`/`notFound`/`network`/
   `noAuth`/`noWriteScope`/`apiDisabled` so toasts are precise.
4. NO real writes in implementation/verification — mocked `fetch` only.
5. `invalidate(id)` (not `clearCache()`) after a successful write, then refresh UI/views/detail.
6. Menus/views gated by `config.linearLens.<feature>.enable` AND `linearLens.authed`, but the
   command STILL re-checks at runtime.
