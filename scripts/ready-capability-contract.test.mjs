import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import {
  evaluateReadyCapabilityContract,
  manifestWithoutProviderProbe,
  scanReadyElements,
} from "./ready-capability-contract.mjs";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const manifestPath = "packages/daemon/src/registry.manifest.ts";

test("the ready message is read from core.ts, not from a carrier fixture", () => {
  const core = readFileSync(join(repoRoot, "packages/daemon/src/core.ts"), "utf8");
  const scanned = scanReadyElements(core);
  assert.deepEqual(scanned.strings, [
    "agent:start",
    "agent:stop",
    "agent:deliver",
    "workspace:files",
  ]);
  assert.ok(scanned.spreads.includes("BUILT_IN_READY_CAPABILITIES"));
  assert.ok(scanned.idents.includes("AGENT_PURGE_CAPABILITY"));
  assert.ok(scanned.idents.includes("WIKI_WORKSPACE_PACK_CAPABILITY"));
  assert.ok(scanned.idents.includes("COMPUTER_CAPABILITY_SUPERVISOR_MUTATIONS"));
});

test("server capability checks match the daemon ready list on this tree", () => {
  const result = evaluateReadyCapabilityContract(repoRoot);
  assert.deepEqual(result.gaps, [], JSON.stringify(result.gaps, null, 2));
  assert.ok(result.readyValues.includes("provider-probe:v1"));
  assert.ok(result.checks.some((check) => check.name === "PROVIDER_PROBE_CAPABILITY"));
});

test("removing PROVIDER_PROBE_CAPABILITY from BUILT_IN_READY_CAPABILITIES fails the contract", () => {
  const manifest = readFileSync(join(repoRoot, manifestPath), "utf8");
  const stripped = manifestWithoutProviderProbe(manifest);
  assert.notEqual(stripped, manifest);
  assert.doesNotMatch(
    stripped.slice(stripped.indexOf("BUILT_IN_READY_CAPABILITIES")),
    /PROVIDER_PROBE_CAPABILITY/,
  );
  const result = evaluateReadyCapabilityContract(repoRoot, { [manifestPath]: stripped });
  assert.ok(
    result.gaps.some((gap) => gap.name === "PROVIDER_PROBE_CAPABILITY"),
    JSON.stringify(result.gaps, null, 2),
  );
});

test("a transport.capabilities check is not treated as a ready-list check", () => {
  const result = evaluateReadyCapabilityContract(repoRoot);
  assert.equal(
    result.checks.some((check) => check.name === "AGENT_MIGRATION_SOURCE_WORKSPACE_ARCHIVE_CAPABILITY"),
    false,
  );
});
