import { agentApiContract } from "@botiverse/raft-shared";
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { dbTest } from "./dbTest.js";
import { agentCredentials, agents, channelAgents, channels, externalAgentClaims, externalAgentConnections, externalAgentInboxReceipts, externalAgentRuns, externalAgentWakeAttempts, externalAgentWakes, inboxNotificationFacts, messages, messageMentions, threadFollows, inboxTargetMuteStates, productEvents, tasks, taskEvents, reminders, reminderEvents, serverAgentMembers, serverMembers, servers, users } from "../../db/schema.js";
import { assertAgentTransaction, DelegationError, requireAgentBusinessAuthority, withAgentTransaction, type ExecutionContext, withExpandingAgentTransaction } from "../../services/agentTransactionAuthority.js";
import { ExternalAgentConnectionService, WebhookSecretBox } from "../../services/externalAgentConnectionService.js";
import { ExternalAgentDelegationService } from "../../services/externalAgentDelegationService.js";
import { admitNotificationFact, ExternalAgentInboxReceiptService } from "../../services/externalAgentInboxReceiptService.js";
import { createTasks, claimTask, updateTaskStatus } from "../../services/taskService.js";
import { addAgent, removeAgent, createChannel, setInboxTargetActivityMuteState, canAgentAccessChannel, archiveChannel } from "../../services/channelService.js";
import { updateAgent } from "../../services/agentService.js";
import { createReminder, replaceReminder, ackAuthorizedReminderFire } from "../../apps/reminder/service.js";
import { recordInboxNotificationFacts } from "../../services/inboxNotificationService.js";
import { createThirdPartyAgentEvent } from "../../services/oauthService.js";
import { endRun } from "../../services/externalAgentDelegationState.js";
import { guardLegacyAgentConsumption } from "../../middleware/legacyAgentConsumption.js";
import { revokeAgentCredential } from "../../services/agentCredentialService.js";
import { createOrReplayAgentSend } from "../../services/agentSendReplayService.js";
import type { Database } from "../../db/index.js";

import { delegationFixture as fixture } from "./externalAgentDelegation.fixture.js";

const hasCode = (code: string) => (e: unknown) => e instanceof DelegationError && e.code === code;

dbTest("begin response loss replays the same run without renewing its fence or lease; different token conflicts", async ({ db }) => {
  const f = await fixture(db); await f.input(); const active = await f.start();
  const replay = await f.delegation.beginRun(f.identity, active.begin);
  assert.deepEqual(replay, { kind: "replayed", run: active.result.run });
  await assert.rejects(f.delegation.beginRun(f.identity, { ...active.begin, ownerToken: randomBytes(32).toString("hex") }), hasCode("begin_conflict"));
  await assert.rejects(f.delegation.beginRun(f.identity, { ...active.begin, beginRequestKey: randomUUID() }), hasCode("run_busy"));
  const rows = await db.select().from(externalAgentRuns); assert.equal(rows.length, 1);
  assert.ok(!JSON.stringify(active.result).includes(active.begin.ownerToken));
}, 180000);

dbTest("begin before transport callback remains active; provider run id is never fabricated", async ({ db }) => {
  const f = await fixture(db); await f.input(); const active = await f.start();
  await f.delegation.finishDispatchAttempt(f.server.id, f.agent.id, { ...active.reservation, outcome: "accepted", httpStatus: 200 });
  const [wake] = await db.select().from(externalAgentWakes);
  const [attempt] = await db.select().from(externalAgentWakeAttempts);
  assert.equal(wake.state, "active"); assert.equal(attempt.outcome, "accepted"); assert.equal(attempt.providerRunId, null);
}, 180000);

dbTest("fixed claim replay excludes later input, one open claim, partial ack remains durable after expiry", async ({ db }) => {
  const f = await fixture(db); await f.input(); await f.input(); const active = await f.start();
  const first = await f.inbox.claimBatch(f.identity, active.execution, "batch", 2);
  assert.equal(first.receipts.length, 2); await f.input();
  assert.deepEqual(await f.inbox.claimBatch(f.identity, active.execution, "batch", 2), first);
  await assert.rejects(f.inbox.claimBatch(f.identity, active.execution, "another", 1), hasCode("claim_busy"));
  const ack = { receiptId: first.receipts[0].id, disposition: "processed" as const, resultRefs: [] };
  await f.inbox.acknowledgeSubset(f.identity, active.execution, first.claim.id, [ack]);
  await f.inbox.acknowledgeSubset(f.identity, active.execution, first.claim.id, [ack]);
  await assert.rejects(f.inbox.acknowledgeSubset(f.identity, active.execution, first.claim.id, [{ ...ack, disposition: "durable_handoff" }]), hasCode("ack_conflict"));
  await db.update(externalAgentRuns).set({ leaseExpiresAt: new Date(0) }).where(eq(externalAgentRuns.id, active.execution.runId));
  await f.delegation.reconcileConnection(f.server.id, f.agent.id);
  const rows = await db.select().from(externalAgentInboxReceipts);
  assert.equal(rows.find((r) => r.id === ack.receiptId)?.state, "acked");
  assert.equal(rows.filter((r) => r.state === "pending").length, 2);
  await assert.rejects(f.inbox.acknowledgeSubset(f.identity, active.execution, first.claim.id, [ack]), hasCode("execution_stale"));
}, 180000);

