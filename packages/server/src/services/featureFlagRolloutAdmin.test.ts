import assert from "node:assert/strict";
import { test } from "vitest";
import { eq } from "drizzle-orm";
import {
  FEATURE_FLAG_ROLLOUT_GUARDRAIL_ISSUER,
  FEATURE_FLAG_ROLLOUT_GUARDRAIL_POLICY_VERSION,
  FEATURE_FLAG_ROLLOUT_GUARDRAIL_SCHEMA,
  type FeatureFlagRolloutGuardrailReceiptV1,
} from "@botiverse/raft-shared";
import { getDb } from "../db/index.js";
import {
  featureFlagConfigVersions,
  featureFlagRolloutAuditEvents,
  featureFlagRules,
  featureFlags,
} from "../db/schema.js";
import { dbTest } from "../test/integration/dbTest.js";
import { runNamedCase } from "../test/runNamedCase.js";
import {
  FlagRolloutUsageError,
  indexReceiptDocument,
  parseFlagRolloutArgs,
  runFlagRollout,
  type FlagRolloutRequest,
} from "./featureFlagRolloutAdmin.js";

const CONTROL_PLANE_ID = "production";
const SERVER_A = "00000000-0000-4000-8000-0000000000a1";
const SERVER_B = "00000000-0000-4000-8000-0000000000b2";
const RECEIPT_ID = "00000000-0000-4000-8000-0000000000c3";
const NOW_MS = Date.parse("2026-07-11T00:00:30.000Z");
const ENV = { DATABASE_URL: "postgres://example.invalid/raft" };

function passingReceipt(input: {
  id: string;
  flagKey: string;
  configVersion: number;
  operation: FeatureFlagRolloutGuardrailReceiptV1["operation"];
}): FeatureFlagRolloutGuardrailReceiptV1 {
  return {
    schema: FEATURE_FLAG_ROLLOUT_GUARDRAIL_SCHEMA,
    id: input.id,
    verdict: "pass",
    issuer: FEATURE_FLAG_ROLLOUT_GUARDRAIL_ISSUER,
    controlPlaneId: CONTROL_PLANE_ID,
    flagKey: input.flagKey,
    configVersion: input.configVersion,
    operation: input.operation,
    policyVersion: FEATURE_FLAG_ROLLOUT_GUARDRAIL_POLICY_VERSION,
    evaluatedAt: "2026-07-11T00:00:00.000Z",
    expiresAt: "2026-07-11T00:01:00.000Z",
  };
}

function mutation(overrides: Partial<FlagRolloutRequest> & Pick<FlagRolloutRequest, "command" | "flagKey">): FlagRolloutRequest {
  return {
    dryRun: false,
    actor: { type: "human", id: "lyon" },
    reason: "owner asked for this flag change",
    ...overrides,
  };
}

async function insertFlag(flagKey: string, killSwitch = false): Promise<void> {
  await getDb().insert(featureFlags).values({
    key: flagKey,
    randomizationUnit: "server",
    defaultEnabled: false,
    killSwitch,
    salt: `${flagKey}-salt`,
  });
}

async function currentConfigVersion(): Promise<number> {
  const [row] = await getDb()
    .select({ version: featureFlagConfigVersions.version })
    .from(featureFlagConfigVersions)
    .where(eq(featureFlagConfigVersions.scope, "global"));
  return row?.version ?? 0;
}

async function auditFor(flagKey: string) {
  return getDb()
    .select()
    .from(featureFlagRolloutAuditEvents)
    .where(eq(featureFlagRolloutAuditEvents.flagKey, flagKey));
}

test("flag rollout CLI rejects incomplete production invocations", () => {
  assert.throws(() => parseFlagRolloutArgs(["show", "--flag", "provider_connections_v0"], {}), /DATABASE_URL is required/);
  assert.deepEqual(parseFlagRolloutArgs(["show", "--flag", "provider_connections_v0"], ENV), {
    command: "show",
    flagKey: "provider_connections_v0",
    dryRun: false,
  });
  assert.equal(
    parseFlagRolloutArgs([
      "server_allowlist_remove",
      "--flag", "provider_connections_v0",
      "--server", SERVER_A,
      "--actor-type", "agent",
      "--actor-name", "Cursor-mac",
      "--reason", "take raftbuild back off",
      "--dry-run",
      "--expected-version", "4",
    ], ENV).dryRun,
    true,
  );
  assert.throws(
    () => parseFlagRolloutArgs([
      "server_allowlist_add",
      "--flag", "provider_connections_v0",
      "--server", SERVER_A,
      "--actor-type", "human",
      "--actor-name", "lyon",
    ], ENV),
    /--reason is required/,
  );
  assert.throws(
    () => parseFlagRolloutArgs([
      "server_allowlist_add",
      "--flag", "provider_connections_v0",
      "--server", SERVER_A,
      "--server", SERVER_B,
      "--actor-type", "human",
      "--actor-name", "lyon",
      "--reason", "two servers",
    ], ENV),
    /one --server/,
  );
  assert.throws(() => indexReceiptDocument(null), FlagRolloutUsageError);
  const receipt = passingReceipt({
    id: RECEIPT_ID,
    flagKey: "provider_connections_v0",
    configVersion: 1,
    operation: { kind: "server_allowlist_add", ruleId: null, serverId: SERVER_A },
  });
  assert.equal(indexReceiptDocument(receipt).get(RECEIPT_ID), receipt);
});

