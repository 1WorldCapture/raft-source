import { chmodSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// Post-tsup step: write the dual bin wrappers for the canonical
// @botiverse/raft-daemon package (rename migration block ④,
// #proj-aiax:c1b79aaa). tsup emits dist/index.js without a shebang; the
// published bins are thin shebang wrappers so `raft-daemon` and the legacy
// `slock-daemon` alias share the same entry. The @slock-ai/daemon delegation
// shim deep-imports dist/slock-daemon.js, so both wrapper paths are also
// listed in package.json `exports` — removing them there breaks the shim.

const root = dirname(dirname(fileURLToPath(import.meta.url)));
// Optional --dist <dir> for alternate build targets (self-host bundle,
// acceptance D3); default keeps the official `dist` untouched.
const distArgIndex = process.argv.indexOf("--dist");
const distDir = join(root, distArgIndex !== -1 && process.argv[distArgIndex + 1] ? process.argv[distArgIndex + 1] : "dist");

for (const bin of ["raft-daemon.js", "slock-daemon.js"]) {
  const path = join(distDir, bin);
  writeFileSync(path, '#!/usr/bin/env node\nawait import("./index.js");\n');
  chmodSync(path, 0o755);
}
