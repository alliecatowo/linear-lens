import esbuild from "esbuild";

const production = process.argv.includes("--production");
const watch = process.argv.includes("--watch");

/**
 * Emits the marker lines VS Code's background problem matcher latches onto so a
 * watch task reports "started"/"finished" correctly (and reports build errors).
 * @type {import('esbuild').Plugin}
 */
const problemMatcherPlugin = {
  name: "linear-lens-problem-matcher",
  setup(build) {
    build.onStart(() => {
      console.log("[watch] build started");
    });
    build.onEnd((result) => {
      for (const { text, location } of result.errors) {
        console.error(`✘ [ERROR] ${text}`);
        if (location) {
          console.error(`    ${location.file}:${location.line}:${location.column}:`);
        }
      }
      console.log("[watch] build finished");
    });
  },
};

/** @type {import('esbuild').BuildOptions} */
const options = {
  entryPoints: ["src/extension.ts"],
  bundle: true,
  format: "cjs",
  platform: "node",
  target: "node18",
  outfile: "dist/extension.js",
  // The `vscode` module is provided by the VS Code runtime, never bundled.
  external: ["vscode"],
  sourcemap: !production,
  minify: production,
  logLevel: watch ? "silent" : "info",
  plugins: [problemMatcherPlugin],
};

if (watch) {
  const ctx = await esbuild.context(options);
  await ctx.watch();
  console.log("[watch] watching for changes…");
} else {
  await esbuild.build(options);
}
