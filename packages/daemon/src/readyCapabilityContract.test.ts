import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "vitest";

const require = createRequire(import.meta.url);
const {
  evaluateReadyCapabilityContract,
  manifestWithoutProviderProbe,
} = require("../../../scripts/ready-capability-contract.mjs") as {
  evaluateReadyCapabilityContract: (
    repoRoot: string,
    overrides?: Record<string, string>,
  ) => { gaps: Array<{ name: string }> };
  manifestWithoutProviderProbe: (source: string) => string;
};

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const manifestPath = "packages/daemon/src/registry.manifest.ts";

test("server capability checks are on the daemon ready list", () => {
  const result = evaluateReadyCapabilityContract(repoRoot);
  assert.deepEqual(result.gaps, []);
});

test("removing PROVIDER_PROBE_CAPABILITY from BUILT_IN_READY_CAPABILITIES fails the contract", () => {
  const stripped = manifestWithoutProviderProbe(readFileSync(path.join(repoRoot, manifestPath), "utf8"));
  const result = evaluateReadyCapabilityContract(repoRoot, { [manifestPath]: stripped });
  assert.equal(result.gaps.some((gap) => gap.name === "PROVIDER_PROBE_CAPABILITY"), true);
});
