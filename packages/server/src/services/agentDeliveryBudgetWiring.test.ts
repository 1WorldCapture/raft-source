// Task #8 review: the REAL send path must obey the persistent budget. The
// reviewer's probe on the first submission showed 30 outer sends with the
// tracked counter stuck at 1 — these tests drive the actual orchestrator
// method (sendAgentDeliveryWithAckRetry) against the real database, with
// only the transport stubbed, and freeze the fixed shape: outer sends are
// budget-gated, tracker deletion does not reset anything, and exhaustion
// writes a queryable terminal verdict with zero further sends.
import { dbTest as test } from "../test/integration/dbTest.js";
import { closeTestDatabase, openTestDatabase } from "../test/integration/database.js";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { afterEach } from "vitest";
import { getDb } from "../db/index.js";
import { agents, channels, messageMentions, messages, servers, users } from "../db/schema.js";
import { AgentOrchestrator } from "./agentOrchestrator.js";
import {
  ensureMentionDeliveryOccurrences,
  getMentionDeliveryOccurrenceById,
  recordMentionDeliveryServerDecision,
} from "./mentionDeliveryOccurrenceService.js";
import { AGENT_DELIVERY_ACK_MAX_ATTEMPTS } from "./agentDeliveryRetryPolicy.js";

const at = new Date("2026-10-02T00:00:00.000Z");

afterEach(async () => {
  await closeTestDatabase();
});

interface Wiring {
  orch: any;
  sends: number;
  now: { ms: number };
}

/** Real orchestrator, fake clock, stubbed transport and scheduling. */
function wiredOrchestrator(): Wiring {
  const now = { ms: at.getTime() };
  const orch = new AgentOrchestrator(undefined as never, {
    now: () => now.ms,
    setTimeout: ((fn: () => void) => { fn(); return null as never; }),
    clearTimeout: () => {},
  } as never, undefined as never);
  const sends = { count: 0 };
  orch.hasMachineLocally = () => true;
  orch.sendToMachine = async () => {
    sends.count += 1;
    return true;
  };
  orch.getMachineOwnerTraceAttrs = async () => ({});
  // Never let a timer fire synchronously inside these tests.
  orch.scheduleOnClock = () => null as never;
  return { orch, sends: sends.count, now };
}

async function occurrenceFixture(): Promise<{ occurrenceId: string; deliverMsg: () => any }> {
  const db = getDb();
  const suffix = randomUUID();
  const [owner] = await db.insert(users).values({
    email: `wire-${suffix}@raft.test`, name: `owner-${suffix}`, passwordHash: "hash", emailVerified: true,
  }).returning();
  const [server] = await db.insert(servers).values({
    name: `Wire ${suffix.slice(0, 8)}`, slug: `wire-${suffix}`, ownerId: owner.id,
  }).returning();
  const [agent] = await db.insert(agents).values({
    serverId: server.id, name: `agent-${suffix}`, runtime: "codex",
  }).returning();
  const [channel] = await db.insert(channels).values({
    serverId: server.id, name: `channel-${suffix}`, type: "channel",
  }).returning();
  const [message] = await db.insert(messages).values({
    channelId: channel.id, senderType: "user", senderId: owner.id,
    content: `hello @${agent.name}`, seq: 1,
  }).returning();
  const [mention] = await db.insert(messageMentions).values({
    messageId: message.id, messageSeq: 1, serverId: server.id, channelId: channel.id,
    targetType: "agent", targetId: agent.id, handleAtSendTime: agent.name,
  }).returning();
  const payload = {
    channel_id: channel.id, channel_name: channel.name, channel_type: "channel" as const,
    sender_id: owner.id, sender_name: owner.name, sender_type: "human" as const,
    content: message.content, timestamp: at.toISOString(), message_id: message.id, seq: 1,
  };
  const identity = {
    machineId: "00000000-0000-4000-8000-000000000007",
    launchId: "launch-1",
    sessionId: "session-1",
  };
  await ensureMentionDeliveryOccurrences([{
    occurrenceId: mention.id, messageId: message.id, serverId: server.id,
    agentId: agent.id, deliveryPayload: payload,
  }]);
  await recordMentionDeliveryServerDecision({ occurrenceId: mention.id, payload, identity });
  const deliverMsg = () => ({
    type: "agent:deliver" as const,
    agentId: agent.id,
    seq: 1,
    deliveryId: `delivery-${suffix}`,
    mentionDelivery: {
      occurrenceId: mention.id,
      messageId: message.id,
      machineId: identity.machineId,
      launchId: identity.launchId,
      sessionId: identity.sessionId,
    },
    payload,
    traceparent: undefined,
  });
  return { occurrenceId: mention.id, deliverMsg };
}

