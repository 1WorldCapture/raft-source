// Task #11 G2 (part 2): the EXPLICIT, BOUNDED, AUDITABLE recovery for a
// terminal receipt whose operation record lacks predecessor process
// identities (crash-redo completed transactions never recorded them; the
// normal acknowledgement refuses and the next upgrade is locked). Every
// gate must pass and every refusal is typed with zero consumption:
// wrong operation, identities actually present, non-whitelisted outcome,
// live predecessor, missing journal history, same-generation successor
// (handover never happened), unstable service readback, version mismatch.
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import assert from "node:assert/strict";
import { test } from "vitest";
import type { OperationRecord } from "@botiverse/k-carrier";
import {
  recoverTerminalUpgradeReceiptMissingPredecessors,
  type ReceiptRecoveryDeps,
} from "./kOperationAcknowledgement.js";
import type { MachineServiceAttestation } from "./lib/types.js";

const OPERATION_ID = "terminal-k-recovery-op";

function recoveryOperation(overrides: Partial<OperationRecord> = {}): OperationRecord {
  return {
    formatVersion: 1,
    id: OPERATION_ID,
    startedAtMs: 1,
    updatedAtMs: 2,
    fromVersion: "9.9.90",
    targetVersion: "9.9.91",
    previousStableVersion: "9.9.90",
    phase: "promoted",
    outcome: "promoted",
    reason: "recovery settled at promoted",
    provenance: { who: "local", carrier: "cli" },
    metadata: {
      trigger: "cli",
      upgradeScopeVersion: "1",
      upgradeScope: "local",
      // ABSENT — the crash-redo shape this path exists for.
      coordinatorPid: "5502",
    },
    acknowledgedAtMs: null,
    ...overrides,
  };
}

function okDeps(overrides: Partial<ReceiptRecoveryDeps> = {}): ReceiptRecoveryDeps {
  return {
    load: async () => ({ kind: "observed", operation: recoveryOperation() }),
    acknowledge: async () => "acknowledged",
    nowMs: () => 42_000,
    readServiceAttestationFn: async (): Promise<MachineServiceAttestation | null> => ({
      computerVersion: "9.9.91",
      serviceGeneration: "successor-generation",
      servicePid: 6100,
      managedServerIds: [],
      managedSetRevision: "stable-revision",
    }),
    isKQuiescentFn: async () => true,
    readHandover: async () => ({ operationRecorded: true, priorStartId: "prior-generation" }),
    audit: () => {},
    ...overrides,
  };
}

