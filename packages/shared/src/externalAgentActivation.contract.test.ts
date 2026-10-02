// Contract tests for the Proxy Delegation closed schemas (design v1.1 §3,
// Phase A1). Freezes: closed-schema rejection of unknown fields, exact
// decimal-string bigint, sanitized secret surfaces, claim receipt cap, and
// the wake payload carrying no secret material.
import assert from "node:assert/strict";
import test from "node:test";

import {
  EXTERNAL_AGENT_CLAIM_MAX_RECEIPTS,
  claimDtoSchema,
  encryptedSecretSchema,
  externalAgentConnectionDtoSchema,
  inboxReceiptDtoSchema,
  runDtoSchema,
  wakeDtoSchema,
  wakePayloadSchema,
} from "./externalAgentActivation.js";

const UUID = "0b0a0f9e-0000-4000-8000-000000000001";
const UUID2 = "0b0a0f9e-0000-4000-8000-000000000002";
const TS = "2026-10-02T11:00:00.000Z";
// Above Number.MAX_SAFE_INTEGER: exactness must survive (A32).
const HUGE_EPOCH = "9007199254740993";

function connectionDto(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: UUID,
    serverId: UUID,
    agentId: UUID,
    schemaVersion: 1,
    activation: {
      strategy: "proxy_delegation",
      delivery: {
        adapter: "grokbot_webhook",
        protocolVersion: 1,
        endpointUrl: "https://api2.cursor.sh/automations/webhook/37213f9f",
      },
      policy: {
        debounceMs: 1500,
        startupTimeoutMs: 120000,
        leaseTtlMs: 300000,
        maxRunDurationMs: 1800000,
        maxDeliveryAttempts: 5,
        maxWakesPerHour: 30,
      },
    },
    enabled: false,
    pauseReason: null,
    revision: 0,
    epoch: "3",
    boundCredentialId: null,
    secretConfigured: true,
    secretFingerprint: "ab…yz",
    pendingGeneration: "12",
    currentRunId: null,
    createdAt: TS,
    updatedAt: TS,
    ...overrides,
  };
}

test("closed schemas: connection DTO rejects an injected extra field", () => {
  assert.equal(externalAgentConnectionDtoSchema.safeParse(connectionDto({ extra: 1 })).success, false);
});

test("closed schemas: activation config rejects an unknown strategy-adjacent key", () => {
  const bad = connectionDto() as { activation: Record<string, unknown> };
  bad.activation.rogue = true;
  assert.equal(externalAgentConnectionDtoSchema.safeParse(bad).success, false);
});

test("closed schemas: inbox receipt DTO rejects unknown fields", () => {
  const base = {
    id: UUID, serverId: UUID, agentId: UUID,
    source: { kind: "message", messageId: UUID, occurrenceKey: "occ-1" },
    sourceEventKey: "msg:1:occ-1", admittedGeneration: "1", state: "pending",
    currentClaimId: null, ackDisposition: null, suppressReason: null,
    resultRefs: [], createdAt: TS, ackedAt: null, unknownField: true,
  };
  assert.equal(inboxReceiptDtoSchema.safeParse(base).success, false);
});

test("closed schemas: wake DTO rejects unknown fields", () => {
  const wake = {
    id: UUID, connectionId: UUID, connectionEpoch: "1", generationAtCreation: "1",
    state: "queued", nextAttemptAt: TS, attemptCount: 0, dispatchOwner: null,
    dispatchFence: "0", dispatchLeaseUntil: null, startupDeadline: null,
    blockReason: null, exhaustedReason: null, recoveryAuditRef: null,
    createdAt: TS, nope: 1,
  };
  assert.equal(wakeDtoSchema.safeParse(wake).success, false);
});

test("closed schemas: run DTO has no owner-token surface — unknown field rejected", () => {
  const run = {
    id: UUID, connectionId: UUID, connectionEpoch: "1", agentId: UUID,
    credentialId: UUID, wakeId: UUID, fence: "1",
    beginRequestKey: "k1", beginRequestDigest: "d1", state: "active",
    leaseExpiresAt: TS, maxEndsAt: TS, lastHeartbeatAt: TS,
    finishedAt: null, finishOutcome: null, ownerToken: "should-not-exist",
  };
  assert.equal(runDtoSchema.safeParse(run).success, false);
});

test("bigint exactness (A32): epoch above MAX_SAFE_INTEGER round-trips exactly", () => {
  const parsed = externalAgentConnectionDtoSchema.parse(connectionDto({ epoch: HUGE_EPOCH }));
  assert.equal(parsed.epoch, HUGE_EPOCH);
});

test("bigint exactness: numeric epoch is rejected (must be a decimal string)", () => {
  assert.equal(
    externalAgentConnectionDtoSchema.safeParse(connectionDto({ epoch: 3 as unknown as string })).success,
    false,
  );
});

test("secret hygiene: DTOs carry no ciphertext fields — presence is a boolean fact", () => {
  const dto = connectionDto();
  const raw = JSON.stringify(dto);
  for (const banned of ["ciphertext", "authTag", 'iv"', "keyId"]) {
    assert.equal(raw.includes(banned), false, `unexpected secret member ${banned} in DTO JSON`);
  }
  assert.equal(dto.secretConfigured, true);
});

test("secret hygiene: wake payload members are exactly the six non-secret fields", () => {
  const payload = wakePayloadSchema.parse({
    schema: "raft.external-agent.wake.v1", kind: "wake",
    wakeId: "w1", attemptId: "a1", connectionEpoch: "3", occurredAt: TS,
  });
  assert.deepEqual(Object.keys(payload).sort(), [
    "attemptId", "connectionEpoch", "kind", "occurredAt", "schema", "wakeId",
  ]);
});

test("secret hygiene: encrypted material validates only in its private schema", () => {
  assert.equal(
    encryptedSecretSchema.safeParse({ keyId: "k", ciphertext: "c", iv: "i", authTag: "t" }).success,
    true,
  );
  assert.equal(
    encryptedSecretSchema.safeParse({ keyId: "k", ciphertext: "c", iv: "i", authTag: "t", extra: 1 }).success,
    false,
  );
});

test(`claim batch cap: receiptIds rejects more than ${EXTERNAL_AGENT_CLAIM_MAX_RECEIPTS} entries`, () => {
  const ids = Array.from({ length: EXTERNAL_AGENT_CLAIM_MAX_RECEIPTS + 1 }, (_, i) =>
    UUID.replace(/000000000001$/, String(i).padStart(12, "0")));
  const claim = {
    id: UUID, serverId: UUID, agentId: UUID, connectionEpoch: "1",
    runId: UUID2, fence: "1", requestKey: "rk", receiptIds: ids,
    state: "open", expiresAt: TS, createdAt: TS,
  };
  assert.equal(claimDtoSchema.safeParse(claim).success, false);
});
