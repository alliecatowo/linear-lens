# Commands and shortcuts

Available from the command palette (`Ctrl+Shift+P` / `Cmd+Shift+P`):

| Command | Title | Description |
|---|---|---|
| `linearLens.configureWorkspace` | Linear Lens: Configure Workspace Slug | Set the workspace slug used to build issue URLs. |
| `linearLens.openIssue` | Linear Lens: Open Issue… | Type an issue ID (e.g. `ENG-123`) and open it in Linear. |
| `linearLens.copyIssueLink` | Linear Lens: Copy Issue Link… | Copy the Linear URL for an issue ID to the clipboard. |
| `linearLens.refreshCache` | Linear Lens: Refresh Issue Cache | Drop cached issue metadata and re-read auth. |
| `linearLens.openCurrentBranchIssue` | Linear Lens: Open Current Branch Issue | Open the issue detected in the current git branch. |
| `linearLens.signIn` | Linear Lens: Sign in to Linear | Sign in via Linear's official Linear Connect extension (one-click install if needed) or use a personal API key. |
| `linearLens.signOut` | Linear Lens: Sign out of Linear | Sign out of Linear (invokes Linear Connect's logout, or guides you to the Accounts menu). |
| `linearLens.showAuthStatus` | Linear Lens: Show Authentication Status | Show whether Linear Connect is installed, your current sign-in state, and whether a personal API key is set. |
| `linearLens.setApiKey` | Linear Lens: Set Personal API Key | Store a Linear personal API key in VS Code SecretStorage as an alternative to Linear Connect sign-in. |
| `linearLens.clearApiKey` | Linear Lens: Clear Personal API Key | Remove the stored personal API key. |
| `linearLens.searchIssues` | Linear Lens: Go to Linear Issue… | Fuzzy-search your issues (or open one by ID) and jump to it. |
| `linearLens.openTicket` | Linear Lens: Open Issue Detail | Open the in-editor issue detail panel for the reference under the cursor (or a typed ID). |
| `linearLens.refreshViews` | Linear Lens: Refresh Linear Views | Re-fetch the Activity Bar issue views. |
| `linearLens.jumpToNextReference` | Linear Lens: Jump to Next Reference | Move the cursor to the next Linear reference in the file. |
| `linearLens.jumpToPreviousReference` | Linear Lens: Jump to Previous Reference | Move the cursor to the previous Linear reference in the file. |
| `linearLens.revealInLinearView` | Linear Lens: Reveal in Linear View | Reveal the reference under the cursor in the "Issues in This File" view. |
| `linearLens.copyIssueId` | Linear Lens: Copy Issue ID | Copy the normalized issue ID under the cursor to the clipboard. |
| `linearLens.openInTool` | Linear Lens: Open in Coding Tool | Open the issue in the preferred coding tool (see `linearLens.openIn.tool`). Replaces the legacy **Open in Coding Agent** command. |

## Keyboard shortcuts

| Command | Windows / Linux | macOS | When |
|---|---|---|---|
| Open Issue… | `Ctrl+Alt+L` | `Cmd+Alt+L` | Editor focused |
| Go to Linear Issue… | `Ctrl+Alt+F` | `Cmd+Alt+F` | Always |
| Jump to Next Reference | `Ctrl+Alt+]` | `Cmd+Alt+]` | Editor focused, file has references |
| Jump to Previous Reference | `Ctrl+Alt+[` | `Cmd+Alt+[` | Editor focused, file has references |

The full list of commands is in the extension's `contributes.commands` in [package.json](https://github.com/alliecatowo/linear-lens/blob/main/package.json); the editing commands (Set Status, Set Assignee, Edit Labels, Create Issue and so on) appear in the command palette and the sidebar context menus.
