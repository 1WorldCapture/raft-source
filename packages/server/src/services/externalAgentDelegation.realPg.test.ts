import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { beforeAll, afterAll, test } from "vitest";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import pg from "pg";
import { eq, sql } from "drizzle-orm";
import { closeDatabase, initDatabase, type Database } from "../db/index.js";
import * as schema from "../db/schema.js";
import { externalAgentConnections, messages, agentCredentials, externalAgentInboxReceipts, inboxNotificationFacts, agents, channelAgents, externalAgentWakes, externalAgentRuns, externalAgentClaims } from "../db/schema.js";
import { DelegationError, requireAgentBusinessAuthority, withAgentTransaction } from "./agentTransactionAuthority.js";
import { createOrReplayAgentSend, type AgentSendInsertedTransactionInput } from "./agentSendReplayService.js";
import { revokeAgentCredential } from "./agentCredentialService.js";
import { recordInboxNotificationFacts } from "./inboxNotificationService.js";
import { ExternalAgentDelegationService } from "./externalAgentDelegationService.js";
import { ExternalAgentInboxReceiptService } from "./externalAgentInboxReceiptService.js";
import { ExternalAgentConnectionService } from "./externalAgentConnectionService.js";
import { delegationFixture } from "../test/integration/externalAgentDelegation.fixture.js";

