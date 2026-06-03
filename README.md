# Linear Lens

Make Linear issue IDs like `ENG-123` clickable, hoverable, and useful inside VS Code and Cursor.

Linear Lens recognizes Linear issue references wherever they appear — in code comments,
commit-message buffers, Markdown, and even your current git branch name — and turns them
into rich, clickable links with informative hovers. Stop copy-pasting issue IDs into your
browser; just click them where you already are.

## What it does

Linear Lens **links the tickets you already have**. It scans the text you are reading and
makes every recognized issue reference actionable:

- **Clickable links** — `ENG-123` becomes a document link straight to your Linear workspace.
- **Hovers** — hover any reference to see the issue at a glance. With Linear sign-in or an
  optional personal API key, hovers show live title, status, assignee, priority, and project.
- **In-editor decorations** — recognized references are subtly highlighted (dotted underline)
  directly in the editor so they stand out at a glance.
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
- Only references **bound to a marker keyword** (configurable via `linearLens.markers`,
  defaulting to `TODO`/`FIXME`/`BUG`/`HACK`) or an unchecked Markdown task
  (`- [ ] ENG-123 ...`) appear in Problems, because those represent outstanding work.

In short: every reference links and hovers; only actionable, marker-bound references become
diagnostics.

## Features

- Detects `ABC-123`-shaped issue IDs (2–7 letter team key, 1–6 digit number), case-insensitive.
- Recognizes full `linear.app` issue URLs and links them directly.
- Classifies each reference as actionable (`todo`) or informational (`raw`/`url`).
- Clickable `DocumentLink`s for every reference.
- In-editor decorations that visibly highlight all issue references.
- Hover cards with basic info always; rich live metadata when signed in or a personal API key
  is configured.
- Problems-panel diagnostics for marker-bound references only, with configurable severity and
  custom marker keywords.
- Status bar item for the current branch's issue, with a one-click open command.
- Optional team-key allowlist to eliminate false positives in zero-config mode.
- OAuth 2.0 PKCE sign-in (no client secret required) and personal API key as a simpler
  alternative; both **degrade gracefully** when unavailable.

## Supported syntax

Linear Lens recognizes all of the following:

| Example | What happens |
|---|---|
| `ENG-123` | Linked + decorated + hover (raw reference) |
| `eng-123` | Linked + decorated + hover; normalized to `ENG-123` |
| `Fixed in ENG-123` | Linked + decorated + hover only — **never** a Problem |
| `TODO: ENG-123 fix retry logic` | Linked + decorated + hover + Problem (`TODO`) |
| `TODO ENG-123: fix retry logic` | Linked + decorated + hover + Problem (`TODO`) |
| `TODO: fix retry logic in ENG-123` | Linked + decorated + hover + Problem (`TODO`) |
| `FIXME ENG-124 handle null user` | Linked + decorated + hover + Problem (`FIXME`) |
| `// BUG ENG-9 leaks memory` | Linked + decorated + hover + Problem (`BUG`) |
| `# HACK ABC-1 workaround` | Linked + decorated + hover + Problem (`HACK`) |
| `- [ ] ENG-123 fix auth redirect` | Linked + decorated + hover + Problem (unchecked task) |
| `- [x] ENG-200 done` | Linked + decorated + hover only — checked task is not actionable |
| `https://linear.app/acme/issue/ENG-123/fix-auth` | Linked + decorated + hover (URL reference) |
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

Then press **F5** in VS Code or Cursor to launch the Extension Development Host with Linear
Lens loaded.

To use it, set your workspace slug so links resolve to the right Linear workspace: run
**Linear Lens: Configure Workspace Slug** from the command palette, or set
`linearLens.workspaceSlug` in your settings. Your slug is the segment in your Linear URL,
e.g. the `acme` in `https://linear.app/acme/...`.

## Sign in with Linear (OAuth / PKCE)

Linear Lens supports OAuth 2.0 PKCE sign-in — **no client secret is ever needed or stored.**
The entire flow uses a short-lived loopback server (`http://localhost:<port>/callback`) so it
works reliably even in Cursor without any editor-scheme workarounds.

### One-time OAuth app setup (in Linear)

1. Go to **Linear → Settings → API → OAuth applications** and click **Create application**.
2. Give it a name (e.g. "Linear Lens (local)"). Scopes: **read**.
3. Under **Redirect URIs**, add `http://localhost:7982/callback` (or whatever port you set for
   `linearLens.auth.redirectPort`). The URI must be an exact match.
4. Copy the **Client ID** shown on the app's page. You do **not** need the Client Secret.

> Run **Linear Lens: Show Authentication Status** at any time to see the exact redirect URI you
> need to register, together with whether a Client ID is configured and your sign-in state.

