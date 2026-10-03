# Install

Linear Lens is published on [Open VSX](https://open-vsx.org/extension/alliecatowo/linear-lens), the registry used by Cursor, VSCodium and other VS Code forks. It is not on the Visual Studio Marketplace.

## From the editor

Open the Extensions view, search for **Linear Lens** (publisher `alliecatowo`) and install it. Requires an editor compatible with VS Code 1.90 or newer.

If your editor uses the Visual Studio Marketplace (stock VS Code), download the `.vsix` from the [Open VSX page](https://open-vsx.org/extension/alliecatowo/linear-lens) and run **Extensions: Install from VSIX**.

## Set your workspace slug

Run **Linear Lens: Configure Workspace Slug** from the command palette, or set `linearLens.workspaceSlug`. Your slug is the segment in your Linear URL, for example the `acme` in `https://linear.app/acme/...`. Once you sign in, Linear Lens can detect it for you.

Next: [Authentication](/guide/authentication) for rich hovers.

## Build from source

This project uses [mise](https://mise.jdx.dev/) to pin the toolchain and
[pnpm](https://pnpm.io/) for dependencies.

```sh
mise install     # install the pinned toolchain (Node, pnpm, etc.)
pnpm install     # install dependencies
pnpm build       # bundle the extension
```

Then press **F5** in VS Code or Cursor to launch the Extension Development Host with Linear
Lens loaded.


Linear Lens works in both VS Code and Cursor. Sign-in is handled entirely by Linear Connect
(or your personal API key) so there are no editor-scheme workarounds needed.

## Extension Development Host (F5)

1. Open the `linear-lens` folder in VS Code or Cursor.
2. Run `pnpm install && pnpm build` (or `pnpm watch` for live recompilation).
3. Press **F5** to launch the Extension Development Host — a fresh editor window with Linear
   Lens active.
4. Open any file and type `ENG-123` or `TODO: ENG-123` to see links, decorations, and hovers.
   Open a file with `TODO: ENG-123 fix this` and check the Problems panel.

## Install a local build from VSIX

To test as an end-user install:

```sh
pnpm package    # produces linear-lens-<version>.vsix
```

Then run **Extensions: Install from VSIX** in VS Code or Cursor and select the generated file.
