// Task #8 review r1 finding 3 (authenticated-identity closure): the attempt
// a terminal_error may stop is located by TRUSTED context only — the
// authenticated connection's machineId plus the server's own tracked
// snapshot. These drive the REAL handleMachineMessage terminal_error path
// (with the agent validator and transport stubbed) and freeze:
//   - machine B forging machine A's full matching payload → ZERO change;
//   - an old launch/session report does not touch a newer tracker;
//   - a legitimate IDENTITY_UNKNOWN stops ONLY its own attempt and the
//     occurrence stays recoverable (no terminal verdict);
//   - a normal confirmed error still completes (terminal verdict + stop).
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

const at = new Date("2026-10-02T00:00:00.000Z");
const MACHINE_A = "00000000-0000-4000-8000-0000000000aa";
const MACHINE_B = "00000000-0000-4000-8000-0000000000bb";

afterEach(async () => {
  await closeTestDatabase();
});

interface Rig {
  orch: any;
  trackers: () => number;
}

function riggedOrchestrator(validatedAgent: { expectedLaunchId: string; sessionId: string; machineId: string } | null): Rig {
  const orch: any = new AgentOrchestrator(undefined as never, {
    now: () => at.getTime(),
    setTimeout: ((fn: () => void) => { fn(); return null as never; }) as never,
    clearTimeout: () => {},
  } as never, undefined as never);
  orch.hasMachineLocally = () => true;
  orch.sendToMachine = async () => true;
  orch.getMachineOwnerTraceAttrs = async () => ({});
  orch.scheduleOnClock = () => null as never;
  orch.validateMachineAgentMessage = async () => validatedAgent;
  const trackers = () => orch.pendingAgentDeliveryAcks.size as number;
  return { orch, trackers };
}