test("outer sends obey the persistent budget: 30 outer calls, one send inside the window", { timeout: 30_000 }, async () => {
  await openTestDatabase("pglite://");
  const { occurrenceId, deliverMsg } = await occurrenceFixture();
  const wiring = wiredOrchestrator();
  const sendCount = { count: 0 };
  wiring.orch.sendToMachine = async () => { sendCount.count += 1; return true; };

  // The reviewer's probe shape: 30 outer calls, each with the tracker
  // cleared first (an outer re-delivery path sees a fresh tracker).
  for (let i = 0; i < 30; i += 1) {
    wiring.orch.pendingAgentDeliveryAcks?.clear();
    await wiring.orch.sendAgentDeliveryWithAckRetry(identity0(), deliverMsg(), "probe");
  }
  // First call sends; the remaining 29 meet the budget's wait window (the
  // fake clock never advances) and DO NOT send.
  assert.equal(sendCount.count, 1);
  const row = await getMentionDeliveryOccurrenceById(occurrenceId);
  assert.equal(row?.deliveryRetryAttempts, 1);
  // The next allowed time is authoritative: still one send right after.
  wiring.orch.pendingAgentDeliveryAcks?.clear();
  await wiring.orch.sendAgentDeliveryWithAckRetry(identity0(), deliverMsg(), "probe");
  assert.equal(sendCount.count, 1);

  function identity0(): string {
    return "00000000-0000-4000-8000-000000000007";
  }
});

test("tracker deletion never resets the budget: attempts survive across tracker lifetimes", { timeout: 30_000 }, async () => {
  await openTestDatabase("pglite://");
  const { occurrenceId, deliverMsg } = await occurrenceFixture();
  const wiring = wiredOrchestrator();
  const sendCount = { count: 0 };
  wiring.orch.sendToMachine = async () => { sendCount.count += 1; return true; };

  // Send once, then delete the tracker and advance past the wait window.
  await wiring.orch.sendAgentDeliveryWithAckRetry("00000000-0000-4000-8000-000000000007", deliverMsg(), "probe");
  wiring.orch.pendingAgentDeliveryAcks?.clear();
  wiring.now.ms += 6_000;
  // A "restarted" caller re-delivers the same message: budget continues.
  await wiring.orch.sendAgentDeliveryWithAckRetry("00000000-0000-4000-8000-000000000007", deliverMsg(), "probe");
  const row = await getMentionDeliveryOccurrenceById(occurrenceId);
  assert.equal(row?.deliveryRetryAttempts, 2);
  assert.equal(sendCount.count, 2);
});

test("exhaustion: zero further sends, terminal verdict durable and queryable", { timeout: 120_000 }, async () => {
  await openTestDatabase("pglite://");
  const { occurrenceId, deliverMsg } = await occurrenceFixture();
  const wiring = wiredOrchestrator();
  const sendCount = { count: 0 };
  wiring.orch.sendToMachine = async () => { sendCount.count += 1; return true; };
  const machineId = "00000000-0000-4000-8000-000000000007";

  // Spend the full budget, advancing the clock past each wait window
  // (exponential backoff capped at 5 minutes: advance by the cap).
  for (let i = 0; i < AGENT_DELIVERY_ACK_MAX_ATTEMPTS; i += 1) {
    wiring.orch.pendingAgentDeliveryAcks?.clear();
    await wiring.orch.sendAgentDeliveryWithAckRetry(machineId, deliverMsg(), "probe");
    wiring.now.ms += 6 * 60_000;
  }
  assert.equal(sendCount.count, AGENT_DELIVERY_ACK_MAX_ATTEMPTS);
  // Past exhaustion: outer sends meet the queryable terminal verdict and
  // never touch the transport again.
  for (let i = 0; i < 5; i += 1) {
    wiring.orch.pendingAgentDeliveryAcks?.clear();
    await wiring.orch.sendAgentDeliveryWithAckRetry(machineId, deliverMsg(), "probe");
  }
  assert.equal(sendCount.count, AGENT_DELIVERY_ACK_MAX_ATTEMPTS);
  const row = await getMentionDeliveryOccurrenceById(occurrenceId);
  assert.equal(row?.state, "terminal_error");
  assert.equal(row?.terminalErrorCode, "RETRY_EXHAUSTED");
});
