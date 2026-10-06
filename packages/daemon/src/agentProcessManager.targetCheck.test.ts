import assert from "node:assert/strict";
import { test } from "vitest";
import { AgentProcessManager } from "./agentProcessManager.js";
import { AgentVisibleDeliveryLedger } from "./agentVisibleDeliveryLedger.js";
import type { AgentProxyVisibleMessage } from "./agentCredentialProxy.js";

type Tracked = {
  agentId: string;
  messageId: string;
  state: "pending" | "drained";
  context: {
    mentionDelivery: { occurrenceId: string; messageId: string; launchId: string; sessionId: string };
    onMentionTransition: (stage: string) => void;
    onMentionAck: () => void;
  };
};
interface Fixture {
  agents: Map<string, { launchId: string; sessionId: string }>;
  trackedMentionDeliveries: Map<string, Tracked>;
  consumeVisibleMessages: (agentId: string, input: { messages: AgentProxyVisibleMessage[]; source: string }) => void;
  consumeTargetInboxMessages: (agentId: string, messages: AgentProxyVisibleMessage[]) => void;
  completePendingTrackedMentions: () => never;
}

// Exercise the real APM composition method and real single-occurrence completion,
// without launching processes, using user state roots, or opening network sockets.
function fixture() {
  const manager = Object.create(AgentProcessManager.prototype) as Fixture;
  manager.agents = new Map([["A", { launchId: "launch-a", sessionId: "session-a" }]]);
  manager.trackedMentionDeliveries = new Map();
  manager.completePendingTrackedMentions = () => { throw new Error("global ACK is forbidden in this path"); };
  const ledger = new AgentVisibleDeliveryLedger();
  const consumed: string[] = [];
  manager.consumeVisibleMessages = (agentId, input) => {
    ledger.recordConsumed(agentId, input);
    consumed.push(...input.messages.map((m) => m.message_id!));
  };
  const acked: string[] = [];
  const transitions: string[] = [];
  const add = (occurrenceId: string, messageId: string, agentId = "A", launchId = "launch-a", sessionId = "session-a") => {
    manager.trackedMentionDeliveries.set(occurrenceId, {
      agentId, messageId, state: "pending",
      context: {
        mentionDelivery: { occurrenceId, messageId, launchId, sessionId },
        onMentionTransition: (stage) => { transitions.push(`${occurrenceId}:${stage}`); },
        onMentionAck: () => { acked.push(occurrenceId); },
      },
    });
  };
  return { manager, ledger, consumed, acked, transitions, add };
}
const message: AgentProxyVisibleMessage = { message_id: "selected", seq: 104, channel_id: "channel-a", channel_type: "channel", channel_name: "a", content: "full body" };

test("target consume completes only returned IDs for current Agent/launch/session, without all-mention ACK", () => {
  const h = fixture();
  h.add("chosen", "selected");
  h.add("other-target", "not-returned");
  h.add("other-agent", "selected", "B");
  h.add("old-launch", "selected", "A", "old-launch");
  h.add("old-session", "selected", "A", "launch-a", "old-session");
  h.manager.consumeTargetInboxMessages("A", [message]);
  assert.deepEqual(h.acked, ["chosen"]);
  assert.deepEqual(h.transitions, ["chosen:daemon_drained"]);
  assert.equal(h.manager.trackedMentionDeliveries.get("other-target")?.state, "pending");
  assert.equal(h.manager.trackedMentionDeliveries.get("old-session")?.state, "pending");
  assert.equal(h.ledger.getBoundary("A", "#a"), undefined, "sparse seq 104 is not a read-through watermark");
  assert.equal(h.ledger.isModelSeen("A", "#a", { message_id: "selected", seq: 104 }), true);
  assert.equal(h.ledger.isModelSeen("A", "#a", { message_id: "older-unread", seq: 90 }), false);
});
test("target consumption confirms a busy mention without waiting for turn_end and is idempotent", () => {
  const h = fixture();
  h.add("chosen", "selected");
  h.manager.consumeTargetInboxMessages("A", [message]);
  h.manager.consumeTargetInboxMessages("A", [message]);
  assert.deepEqual(h.acked, ["chosen"]);
});
test("failed body consumption cannot emit a mention ACK", () => {
  const h = fixture();
  h.add("chosen", "selected");
  h.manager.consumeVisibleMessages = () => { throw new Error("preparation/ledger failure"); };
  assert.throws(() => h.manager.consumeTargetInboxMessages("A", [message]));
  assert.deepEqual(h.acked, []);
  assert.equal(h.manager.trackedMentionDeliveries.get("chosen")?.state, "pending");
});
