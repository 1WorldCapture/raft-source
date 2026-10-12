import assert from "node:assert/strict";
import { test } from "vitest";
import {
  isProbeCarrierFactLive,
  parseProbeCarrierMeta,
  probeCarrierFactHasProbeCapability,
  PROBE_CARRIER_FACT_MAX_AGE_MS,
  selectProbeCarrierMeta,
} from "./probeCarrierFact.js";

const NOW = Date.parse("2026-09-15T00:00:00.000Z");

function meta(overrides: Record<string, string | null> = {}) {
  return {
    probeCapabilities: JSON.stringify(["provider-probe:v1"]),
    probeConnectionEpochId: "epoch-1",
    probeReplicaGeneration: "gen-1",
    probeObservedAt: new Date(NOW).toISOString(),
    probeRuntimeVersions: JSON.stringify({ builtin: "pi-1" }),
    daemonVersion: "daemon-1",
    computerVersion: "computer-1",
    ...overrides,
  };
}

test("parseProbeCarrierMeta projects capabilities and runtime versions", () => {
  const snapshot = parseProbeCarrierMeta(meta());
  assert.ok(snapshot);
  assert.deepEqual(snapshot?.capabilities, ["provider-probe:v1"]);
  assert.deepEqual(snapshot?.runtimeVersions, { builtin: "pi-1" });
  assert.equal(snapshot?.connectionEpochId, "epoch-1");
  assert.equal(probeCarrierFactHasProbeCapability(snapshot!), true);
  // fallback to the legacy runtimeVersions field when the probe field is absent
  const legacy = parseProbeCarrierMeta(meta({ probeRuntimeVersions: null, runtimeVersions: JSON.stringify({ claude: "c-1" }) }));
  assert.deepEqual(legacy?.runtimeVersions, { claude: "c-1" });
  // missing authority or unparseable observation time yields no fact at all
  assert.equal(parseProbeCarrierMeta(meta({ probeConnectionEpochId: null })), null);
  assert.equal(parseProbeCarrierMeta(meta({ probeObservedAt: "not-a-date" })), null);
  const noCap = parseProbeCarrierMeta(meta({ probeCapabilities: "[]" }));
  assert.ok(noCap);
  assert.equal(probeCarrierFactHasProbeCapability(noCap), false);
});

test("probe meta is omitted when provider connections are off and never carries runtime reassignment", () => {
  const input = {
    capabilities: ["provider-probe:v1", "other"],
    connectionEpochId: "epoch-1",
    replicaGeneration: "gen-1",
    runtimeVersions: { builtin: "pi-1" },
    observedAt: new Date(NOW).toISOString(),
  };
  assert.equal(selectProbeCarrierMeta({ ...input, probesEnabled: false }), null);
  const enabled = selectProbeCarrierMeta({ ...input, probesEnabled: true });
  assert.ok(enabled);
  assert.deepEqual(JSON.parse(enabled.probeCapabilities), ["other", "provider-probe:v1"]);
  assert.equal(enabled.probeConnectionEpochId, "epoch-1");
  assert.deepEqual(JSON.parse(enabled.probeRuntimeVersions), { builtin: "pi-1" });
  assert.equal("runtimes" in enabled, false);
});

test("fact freshness rejects future and stale observations", () => {
  const fresh = parseProbeCarrierMeta(meta());
  assert.equal(isProbeCarrierFactLive(fresh!, NOW), true);
  assert.equal(isProbeCarrierFactLive(fresh!, NOW + PROBE_CARRIER_FACT_MAX_AGE_MS), true);
  const stale = parseProbeCarrierMeta(meta({ probeObservedAt: new Date(NOW - PROBE_CARRIER_FACT_MAX_AGE_MS - 1).toISOString() }));
  assert.equal(isProbeCarrierFactLive(stale!, NOW), false, "stale facts must not authorize a dispatch");
  const future = parseProbeCarrierMeta(meta({ probeObservedAt: new Date(NOW + 1_000).toISOString() }));
  assert.equal(isProbeCarrierFactLive(future!, NOW), false, "future-dated facts must not authorize a dispatch");
});
