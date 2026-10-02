import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, vi } from "vitest";
import http from "node:http";
import https from "node:https";
import net from "node:net";
import dns from "node:dns";
import childProcess from "node:child_process";
import { dbTest } from "./dbTest.js";
import { delegationFixture } from "./externalAgentDelegation.fixture.js";
import { externalAgentConnections as connections, externalAgentWakes as wakes, externalAgentWakeAttempts as attempts, externalAgentRuns as runs, externalAgentInboxReceipts as receipts } from "../../db/schema.js";
import { ExternalAgentDelegationWorker } from "../../services/externalAgentDelegationWorker.js";
import { DeterministicFakeWakeAdapter } from "../../services/externalAgentFakeAdapter.js";
import type { Database } from "../../db/index.js";

let unexpectedEffects = 0;
let consumedNegativeControl = 0;
beforeEach(() => {
  unexpectedEffects = 0; consumedNegativeControl = 0;
  const reject = () => { unexpectedEffects++; throw new Error("forbidden test side effect"); };
  vi.spyOn(globalThis, "fetch").mockImplementation(async () => reject());
  for (const [target, names] of [
    [http, ["request", "get"]], [https, ["request", "get"]], [net, ["connect", "createConnection"]],
    [dns, ["lookup", "resolve", "resolve4", "resolve6"]],
    [dns.promises, ["lookup", "resolve", "resolve4", "resolve6"]],
    [childProcess, ["spawn", "exec", "execFile", "spawnSync", "execSync", "execFileSync"]],
  ] as const) for (const name of names) vi.spyOn(target as unknown as Record<string, (...args: unknown[]) => unknown>, name).mockImplementation(reject);
});
afterEach(() => {
  try { assert.equal(unexpectedEffects, consumedNegativeControl, "unconsumed network/browser audit"); }
  finally { vi.restoreAllMocks(); }
});

const makeWorker = (db: Database, serverId: string, adapter?: DeterministicFakeWakeAdapter, extra: { deadlineMs?: number; pageSize?: number } = {}) =>
  new ExternalAgentDelegationWorker(db, adapter ? new Map([["grokbot_webhook", adapter]]) : new Map(), { serverId, jitter: () => 0.5, ...extra });
async function due(db: Database) {
  await db.update(wakes).set({ nextAttemptAt: new Date(0), startupDeadline: new Date(0), dispatchLeaseUntil: new Date(0) });
}
function deferred() { let resolve!: () => void; const promise = new Promise<void>((r) => { resolve = r; }); return { promise, resolve }; }

dbTest("A06 default registry is inert; accepted wake does not ack or claim execution", async ({ db }) => {
  const f = await delegationFixture(db); await f.input();
  assert.equal((await makeWorker(db, f.server.id).runOnce())[0].kind, "unsupported");
  assert.equal((await db.select().from(attempts)).length, 0);
  const adapter = new DeterministicFakeWakeAdapter([{ result: { kind: "http", status: 200 } }]);
  await makeWorker(db, f.server.id, adapter).runOnce();
  assert.equal((await db.select().from(wakes))[0].state, "awaiting_agent");
  assert.equal((await db.select().from(receipts))[0].state, "pending");
  assert.equal((await db.select().from(runs)).length, 0);
  assert.equal((await db.select().from(attempts))[0].outcome, "accepted");
  assert.equal((await db.select().from(attempts))[0].providerRunId, null);
  assert.equal(adapter.calls.length, 1); assert.equal(adapter.pendingCalls, 0);
  assert.deepEqual(Object.keys(adapter.calls[0]).sort(), ["schema", "kind", "wakeId", "attemptId", "connectionEpoch", "occurredAt"].sort());
}, 180000);

