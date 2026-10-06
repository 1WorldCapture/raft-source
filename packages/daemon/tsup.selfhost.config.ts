import { readFileSync } from "node:fs";
import { defineConfig } from "tsup";

// SELF-HOST ONLY build target (acceptance D3, task #6/#9): bundles every
// runtime dependency so the self-hosted tarball can install with
// `npm i -g <tgz>` on a machine with NO registry access. The official
// `build` (tsup.config.ts) stays byte-identical — the release pipeline
// packs THIS variant into a dependency-free package.json.
//
// banner: several CJS deps call require() dynamically at runtime; under an
// ESM bundle that shim must exist or startup throws "Dynamic require of
// 'events' is not supported".
const pkg = JSON.parse(readFileSync(new URL("./package.json", import.meta.url), "utf8")) as {
  dependencies?: Record<string, string>;
};

export default defineConfig({
  entry: ["src/index.ts", "src/core.ts"],
  format: "esm",
  target: "node20",
  platform: "node",
  splitting: true,
  clean: true,
  outDir: "dist-selfhost",
  noExternal: Object.keys(pkg.dependencies ?? {}),
  banner: {
    js: "import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);",
  },
});