dbTest("heartbeat extends the open claim within fixed maximum; short or stale owners never write", async ({ db }) => {
  const f = await fixture(db); await f.input(); const active = await f.start(); const first = await f.inbox.claimBatch(f.identity, active.execution, "batch");
  await db.update(externalAgentRuns).set({ leaseExpiresAt: new Date(Date.now() + 5000) }).where(eq(externalAgentRuns.id, active.execution.runId));
  await db.update(externalAgentClaims).set({ expiresAt: new Date(Date.now() + 5000) }).where(eq(externalAgentClaims.id, first.claim.id));
  const run = await f.delegation.heartbeatRun(f.identity, active.execution);
  const [claim] = await db.select().from(externalAgentClaims);
  assert.equal(claim.expiresAt.toISOString(), run.leaseExpiresAt); assert.ok(claim.expiresAt <= new Date(run.maxEndsAt));
  await assert.rejects(f.delegation.heartbeatRun(f.identity, { ...active.execution, ownerToken: "short" }), hasCode("owner_token_invalid"));
}, 180000);

dbTest("block stops old execution; new input cannot wake; explicit resume preserves budgets", async ({ db }) => {
  const f = await fixture(db); await f.input(); const active = await f.start(); await f.inbox.claimBatch(f.identity, active.execution, "batch");
  await f.delegation.blockRun(f.identity, active.execution, "approval_required"); await f.input();
  await assert.rejects(f.delegation.heartbeatRun(f.identity, active.execution), hasCode("execution_stale"));
  assert.equal(await f.delegation.reserveDispatch(f.server.id, f.agent.id, "worker2"), null);
  const [before] = await db.select().from(externalAgentWakes); assert.equal(before.state, "blocked");
  await f.connectionService.resumeBlocked(f.human, f.agent.id, f.connection.revision, "approved");
  const [after] = await db.select().from(externalAgentWakes); assert.equal(after.id, before.id); assert.equal(after.attemptCount, before.attemptCount); assert.equal(after.state, "queued");
  assert.ok(after.recoveryAuditRef);
  const [audit] = await db.select().from(productEvents).where(eq(productEvents.id, after.recoveryAuditRef));
  const [connection] = await db.select().from(externalAgentConnections).where(eq(externalAgentConnections.agentId, f.agent.id));
  assert.equal((audit.metadata as Record<string, unknown>).revision, connection.revision);
  assert.equal((audit.metadata as Record<string, unknown>).requestRevision, f.connection.revision);
}, 180000);

dbTest("exhausted terminal wake blocks input and scanner; explicit redrive is linked and idempotent", async ({ db }) => {
  const f = await fixture(db); await f.input(); const active = await f.start();
  await f.delegation.finishRun(f.identity, active.execution, "yielded");
  await db.update(externalAgentWakes).set({ state: "exhausted", exhaustedReason: "retry_budget_exhausted" });
  await f.input(); await f.delegation.reconcileConnection(f.server.id, f.agent.id);
  assert.equal(await f.delegation.reserveDispatch(f.server.id, f.agent.id, "worker2"), null);
  const [old] = await db.select().from(externalAgentWakes);
  const updated = await f.connectionService.redriveExhausted(f.human, f.agent.id, f.connection.revision, "redrive-once");
  assert.equal(updated.revision, f.connection.revision + 1);
  await f.connectionService.redriveExhausted(f.human, f.agent.id, f.connection.revision, "redrive-once");
  const rows = await db.select().from(externalAgentWakes); assert.equal(rows.length, 2);
  const fresh = rows.find((r) => r.id !== old.id)!; assert.equal(fresh.cycle, old.cycle + 1n); assert.equal(fresh.attemptCount, 0); assert.ok(fresh.recoveryAuditRef);
  const [audit] = await db.select().from(productEvents).where(eq(productEvents.id, fresh.recoveryAuditRef));
  assert.equal((audit.metadata as Record<string, unknown>).revision, updated.revision);
  assert.equal((audit.metadata as Record<string, unknown>).requestRevision, f.connection.revision);
}, 180000);

