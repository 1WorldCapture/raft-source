import { defineConfig } from "tsup";

import { buildCommitDefines } from "../../scripts/build-provenance.mjs";

export default defineConfig({
  entry: ["src/index.ts", "src/core.ts"],
  format: "esm",
  target: "node20",
  platform: "node",
  splitting: true,
  clean: true,
  // Bake the commit this dist was built from. `package.json`'s version and the
  // trace's `daemon_version` both come from package.json and therefore cannot
  // prove build provenance; see scripts/build-provenance.mjs (task #32).
  define: {
    ...buildCommitDefines("RAFT_DAEMON"),
  },
});