dbTest("A06/A26 accepted without begin exhausts after restart; new input cannot reset budget", async ({ db }) => {
  const f = await delegationFixture(db); await f.input();
  const adapter = new DeterministicFakeWakeAdapter(Array.from({ length: 3 }, () => ({ result: { kind: "http" as const, status: 200 } })));
  for (let i = 0; i < 3; i++) { await due(db); await makeWorker(db, f.server.id, adapter).runOnce(); }
  await due(db); await makeWorker(db, f.server.id, adapter).runOnce();
  assert.equal((await db.select().from(wakes))[0].state, "exhausted");
  await f.input(); await makeWorker(db, f.server.id, adapter).runOnce();
  assert.equal((await db.select().from(wakes)).length, 1); assert.equal(adapter.calls.length, 3);
  assert.equal((await db.select().from(receipts)).length, 2);
}, 180000);

dbTest("A08/A07 early begin and duplicate physical wakes keep one owner and active state", async ({ db }) => {
  const f = await delegationFixture(db); await f.input();
  const adapter = new DeterministicFakeWakeAdapter([{ result: { kind: "unknown", reason: "network_failure" }, onWake: async (payload) => {
    const begin = { wakeId: payload.wakeId, attemptId: payload.attemptId, epoch: payload.connectionEpoch, beginRequestKey: randomUUID(), ownerToken: randomBytes(32).toString("hex") };
    await f.delegation.beginRun(f.identity, begin);
    await assert.rejects(f.delegation.beginRun(f.identity, { ...begin, beginRequestKey: randomUUID() }));
  } }]);
  await makeWorker(db, f.server.id, adapter).runOnce();
  assert.equal((await db.select().from(wakes))[0].state, "active");
  assert.equal((await db.select().from(runs)).length, 1);
  assert.equal((await db.select().from(attempts))[0].outcome, "unknown");
  assert.equal((await db.select().from(receipts))[0].state, "pending");
}, 180000);

dbTest("A27 auth failure blocks entire binding; new input does not auto wake", async ({ db }) => {
  const f = await delegationFixture(db); await f.input();
  const adapter = new DeterministicFakeWakeAdapter([{ result: { kind: "http", status: 401 } }]);
  await makeWorker(db, f.server.id, adapter).runOnce(); await f.input();
  await makeWorker(db, f.server.id, adapter).runOnce();
  assert.equal(adapter.calls.length, 1);
  assert.equal((await db.select().from(wakes))[0].state, "blocked");
  assert.equal((await db.select().from(connections))[0].pauseReason, "provider_auth_rejected");
  assert.equal((await db.select().from(receipts)).length, 2);
}, 180000);

dbTest("A27 persisted Retry-After survives worker reconstruction with no premature I/O", async ({ db }) => {
  const f = await delegationFixture(db); await f.input();
  const adapter = new DeterministicFakeWakeAdapter([{ result: { kind: "http", status: 429, retryAfterMs: 300000 } }]);
  await makeWorker(db, f.server.id, adapter).runOnce();
  const wake = (await db.select().from(wakes))[0]; const attempt = (await db.select().from(attempts))[0];
  assert.ok(wake.nextAttemptAt.getTime() >= attempt.finishedAt!.getTime() + 300000);
  await makeWorker(db, f.server.id, adapter).runOnce();
  assert.equal(adapter.calls.length, 1); assert.equal(wake.attemptCount, 1);
}, 180000);

dbTest("A28 deadline and cancellation record unknown and clean cooperative fake callbacks", async ({ db }) => {
  const f = await delegationFixture(db); await f.input(); const barrier = deferred();
  const adapter = new DeterministicFakeWakeAdapter([{ result: { kind: "http", status: 200 }, barrier: barrier.promise }]);
  await makeWorker(db, f.server.id, adapter, { deadlineMs: 20 }).runOnce();
  assert.equal(adapter.pendingCalls, 0);
  assert.equal((await db.select().from(attempts))[0].errorCode, "deadline_exceeded");
  barrier.resolve(); await Promise.resolve();
  assert.equal((await db.select().from(wakes))[0].state, "awaiting_agent");
  const cancelled = new AbortController(); cancelled.abort();
  await makeWorker(db, f.server.id, adapter).runOnce(cancelled.signal);
  assert.equal(adapter.calls.length, 1);
}, 180000);

