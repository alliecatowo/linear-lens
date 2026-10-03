# Authentication

Without authentication, Linear Lens still links every issue reference, highlights it, and
shows a hover with a clickable URL. Authentication unlocks rich hovers that show live title,
workflow status (with a color-coded dot), assignee avatar, labels (with their colors), the
suggested git branch name, and quick branch-action links.

Two authentication paths are available. **The personal API key path requires no third-party
extension and works everywhere** — it is the fastest way to get started.

## Option A — Personal API key (recommended, no extra extension needed)

A personal API key is generated directly in your Linear account and is valid for as long as
you keep it. It works in VS Code, Cursor, and any remote or restricted workspace.

1. In Linear, open **Settings → Security & access → Personal API keys** (direct URL:
   `https://linear.app/settings/api`).
2. Click **Create key**, give it a label (e.g. `VS Code`), and copy the generated key.
3. In the editor, run **Linear Lens: Set Personal API Key** from the command palette and
   paste the key. It is stored in VS Code's encrypted `SecretStorage` and sent only to
   `api.linear.app`. It is never written to disk in plaintext.

To remove a stored key, run **Linear Lens: Clear Personal API Key**.

> **Tip:** after setting the key, run **Linear Lens: Refresh Issue Cache** once to drop any
> cached unauthenticated data and immediately see rich hovers.

## Option B — Linear Connect (OAuth, no client secret)

If you prefer OAuth over a static key, Linear Lens can consume an OAuth token from Linear's
official *Linear Connect* extension (`linear.linear-connect`). Linear Connect is Linear's own
first-party extension; Linear Lens never sees a client secret and hosts no redirect URI.

1. Run **Linear Lens: Sign in to Linear** from the command palette.
2. If *Linear Connect* is not installed, click **Install Linear Connect** in the prompt (one
   time only). You may need to reload the window after installation.
3. Approve the request in your browser. The token is stored securely by VS Code and Linear
   Connect. You are now signed in.

To sign out, run **Linear Lens: Sign out of Linear**. If Linear Connect's logout command is
available it is invoked directly; otherwise Linear Lens guides you to the Accounts menu
(bottom-left corner → Linear → Sign Out).

## Fallback behavior

If neither method is configured, Linear Lens **degrades gracefully** to basic link/hover
behavior — it never throws and never blocks your editor.