dbTest("pause and unbind retain delegated mode; explicit rollback alone admits legacy writers", async ({ db }) => {
  const f = await fixture(db); await f.input(); const active = await f.start();
  const paused = await f.connectionService.pause(f.human, f.agent.id, f.connection.revision, "pause", true);
  assert.equal(paused.enabled, false); assert.equal(paused.consumptionMode, "delegated"); assert.equal(paused.boundCredentialId, null);
  await assert.rejects(withAgentTransaction([f.agent.id], (c) => requireAgentBusinessAuthority(c, f.identity, "send"), db), hasCode("execution_required"));
  const restored = await f.connectionService.rollbackToLegacy(f.human, f.agent.id, paused.revision, "explicit-rollback");
  assert.equal(restored.consumptionMode, "legacy");
  await withAgentTransaction([f.agent.id], (c) => requireAgentBusinessAuthority(c, f.identity, "send"), db);
  await assert.rejects(f.delegation.heartbeatRun(f.identity, active.execution), hasCode("execution_stale"));
  assert.equal((await db.select().from(externalAgentInboxReceipts)).length, 1);
}, 180000);

dbTest("same canonical event is idempotent; source and generation rollback together", async ({ db }) => {
  const f = await fixture(db); const input = await f.input();
  const replay = await withAgentTransaction([f.agent.id], (c) => admitNotificationFact(c, f.server.id, f.agent.id, input.fact.id), db);
  assert.equal(replay!.id, input.receipt.id);
  const [before] = await db.select().from(externalAgentConnections);
  await assert.rejects(withAgentTransaction([f.agent.id], async (c) => {
    const [message] = await c.tx.insert(messages).values({ channelId: f.channel.id, senderType: "user", senderId: f.owner.id, content: "must roll back" }).returning();
    await recordInboxNotificationFacts([{ serverId: f.server.id, receiverType: "agent", receiverId: f.agent.id, kind: "channel", sourceChannelId: f.channel.id, messageId: message.id, messageSeq: message.seq, activityAt: message.createdAt }], c.tx);
    throw new Error("rollback");
  }, db));
  assert.equal((await db.select().from(messages)).filter((row) => row.content === "must roll back").length, 0);
  assert.equal((await db.select().from(inboxNotificationFacts)).length, 1);
  const [after] = await db.select().from(externalAgentConnections); assert.equal(after.pendingGeneration, before.pendingGeneration);
  assert.equal((await db.select().from(externalAgentInboxReceipts)).length, 1);
}, 180000);

dbTest("permission removal suppresses input rather than pretending it was processed; unverified handoff refuses ack", async ({ db }) => {
  const f = await fixture(db); await f.input(); const active = await f.start(); const batch = await f.inbox.claimBatch(f.identity, active.execution, "batch");
  await assert.rejects(f.inbox.acknowledgeSubset(f.identity, active.execution, batch.claim.id, [{ receiptId: batch.receipts[0].id, disposition: "durable_handoff", resultRefs: [] }]), hasCode("handoff_unverified"));
  await db.delete(channelAgents).where(and(eq(channelAgents.channelId, f.channel.id), eq(channelAgents.agentId, f.agent.id)));
  await f.inbox.acknowledgeSubset(f.identity, active.execution, batch.claim.id, [{ receiptId: batch.receipts[0].id, disposition: "processed", resultRefs: [] }]);
  const [receipt] = await db.select().from(externalAgentInboxReceipts); assert.equal(receipt.state, "suppressed"); assert.equal(receipt.ackDisposition, null); assert.equal(receipt.suppressReason, "permission_revoked");
}, 180000);

dbTest("secret encryption binds all ownership dimensions; DTOs and errors never expose material", async ({ db }) => {
  const f = await fixture(db); const [row] = await db.select().from(externalAgentConnections);
  assert.equal(f.secretBox.open(row, row.webhookSecret!), "fixture-webhook-secret");
  assert.throws(() => f.secretBox.open({ ...row, agentId: randomUUID() }, row.webhookSecret!), hasCode("webhook_secret_unavailable"));
  assert.ok(!JSON.stringify(f.connection).includes("fixture-webhook-secret")); assert.ok(!JSON.stringify(f.connection).includes("ciphertext"));
}, 180000);

dbTest("transaction proof cannot be fabricated or reused after commit", async ({ db }) => {
  const f = await fixture(db);
  let old: Parameters<typeof assertAgentTransaction>[0] | undefined;
  await withAgentTransaction([f.agent.id], async (context) => {
    old = context; assertAgentTransaction(context, f.agent.id);
    const foreign = randomUUID();
    (context.agentIds as Set<string>).add(foreign);
    assert.throws(() => assertAgentTransaction(context, foreign), hasCode("agent_transaction_required"));
  }, db);
  assert.throws(() => assertAgentTransaction(old!, f.agent.id), hasCode("agent_transaction_required"));
  assert.throws(() => assertAgentTransaction({ tx: {} as never, agentIds: new Set([f.agent.id]) }, f.agent.id), hasCode("agent_transaction_required"));
}, 180000);