dbTest("A28 local repeated tick shares reservation and stop joins the loop", async ({ db }) => {
  const f = await delegationFixture(db); await f.input(); const barrier = deferred();
  const adapter = new DeterministicFakeWakeAdapter([{ result: { kind: "http", status: 200 }, barrier: barrier.promise }]);
  const worker = makeWorker(db, f.server.id, adapter, { deadlineMs: 50 });
  const first = worker.runOnce(); assert.equal(first, worker.runOnce());
  await first; assert.equal(adapter.calls.length, 1);
  worker.start(10); worker.start(10); await worker.stop(); await worker.stop();
  assert.equal(adapter.pendingCalls, 0);
}, 180000);

dbTest("A32 swallowed unknown network attempt remains visible to test guard", async ({ db }) => {
  const f = await delegationFixture(db); await f.input();
  {
    const adapter = new DeterministicFakeWakeAdapter([{ result: { kind: "http", status: 200 }, onWake: async () => { await fetch("https://provider.invalid"); } }]);
    await makeWorker(db, f.server.id, adapter).runOnce();
    // Negative-control evidence: a swallowed exception cannot erase the audit.
    assert.throws(() => assert.equal(unexpectedEffects, 0));
    assert.equal(unexpectedEffects, 1); consumedNegativeControl = 1;
    assert.equal((await db.select().from(attempts))[0].errorCode, "adapter_failure");
    assert.equal((await db.select().from(receipts))[0].state, "pending");
  }
}, 180000);

dbTest("A05 lease expiry alone fences a completion even before the recovery scan", async ({ db }) => {
  const f = await delegationFixture(db); await f.input();
  const reservation = await f.delegation.reserveDispatch(f.server.id, f.agent.id, "expired-owner"); assert.ok(reservation);
  await db.update(wakes).set({ dispatchLeaseUntil: new Date(0) });
  const [before] = await db.select().from(wakes);
  await f.delegation.completeDispatch(f.server.id, f.agent.id, reservation, { kind: "http", status: 401 });
  assert.deepEqual((await db.select().from(wakes))[0], before);
  assert.equal((await db.select().from(connections))[0].pauseReason, null);
  assert.equal((await db.select().from(attempts))[0].httpStatus, 401);
}, 180000);

dbTest("A28 stopping active loop aborts fake wait, joins audit and allows clean restart", async ({ db }) => {
  const f = await delegationFixture(db); await f.input();
  const waiting = deferred();
  const adapter = new DeterministicFakeWakeAdapter([{ result: { kind: "http", status: 200 }, barrier: waiting.promise }]);
  const worker = makeWorker(db, f.server.id, adapter);
  worker.start(10);
  // Bounded observation without a long sleep or an untracked background job.
  const end = Date.now() + 5000;
  while (!adapter.calls.length && Date.now() < end) await new Promise((r) => setTimeout(r, 1));
  try { assert.equal(adapter.calls.length, 1); }
  finally { await worker.stop(); waiting.resolve(); }
  assert.equal(adapter.pendingCalls, 0);
  assert.equal((await db.select().from(attempts))[0].errorCode, "worker_cancelled");
  const before = await db.select().from(wakes);
  await Promise.resolve(); assert.deepEqual(await db.select().from(wakes), before);
  worker.start(10); await worker.stop();
}, 180000);