async function withHome(fn: (home: string) => Promise<void>): Promise<void> {
  const home = await mkdtemp(join(tmpdir(), "k-recovery-"));
  try {
    await fn(home);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
}

test("happy path: absent identities + trusted handover history + different live generation + stable matching version recovers", { timeout: 10_000 }, async () => {
  await withHome(async (home) => {
    const audited: string[] = [];
    const result = await recoverTerminalUpgradeReceiptMissingPredecessors(home, OPERATION_ID, okDeps({
      audit: (line) => audited.push(line),
    }));
    assert.equal(result.status, "acknowledged");
    assert.equal(result.operationId, OPERATION_ID);
    assert.equal(result.outcome, "promoted");
    assert.equal(audited.length, 1, "the recovery must be audited exactly once");
    assert.match(audited[0]!, /RECEIPT_RECOVERED_MISSING_PREDECESSORS/);
    assert.match(audited[0]!, /priorStartId=prior-generation/);
    assert.match(audited[0]!, /liveGeneration=successor-generation/);
  });
});

test("wrong operation id: refused, bound to the exact operation", { timeout: 10_000 }, async () => {
  await withHome(async (home) => {
    await assert.rejects(
      recoverTerminalUpgradeReceiptMissingPredecessors(home, "another-operation", okDeps()),
      /bound to the exact operation/,
    );
  });
});

test("identities actually PRESENT: refused — that record must use the normal acknowledgement", { timeout: 10_000 }, async () => {
  await withHome(async (home) => {
    const op = recoveryOperation();
    op.metadata.priorProcessIdentities = JSON.stringify(["service:5500"]);
    await assert.rejects(
      recoverTerminalUpgradeReceiptMissingPredecessors(home, OPERATION_ID, okDeps({
        load: async () => ({ kind: "observed", operation: op }),
      })),
      /DOES carry predecessor process identities/,
    );
  });
});

test("non-whitelisted outcome (failed): refused — bounded to promoted/rolled-back", { timeout: 10_000 }, async () => {
  await withHome(async (home) => {
    const op = recoveryOperation({ phase: "failed", outcome: "failed" });
    await assert.rejects(
      recoverTerminalUpgradeReceiptMissingPredecessors(home, OPERATION_ID, okDeps({
        load: async () => ({ kind: "observed", operation: op }),
      })),
      /accepts only promoted or rolled-back/,
    );
  });
});

test("live predecessor: refused recovery", { timeout: 10_000 }, async () => {
  await withHome(async (home) => {
    await assert.rejects(
      recoverTerminalUpgradeReceiptMissingPredecessors(home, OPERATION_ID, okDeps({
        isKQuiescentFn: async () => false,
      })),
      /active coordinator or lock/,
    );
  });
});

test("missing journal history: refused (trusted-history gate)", { timeout: 10_000 }, async () => {
  await withHome(async (home) => {
    await assert.rejects(
      recoverTerminalUpgradeReceiptMissingPredecessors(home, OPERATION_ID, okDeps({
        readHandover: async () => ({ operationRecorded: false, priorStartId: null }),
      })),
      /trusted-history gate refuses recovery/,
    );
  });
});

test("same generation as priorStartId: the handover successor is not running — refused", { timeout: 10_000 }, async () => {
  await withHome(async (home) => {
    await assert.rejects(
      recoverTerminalUpgradeReceiptMissingPredecessors(home, OPERATION_ID, okDeps({
        readServiceAttestationFn: async () => ({
          computerVersion: "9.9.91",
          serviceGeneration: "prior-generation", // STILL the pre-handover incarnation
          servicePid: 6100,
          managedServerIds: [],
          managedSetRevision: "stable-revision",
        }),
      })),
      /handover successor is not running/,
    );
  });
});

test("unstable service readback: refused", { timeout: 10_000 }, async () => {
  await withHome(async (home) => {
    let call = 0;
    await assert.rejects(
      recoverTerminalUpgradeReceiptMissingPredecessors(home, OPERATION_ID, okDeps({
        readServiceAttestationFn: async () => {
          call += 1;
          return call === 1
            ? { computerVersion: "9.9.91", serviceGeneration: "successor-generation", servicePid: 6100, managedServerIds: [], managedSetRevision: "r1" }
            : null;
        },
      })),
      /no stable live Computer service readback/,
    );
  });
});

test("version mismatch: refused even when every other gate passes", { timeout: 10_000 }, async () => {
  await withHome(async (home) => {
    await assert.rejects(
      recoverTerminalUpgradeReceiptMissingPredecessors(home, OPERATION_ID, okDeps({
        readServiceAttestationFn: async () => ({
          computerVersion: "9.9.90", // NOT the promoted target
          serviceGeneration: "successor-generation",
          servicePid: 6100,
          managedServerIds: [],
          managedSetRevision: "stable-revision",
        }),
      })),
      /recovery refused/,
    );
  });
});

test("rolled-back outcome recovers against the restored version", { timeout: 10_000 }, async () => {
  await withHome(async (home) => {
    const result = await recoverTerminalUpgradeReceiptMissingPredecessors(home, OPERATION_ID, okDeps({
      load: async () => ({ kind: "observed", operation: recoveryOperation({ phase: "rolled-back", outcome: "rolled-back" }) }),
      readServiceAttestationFn: async () => ({
        computerVersion: "9.9.90", // the RESTORED version
        serviceGeneration: "successor-generation",
        servicePid: 6100,
        managedServerIds: [],
        managedSetRevision: "stable-revision",
      }),
    }));
    assert.equal(result.outcome, "rolled-back");
    assert.equal(result.status, "acknowledged");
  });
});

test("real journal file: priorStartId parses from the handing-over record", { timeout: 10_000 }, async () => {
  await withHome(async (home) => {
    await mkdir(join(home, "computer", "k"), { recursive: true });
    await writeFile(join(home, "computer", "k", "journal.jsonl"), [
      JSON.stringify({ seq: 0, timestampMs: 1, intent: "staged", detail: { version: "9.9.91" } }),
      JSON.stringify({ seq: 1, timestampMs: 2, intent: "handing-over", detail: { version: "9.9.91", priorStartId: "journal-prior-gen" } }),
      JSON.stringify({ seq: 2, timestampMs: 3, intent: "promoted", detail: { version: "9.9.91" } }),
      "", // trailing newline shape
    ].join("\n"));
    const result = await recoverTerminalUpgradeReceiptMissingPredecessors(home, OPERATION_ID, okDeps({
      // No readHandover override: the REAL file reader runs.
      readServiceAttestationFn: async () => ({
        computerVersion: "9.9.91",
        serviceGeneration: "different-live-gen",
        servicePid: 6100,
        managedServerIds: [],
        managedSetRevision: "stable-revision",
      }),
    }));
    assert.equal(result.status, "acknowledged");
  });
});