const url = process.env.RAFT_A2_REAL_PG_URL;
const required = process.env.RAFT_A2_REAL_PG_REQUIRED === "1";
let db: Database;
let observer: pg.Pool;
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => { resolve = r; });
  return { promise, resolve };
}
async function bounded(promise: Promise<unknown>) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([promise, new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error("barrier timed out")), 4000);
    })]);
  } finally { clearTimeout(timer); }
}
async function observedWait() {
  const end = Date.now() + 4000;
  while (Date.now() < end) {
    const result = await observer.query(`SELECT pg_blocking_pids(pid) AS blockers FROM pg_stat_activity
      WHERE datname = current_database() AND application_name = 'raft-a2-application'
      AND wait_event_type = 'Lock' AND query LIKE '%pg_advisory_xact_lock%'`);
    if (result.rows.some((row) => row.blockers.length > 0)) return;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error("no real PostgreSQL advisory lock wait observed");
}
beforeAll(async () => {
  if (!url) { if (required) throw new Error("ephemeral PostgreSQL URL required"); return; }
  const parsed = new URL(url);
  assert.equal(parsed.hostname, "127.0.0.1");
  assert.equal(parsed.username, "a2_test");
  const applicationUrl = new URL(url);
  applicationUrl.searchParams.set("application_name", "raft-a2-application");
  observer = new pg.Pool({ connectionString: url, max: 2 });
  const migrationPool = new pg.Pool({ connectionString: url, max: 1 });
  try { await migrate(drizzle(migrationPool, { schema }), { migrationsFolder: fileURLToPath(new URL("../../drizzle", import.meta.url)) }); }
  finally { await migrationPool.end(); }
  db = await initDatabase(applicationUrl.toString());
}, 180000);
afterAll(async () => { if (url) { await closeDatabase(); await observer.end(); } });
const realTest = test.skipIf(!url && !required);

realTest("active writer commits before waiting pause; old execution writes zero bytes afterward", async () => {
  const f = await delegationFixture(db); await f.input(); const active = await f.start();
  const entered = deferred(), release = deferred();
  const write = withAgentTransaction([f.agent.id], async (context) => {
    await requireAgentBusinessAuthority(context, f.identity, "send", active.execution);
    entered.resolve(); await release.promise;
    await requireAgentBusinessAuthority(context, f.identity, "send", active.execution);
    await context.tx.insert(messages).values({ channelId: f.channel.id, senderType: "agent", senderId: f.agent.id, content: "before-pause", messageType: "chat" });
  }, db);
  let pause: Promise<unknown> | undefined;
  try {
    await bounded(entered.promise);
    pause = f.connectionService.pause(f.human, f.agent.id, f.connection.revision, randomUUID());
    await observedWait();
  } finally { release.resolve(); await write; }
  await pause;
  const before = await db.select().from(messages).where(eq(messages.senderId, f.agent.id));
  assert.equal(before.length, 1);
  await assert.rejects(withAgentTransaction([f.agent.id], async (context) => {
    await requireAgentBusinessAuthority(context, f.identity, "send", active.execution);
    await context.tx.insert(messages).values({ channelId: f.channel.id, senderType: "agent", senderId: f.agent.id, content: "forbidden", messageType: "chat" });
  }, db), (e: unknown) => e instanceof DelegationError && e.code === "execution_stale");
  assert.deepEqual(await db.select().from(messages).where(eq(messages.senderId, f.agent.id)), before);
}, 30000);

realTest("pause holds the transaction through commit; waiting old writer rejects after revoke", async () => {
  const f = await delegationFixture(db); await f.input(); const active = await f.start();
  const changed = deferred(), release = deferred();
  // Delay the real service's commit through a test-only database adapter.
  // All statements still execute on one real PostgreSQL transaction/connection.
  const delayed = new Proxy(db, { get(target, property, receiver) {
    if (property !== "transaction") return Reflect.get(target, property, receiver);
    return async (work: Parameters<Database["transaction"]>[0]) => target.transaction(async (tx) => {
      const value = await work(tx); changed.resolve(); await release.promise; return value;
    });
  } });
  const service = new ExternalAgentConnectionService(f.secretBox, delayed);
  const pause = service.pause(f.human, f.agent.id, f.connection.revision, randomUUID());
  let write: Promise<unknown> | undefined;
  let rejected: Promise<void> | undefined;
  try {
    await bounded(changed.promise);
    write = withAgentTransaction([f.agent.id], async (context) => {
      await requireAgentBusinessAuthority(context, f.identity, "send", active.execution);
      await context.tx.insert(messages).values({ channelId: f.channel.id, senderType: "agent", senderId: f.agent.id, content: "forbidden", messageType: "chat" });
    }, db);
    rejected = assert.rejects(write, (e: unknown) => e instanceof DelegationError && e.code === "execution_stale");
    await observedWait();
  } finally { release.resolve(); await pause; }
  await rejected;
  assert.equal((await db.select().from(messages).where(eq(messages.senderId, f.agent.id))).length, 0);
}, 30000);

realTest("missing connection uses the same stable gate as first configuration", async () => {
  const f = await delegationFixture(db);
  await db.delete(externalAgentConnections).where(eq(externalAgentConnections.agentId, f.agent.id));
  const entered = deferred(), release = deferred();
  const write = withAgentTransaction([f.agent.id], async (context) => {
    await requireAgentBusinessAuthority(context, f.identity, "send");
    entered.resolve(); await release.promise;
    await context.tx.insert(messages).values({ channelId: f.channel.id, senderType: "agent", senderId: f.agent.id, content: "legacy-before-draft", messageType: "chat" });
  }, db);
  let draft: Promise<unknown> | undefined;
  try {
    await bounded(entered.promise);
    draft = f.connectionService.saveDraft(f.human, f.agent.id, f.connection.activation, null);
    await observedWait();
  } finally { release.resolve(); await write; }
  await draft;
  assert.equal((await db.select().from(externalAgentConnections).where(eq(externalAgentConnections.agentId, f.agent.id))).length, 1);
}, 30000);

realTest("reversed multi-Agent input acquires gates in one stable order without deadlock", async () => {
  const a = await delegationFixture(db), b = await delegationFixture(db);
  const entered = deferred(), release = deferred();
  const first = withAgentTransaction([a.agent.id, b.agent.id], async (context) => {
    assert.deepEqual([...context.agentIds], [a.agent.id, b.agent.id].sort());
    entered.resolve(); await release.promise;
  }, db);
  let second: Promise<unknown> | undefined;
  try {
    await bounded(entered.promise);
    second = withAgentTransaction([b.agent.id, a.agent.id], async (context) => {
      assert.deepEqual([...context.agentIds], [a.agent.id, b.agent.id].sort());
    }, db);
    await observedWait();
  } finally { release.resolve(); await first; }
  await second;
}, 30000);


realTest("actual message write wins credential revocation; revocation then rejects even the same replay key", async () => {
  const f = await delegationFixture(db); await f.input(); const active = await f.start();
  const entered = deferred(), release = deferred();
  const request = { channelId: f.channel.id, senderId: f.agent.id, content: "actual-before-revocation", agentSendKey: randomUUID(), authority: { identity: f.identity, execution: active.execution } };
  const write = createOrReplayAgentSend({ ...request, beforeInsert: async () => { entered.resolve(); await release.promise; } });
  let revocation: Promise<unknown> | undefined;
  try {
    await bounded(entered.promise);
    revocation = revokeAgentCredential({ credentialId: f.credential.id, agentId: f.agent.id, serverId: f.server.id, reason: "isolated-test", revokedByUserId: f.owner.id });
    await observedWait();
  } finally { release.resolve(); await write; }
  await revocation;
  const output = await db.select().from(messages).where(eq(messages.senderId, f.agent.id));
  assert.equal(output.length, 1);
  await assert.rejects(createOrReplayAgentSend(request), (e: unknown) => e instanceof DelegationError && e.code === "execution_stale");
  assert.deepEqual(await db.select().from(messages).where(eq(messages.senderId, f.agent.id)), output);
}, 30000);

realTest("actual credential revocation holds through commit; the waiting message writer produces no source", async () => {
  const f = await delegationFixture(db); await f.input(); const active = await f.start();
  const changed = deferred(), release = deferred();
  const delayed = new Proxy(db, { get(target, property, receiver) {
    if (property !== "transaction") return Reflect.get(target, property, receiver);
    return async (work: Parameters<Database["transaction"]>[0]) => target.transaction(async (tx) => {
      const value = await work(tx); changed.resolve(); await release.promise; return value;
    });
  } });
  const revoke = revokeAgentCredential({ credentialId: f.credential.id, agentId: f.agent.id, serverId: f.server.id, reason: "isolated-test", revokedByUserId: f.owner.id }, delayed);
  let rejected: Promise<void> | undefined;
  try {
    await bounded(changed.promise);
    const write = createOrReplayAgentSend({ channelId: f.channel.id, senderId: f.agent.id, content: "actual-forbidden", agentSendKey: randomUUID(), authority: { identity: f.identity, execution: active.execution } });
    rejected = assert.rejects(write, (e: unknown) => e instanceof DelegationError && e.code === "execution_stale");
    await observedWait();
  } finally { release.resolve(); await revoke; }
  await rejected;
  assert.equal((await db.select().from(messages).where(eq(messages.senderId, f.agent.id))).length, 0);
}, 30000);

realTest("new-Agent cutover commits before waiting canonical source; empty proof never loses concurrent input", async () => {
  const f = await delegationFixture(db);
  const born = deferred(), release = deferred();
  let newId = "";
  const delayed = new Proxy(db, { get(target, property, receiver) {
    if (property !== "transaction") return Reflect.get(target, property, receiver);
    return async (work: Parameters<Database["transaction"]>[0]) => target.transaction(async (tx) => {
      const value = await work(tx);
      newId = (value as { agent: { id: string } }).agent.id; born.resolve(); await release.promise; return value;
    });
  } });
  const provision = new ExternalAgentConnectionService(f.secretBox, delayed).createEnabledExternalAgent(f.human, "concurrent-new-agent", f.connection.activation, "isolated-webhook", randomUUID());
  let source: Promise<unknown> | undefined;
  try {
    await bounded(born.promise);
    assert.equal((await db.select().from(agents).where(eq(agents.id, newId))).length, 0);
    source = withAgentTransaction([newId], async (context) => {
      const [message] = await context.tx.insert(messages).values({ channelId: f.channel.id, senderType: "user", senderId: f.owner.id, content: "source-after-birth" }).returning();
      await recordInboxNotificationFacts([{ serverId: f.server.id, receiverType: "agent", receiverId: newId, kind: "channel", sourceChannelId: f.channel.id, messageId: message.id, messageSeq: message.seq, activityAt: message.createdAt }], context.tx);
    }, db);
    await observedWait();
  } finally { release.resolve(); await provision; }
  await source;
  const [connection] = await db.select().from(externalAgentConnections).where(eq(externalAgentConnections.agentId, newId));
  assert.equal(connection.consumptionMode, "delegated"); assert.equal(connection.pendingGeneration, 1n);
  assert.equal((await db.select().from(externalAgentInboxReceipts).where(eq(externalAgentInboxReceipts.agentId, newId))).length, 1);
}, 30000);


realTest("actual cross-Agent messages serialize reversed recipient plans and atomically project distinct receipts", async () => {
  const a = await delegationFixture(db);
  const provisioned = await a.connectionService.createEnabledExternalAgent(a.human, "grok-peer", a.connection.activation, "peer-secret", randomUUID());
  const b = provisioned.agent;
  await db.insert(channelAgents).values({ channelId: a.channel.id, agentId: b.id });
  const bIdentity = { serverId: a.server.id, agentId: b.id, credentialId: provisioned.credential.credentialId };
  await a.input();
  await withAgentTransaction([b.id], async (context) => {
    const [message] = await context.tx.insert(messages).values({ channelId: a.channel.id, senderType: "user", senderId: a.owner.id, content: "peer-input" }).returning();
    await recordInboxNotificationFacts([{ serverId: a.server.id, receiverType: "agent", receiverId: b.id, kind: "channel", sourceChannelId: a.channel.id, messageId: message.id, messageSeq: message.seq, activityAt: message.createdAt }], context.tx);
  }, db);
  const aRun = await a.start();
  const reservation = await a.delegation.reserveDispatch(a.server.id, b.id, "peer-worker"); assert.ok(reservation);
  const ownerToken = randomBytes(32).toString("hex");
  const bRun = await a.delegation.beginRun(bIdentity, { wakeId: reservation.payload.wakeId, attemptId: reservation.attemptId, epoch: provisioned.connection.epoch, beginRequestKey: randomUUID(), ownerToken });
  assert.notEqual(bRun.kind, "denied"); if (bRun.kind === "denied") throw new Error("peer start rejected");
  const bExecution = { runId: bRun.run.id, epoch: bRun.run.connectionEpoch, fence: bRun.run.fence, ownerToken };
  const entered = deferred(), release = deferred();
  const send = (senderId: string, receiverId: string, authority: Parameters<typeof createOrReplayAgentSend>[0]["authority"], participatingAgentIds: string[], hold = false) => createOrReplayAgentSend({ channelId: a.channel.id, senderId, content: "cross-agent", agentSendKey: randomUUID(), authority, participatingAgentIds,
    beforeInsert: hold ? async () => { entered.resolve(); await release.promise; } : undefined,
    onInserted: async ({ executor, message }: AgentSendInsertedTransactionInput) => recordInboxNotificationFacts([{ serverId: a.server.id, receiverType: "agent", receiverId, kind: "channel", sourceChannelId: a.channel.id, messageId: message.id, messageSeq: message.seq, activityAt: message.createdAt }], executor),
  });
  const first = send(a.agent.id, b.id, { identity: a.identity, execution: aRun.execution }, [a.agent.id, b.id], true);
  let second: ReturnType<typeof send> | undefined;
  try {
    await bounded(entered.promise);
    second = send(b.id, a.agent.id, { identity: bIdentity, execution: bExecution }, [b.id, a.agent.id]);
    await observedWait();
  } finally { release.resolve(); await first; }
  const result = await second; assert.ok(result);
  const sent = await db.select().from(messages).where(eq(messages.channelId, a.channel.id));
  assert.equal(sent.filter((m) => m.content === "cross-agent").length, 2);
  const receipts = await db.select().from(externalAgentInboxReceipts).where(eq(externalAgentInboxReceipts.serverId, a.server.id));
  assert.equal(receipts.length, 4);
  assert.equal(new Set(receipts.map((r) => r.sourceEventKey)).size, 4);
}, 30000);


function delayCommit(database: Database, changed: ReturnType<typeof deferred>, release: ReturnType<typeof deferred>): Database {
  return new Proxy(database, { get(target, property, receiver) {
    if (property !== "transaction") return Reflect.get(target, property, receiver);
    return async (work: Parameters<Database["transaction"]>[0]) => target.transaction(async (tx) => {
      const value = await work(tx); changed.resolve(); await release.promise; return value;
    });
  } });
}
realTest("concurrent begin grants one effective owner; losing owner cannot claim receipts", async () => {
  const f = await delegationFixture(db); await f.input();
  const reservation = await f.delegation.reserveDispatch(f.server.id, f.agent.id, "begin-worker"); assert.ok(reservation);
  const input = { wakeId: reservation.payload.wakeId, attemptId: reservation.attemptId, epoch: f.connection.epoch, beginRequestKey: randomUUID(), ownerToken: randomBytes(32).toString("hex") };
  const changed = deferred(), release = deferred();
  const first = new ExternalAgentDelegationService(delayCommit(db, changed, release)).beginRun(f.identity, input);
  let rejected: Promise<void> | undefined;
  try {
    await bounded(changed.promise);
    rejected = assert.rejects(f.delegation.beginRun(f.identity, { ...input, beginRequestKey: randomUUID(), ownerToken: randomBytes(32).toString("hex") }), (error) => error instanceof DelegationError && error.code === "run_busy");
    await observedWait();
  } finally { release.resolve(); await first; }
  await rejected;
  const runs = await db.select().from(externalAgentRuns).where(eq(externalAgentRuns.agentId, f.agent.id));
  assert.equal(runs.length, 1); assert.equal(runs[0].state, "active");
  await assert.rejects(f.inbox.claimBatch(f.identity, { runId: runs[0].id, epoch: runs[0].connectionEpoch.toString(), fence: runs[0].fence.toString(), ownerToken: randomBytes(32).toString("hex") }, "foreign-owner"), (error) => error instanceof DelegationError && error.code === "execution_stale");
  assert.equal((await db.select().from(externalAgentClaims).where(eq(externalAgentClaims.agentId, f.agent.id))).length, 0);
}, 30000);

realTest("concurrent fixed batches cannot own the same receipt; another key sees claim_busy", async () => {
  const f = await delegationFixture(db); await f.input(); const active = await f.start();
  const changed = deferred(), release = deferred();
  const first = new ExternalAgentInboxReceiptService(delayCommit(db, changed, release)).claimBatch(f.identity, active.execution, "winning");
  let rejected: Promise<void> | undefined;
  try {
    await bounded(changed.promise);
    rejected = assert.rejects(f.inbox.claimBatch(f.identity, active.execution, "losing"), (error) => error instanceof DelegationError && error.code === "claim_busy");
    await observedWait();
  } finally { release.resolve(); await first; }
  await rejected;
  const claims = await db.select().from(externalAgentClaims).where(eq(externalAgentClaims.agentId, f.agent.id));
  const receipts = await db.select().from(externalAgentInboxReceipts).where(eq(externalAgentInboxReceipts.agentId, f.agent.id));
  assert.equal(claims.length, 1); assert.equal(receipts[0].currentClaimId, claims[0].id);
}, 30000);

for (const winner of ["finish", "producer"] as const) realTest(`finish/new-input with ${winner} committing first always retains a recoverable wake`, async () => {
  const f = await delegationFixture(db); await f.input(); const active = await f.start();
  const batch = await f.inbox.claimBatch(f.identity, active.execution, "drain");
  await f.inbox.acknowledgeSubset(f.identity, active.execution, batch.claim.id, batch.receipts.map((r) => ({ receiptId: r.id, disposition: "processed" as const, resultRefs: [] })));
  const changed = deferred(), release = deferred();
  const produce = (database: Database) => withAgentTransaction([f.agent.id], async (context) => {
    const [message] = await context.tx.insert(messages).values({ channelId: f.channel.id, senderType: "user", senderId: f.owner.id, content: "concurrent-final-input" }).returning();
    await recordInboxNotificationFacts([{ serverId: f.server.id, receiverType: "agent", receiverId: f.agent.id, kind: "channel", sourceChannelId: f.channel.id, messageId: message.id, messageSeq: message.seq, activityAt: message.createdAt }], context.tx);
  }, database);
  const delayed = delayCommit(db, changed, release);
  const first = winner === "finish" ? new ExternalAgentDelegationService(delayed).finishRun(f.identity, active.execution, "drained") : produce(delayed);
  let second: Promise<unknown> | undefined;
  try {
    await bounded(changed.promise);
    second = winner === "finish" ? produce(db) : f.delegation.finishRun(f.identity, active.execution, "drained");
    await observedWait();
  } finally { release.resolve(); await first; }
  await second;
  const receipts = await db.select().from(externalAgentInboxReceipts).where(eq(externalAgentInboxReceipts.agentId, f.agent.id));
  assert.equal(receipts.filter((r) => r.state === "pending").length, 1);
  const connection = (await db.select().from(externalAgentConnections).where(eq(externalAgentConnections.agentId, f.agent.id)))[0];
  const wakes = await db.select().from(externalAgentWakes).where(eq(externalAgentWakes.connectionId, connection.id));
  assert.equal(wakes.filter((wake) => wake.state === "queued").length, 1); assert.equal(connection.currentRunId, null);
}, 30000);


realTest("real database clock expiry during a business transaction rolls the message back", async () => {
  const f = await delegationFixture(db); await f.input(); const active = await f.start();
  await db.update(externalAgentRuns).set({ leaseExpiresAt: sql`clock_timestamp() + interval '2 seconds'` }).where(eq(externalAgentRuns.id, active.execution.runId));
  let reachedWrite = false;
  await assert.rejects(createOrReplayAgentSend({ channelId: f.channel.id, senderId: f.agent.id, content: "late-lease-message", agentSendKey: randomUUID(), authority: { identity: f.identity, execution: active.execution }, beforeInsert: async (tx) => {
    reachedWrite = true; await tx.execute(sql`SELECT pg_sleep(2.2)`);
  } }), (error) => error instanceof DelegationError && error.code === "execution_stale");
  assert.equal(reachedWrite, true);
  assert.equal((await db.select().from(messages).where(eq(messages.senderId, f.agent.id))).length, 0);
}, 30000);

realTest("A04 two workers contend on the real gate; no adapter before reservation commit", async () => {
  const { ExternalAgentDelegationWorker } = await import("./externalAgentDelegationWorker.js");
  const { DeterministicFakeWakeAdapter } = await import("./externalAgentFakeAdapter.js");
  const f = await delegationFixture(db); await f.input();
  const entered = deferred(), release = deferred();
  const delayed = new Proxy(db, { get(target, property, receiver) {
    if (property !== "transaction") return Reflect.get(target, property, receiver);
    return async (work: Parameters<Database["transaction"]>[0]) => target.transaction(async (tx) => {
      const value = await work(tx);
      if (value && typeof value === "object" && "attemptId" in value) { entered.resolve(); await release.promise; }
      return value;
    });
  } });
  const adapter = new DeterministicFakeWakeAdapter([{ result: { kind: "http", status: 200 } }]);
  const registry = new Map([["grokbot_webhook", adapter]]);
  const a = new ExternalAgentDelegationWorker(delayed, registry, { serverId: f.server.id });
  const b = new ExternalAgentDelegationWorker(db, registry, { serverId: f.server.id });
  const first = a.runOnce(); let second: ReturnType<typeof b.runOnce> | undefined;
  try { await bounded(entered.promise); second = b.runOnce(); await observedWait(); assert.equal(adapter.calls.length, 0); }
  finally { release.resolve(); await first; }
  await second;
  assert.equal(adapter.calls.length, 1);
  assert.equal((await db.select().from(schema.externalAgentWakeAttempts).innerJoin(externalAgentWakes, eq(externalAgentWakes.id, schema.externalAgentWakeAttempts.wakeId)).where(eq(externalAgentWakes.connectionId, f.connection.id))).length, 1);
}, 30000);

realTest("A05 lost worker lease recovers durably; stale result cannot overwrite new dispatch", async () => {
  const f = await delegationFixture(db); await f.input();
  const old = await f.delegation.reserveDispatch(f.server.id, f.agent.id, "lost-worker"); assert.ok(old);
  await db.update(externalAgentWakes).set({ dispatchLeaseUntil: new Date(0), startupDeadline: new Date(0), nextAttemptAt: new Date(0) }).where(eq(externalAgentWakes.id, old.payload.wakeId));
  const recovered = new ExternalAgentDelegationService(db);
  await recovered.reconcileConnection(f.server.id, f.agent.id);
  await recovered.reconcileConnection(f.server.id, f.agent.id);
  const fresh = await recovered.reserveDispatch(f.server.id, f.agent.id, "replacement"); assert.ok(fresh);
  assert.ok(BigInt(fresh.dispatchFence) > BigInt(old.dispatchFence));
  const before = (await db.select().from(externalAgentWakes).where(eq(externalAgentWakes.id, old.payload.wakeId)))[0];
  assert.deepEqual(await recovered.completeDispatch(f.server.id, f.agent.id, old, { kind: "http", status: 200 }), { recorded: false });
  assert.deepEqual((await db.select().from(externalAgentWakes).where(eq(externalAgentWakes.id, old.payload.wakeId)))[0], before);
  const history = await db.select().from(schema.externalAgentWakeAttempts).where(eq(schema.externalAgentWakeAttempts.wakeId, old.payload.wakeId));
  assert.equal(history.length, 2);
  const expired = history.find((item) => item.id === old.attemptId)!;
  assert.equal(expired.outcome, "unknown"); assert.equal(expired.errorCode, "dispatch_lease_expired");
}, 30000);

realTest("A28 pause during provider I/O keeps late accepted audit but never revives superseded wake", async () => {
  const { ExternalAgentDelegationWorker } = await import("./externalAgentDelegationWorker.js");
  const { DeterministicFakeWakeAdapter } = await import("./externalAgentFakeAdapter.js");
  const f = await delegationFixture(db); await f.input(); const entered = deferred(), release = deferred();
  const adapter = new DeterministicFakeWakeAdapter([{ result: { kind: "http", status: 200 }, onWake: async () => { entered.resolve(); await release.promise; } }]);
  const worker = new ExternalAgentDelegationWorker(db, new Map([["grokbot_webhook", adapter]]), { serverId: f.server.id });
  const tick = worker.runOnce();
  try { await bounded(entered.promise); await f.connectionService.pause(f.human, f.agent.id, f.connection.revision, randomUUID()); }
  finally { release.resolve(); await tick; }
  const [wake] = await db.select().from(externalAgentWakes).where(eq(externalAgentWakes.connectionId, f.connection.id));
  assert.equal(wake.state, "superseded");
  assert.equal((await db.select().from(schema.externalAgentWakeAttempts).where(eq(schema.externalAgentWakeAttempts.wakeId, wake.id)))[0].outcome, "accepted");
  assert.equal((await db.select().from(externalAgentInboxReceipts).where(eq(externalAgentInboxReceipts.agentId, f.agent.id)))[0].state, "pending");
  assert.equal(adapter.pendingCalls, 0);
}, 30000);

realTest("A27 hourly cap spans workers and retry cycles; rate rejection does not spend attempt budget", async () => {
  const f = await delegationFixture(db); await f.input();
  if (f.connection.activation.strategy !== "proxy_delegation") throw new Error("fixture strategy");
  await db.update(externalAgentConnections).set({ activation: { ...f.connection.activation, policy: { ...f.connection.activation.policy, maxWakesPerHour: 1 } } }).where(eq(externalAgentConnections.id, f.connection.id));
  const reservation = await f.delegation.reserveDispatch(f.server.id, f.agent.id, "hourly-first"); assert.ok(reservation);
  await f.delegation.completeDispatch(f.server.id, f.agent.id, reservation, { kind: "http", status: 500 }, 0.5);
  await db.update(externalAgentWakes).set({ nextAttemptAt: new Date(0) }).where(eq(externalAgentWakes.id, reservation.payload.wakeId));
  assert.equal(await new ExternalAgentDelegationService(db).reserveDispatch(f.server.id, f.agent.id, "hourly-next"), null);
  const [wake] = await db.select().from(externalAgentWakes).where(eq(externalAgentWakes.id, reservation.payload.wakeId));
  assert.equal(wake.attemptCount, 1); assert.ok(wake.nextAttemptAt.getTime() > Date.now() + 3500000);
}, 30000);