dbTest("A01 rolled-back source never invokes adapter or creates dispatch audit", async ({ db }) => {
  const f = await delegationFixture(db);
  const { withAgentTransaction } = await import("../../services/agentTransactionAuthority.js");
  const { admitNotificationFact } = await import("../../services/externalAgentInboxReceiptService.js");
  const { messages, inboxNotificationFacts } = await import("../../db/schema.js");
  await assert.rejects(withAgentTransaction([f.agent.id], async (context) => {
    const [message] = await context.tx.insert(messages).values({ channelId: f.channel.id, senderType: "user", senderId: f.owner.id, content: "rollback", messageType: "chat" }).returning();
    const [fact] = await context.tx.insert(inboxNotificationFacts).values({ receiverType: "agent", receiverId: f.agent.id, serverId: f.server.id, kind: "channel", sourceChannelId: f.channel.id, messageId: message.id, messageSeq: message.seq, activityAt: message.createdAt }).returning();
    await admitNotificationFact(context, f.server.id, f.agent.id, fact.id);
    throw new Error("source rollback");
  }, db));
  const adapter = new DeterministicFakeWakeAdapter([{ result: { kind: "http", status: 200 } }]);
  await makeWorker(db, f.server.id, adapter).runOnce();
  assert.equal(adapter.calls.length, 0); assert.equal((await db.select().from(attempts)).length, 0);
  assert.equal((await db.select().from(receipts)).length, 0);
}, 180000);

dbTest("A27 unknown response retains startup correlation and persisted backoff", async ({ db }) => {
  const f = await delegationFixture(db); await f.input();
  const adapter = new DeterministicFakeWakeAdapter([{ result: { kind: "unknown", reason: "network_failure" } }]);
  await makeWorker(db, f.server.id, adapter).runOnce();
  await db.update(wakes).set({ startupDeadline: new Date(0) });
  await makeWorker(db, f.server.id, adapter).runOnce();
  assert.equal(adapter.calls.length, 1); assert.equal((await db.select().from(wakes))[0].state, "awaiting_agent");
}, 180000);

dbTest("A28 non-cooperative callback cannot be reported as successful cleanup", async ({ db }) => {
  const f = await delegationFixture(db); await f.input(); const release = deferred();
  const adapter = new DeterministicFakeWakeAdapter([{ result: { kind: "http", status: 200 }, onWake: async () => { await release.promise; } }]);
  const worker = makeWorker(db, f.server.id, adapter, { deadlineMs: 20 });
  try {
    await assert.rejects(worker.runOnce(), /adapter cleanup incomplete/);
    await assert.rejects(worker.stop(), /adapter cleanup incomplete/);
    await assert.rejects(worker.runOnce(), /adapter cleanup incomplete/);
    assert.equal((await db.select().from(attempts))[0].errorCode, "deadline_exceeded");
  } finally { release.resolve(); await new Promise((r) => setTimeout(r, 0)); }
  assert.equal(adapter.pendingCalls, 0);
  assert.equal((await db.select().from(receipts))[0].state, "pending");
}, 180000);

dbTest("bounded keyset scan reaches later bindings behind blocked ones", async ({ db }) => {
  const a = await delegationFixture(db), b = await delegationFixture(db); await a.input(); await b.input();
  const aReservation = await a.delegation.reserveDispatch(a.server.id, a.agent.id, "blocked-first"); assert.ok(aReservation);
  await a.delegation.completeDispatch(a.server.id, a.agent.id, aReservation, { kind: "http", status: 401 });
  const adapter = new DeterministicFakeWakeAdapter([{ result: { kind: "http", status: 200 } }]);
  const worker = new ExternalAgentDelegationWorker(db, new Map([["grokbot_webhook", adapter]]), { pageSize: 1 });
  await worker.runOnce(); await worker.runOnce();
  assert.equal(adapter.calls.length, 1);
  assert.equal((await db.select().from(wakes).where(eq(wakes.connectionId, b.connection.id)))[0].state, "awaiting_agent");
}, 180000);