dbTest("empty legacy queues cannot prove cutover; source failure changes no mode, credential or audit", async ({ db }) => {
  const f = await fixture(db);
  const rolledBack = await f.connectionService.rollbackToLegacy(f.human, f.agent.id, f.connection.revision, "rollback-for-cutover");
  const beforeCredentials = await db.select().from(agentCredentials);
  const beforeEvents = await db.select().from(productEvents);
  assert.deepEqual(await f.connectionService.cutoverReadiness(f.human, f.agent.id), { supported: false, reason: "legacy_pending_completeness_unproven" });
  await assert.rejects(f.connectionService.enableWithCutover(f.human, f.agent.id, rolledBack.revision, "unproven"), hasCode("legacy_pending_completeness_unproven"));
  const [connection] = await db.select().from(externalAgentConnections);
  assert.equal(connection.consumptionMode, "legacy"); assert.equal(connection.revision, rolledBack.revision);
  assert.deepEqual(await db.select().from(agentCredentials), beforeCredentials);
  assert.deepEqual(await db.select().from(productEvents), beforeEvents);
  const cutover = beforeEvents.find((row) => row.eventType === "external_agent.cutover")!;
  assert.deepEqual((cutover.metadata as { cutoverManifest: unknown }).cutoverManifest, { version: 1, proof: "same_transaction_new_agent", legacyCandidateIds: [] });
}, 180000);

dbTest("actual task producer replans recipient gates; source, fact, receipt and generation commit together", async ({ db }) => {
  const f = await fixture(db);
  const created = await createTasks(f.channel.id, "user", f.owner.id, [{ title: "A2 canonical task" }]);
  assert.equal(created.tasks.length, 1);
  const [receipt] = await db.select().from(externalAgentInboxReceipts);
  const [fact] = await db.select().from(inboxNotificationFacts);
  assert.equal(receipt.source.kind, "message");
  if (receipt.source.kind === "message") assert.equal(receipt.source.messageId, created.hostMessages[0].id);
  assert.equal(fact.messageId, created.hostMessages[0].id);
  const [connection] = await db.select().from(externalAgentConnections);
  assert.equal(connection.pendingGeneration, 1n);
  assert.equal((await db.select().from(externalAgentWakes)).length, 1);
  await assert.rejects(createTasks(f.channel.id, "agent", f.agent.id, [{ title: "old task writer" }]), hasCode("delegated_legacy_writer_unsupported"));
  assert.equal((await db.select().from(tasks)).length, 1);
}, 180000);

dbTest("actual task claim and status accept current run only; pause rejects legacy and stale commits with zero events", async ({ db }) => {
  const f = await fixture(db); await f.input(); const active = await f.start();
  const [task] = await db.insert(tasks).values({ channelId: f.channel.id, taskNumber: 1, title: "Run-owned task", createdByType: "user", createdById: f.owner.id }).returning();
  const authority = { identity: f.identity, execution: active.execution };
  const claimed = await claimTask(task.id, "agent", f.agent.id, authority); assert.equal(typeof claimed, "object");
  await updateTaskStatus(task.id, "in_review", f.agent.id, "agent", authority);
  await f.connectionService.pause(f.human, f.agent.id, f.connection.revision, "pause-writer");
  const before = await db.select().from(taskEvents);
  await assert.rejects(updateTaskStatus(task.id, "done", f.agent.id, "agent", authority), hasCode("execution_stale"));
  await assert.rejects(updateTaskStatus(task.id, "done", f.agent.id, "agent"), hasCode("delegated_legacy_writer_unsupported"));
  assert.deepEqual(await db.select().from(taskEvents), before);
  assert.equal((await db.select().from(tasks))[0].status, "in_review");
}, 180000);

dbTest("actual message writer accepts authenticated run, retries once and rejects stale replay after credential revoke", async ({ db }) => {
  const f = await fixture(db); await f.input(); const active = await f.start();
  const request = { channelId: f.channel.id, senderId: f.agent.id, content: "run output", agentSendKey: randomUUID(), authority: { identity: f.identity, execution: active.execution } };
  const output = await createOrReplayAgentSend(request);
  assert.equal(output.replayed, false);
  const replay = await createOrReplayAgentSend(request); assert.equal(replay.message.id, output.message.id); assert.equal(replay.replayed, true);
  await revokeAgentCredential({ credentialId: f.credential.id, serverId: f.server.id, agentId: f.agent.id, reason: "test", revokedByUserId: f.owner.id });
  await assert.rejects(createOrReplayAgentSend(request), hasCode("execution_stale"));
  assert.equal((await db.select().from(messages)).filter((row) => row.content === "run output").length, 1);
}, 180000);

