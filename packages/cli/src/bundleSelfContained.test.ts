// The desktop app ships `dist/index.js` as a sidecar
// (`<app>/Contents/Resources/cli/index.js`) and executes it with Electron's
// Node runtime — no package root, no ambient node_modules. Every runtime
// dependency must therefore be INLINED by tsup (`noExternal: true`). This
// regression pin exists because ajv and safe-regex2 were added to
// package.json without being added to the old explicit noExternal list: the
// CLI then crashed with ERR_MODULE_NOT_FOUND for every agent on the packaged
// app while continuing to work in dev (where node_modules resolves).
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const packageRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const BUNDLE = join(packageRoot, "dist", "index.js");

test("built bundle leaves no runtime dependency external (skips without a build)", async (t) => {
  let source: string;
  try {
    source = await readFile(BUNDLE, "utf8");
  } catch {
    t.skip("dist/index.js missing — run pnpm --filter @botiverse/raft build first");
    return;
  }

  const pkg = JSON.parse(await readFile(join(packageRoot, "package.json"), "utf8")) as {
    dependencies?: Record<string, string>;
  };
  const deps = Object.keys(pkg.dependencies ?? {});
  assert.ok(deps.length > 0, "the cli declares runtime dependencies to check");

  // Bare specifiers only: relative "./x" and "node:x" builtins are fine.
  // Covers static `import … from "x"` / `export … from "x"`, dynamic
  // `import("x")`, and `require("x")` forms emitted into the bundle.
  const patterns = [
    /\bfrom\s*["']([^"']+)["']/g,
    /\bimport\s*\(\s*["']([^"']+)["']\s*\)/g,
    /\brequire\s*\(\s*["']([^"']+)["']\s*\)/g,
  ];
  const external = new Set<string>();
  for (const pattern of patterns) {
    for (const match of source.matchAll(pattern)) {
      const specifier = match[1]!;
      if (specifier.startsWith(".") || specifier.startsWith("node:")) continue;
      if (deps.includes(specifier)) external.add(specifier);
    }
  }
  assert.deepEqual(
    [...external].sort(),
    [],
    "dist/index.js must inline every runtime dependency for the packaged-app sidecar",
  );

  // The single-file sidecar has no package.json beside it, so the version must
  // be baked in (tsup define), not resolved at runtime.
  assert.doesNotMatch(source, /__RAFT_CLI_VERSION__/, "bundle leaves the version identifier unresolved");
  const version = (pkg as { version?: string }).version;
  assert.ok(version && source.includes(`"${version}"`), `bundle bakes the CLI version ${version}`);
});
