import { readFileSync } from "node:fs";
import { defineConfig } from "tsup";

// Every runtime dependency must be inlined: the list is DERIVED from
// package.json so a dependency added later is bundled automatically instead of
// silently staying external (ajv and safe-regex2 were initially missed by a
// hand-maintained list, breaking every agent CLI on the packaged app; see
// src/bundleSelfContained.test.ts).
const pkg = JSON.parse(readFileSync(new URL("./package.json", import.meta.url), "utf8"));
const runtimeDependencies = Object.keys(pkg.dependencies ?? {});

export default defineConfig({
  entry: ["src/index.ts"],
  format: "esm",
  target: "node20",
  platform: "node",
  splitting: false,
  clean: true,
  shims: true,
  // The Computer app copies this single file into
  // `<app>/Contents/Resources/cli/index.js` and executes it with Electron's
  // Node runtime. That sidecar has no package root, so runtime deps must be
  // inlined rather than resolved from ambient node_modules (see
  // runtimeDependencies above). `commander` is CJS and still requires Node
  // built-ins, so the ESM bundle also needs a createRequire shim.
  noExternal: runtimeDependencies,
  // Bake the version so the single-file desktop sidecar
  // (<app>/Contents/Resources/cli/index.js) has trustworthy metadata with no
  // package.json beside it (src/version.ts prefers the baked identifier).
  // npm-package and daemon-bundled consumers resolve the same value via
  // dist/package.json today; baking changes nothing for them.
  define: {
    __RAFT_CLI_VERSION__: JSON.stringify(pkg.version),
  },
  banner: {
    js:
      "#!/usr/bin/env node\n" +
      "import { createRequire as __raftCreateRequire } from \"node:module\";\n" +
      "const require = __raftCreateRequire(import.meta.url);",
  },
});
