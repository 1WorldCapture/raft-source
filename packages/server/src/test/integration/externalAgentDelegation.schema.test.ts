// Phase A1 data layer (design v1.1 §3): the six Proxy Delegation tables
// exist after migration, and the contract-defining uniqueness constraints
// actually reject the writes they exist for. Behavior beyond constraints
// (state transitions, leases) is Phase A2.
import assert from "node:assert/strict";
import { sql } from "drizzle-orm";

import { dbTest } from "./dbTest.js";
import {
  agents,
  users,
  externalAgentClaims,
  externalAgentConnections,
  externalAgentInboxReceipts,
  externalAgentRuns,
  externalAgentWakeAttempts,
  externalAgentWakes,
  servers,
} from "../../db/schema.js";

dbTest("the six delegation tables exist after migration", async ({ db }) => {
  const result = await db.execute(sql`
    SELECT table_name FROM information_schema.tables
    WHERE table_name IN (
      'external_agent_connections', 'external_agent_inbox_receipts',
      'external_agent_wakes', 'external_agent_wake_attempts',
      'external_agent_runs', 'external_agent_claims'
    ) ORDER BY table_name`);
  assert.deepEqual(
    result.rows.map((r) => r.table_name),
    [
      "external_agent_claims",
      "external_agent_connections",
      "external_agent_inbox_receipts",
      "external_agent_runs",
      "external_agent_wake_attempts",
      "external_agent_wakes",
    ],
  );
});

interface SeededIds { serverId: string; agentId: string; connectionId: string }

async function seedConnection(db: import("../../db/index.js").Database): Promise<SeededIds> {
  const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const [owner] = await db.insert(users).values({ email: `delegation-${stamp}@example.invalid`, name: "delegation-owner", passwordHash: "integration-test-hash" }).returning();
  const [server] = await db.insert(servers).values({ name: `delegation-${stamp}`, slug: `delegation-${stamp}`, ownerId: owner.id }).returning();
  const [agent] = await db.insert(agents).values({ serverId: server.id, name: "grok-test" }).returning();
  const [connection] = await db.insert(externalAgentConnections).values({
    serverId: server.id,
    agentId: agent.id,
    activation: {
      strategy: "proxy_delegation",
      delivery: { adapter: "grokbot_webhook", protocolVersion: 1, endpointUrl: "https://api2.cursor.sh/automations/webhook/x" },
      policy: { debounceMs: 1500, startupTimeoutMs: 120000, leaseTtlMs: 300000, maxRunDurationMs: 1800000, maxDeliveryAttempts: 5, maxWakesPerHour: 30 },
    },
  }).returning();
  return { serverId: server.id, agentId: agent.id, connectionId: connection.id };
}

dbTest("one connection config per agent (§3.1)", async ({ db }) => {
  const ids = await seedConnection(db);
  await assert.rejects(
    db.insert(externalAgentConnections).values({
      serverId: ids.serverId,
      agentId: ids.agentId,
      activation: { strategy: "local_bridge", adapter: "raft-channel" },
    }),
    /Failed query|unique|duplicate/i,
  );
});

dbTest("inbox receipt dedup: same (agent, sourceEventKey) collapses (§3.2)", async ({ db }) => {
  const ids = await seedConnection(db);
  const row = {
    serverId: ids.serverId,
    agentId: ids.agentId,
    source: { kind: "message" as const, messageId: "0b0a0f9e-0000-4000-8000-00000000000f", occurrenceKey: "occ-1" },
    sourceEventKey: "msg:1:occ-1",
    admittedGeneration: 1n,
  };
  await db.insert(externalAgentInboxReceipts).values(row);
  await assert.rejects(
    db.insert(externalAgentInboxReceipts).values({ ...row, admittedGeneration: 2n }),
    /Failed query|unique|duplicate/i,
  );
  // A legitimate later occurrence uses a different key and is admitted.
  await db.insert(externalAgentInboxReceipts).values({ ...row, sourceEventKey: "msg:1:occ-2" });
});