dbTest("A26 repeated yielded runs exhaust independent run-start budget across reconstruction", async ({ db }) => {
  const f = await delegationFixture(db); await f.input();
  const step = { result: { kind: "http" as const, status: 200 }, onWake: async (payload: Parameters<DeterministicFakeWakeAdapter["deliver"]>[0]) => {
    const ownerToken = randomBytes(32).toString("hex");
    const result = await f.delegation.beginRun(f.identity, { wakeId: payload.wakeId, attemptId: payload.attemptId, epoch: payload.connectionEpoch, beginRequestKey: randomUUID(), ownerToken });
    assert.ok(result.kind !== "denied");
    await f.delegation.finishRun(f.identity, { runId: result.run.id, epoch: result.run.connectionEpoch, fence: result.run.fence, ownerToken }, "yielded");
  } };
  const adapter = new DeterministicFakeWakeAdapter([step, step]);
  await makeWorker(db, f.server.id, adapter).runOnce(); await makeWorker(db, f.server.id, adapter).runOnce();
  await f.input(); await makeWorker(db, f.server.id, adapter).runOnce();
  assert.equal(adapter.calls.length, 2); assert.equal((await db.select().from(runs)).length, 2);
  assert.equal((await db.select().from(wakes))[0].state, "exhausted");
  assert.equal((await db.select().from(wakes))[0].attemptCount, 2);
  assert.equal((await db.select().from(receipts)).length, 2);
}, 180000);

dbTest("A14/A18 scan releases expired run batch and preserves partial acknowledgement", async ({ db }) => {
  const f = await delegationFixture(db); await f.input(); await f.input(); const active = await f.start();
  const batch = await f.inbox.claimBatch(f.identity, active.execution, "before-crash", 2);
  await f.inbox.acknowledgeSubset(f.identity, active.execution, batch.claim.id, [{ receiptId: batch.receipts[0].id, disposition: "processed", resultRefs: [] }]);
  await db.update(runs).set({ leaseExpiresAt: new Date(0) }).where(eq(runs.id, active.execution.runId));
  const adapter = new DeterministicFakeWakeAdapter([{ result: { kind: "http", status: 200 } }]);
  await makeWorker(db, f.server.id, adapter).runOnce();
  const rows = await db.select().from(receipts);
  assert.equal(rows.filter((row) => row.state === "acked").length, 1);
  assert.equal(rows.filter((row) => row.state === "pending").length, 1);
  assert.equal((await db.select().from(runs))[0].state, "expired");
  assert.equal((await db.select().from(connections))[0].currentRunId, null);
  assert.equal(adapter.calls.length, 1);
  await assert.rejects(f.inbox.acknowledgeSubset(f.identity, active.execution, batch.claim.id, [{ receiptId: batch.receipts[1].id, disposition: "processed", resultRefs: [] }]));
}, 180000);

dbTest("A28 bounded concurrent dispatch joins every sibling on cancellation", async ({ db }) => {
  const a = await delegationFixture(db), b = await delegationFixture(db); await a.input(); await b.input();
  const release = deferred();
  const adapter = new DeterministicFakeWakeAdapter([
    { result: { kind: "http", status: 200 }, barrier: release.promise },
    { result: { kind: "http", status: 200 }, barrier: release.promise },
  ]);
  const worker = new ExternalAgentDelegationWorker(db, new Map([["grokbot_webhook", adapter]]), { concurrency: 2 });
  const cancel = new AbortController(); const tick = worker.runOnce(cancel.signal);
  const end = Date.now() + 5000;
  try {
    while (adapter.pendingCalls < 2 && Date.now() < end) await new Promise((r) => setTimeout(r, 1));
    assert.equal(adapter.pendingCalls, 2);
  } finally { cancel.abort(); await tick; release.resolve(); }
  assert.equal(adapter.pendingCalls, 0);
  assert.equal((await db.select().from(attempts)).filter((row) => row.errorCode === "worker_cancelled").length, 2);
  assert.equal((await db.select().from(receipts)).filter((row) => row.state === "pending").length, 2);
}, 180000);