dbTest("released fixed batch remains inspectable without renewing expired execution or claiming new input", async ({ db }) => {
  const f = await fixture(db); await f.input(); const active = await f.start();
  const batch = await f.inbox.claimBatch(f.identity, active.execution, "fixed-before-expiry");
  await db.update(externalAgentRuns).set({ leaseExpiresAt: new Date(0) }).where(eq(externalAgentRuns.id, active.execution.runId));
  await f.delegation.reconcileConnection(f.server.id, f.agent.id); await f.input();
  const replay = await f.inbox.claimBatch(f.identity, active.execution, "fixed-before-expiry");
  assert.equal(replay.claim.id, batch.claim.id); assert.equal(replay.claim.state, "released");
  assert.deepEqual(replay.receipts.map((row) => row.id), batch.receipts.map((row) => row.id));
  await assert.rejects(f.inbox.claimBatch(f.identity, active.execution, "new-after-expiry"), hasCode("execution_stale"));
}, 180000);


dbTest("bootstrap status needs a valid credential but no run, while every legacy route rejects before its handler", async ({ db }) => {
  const f = await fixture(db);
  const status = await f.connectionService.getSelfStatus(f.identity);
  assert.equal(status.connection?.consumptionMode, "delegated");
  assert.ok(!JSON.stringify(status).includes("ciphertext"));
  await f.connectionService.pause(f.human, f.agent.id, f.connection.revision, "guard-paused");
  const oldPaths: [string, string][] = Object.values(agentApiContract).map((route) => [route.method, route.path]);
  oldPaths.push(["GET", "/labs"], ["PATCH", "/labs/access"], ["POST", "/server/avatar"], ["GET", "/mentions"], ["GET", "/mentions/example/delivery"], ["POST", "/channels"], ["PATCH", "/channels/example"], ["POST", "/channels/example/members"], ["DELETE", "/channels/example/members"], ["GET", "/wake-hints"], ["POST", "/activity"], ["GET", "/wake-hints/stream"], ["POST", "/attachments/example/comments"], ["POST", "/bridge/events"]);
  assert.ok(oldPaths.length >= 90);
  for (const [method, path] of oldPaths) {
    let nextCalls = 0, statusCode = 0, body: unknown;
    const request = { principalKind: "agent_credential", actingAgentId: f.agent.id, serverId: f.server.id, agentCredentialId: f.credential.id, method, path };
    const response = { status(code: number) { statusCode = code; return this; }, json(value: unknown) { body = value; return this; } };
    await guardLegacyAgentConsumption(request as never, response as never, () => { nextCalls++; });
    assert.equal(nextCalls, 0); assert.equal(statusCode, 403); assert.deepEqual(body, { code: "delegated_legacy_route_unsupported" });
  }
  assert.equal((await db.select().from(externalAgentInboxReceipts)).length, 0);
}, 180000);

dbTest("claim body reader rechecks canonical permission and never serves a foreign or expired batch", async ({ db }) => {
  const f = await fixture(db); await f.input(); const active = await f.start();
  const batch = await f.inbox.claimBatch(f.identity, active.execution, "body");
  const body = await f.inbox.readClaimSource(f.identity, active.execution, batch.claim.id, batch.receipts[0].id);
  assert.equal(body.content, "isolated input"); assert.equal(body.sourceChannelId, f.channel.id);
  await assert.rejects(f.inbox.readClaimSource(f.identity, active.execution, randomUUID(), batch.receipts[0].id), hasCode("claim_stale"));
  await db.delete(channelAgents).where(and(eq(channelAgents.channelId, f.channel.id), eq(channelAgents.agentId, f.agent.id)));
  await assert.rejects(f.inbox.readClaimSource(f.identity, active.execution, batch.claim.id, batch.receipts[0].id), hasCode("source_unavailable"));
  await db.update(externalAgentRuns).set({ leaseExpiresAt: new Date(0) }).where(eq(externalAgentRuns.id, active.execution.runId));
  await assert.rejects(f.inbox.readClaimSource(f.identity, active.execution, batch.claim.id, batch.receipts[0].id), hasCode("execution_stale"));
}, 180000);

dbTest("earlier legitimate attempt of the current wake can begin after a later delivery reservation", async ({ db }) => {
  const f = await fixture(db); await f.input();
  const first = await f.delegation.reserveDispatch(f.server.id, f.agent.id, "worker-one"); assert.ok(first);
  await f.delegation.finishDispatchAttempt(f.server.id, f.agent.id, { ...first, outcome: "accepted", httpStatus: 200 });
  await db.update(externalAgentWakes).set({ startupDeadline: new Date(0) }).where(eq(externalAgentWakes.id, first.payload.wakeId));
  await f.delegation.reconcileConnection(f.server.id, f.agent.id);
  await db.update(externalAgentWakes).set({ nextAttemptAt: new Date(0) });
  const second = await f.delegation.reserveDispatch(f.server.id, f.agent.id, "worker-two"); assert.ok(second);
  const result = await f.delegation.beginRun(f.identity, { wakeId: first.payload.wakeId, attemptId: first.attemptId, epoch: f.connection.epoch, beginRequestKey: randomUUID(), ownerToken: randomBytes(32).toString("hex") });
  assert.equal(result.kind, "started");
  assert.equal((await db.select().from(externalAgentRuns)).length, 1);
}, 180000);

