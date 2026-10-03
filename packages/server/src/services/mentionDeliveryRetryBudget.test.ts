// Task #8 review: the send budget is PERSISTENT on the occurrence — real
// sends are claimed atomically, survive tracker deletion / redrive / process
// restart, exhaust into a queryable terminal state with a CONTROLLED
// recovery entry, and IDENTITY_UNKNOWN legacy terminal rows stay recoverable
// (an attempt failure never ends the message obligation). These run against
// the real database (dbTest) — the actual state machine, not pure functions.
import { dbTest as test } from "../test/integration/dbTest.js";
import { closeTestDatabase, openTestDatabase } from "../test/integration/database.js";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { afterEach } from "vitest";
import { eq } from "drizzle-orm";
import { getDb } from "../db/index.js";
import { agents, channels, mentionDeliveryOccurrences, messageMentions, messages, servers, users } from "../db/schema.js";
import {
  claimMentionDeliverySendBudget,
  ensureMentionDeliveryOccurrences,
  evaluateMentionDeliveryOccurrence,
  getMentionDeliveryOccurrenceById,
  listRecoverableMentionDeliveries,
  recordMentionDeliveryDaemonTransition,
  recordMentionDeliveryServerDecision,
  recordMentionDeliveryTerminalError,
  recoverMentionDeliveryFromRetryExhaustion,
} from "./mentionDeliveryOccurrenceService.js";

const at = new Date("2026-10-02T00:00:00.000Z");

afterEach(async () => {
  await closeTestDatabase();
});

const MAX = 5;
const backoff = (attemptsAfterSend: number) => attemptsAfterSend * 1_000;

async function deliverableFixture() {
  await openTestDatabase("pglite://");
  const db = getDb();
  const suffix = randomUUID();
  const [owner] = await db.insert(users).values({
    email: `budget-${suffix}@raft.test`,
    name: `owner-${suffix}`,
    passwordHash: "hash",
    emailVerified: true,
  }).returning();
  const [server] = await db.insert(servers).values({
    name: `Budget ${suffix.slice(0, 8)}`,
    slug: `budget-${suffix}`,
    ownerId: owner.id,
  }).returning();
  const [agent] = await db.insert(agents).values({
    serverId: server.id,
    name: `agent-${suffix}`,
    runtime: "codex",
  }).returning();
  const [channel] = await db.insert(channels).values({
    serverId: server.id,
    name: `channel-${suffix}`,
    type: "channel",
  }).returning();
  const [message] = await db.insert(messages).values({
    channelId: channel.id,
    senderType: "user",
    senderId: owner.id,
    content: `hello @${agent.name}`,
    seq: 1,
  }).returning();
  const [mention] = await db.insert(messageMentions).values({
    messageId: message.id,
    messageSeq: 1,
    serverId: server.id,
    channelId: channel.id,
    targetType: "agent",
    targetId: agent.id,
    handleAtSendTime: agent.name,
  }).returning();
  const payload = {
    channel_id: channel.id,
    channel_name: channel.name,
    channel_type: "channel" as const,
    sender_id: owner.id,
    sender_name: owner.name,
    sender_type: "human" as const,
    content: message.content,
    timestamp: at.toISOString(),
    message_id: message.id,
    seq: 1,
  };
  const identity = {
    machineId: "00000000-0000-4000-8000-000000000006",
    launchId: "launch-1",
    sessionId: "session-1",
  };
  await ensureMentionDeliveryOccurrences([{
    occurrenceId: mention.id,
    messageId: message.id,
    serverId: server.id,
    agentId: agent.id,
    deliveryPayload: payload,
  }]);
  await recordMentionDeliveryServerDecision({ occurrenceId: mention.id, payload, identity });
  return { occurrenceId: mention.id, agentId: agent.id, messageId: message.id, identity };
}

function claim(occurrenceId: string, nowMs: number) {
  return claimMentionDeliverySendBudget({
    occurrenceId, nowMs, maxAttempts: MAX, backoffMsForAttempts: backoff,
  });
}

test("budget: each real send claims once; the wait window gates re-sends", async () => {
  const { occurrenceId } = await deliverableFixture();
  const t0 = at.getTime();
  // Send #1: claims, schedules the next allowed at t0+1s.
  const first = await claim(occurrenceId, t0);
  assert.deepEqual(first, { decision: "send", attempts: 1, nextAllowedAt: new Date(t0 + 1_000) });
  // A re-send attempt INSIDE the wait window does not send and does not spend.
  const early = await claim(occurrenceId, t0 + 500);
  assert.equal(early.decision, "wait");
  assert.equal((early as { attempts: number }).attempts, 1);
  // Past the window the next send claims again — attempts persist.
  const second = await claim(occurrenceId, t0 + 1_001);
  assert.deepEqual(second, { decision: "send", attempts: 2, nextAllowedAt: new Date(t0 + 1_001 + 2_000) });
});

