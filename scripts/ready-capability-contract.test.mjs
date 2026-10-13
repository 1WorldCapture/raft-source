import assert from "node:assert/strict";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { evaluateReadyCapabilityContract } from "./ready-capability-contract.mjs";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

test("an empty ready list reports the probe capability and skips transport checks", () => {
  const result = evaluateReadyCapabilityContract(repoRoot, []);
  assert.equal(
    result.checks.some((check) => check.name === "AGENT_MIGRATION_SOURCE_WORKSPACE_ARCHIVE_CAPABILITY"),
    false,
  );
  assert.ok(result.gaps.some((gap) => gap.name === "PROVIDER_PROBE_CAPABILITY"));
  assert.equal(result.gaps.some((gap) => gap.name === "DAEMON_CAPABILITY_MODEL_SEEN_BOUNDARY"), false);
  assert.equal(result.gaps.some((gap) => gap.name === "REMINDER_FIRE_RECEIPT_CAPABILITY"), false);
});

test("readyCapabilities must be the array a DaemonCore ready message sent", () => {
  assert.throws(
    () => evaluateReadyCapabilityContract(repoRoot, undefined),
    /DaemonCore ready message/,
  );
});
