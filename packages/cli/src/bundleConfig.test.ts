import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import test from "node:test";

import tsupConfig from "../tsup.config.js";

type BundleConfigShape = {
  banner?: {
    js?: unknown;
  };
  noExternal?: unknown;
  shims?: unknown;
  define?: Record<string, unknown>;
};

const config = tsupConfig as BundleConfigShape;

test("tsup config inlines runtime deps for the Computer app sidecar CLI", async () => {
  assert.equal(config.shims, true);
  // The sidecar has no package root, so EVERY declared runtime dependency must
  // be inlined. The list is derived from package.json — pin that contract (the
  // old hand-maintained list missed ajv and safe-regex2 and broke the packaged
  // app; bundleSelfContained.test.ts guards the built output).
  const pkg = JSON.parse(
    await readFile(fileURLToPath(new URL("../package.json", import.meta.url)), "utf8"),
  ) as { dependencies?: Record<string, string>; version?: string };
  const deps = Object.keys(pkg.dependencies ?? {});
  assert.ok(deps.length > 0, "the cli declares runtime dependencies to inline");
  assert.deepEqual(
    [...(config.noExternal as string[])].sort(),
    [...deps].sort(),
    "noExternal must inline every runtime dependency",
  );
  assert.match(String(config.banner?.js), /createRequire/);

  // The single-file sidecar also has no package.json beside it, so the version
  // must be baked at build time (src/version.ts prefers the baked identifier).
  assert.ok(pkg.version, "package.json carries a version");
  assert.deepEqual(config.define, { __RAFT_CLI_VERSION__: JSON.stringify(pkg.version) });

  const source = await readFile(
    fileURLToPath(new URL("../tsup.config.ts", import.meta.url)),
    "utf8",
  );
  assert.match(source, /Computer app copies this single file/);
  assert.match(source, /sidecar has no package root/);
  assert.match(source, /commander` is CJS/);
});
