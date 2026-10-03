# Development

This project uses [mise](https://mise.jdx.dev/) to pin the toolchain and
[pnpm](https://pnpm.io/) for dependencies.

```sh
mise install     # install the pinned toolchain (Node, pnpm, etc.)
pnpm install     # install dependencies
pnpm build       # bundle the extension
```

Then press **F5** in VS Code or Cursor to launch the Extension Development Host with Linear
Lens loaded.


```sh
pnpm watch       # rebuild on change (run alongside F5)
pnpm test        # run the unit tests (vitest)
pnpm typecheck   # strict TypeScript type checking
```

The parser (`src/parser.ts`) and shared types (`src/types.ts`) are intentionally free of any
`vscode` import so the detection logic can be unit-tested in plain Node.