test("budget: survives tracker deletion, redrive and restart (the row IS the budget)", async () => {
  const { occurrenceId } = await deliverableFixture();
  const t0 = at.getTime();
  for (let i = 0; i < 3; i += 1) {
    const c = await claim(occurrenceId, t0 + i * 10_000);
    assert.equal(c.decision, "send");
  }
  // "Tracker deleted / process restarted": a FRESH reader of the same row
  // sees the same spent budget — no fresh budget ever starts implicitly.
  const row = await getMentionDeliveryOccurrenceById(occurrenceId);
  assert.equal(row?.deliveryRetryAttempts, 3);
  const fresh = await claim(occurrenceId, t0 + 100_000);
  assert.deepEqual(fresh, { decision: "send", attempts: 4, nextAllowedAt: new Date(t0 + 100_000 + 4_000) });
});

test("budget: exhaustion is queryable and recovers ONLY through the controlled entry", async () => {
  const { occurrenceId, agentId, messageId, identity } = await deliverableFixture();
  const t0 = at.getTime();
  for (let i = 0; i < MAX; i += 1) {
    const c = await claim(occurrenceId, t0 + i * 10_000);
    assert.equal(c.decision, "send");
  }
  // Past MAX: every later entry point meets "exhausted" — no more sends.
  const spent = await claim(occurrenceId, t0 + 1_000_000);
  assert.deepEqual(spent, { decision: "exhausted", attempts: MAX });

  // Terminal verdict is durable and queryable.
  const terminal = await recordMentionDeliveryTerminalError({
    occurrenceId, agentId, messageId, identity, code: "RETRY_EXHAUSTED",
  });
  assert.ok(terminal);
  assert.equal(evaluateMentionDeliveryOccurrence(terminal).status, "TERMINAL_ERROR");

  // The controlled recovery clears BOTH the verdict and the budget.
  const recovered = await recoverMentionDeliveryFromRetryExhaustion(occurrenceId);
  assert.ok(recovered);
  assert.equal(recovered.deliveryRetryAttempts, 0);
  assert.equal(recovered.deliveryRetryNextAllowedAt, null);
  const again = await claim(occurrenceId, t0 + 2_000_000);
  assert.equal(again.decision, "send");

  // The entry is scoped: non-exhausted terminal rows are NOT recoverable.
  const drifted = await recordMentionDeliveryTerminalError({
    occurrenceId, agentId, messageId, identity, code: "IDENTITY_DRIFT",
  });
  assert.ok(drifted);
  assert.equal(await recoverMentionDeliveryFromRetryExhaustion(occurrenceId), null);
});

test("IDENTITY_UNKNOWN: legacy terminal rows stay recoverable (attempt failure, not obligation end)", async () => {
  const { occurrenceId, agentId, messageId, identity } = await deliverableFixture();
  // Simulate a PRE-FIX build's terminal write (IDENTITY_UNKNOWN was in the
  // closed set then) — written directly, as history left it.
  const db = getDb();
  await db.update(mentionDeliveryOccurrences).set({
    state: "terminal_error",
    terminalErrorAt: new Date(),
    terminalErrorCode: "IDENTITY_UNKNOWN",
  }).where(eq(mentionDeliveryOccurrences.occurrenceId, occurrenceId));
  const row = await getMentionDeliveryOccurrenceById(occurrenceId);
  assert.ok(row);
  // Reads back on the ordinary hop chain — diagnosable, NOT a terminal verdict.
  assert.notEqual(evaluateMentionDeliveryOccurrence(row).status, "TERMINAL_ERROR");
  // And the recoverable list for the machine still includes it: the unread
  // message stays deliverable once the agent can confirm its identity.
  const recoverable = await listRecoverableMentionDeliveries(identity.machineId);
  assert.ok(recoverable.some((r) => r.occurrenceId === occurrenceId));
  // The budget still gates its re-sends (no fresh implicit budget).
  const c = await claim(occurrenceId, at.getTime() + 10_000);
  assert.equal(c.decision, "send");
  void agentId; void messageId;
});

test("budget: acked occurrences never send", async () => {
  const { occurrenceId } = await deliverableFixture();
  const db = getDb();
  await db.update(mentionDeliveryOccurrences).set({ ackedAt: new Date(), state: "acked" })
    .where(eq(mentionDeliveryOccurrences.occurrenceId, occurrenceId));
  const c = await claim(occurrenceId, at.getTime());
  assert.equal(c.decision, "missing");
});

// Touch the daemon-transition writer so the fixture stays an end-to-end row.
void recordMentionDeliveryDaemonTransition;