### Sign in

1. Set `linearLens.auth.clientId` to the Client ID you copied above.
2. Run **Linear Lens: Sign in to Linear** from the command palette.
3. Linear opens in your browser; approve the request. Linear Lens captures the callback,
   exchanges the code (PKCE — no secret), and stores the token securely in VS Code
   `SecretStorage`. You are now signed in.

### Sign out

Run **Linear Lens: Sign out of Linear**. The stored token is revoked and removed.

### Personal API key as an alternative

If you do not want to create an OAuth application, you can supply a personal API key instead:

1. Set `linearLens.api.enable` to `true`.
2. Run **Linear Lens: Set Personal API Key** and paste a Linear personal API key. The key is
   stored securely in VS Code's `SecretStorage` and sent only to `api.linear.app`.

Run **Linear Lens: Clear Personal API Key** to remove a stored key, and
**Linear Lens: Refresh Issue Cache** to drop cached metadata and re-read auth.

If neither method is configured, Linear Lens **degrades gracefully** to basic link/hover
behavior — it never throws and never blocks your editor.

## Testing in Cursor / VS Code

Linear Lens works in both VS Code and Cursor. The loopback OAuth redirect avoids any
editor-scheme issues and works the same way in either editor.

### Extension Development Host (F5)

1. Open the `linear-lens` folder in VS Code or Cursor.
2. Run `pnpm install && pnpm build` (or `pnpm watch` for live recompilation).
3. Press **F5** to launch the Extension Development Host — a fresh editor window with Linear
   Lens active.
4. Open any file and type `ENG-123` or `TODO: ENG-123` to see links, decorations, and hovers.
   Open a file with `TODO: ENG-123 fix this` and check the Problems panel.

### Install from VSIX

To test as an end-user install:

```sh
pnpm package    # produces linear-lens-<version>.vsix
```

Then run **Extensions: Install from VSIX** in VS Code or Cursor and select the generated file.

## Configuration

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
| `linearLens.decorations.enable` | `boolean` | `true` | Visibly highlight recognized issue references in the editor (dotted underline in the link color). |
| `linearLens.statusBar.enable` | `boolean` | `true` | Show a status bar item for the Linear issue detected in the current git branch. |
| `linearLens.api.enable` | `boolean` | `true` | Fetch live issue metadata (title, status, assignee, priority, project) for richer hovers when signed in or a personal API key is set. Acts as a master kill-switch: when off, hovers stay basic even when authenticated. |
| `linearLens.cache.ttlSeconds` | `number` | `300` | How long (in seconds) to cache fetched issue metadata before refetching. |
| `linearLens.auth.clientId` | `string` | `""` | Your Linear OAuth application's Client ID (from Linear → Settings → API → OAuth applications). Required to sign in with Linear. No client secret is needed — the PKCE flow is used. |
| `linearLens.auth.redirectPort` | `number` | `7982` | Local loopback port for the OAuth callback. Register `http://localhost:<port>/callback` as a redirect URI in your Linear OAuth app (exact match required). Run **Show Authentication Status** to see the exact URL. |

## Commands

Available from the command palette (`Ctrl+Shift+P` / `Cmd+Shift+P`):

| Command | Title | Description |
|---|---|---|
| `linearLens.configureWorkspace` | Linear Lens: Configure Workspace Slug | Set the workspace slug used to build issue URLs. |
| `linearLens.openIssue` | Linear Lens: Open Issue… | Type an issue ID (e.g. `ENG-123`) and open it in Linear. |
| `linearLens.copyIssueLink` | Linear Lens: Copy Issue Link… | Copy the Linear URL for an issue ID to the clipboard. |
| `linearLens.refreshCache` | Linear Lens: Refresh Issue Cache | Drop cached issue metadata and re-read auth. |
| `linearLens.openCurrentBranchIssue` | Linear Lens: Open Current Branch Issue | Open the issue detected in the current git branch. |
| `linearLens.signIn` | Linear Lens: Sign in to Linear | Authenticate with Linear via OAuth 2.0 PKCE (no client secret). Requires `linearLens.auth.clientId`. |
| `linearLens.signOut` | Linear Lens: Sign out of Linear | Revoke and remove all stored Linear OAuth tokens. |
| `linearLens.showAuthStatus` | Linear Lens: Show Authentication Status | Display the exact redirect URI to register, whether a Client ID is set, and your current sign-in state. |
| `linearLens.setApiKey` | Linear Lens: Set Personal API Key | Store a Linear personal API key in VS Code SecretStorage as an alternative to OAuth sign-in. |
| `linearLens.clearApiKey` | Linear Lens: Clear Personal API Key | Remove the stored personal API key. |

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