dbTest("at most one non-terminal wake per connection (§3.3 partial unique)", async ({ db }) => {
  const ids = await seedConnection(db);
  const base = { connectionId: ids.connectionId, connectionEpoch: 1n, generationAtCreation: 1n, state: "queued" as const };
  await db.insert(externalAgentWakes).values(base);
  for (const state of ["queued", "active", "blocked"] as const) {
    await assert.rejects(
      db.insert(externalAgentWakes).values({ ...base, state }),
      /Failed query|unique|duplicate/i,
    );
  }
  // Terminal wakes coexist freely with a live one.
  await db.insert(externalAgentWakes).values({ ...base, state: "settled" });
  await db.insert(externalAgentWakes).values({ ...base, state: "exhausted" });
});

dbTest("attempts are unique per (wake, attemptNumber) (§3.3)", async ({ db }) => {
  const ids = await seedConnection(db);
  const [wake] = await db.insert(externalAgentWakes).values({
    connectionId: ids.connectionId, connectionEpoch: 1n, generationAtCreation: 1n,
  }).returning();
  const attempt = { wakeId: wake.id, attemptNumber: 1, connectionRevision: 0, connectionEpoch: 1n, dispatchFence: 1n, requestDigest: "d1" };
  await db.insert(externalAgentWakeAttempts).values(attempt);
  await assert.rejects(
    db.insert(externalAgentWakeAttempts).values({ ...attempt, requestDigest: "d2" }),
    /Failed query|unique|duplicate/i,
  );
});

dbTest("run begin idempotency key is unique per (connection, epoch, key) (v1.1 §3)", async ({ db }) => {
  const ids = await seedConnection(db);
  const [wake] = await db.insert(externalAgentWakes).values({
    connectionId: ids.connectionId, connectionEpoch: 1n, generationAtCreation: 1n,
  }).returning();
  const run = {
    connectionId: ids.connectionId, connectionEpoch: 1n, agentId: ids.agentId,
    credentialId: "0b0a0f9e-0000-4000-8000-0000000000aa", wakeId: wake.id,
    fence: 1n, beginRequestKey: "begin-1", beginRequestDigest: "digest-1",
    ownerTokenHash: "hash-1",
    leaseExpiresAt: new Date(Date.now() + 300_000), maxEndsAt: new Date(Date.now() + 1_800_000),
  };
  await db.insert(externalAgentRuns).values(run);
  await assert.rejects(
    db.insert(externalAgentRuns).values({ ...run, ownerTokenHash: "hash-2" }),
    /Failed query|unique|duplicate/i,
  );
  // A different epoch (connection was revoked/rotated) may reuse the key.
  await db.insert(externalAgentRuns).values({ ...run, connectionEpoch: 2n });
});

dbTest("claim replay and single-open-claim constraints (§3.5, D3)", async ({ db }) => {
  const ids = await seedConnection(db);
  const [wake] = await db.insert(externalAgentWakes).values({
    connectionId: ids.connectionId, connectionEpoch: 1n, generationAtCreation: 1n,
  }).returning();
  const [run] = await db.insert(externalAgentRuns).values({
    connectionId: ids.connectionId, connectionEpoch: 1n, agentId: ids.agentId,
    credentialId: "0b0a0f9e-0000-4000-8000-0000000000aa", wakeId: wake.id,
    fence: 1n, beginRequestKey: "begin-1", beginRequestDigest: "digest-1",
    ownerTokenHash: "hash-1",
    leaseExpiresAt: new Date(Date.now() + 300_000), maxEndsAt: new Date(Date.now() + 1_800_000),
  }).returning();
  const claim = {
    serverId: ids.serverId, agentId: ids.agentId, connectionEpoch: 1n,
    runId: run.id, fence: 1n, requestKey: "rk-1", receiptIds: [],
    expiresAt: new Date(Date.now() + 60_000),
  };
  await db.insert(externalAgentClaims).values(claim);
  // Replay of the same request key is the same batch — a second row collides.
  await assert.rejects(
    db.insert(externalAgentClaims).values(claim),
    /Failed query|unique|duplicate/i,
  );
  // A different request key while one claim is OPEN collides with D3.
  await assert.rejects(
    db.insert(externalAgentClaims).values({ ...claim, requestKey: "rk-2" }),
    /Failed query|unique|duplicate/i,
  );
  // Once the open claim is acked, a new request key may open the next batch.
  await db.execute(sql`UPDATE external_agent_claims SET state = 'acked' WHERE request_key = 'rk-1'`);
  await db.insert(externalAgentClaims).values({ ...claim, requestKey: "rk-2" });
});
