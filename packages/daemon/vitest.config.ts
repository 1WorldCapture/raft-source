import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Isolate from the host's managed-runtime env and real Raft/Slock homes
    // before any test runs (see test-env-guardrail.ts).
    setupFiles: ["./src/test-env-guardrail.ts"],
    // Local runs regenerate snapshots for review; CI only checks committed output.
    update: !process.env.CI,
    environment: "node",
    include: ["src/**/*.test.ts"],
    pool: "forks",
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
