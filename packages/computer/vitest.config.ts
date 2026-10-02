import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["src/**/*.test.ts", "scripts/native/*.test.mjs"],
    pool: "forks",
    // Hermetic state roots (#bugfix task #5): before any test file loads a
    // business module, BOTH home variables point at a throwaway temp root,
    // so an inherited RAFT_HOME (e.g. a managed agent terminal pointing at a
    // live ~/.slock-raft) can never leak state writes into a real home.
    setupFiles: ["src/test/hermeticStateRootSetup.ts", "src/test/hermeticSideEffectsSetup.ts"],
    // Bound forgotten authentication waits and fixture cleanup. Blocking the
    // side effect is primary; a missing mock must not leave CI hung forever.
    testTimeout: 120_000,
    hookTimeout: 120_000,
  },
});