dbTest("startup timeout preserves pending receipts and delivery budget; new input does not reset run-start exhaustion", async ({ db }) => {
  const f = await fixture(db); await f.input(); const first = await f.start();
  await f.delegation.finishRun(f.identity, first.execution, "yielded");
  await db.update(externalAgentWakes).set({ nextAttemptAt: new Date(0) });
  const second = await f.start(); await f.delegation.finishRun(f.identity, second.execution, "yielded");
  await f.input(); await db.update(externalAgentWakes).set({ nextAttemptAt: new Date(0) });
  await f.delegation.reserveDispatch(f.server.id, f.agent.id, "budget-worker");
  const [wake] = await db.select().from(externalAgentWakes);
  const before = wake.attemptCount;
  await f.delegation.reconcileConnection(f.server.id, f.agent.id); await f.input();
  assert.equal(await f.delegation.reserveDispatch(f.server.id, f.agent.id, "new-worker"), null);
  const [after] = await db.select().from(externalAgentWakes);
  assert.equal(after.state, "exhausted"); assert.equal(after.attemptCount, before);
  assert.equal((await db.select().from(externalAgentRuns)).length, 2);
  assert.ok((await db.select().from(externalAgentInboxReceipts)).every((row) => row.state === "pending"));
}, 180000);

dbTest("only protected human acceptance of durable work proves handoff; its replay does not invent a second responsibility", async ({ db }) => {
  const f = await fixture(db); await f.input(); const active = await f.start();
  const batch = await f.inbox.claimBatch(f.identity, active.execution, "handoff");
  const [task] = await db.insert(tasks).values({ channelId: f.channel.id, taskNumber: 1, title: "Accepted responsibility", createdByType: "user", createdById: f.owner.id, claimedByType: "user", claimedById: f.owner.id, status: "in_progress" }).returning();
  const accepted = await f.inbox.acceptDurableHandoff(f.human, f.agent.id, batch.receipts[0].id, task.id);
  assert.deepEqual(await f.inbox.acceptDurableHandoff(f.human, f.agent.id, batch.receipts[0].id, task.id), accepted);
  const ack = await f.inbox.acknowledgeSubset(f.identity, active.execution, batch.claim.id, [{ receiptId: batch.receipts[0].id, disposition: "durable_handoff", resultRefs: [accepted.resultRef] }]);
  assert.equal(ack.receipts[0].ackDisposition, "durable_handoff");
  assert.equal((await db.select().from(productEvents)).filter((row) => row.eventType === "external_agent.durable_handoff").length, 1);
}, 180000);

dbTest("unsupported third-party source is rejected before canonical event insertion, including forged transaction context", async ({ db }) => {
  const f = await fixture(db);
  const input = { serverId: f.server.id, agentId: f.agent.id, clientId: randomUUID(), accessTokenId: randomUUID(), clientKey: "fixture", clientName: "Fixture", kind: "event", summary: "unsupported", payload: {}, resource: "fixture" };
  await assert.rejects(createThirdPartyAgentEvent(input), hasCode("third_party_event_source_unsupported"));
  await assert.rejects(createThirdPartyAgentEvent(input, { tx: db as never, agentIds: new Set([f.agent.id]) }), hasCode("agent_transaction_required"));
}, 180000);


dbTest("manual notify and add are distinct canonical occurrences of one message; replay and forged occurrence cannot duplicate input", async ({ db }) => {
  const f = await fixture(db); const input = await f.input();
  const [mention] = await db.insert(messageMentions).values({ messageId: input.fact.messageId, messageSeq: input.fact.messageSeq, serverId: f.server.id, channelId: f.channel.id, targetType: "agent", targetId: f.agent.id, handleAtSendTime: "grok-test", notifiableAtSend: false, notifiedAt: new Date(), notifiedByType: "user", notifiedById: f.owner.id, notifiedAction: "notify_only" }).returning();
  const admit = (resolutionId: string, action: "notify" | "add") => withAgentTransaction([f.agent.id], (context) => admitNotificationFact(context, f.server.id, f.agent.id, input.fact.id, { resolutionId, action }), db);
  const notify = await admit(mention.id, "notify");
  assert.ok(notify); assert.notEqual(notify.id, input.receipt.id);
  assert.equal((await admit(mention.id, "notify"))?.id, notify.id);
  const [before] = await db.select().from(externalAgentConnections);
  await assert.rejects(admit(randomUUID(), "notify"));
  assert.equal((await db.select().from(externalAgentConnections))[0].pendingGeneration, before.pendingGeneration);
  await db.update(messageMentions).set({ notifiedAction: "add" }).where(eq(messageMentions.id, mention.id));
  const add = await admit(mention.id, "add"); assert.ok(add); assert.notEqual(add.id, notify.id);
  assert.equal((await admit(mention.id, "add"))?.id, add.id);
  const active = await f.start(); const batch = await f.inbox.claimBatch(f.identity, active.execution, "occurrences");
  assert.equal(batch.receipts.length, 3);
  for (const receipt of batch.receipts) {
    const body = await f.inbox.readClaimSource(f.identity, active.execution, batch.claim.id, receipt.id);
    assert.equal(body.messageId, input.fact.messageId);
  }
  assert.equal((await db.select().from(externalAgentConnections))[0].pendingGeneration, 3n);
}, 180000);