dbTest("feature flag rollout admin uses the writer and prints before and after", async ({ db }) => {
  void db;

  await runNamedCase("show reads the flag and does not write", async () => {
    const flagKey = "admin_show_v0";
    await insertFlag(flagKey);
    const versionBefore = await currentConfigVersion();
    const report = await runFlagRollout({ command: "show", flagKey, dryRun: false }, {
      controlPlaneId: CONTROL_PLANE_ID,
    });
    assert.equal(report.command, "show");
    if (report.command !== "show") assert.fail("show should stay a read");
    assert.equal(report.ok, true);
    assert.equal(report.found, true);
    assert.equal(report.killSwitch, false);
    assert.equal(report.defaultEnabled, false);
    assert.deepEqual(report.rules, []);
    assert.equal(await currentConfigVersion(), versionBefore);
    assert.equal((await auditFor(flagKey)).length, 0);
  });

  await runNamedCase("dry-run of a widening add reports the receipt and writes nothing", async () => {
    const flagKey = "admin_dry_run_v0";
    await insertFlag(flagKey);
    const versionBefore = await currentConfigVersion();
    const operation = { kind: "server_allowlist_add" as const, ruleId: null, serverId: SERVER_A };
    const receipt = passingReceipt({ id: RECEIPT_ID, flagKey, configVersion: versionBefore, operation });
    let loads = 0;
    const report = await runFlagRollout(mutation({
      command: "server_allowlist_add",
      flagKey,
      serverId: SERVER_A,
      dryRun: true,
      receiptId: RECEIPT_ID,
    }), {
      controlPlaneId: CONTROL_PLANE_ID,
      nowMs: () => NOW_MS,
      loadTrustedReceipt: async () => {
        loads += 1;
        return receipt;
      },
    });
    assert.equal(report.command, "server_allowlist_add");
    assert.equal(report.ok, true);
    assert.equal(report.dryRun, true);
    assert.equal(report.wrote, false);
    assert.equal(report.applied, false);
    assert.equal(report.authorization, "guardrail_passed");
    assert.equal(report.receiptId, RECEIPT_ID);
    assert.deepEqual(report.operation, operation);
    assert.deepEqual(report.rulesBefore, []);
    assert.deepEqual(report.rulesAfter, []);
    assert.equal(report.configVersionBefore, versionBefore);
    assert.equal(report.configVersionAfter, versionBefore);
    assert.equal(loads, 1);
    assert.equal(await currentConfigVersion(), versionBefore);
    assert.equal((await auditFor(flagKey)).length, 0);
    const rules = await getDb().select().from(featureFlagRules).where(eq(featureFlagRules.flagKey, flagKey));
    assert.equal(rules.length, 0);
  });

  await runNamedCase("allowlist add is a widening with guardrail_passed and a receipt", async () => {
    const flagKey = "admin_add_v0";
    await insertFlag(flagKey);
    const versionBefore = await currentConfigVersion();
    const operation = { kind: "server_allowlist_add" as const, ruleId: null, serverId: SERVER_A };
    const receipt = passingReceipt({ id: RECEIPT_ID, flagKey, configVersion: versionBefore, operation });
    const report = await runFlagRollout(mutation({
      command: "server_allowlist_add",
      flagKey,
      serverId: SERVER_A,
      receiptId: RECEIPT_ID,
    }), {
      controlPlaneId: CONTROL_PLANE_ID,
      nowMs: () => NOW_MS,
      loadTrustedReceipt: async () => receipt,
      requestId: "request-admin-add",
    });
    if (report.command === "show" || !report.applied) assert.fail("allowlist add should apply");
    assert.equal(report.authorization, "guardrail_passed");
    assert.equal(report.receiptId, RECEIPT_ID);
    assert.equal(report.wrote, true);
    assert.equal(report.auditEventId !== null, true);
    assert.equal(report.configVersionBefore, versionBefore);
    assert.equal(report.configVersionAfter, versionBefore + 1);
    assert.deepEqual(report.rulesBefore, []);
    assert.equal(report.rulesAfter.length, 1);
    assert.deepEqual(report.rulesAfter[0]?.values, [SERVER_A]);
    const [audit] = await auditFor(flagKey);
    assert.equal(audit.id, report.auditEventId);
    assert.equal(audit.authorization, "guardrail_passed");
    assert.equal(audit.receiptId, RECEIPT_ID);
    assert.equal(audit.actorType, "human");
    assert.equal(audit.actorId, "lyon");
    assert.equal(audit.reason, "owner asked for this flag change");
    assert.equal(audit.configVersionBefore, versionBefore);
    assert.equal(audit.configVersionAfter, versionBefore + 1);
    assert.deepEqual(audit.operation, operation);
  });

  await runNamedCase("allowlist remove is a narrowing with a null receipt", async () => {
    const flagKey = "admin_remove_v0";
    await insertFlag(flagKey);
    const [rule] = await getDb().insert(featureFlagRules).values({
      flagKey,
      stage: "server",
      priority: 0,
      decision: "allow",
      values: [SERVER_B],
      percentageBasisPoints: null,
      variant: null,
    }).returning();
    const versionBefore = await currentConfigVersion();
    let loads = 0;
    const report = await runFlagRollout(mutation({
      command: "server_allowlist_remove",
      flagKey,
      serverId: SERVER_B,
      actor: { type: "agent", id: "Cursor-mac" },
      reason: "drop the test server",
    }), {
      controlPlaneId: CONTROL_PLANE_ID,
      nowMs: () => NOW_MS,
      loadTrustedReceipt: async () => {
        loads += 1;
        throw new Error("narrowing must not load a receipt");
      },
      requestId: "request-admin-remove",
    });
    if (report.command === "show" || !report.applied) assert.fail("allowlist remove should apply");
    assert.equal(report.authorization, "narrowing");
    assert.equal(report.receiptId, null);
    assert.deepEqual(report.operation, {
      kind: "server_allowlist_remove",
      ruleId: rule.id,
      serverId: SERVER_B,
    });
    assert.deepEqual(report.rulesBefore[0]?.values, [SERVER_B]);
    assert.deepEqual(report.rulesAfter[0]?.values, []);
    assert.equal(loads, 0);
    const [audit] = await auditFor(flagKey);
    assert.equal(audit.authorization, "narrowing");
    assert.equal(audit.receiptId, null);
    assert.equal(audit.actorType, "agent");
    assert.equal(audit.actorId, "Cursor-mac");
    assert.equal(audit.configVersionAfter, versionBefore + 1);
  });

  await runNamedCase("kill switch enable is a narrowing", async () => {
    const flagKey = "admin_kill_v0";
    await insertFlag(flagKey);
    const versionBefore = await currentConfigVersion();
    const report = await runFlagRollout(mutation({
      command: "kill_switch_set",
      flagKey,
      desiredKillSwitch: true,
      reason: "stop the rollout",
    }), {
      controlPlaneId: CONTROL_PLANE_ID,
      nowMs: () => NOW_MS,
      loadTrustedReceipt: async () => {
        throw new Error("kill switch enable must not load a receipt");
      },
    });
    if (report.command === "show" || !report.applied) assert.fail("kill switch enable should apply");
    assert.equal(report.authorization, "narrowing");
    assert.equal(report.receiptId, null);
    assert.deepEqual(report.operation, { kind: "kill_switch_enable" });
    assert.equal(report.configVersionAfter, versionBefore + 1);
    const [flag] = await getDb().select({ killSwitch: featureFlags.killSwitch })
      .from(featureFlags)
      .where(eq(featureFlags.key, flagKey));
    assert.equal(flag.killSwitch, true);
    const [audit] = await auditFor(flagKey);
    assert.equal(audit.authorization, "narrowing");
    assert.equal(audit.receiptId, null);
  });

  await runNamedCase("a stale expected version is rejected with no writes", async () => {
    const flagKey = "admin_stale_v0";
    await insertFlag(flagKey);
    const versionBefore = await currentConfigVersion();
    const auditBefore = (await auditFor(flagKey)).length;
    const staleVersion = versionBefore + 5;
    const receipt = passingReceipt({
      id: RECEIPT_ID,
      flagKey,
      configVersion: staleVersion,
      operation: { kind: "server_allowlist_add", ruleId: null, serverId: SERVER_A },
    });
    const report = await runFlagRollout(mutation({
      command: "server_allowlist_add",
      flagKey,
      serverId: SERVER_A,
      expectedConfigVersion: staleVersion,
      receiptId: RECEIPT_ID,
    }), {
      controlPlaneId: CONTROL_PLANE_ID,
      nowMs: () => NOW_MS,
      loadTrustedReceipt: async () => receipt,
    });
    if (report.command === "show") assert.fail("stale version should be a mutation report");
    assert.equal(report.ok, false);
    assert.equal(report.wrote, false);
    assert.equal(report.applied, false);
    assert.equal(report.reason, "config_version_mismatch");
    assert.equal(report.auditEventId, null);
    assert.equal(report.authorization, null);
    assert.deepEqual(report.rulesBefore, []);
    assert.deepEqual(report.rulesAfter, []);
    assert.equal(await currentConfigVersion(), versionBefore);
    assert.equal((await auditFor(flagKey)).length, auditBefore);
    const rules = await getDb().select().from(featureFlagRules).where(eq(featureFlagRules.flagKey, flagKey));
    assert.equal(rules.length, 0);
  });
});
