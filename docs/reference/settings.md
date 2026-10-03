# Settings

All settings live under the `linearLens.*` namespace.

| Setting | Type | Default | Description |
|---|---|---|---|
| `linearLens.workspaceSlug` | `string` | `""` | Your Linear workspace slug, used to build issue URLs like `https://linear.app/<slug>/issue/ENG-123`. Find it in your Linear URL. |
| `linearLens.teamKeys` | `string[]` | `[]` | Optional allowlist of team keys to recognize (e.g. `["ENG", "DESIGN"]`). When empty, any `ABC-123`-shaped token (2–7 letters) is treated as an issue ID. |
| `linearLens.markers` | `string[]` | `["TODO","FIXME","BUG","HACK"]` | Actionable marker keywords. References on a line containing one of these (case-insensitive, word-bounded) are treated as actionable and can appear in the Problems panel. |
| `linearLens.diagnostics.enable` | `boolean` | `true` | Surface marker-bound Linear references in the Problems panel. Raw references in prose are never reported. |
| `linearLens.diagnostics.severity` | `"error" \| "warning" \| "information" \| "hint"` | `"information"` | Severity used for marker-bound Linear references in the Problems panel. |
| `linearLens.links.enable` | `boolean` | `true` | Turn recognized issue references into clickable document links. |
| `linearLens.hover.enable` | `boolean` | `true` | Show hover cards for issue references. |
| `linearLens.hover.showAvatars` | `boolean` | `true` | Show stacked assignee and subscriber avatars in rich hovers. Falls back to a plain text name when the avatar URL is unavailable. |
| `linearLens.hover.showLabels` | `boolean` | `true` | Show issue labels (with colored dots) in rich hovers. |
| `linearLens.hover.showBranchActions` | `boolean` | `true` | Show the issue's suggested git branch name with Checkout and View Diff action links in rich hovers. |
| `linearLens.inlineStatus.enable` | `boolean` | `false` | Show a small colored status indicator immediately after each issue reference, reflecting its live workflow state. Off by default; the rail is the recommended live-state surface. |
| `linearLens.inlineStatus.style` | `"dot" \| "pill"` | `"dot"` | Style of the inline status indicator: a single colored dot, or a labeled state pill. |
| `linearLens.rail.inline` | `"off" \| "activeLine" \| "allLines"` | `"activeLine"` | Muted end-of-line annotation (`<ID> · <state> · <title>`), GitLens / Error-Lens style. Reads cached metadata; never blocks typing. `activeLine` shows it only on the cursor's line, `allLines` on every reference line. |
| `linearLens.rail.overviewRuler` | `boolean` | `true` | Show status-colored ticks on the scrollbar overview ruler at lines containing a Linear reference. |
| `linearLens.blameHover.enable` | `boolean` | `true` | When you hover a line, look up its last commit via git blame and, if the commit message mentions a Linear issue, show a lightweight `📋 <ID> · View in Linear · Open details` hover entry. Does not fetch the full issue card. |
| `linearLens.decorations.enable` | `boolean` | `true` | Visibly highlight recognized issue references in the editor (dotted underline in the link color). |
| `linearLens.statusBar.enable` | `boolean` | `true` | Show a status bar item for the Linear issue detected in the current git branch. |
| `linearLens.api.enable` | `boolean` | `true` | Fetch live issue metadata for richer hovers when authenticated. Acts as a master kill-switch: when off, hovers stay basic even when a key is set. |
| `linearLens.cache.ttlSeconds` | `number` | `300` | How long (in seconds) to cache fetched issue metadata before refetching. |
| `linearLens.cache.persist` | `boolean` | `true` | Persist fetched issue metadata to this workspace's storage so hovers, pills, and the rail stay instant across editor reloads (stale entries are refreshed in the background). Turn off to keep the cache in memory only. |
| `linearLens.inlineComments.enable` | `boolean` | `true` | Show read-only Linear comment threads inline beside each issue reference, using the native Comments panel. Requires sign-in / a personal API key. |
| `linearLens.edit.enable` | `boolean` | `true` | Show issue-editing actions (Edit Issue, Edit Blockers, status/assignee/labels/team/project/priority/cycle). Turn off to hide all write actions. |
| `linearLens.create.enable` | `boolean` | `true` | Show the **Create Issue** command in the palette and view title bar. Turn off to hide the create action. |
| `linearLens.teams.enable` | `boolean` | `true` | Show the Teams and Active Cycle views in the Linear Lens sidebar. |
| `linearLens.teams.show` | `string[]` | `[]` | Team keys to show in the Teams view (e.g. `["ENG", "DES"]`). Empty = show all accessible teams (filtered by `teams.viewerOnly`). |
| `linearLens.teams.viewerOnly` | `boolean` | `true` | When `teams.show` is empty, show only teams you are a member of (vs. every team in the workspace). |
| `linearLens.teams.autoDetect` | `boolean` | `true` | Detect the signed-in workspace's real team keys and slug (`organization.urlKey`) from Linear and use them for recognition, so only real issue ids are highlighted and a workspace slug is not required to open issues. An explicit `teamKeys` / `workspaceSlug` always overrides detection. |
| `linearLens.views.enable` | `boolean` | `true` | Show the Linear Activity Bar views (Issues in This File, My Issues, Assigned / Recent). |
| `linearLens.views.recent.limit` | `number` | `25` | How many issues to load in the My Issues / Assigned / Recent and search views (clamped to 1–100). |
| `linearLens.board.enable` | `boolean` | `true` | Enable the team Board webview (columns by workflow state, drag a card to change its status). |
| `linearLens.view.defaultGroupBy` | `"none" \| "status" \| "assignee" \| "priority" \| "project" \| "label"` | `"none"` | Default grouping for the issue tree views (My Issues, Assigned / Recent, Teams). |
| `linearLens.view.defaultSortBy` | `"updated" \| "priority" \| "status" \| "created" \| "title" \| "number"` | `"updated"` | Default sort for the issue tree views. |
| `linearLens.worktree.filter` | `"off" \| "currentRepo" \| "currentWorktree"` | `"off"` | How issue lists relate to your current git checkout. Emphasizes (sorts to top) the matching issue rather than hiding others. Useful with multiple worktrees open. |
| `linearLens.openIn.tool` | `"auto" \| "vscode" \| "cursor" \| "linear" \| "custom"` | `"auto"` | Where **Open in Coding Tool** opens an issue. `auto` detects an editor agent; `linear` opens the issue URL; `custom` runs `openIn.customCommand`. |
| `linearLens.openIn.customCommand` | `string` | `""` | Command id run by **Open in Coding Tool** when `openIn.tool` is `custom`. Receives `{ id, url }`. |
| `linearLens.write.confirmDestructive` | `boolean` | `true` | Ask for confirmation before destructive write actions (removing a blocker, moving an issue to another team). |
| `linearLens.agent.command` | `string` | `""` | Optional command id invoked by **Open in Coding Agent** (legacy; prefer `openIn.tool`). Leave empty to auto-detect a Cursor or VS Code agent command. |
| `linearLens.debug` | `boolean` | `false` | Emit verbose diagnostic output to the Linear Lens output channel. |
| `linearLens.copyMarkdown.includeComments` | `boolean` | `false` | Include the comment thread when copying a ticket as Markdown. |
