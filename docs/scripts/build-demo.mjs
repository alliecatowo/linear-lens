// Bundles the extension's real reference scanner (src/parser.ts) for the in-browser
// demo on the home page. Run from the repo root after `pnpm install`:
//   node docs/scripts/build-demo.mjs
// The output is committed so the docs build does not need the extension's dependencies.
import esbuild from "esbuild";

await esbuild.build({
  stdin: {
    contents: `import { scanText } from "./src/parser"; window.LinearLensScan = scanText;`,
    resolveDir: process.cwd(),
    loader: "ts",
  },
  bundle: true,
  minify: true,
  format: "iife",
  target: "es2020",
  platform: "browser",
  outfile: "docs/public/demo/scan.js",
});
