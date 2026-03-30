import * as esbuild from "esbuild";
import { execSync } from "node:child_process";

const watch = process.argv.includes("--watch");

const buildOpts = {
  entryPoints: ["src/shell-entry.tsx"],
  bundle: true,
  outdir: "dist",
  format: "esm",
  jsx: "automatic",
  target: "esnext",
  sourcemap: true,
  loader: { ".tsx": "tsx", ".ts": "ts", ".css": "css" },
};

if (watch) {
  const ctx = await esbuild.context(buildOpts);
  await ctx.watch();
  console.log("[ui] watching for changes...");
} else {
  await esbuild.build(buildOpts);
}

execSync("npx @tailwindcss/cli -i src/index.css -o dist/index.css", { stdio: "inherit" });