async function fixture() {
  const db = getDb();
  const suffix = randomUUID();
  const [owner] = await db.insert(users).values({
    email: `ident-${suffix}@raft.test`, name: `owner-${suffix}`, passwordHash: "hash", emailVerified: true,
  }).returning();
  const [server] = await db.insert(servers).values({
    name: `Ident ${suffix.slice(0, 8)}`, slug: `ident-${suffix}`, ownerId: owner.id,
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
  const identity = { machineId: MACHINE_A, launchId: "launch-1", sessionId: "session-1" };
  await ensureMentionDeliveryOccurrences([{
    occurrenceId: mention.id, messageId: message.id, serverId: server.id,
    agentId: agent.id, deliveryPayload: payload,
  }]);
  await recordMentionDeliveryServerDecision({ occurrenceId: mention.id, payload, identity });
  const trackedMsg: any = {
    type: "agent:deliver",
    agentId: agent.id,
    seq: 1,
    deliveryId: mention.id, // the real send paths use the occurrenceId as deliveryId
    mentionDelivery: {
      occurrenceId: mention.id,
      messageId: message.id,
      ...identity,
    },
    payload,
  };
  const reportFrom = (machineId: string, overrides: Record<string, unknown> = {}) => ({
    type: "agent:delivery:terminal_error" as const,
    agentId: agent.id,
    code: "DELIVERY_REJECTED" as const,
    mentionDelivery: { ...identity, occurrenceId: mention.id, messageId: message.id },
    ...overrides,
  });
  return { occurrenceId: mention.id, agentId: agent.id, trackedMsg, reportFrom };
}

test("machine B forging machine A's full matching payload changes NOTHING", { timeout: 20_000 }, async () => {
  await openTestDatabase("pglite://");
  const { trackedMsg, reportFrom } = await fixture();
  const rig = riggedOrchestrator({ expectedLaunchId: "launch-1", sessionId: "session-1", machineId: MACHINE_A });
  // Machine A's delivery is tracked (as the server itself tracked it).
  rig.orch.trackPendingAgentDeliveryAck(MACHINE_A, trackedMsg);
  assert.equal(rig.trackers(), 1);
  // Machine B reports A's EXACT payload (all three axes match A's snapshot).
  await rig.orch.handleMachineMessage(MACHINE_B, reportFrom(MACHINE_B, {
    mentionDelivery: { ...trackedMsg.mentionDelivery },
  }));
  // ZERO change: tracker intact, occurrence untouched.
  assert.equal(rig.trackers(), 1, "a forged payload must not cancel the target tracker");
});

test("an unconfirmable reporter (no such agent) changes NOTHING", { timeout: 20_000 }, async () => {
  await openTestDatabase("pglite://");
  const { trackedMsg, reportFrom } = await fixture();
  const rig = riggedOrchestrator(null);
  rig.orch.trackPendingAgentDeliveryAck(MACHINE_A, trackedMsg);
  await rig.orch.handleMachineMessage(MACHINE_A, reportFrom(MACHINE_A));
  assert.equal(rig.trackers(), 1, "an unverifiable agent report must not cancel the tracker");
});

test("old launch/session report does not touch a NEWER tracker", { timeout: 20_000 }, async () => {
  await openTestDatabase("pglite://");
  const { trackedMsg, reportFrom, agentId } = await fixture();
  const rig = riggedOrchestrator({ expectedLaunchId: "launch-2", sessionId: "session-2", machineId: MACHINE_A });
  // The server's CURRENT tracked attempt is generation 2…
  const newer: any = { ...trackedMsg, mentionDelivery: { ...trackedMsg.mentionDelivery, launchId: "launch-2", sessionId: "session-2" } };
  rig.orch.trackPendingAgentDeliveryAck(MACHINE_A, newer);
  assert.equal(rig.trackers(), 1);
  // …but the report carries generation 1 axes (an old process's late error).
  await rig.orch.handleMachineMessage(MACHINE_A, reportFrom(MACHINE_A, {
    mentionDelivery: { ...trackedMsg.mentionDelivery, launchId: "launch-1", sessionId: "session-1" },
  }));
  assert.equal(rig.trackers(), 1, "an old-generation report must not cancel the newer tracker");
  void agentId;
});

test("legitimate IDENTITY_UNKNOWN stops ONLY its own attempt; the occurrence stays recoverable", { timeout: 20_000 }, async () => {
  await openTestDatabase("pglite://");
  const { occurrenceId, trackedMsg, reportFrom } = await fixture();
  const rig = riggedOrchestrator({ expectedLaunchId: "launch-1", sessionId: "session-1", machineId: MACHINE_A });
  rig.orch.trackPendingAgentDeliveryAck(MACHINE_A, trackedMsg);
  assert.equal(rig.trackers(), 1);
  await rig.orch.handleMachineMessage(MACHINE_A, reportFrom(MACHINE_A, { code: "IDENTITY_UNKNOWN" }));
  // Its OWN attempt stops…
  assert.equal(rig.trackers(), 0, "the reporting attempt must stop");
  // …and the durable obligation is NOT terminal: still recoverable/deliverable.
  const row = await getMentionDeliveryOccurrenceById(occurrenceId);
  assert.notEqual(row?.state, "terminal_error", "IDENTITY_UNKNOWN must not terminal-mark the occurrence");
  assert.equal(row?.terminalErrorCode, null);
});

test("a normal confirmed error still completes: terminal verdict + stop", { timeout: 20_000 }, async () => {
  await openTestDatabase("pglite://");
  const { occurrenceId, trackedMsg, reportFrom } = await fixture();
  const rig = riggedOrchestrator({ expectedLaunchId: "launch-1", sessionId: "session-1", machineId: MACHINE_A });
  rig.orch.trackPendingAgentDeliveryAck(MACHINE_A, trackedMsg);
  await rig.orch.handleMachineMessage(MACHINE_A, reportFrom(MACHINE_A, { code: "DELIVERY_REJECTED" }));
  assert.equal(rig.trackers(), 0, "the confirmed attempt must stop");
  const row = await getMentionDeliveryOccurrenceById(occurrenceId);
  assert.equal(row?.state, "terminal_error");
  assert.equal(row?.terminalErrorCode, "DELIVERY_REJECTED");
});