dbTest("send replay rejects changed request and checks the database clock again before commit", async ({ db }) => {
  const f = await fixture(db); await f.input(); const active = await f.start();
  const request = { channelId: f.channel.id, senderId: f.agent.id, content: "original", agentSendKey: randomUUID(), authority: { identity: f.identity, execution: active.execution } };
  const sent = await createOrReplayAgentSend(request);
  await assert.rejects(createOrReplayAgentSend({ ...request, content: "changed" }), hasCode("send_request_conflict"));
  assert.equal((await db.select().from(messages)).filter((row) => row.senderId === f.agent.id).length, 1);
  await assert.rejects(createOrReplayAgentSend({ ...request, agentSendKey: randomUUID(), content: "expires-during-write", beforeInsert: async (tx) => { await tx.update(externalAgentRuns).set({ leaseExpiresAt: new Date(0) }).where(eq(externalAgentRuns.id, active.execution.runId)); } }), hasCode("execution_stale"));
  assert.equal((await db.select().from(messages)).filter((row) => row.content === "expires-during-write").length, 0);
  assert.equal((await createOrReplayAgentSend(request)).message.id, sent.message.id);
}, 180000);


dbTest("old direct channel, profile and reminder writers reject delegated callers before their first business write", async ({ db }) => {
  const f = await fixture(db);
  const before = await db.select().from(channelAgents);
  await assert.rejects(createChannel(f.server.id, "forbidden", undefined, "channel", { type: "agent", id: f.agent.id }), hasCode("delegated_legacy_writer_unsupported"));
  await assert.rejects(addAgent(f.channel.id, f.agent.id, { actorAgentId: f.agent.id }), hasCode("delegated_legacy_writer_unsupported"));
  await assert.rejects(removeAgent(f.channel.id, f.agent.id, undefined, f.agent.id), hasCode("delegated_legacy_writer_unsupported"));
  await assert.rejects(setInboxTargetActivityMuteState({ receiverType: "agent", receiverId: f.agent.id, serverId: f.server.id, sourceChannelId: f.channel.id, activityMuted: true }), hasCode("delegated_legacy_writer_unsupported"));
  await assert.rejects(updateAgent(f.agent.id, { description: "forbidden" }, { type: "agent", id: f.agent.id }), hasCode("delegated_legacy_writer_unsupported"));
  await assert.rejects(createReminder({ serverId: f.server.id, ownerAgentId: f.agent.id, msgId: randomUUID(), title: "forbidden", fireAt: new Date(), payload: {}, createdBy: { type: "agent", id: f.agent.id } }), hasCode("delegated_legacy_writer_unsupported"));
  await assert.rejects(ackAuthorizedReminderFire({ serverId: f.server.id, actingAgentId: f.agent.id, reminderId: randomUUID(), sourceVersion: 1, ackAttemptId: randomUUID() }), hasCode("delegated_legacy_writer_unsupported"));
  const source = { serverId: f.server.id, ownerAgentId: f.agent.id, msgId: null, title: "unsupported human source", fireAt: new Date(), payload: null, createdBy: { type: "human" as const, id: f.owner.id } };
  await assert.rejects(createReminder(source), hasCode("reminder_source_unsupported"));
  await assert.rejects(replaceReminder(randomUUID(), source, { expectedVersion: 1 }), hasCode("reminder_source_unsupported"));
  assert.equal((await db.select().from(reminders)).length, 0);
  assert.equal((await db.select().from(reminderEvents)).length, 0);
  assert.deepEqual(await db.select().from(channelAgents), before);
  assert.equal((await db.select().from(channels)).length, 1);
  assert.equal((await db.select().from(agents).where(eq(agents.id, f.agent.id)))[0].description, f.agent.description);
}, 180000);

dbTest("late old-run cleanup never clears the new current run or releases its claim", async ({ db }) => {
  const f = await fixture(db); await f.input(); const old = await f.start();
  await f.inbox.claimBatch(f.identity, old.execution, "old-batch");
  await f.delegation.finishRun(f.identity, old.execution, "yielded");
  const fresh = await f.start(); const batch = await f.inbox.claimBatch(f.identity, fresh.execution, "new-batch");
  const [oldRow] = await db.select().from(externalAgentRuns).where(eq(externalAgentRuns.id, old.execution.runId));
  await withAgentTransaction([f.agent.id], (context) => endRun(context, oldRow, "expired"), db);
  const [connection] = await db.select().from(externalAgentConnections); const [receipt] = await db.select().from(externalAgentInboxReceipts);
  assert.equal(connection.currentRunId, fresh.execution.runId); assert.equal(receipt.currentClaimId, batch.claim.id); assert.equal(receipt.state, "claimed");
  await f.delegation.finishRun(f.identity, old.execution, "yielded");
  assert.equal((await db.select().from(externalAgentConnections))[0].currentRunId, fresh.execution.runId);
}, 180000);


dbTest("receipt reads reuse canonical public, announcement and thread-follow authority", async ({ db }) => {
  const f = await fixture(db); const parent = await f.input();
  const [publicChannel] = await db.insert(channels).values({ serverId: f.server.id, name: "public", type: "channel" }).returning();
  const [announcement] = await db.insert(channels).values({ serverId: f.server.id, name: "announcement", type: "channel", systemKind: "announcement" }).returning();
  const [thread] = await db.insert(channels).values({ serverId: f.server.id, name: "thread", type: "thread", parentMessageId: parent.fact.messageId }).returning();
  const project = (channelId: string, personalMention: boolean) => withAgentTransaction([f.agent.id], async (context) => {
    const [message] = await context.tx.insert(messages).values({ channelId, senderType: "user", senderId: f.owner.id, content: "canonical-source" }).returning();
    await recordInboxNotificationFacts([{ serverId: f.server.id, receiverType: "agent", receiverId: f.agent.id, kind: "channel", sourceChannelId: channelId, messageId: message.id, messageSeq: message.seq, activityAt: message.createdAt, personalMention }], context.tx);
  }, db);
  await project(publicChannel.id, false); await project(announcement.id, false); await project(announcement.id, true); await project(thread.id, false); await project(thread.id, true);
  const active = await f.start(); const batch = await f.inbox.claimBatch(f.identity, active.execution, "canonical-access");
  assert.equal(batch.receipts.length, 4);
  const suppressed = (await db.select().from(externalAgentInboxReceipts)).filter((row) => row.state === "suppressed");
  assert.equal(suppressed.length, 2); assert.ok(suppressed.every((row) => row.suppressReason === "permission_revoked" && row.ackDisposition === null));
  await f.inbox.acknowledgeSubset(f.identity, active.execution, batch.claim.id, batch.receipts.map((row) => ({ receiptId: row.id, disposition: "processed" as const, resultRefs: [] })));
  await db.insert(threadFollows).values({ threadChannelId: thread.id, followerType: "agent", followerId: f.agent.id, parentMessageId: parent.fact.messageId, reason: "manual" });
  await project(thread.id, false);
  assert.equal((await f.inbox.claimBatch(f.identity, active.execution, "followed")).receipts.length, 1);
}, 180000);

dbTest("muted ordinary activity produces no receipt while a personal mention preserves one canonical input", async ({ db }) => {
  const f = await fixture(db);
  await db.insert(inboxTargetMuteStates).values({ receiverType: "agent", receiverId: f.agent.id, serverId: f.server.id, sourceChannelId: f.channel.id, activityMuted: true, muteFromSeq: 1 });
  for (const personalMention of [false, true]) await withAgentTransaction([f.agent.id], async (context) => {
    const [message] = await context.tx.insert(messages).values({ channelId: f.channel.id, senderType: "user", senderId: f.owner.id, content: "muted-policy" }).returning();
    await recordInboxNotificationFacts([{ serverId: f.server.id, receiverType: "agent", receiverId: f.agent.id, kind: "channel", sourceChannelId: f.channel.id, messageId: message.id, messageSeq: message.seq, activityAt: message.createdAt, personalMention }], context.tx);
  }, db);
  assert.equal((await db.select().from(externalAgentInboxReceipts)).length, 1);
  assert.equal((await db.select().from(externalAgentConnections))[0].pendingGeneration, 1n);
}, 180000);


dbTest("delegated thread sends keep archive, projection and parent permissions on the owning transaction", async ({ db }) => {
  const f = await fixture(db); const input = await f.input(); const active = await f.start();
  const [thread] = await db.insert(channels).values({ serverId: f.server.id, name: "thread", type: "thread", parentMessageId: input.fact.messageId }).returning();
  await withAgentTransaction([f.agent.id], async (context) => {
    assert.equal(await canAgentAccessChannel(thread.id, f.agent.id, context.tx), true);
  }, db);
  const request = { channelId: thread.id, senderId: f.agent.id, content: "thread reply", agentSendKey: randomUUID(),
    authority: { identity: f.identity, execution: active.execution } };
  const sent = await createOrReplayAgentSend(request);
  assert.equal(sent.message.channelId, thread.id);
  await archiveChannel(f.channel.id, f.owner.id);
  await assert.rejects(createOrReplayAgentSend({ ...request, agentSendKey: randomUUID(), content: "forbidden after parent archive" }), hasCode("message_target_denied"));
  assert.equal((await db.select().from(messages)).filter((message) => message.senderId === f.agent.id).length, 1);
}, 180000);
