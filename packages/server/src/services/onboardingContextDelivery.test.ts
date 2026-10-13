import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import type { AgentMessage } from "@botiverse/raft-shared";
import { getDb } from "../db/index.js";
import { users } from "../db/schema.js";
import { dbTest } from "../test/integration/dbTest.js";
import { createAgent, updateAgentStatus } from "./agentService.js";
import { resetAgentScopesToDefault } from "./agentScopesService.js";
import { AgentOrchestrator } from "./agentOrchestrator.js";
import { registerMachine } from "./machineService.js";
import { startOnboardingBriefingOnActivation } from "./onboardingBriefingOnActivation.js";
import { createServer, updateServerOnboardingAgent } from "./serverService.js";

class RecordingOrchestrator extends AgentOrchestrator {
  readonly queued: AgentMessage[] = [];
  lastResult: unknown = null;

  override async deliverMessage(
    agentId: string,
    message: AgentMessage,
    options?: Parameters<AgentOrchestrator["deliverMessage"]>[2],
  ) {
    const result = await super.deliverMessage(agentId, message, options);
    this.lastResult = result;
    return result;
  }

  override deliverToLocalInbox(
    agentId: string,
    message: AgentMessage,
    options?: { notifyPendingReceive?: boolean; reconcileNonMemberMention?: boolean },
  ): void {
    this.queued.push(message);
    super.deliverToLocalInbox(agentId, message, options);
  }

  override async sendAgentDeliveryWithAckRetry(): Promise<boolean> {
    return false;
  }
}

function contextMessage(channelId: string): AgentMessage {
  return {
    channel_id: channelId,
    channel_name: channelId,
    channel_type: "channel",
    sender_id: "system",
    sender_name: "system",
    sender_type: "system",
    content: "not the owner facts",
    timestamp: new Date().toISOString(),
    seq: 0,
    message_id: `probe-${channelId}`,
  };
}

dbTest("onboarding-context is delivered and a non-uuid channel id does not hit the database", async ({ db }) => {
  void db;
  const [owner] = await getDb().insert(users).values({
    email: `facts-${randomUUID()}@slock.test`,
    name: "Ada Owner",
    displayName: "Ada",
    passwordHash: "test-hash",
    emailVerified: true,
  }).returning();
  const server = await createServer("Facts", `facts-${randomUUID()}`, owner.id);
  const { machine } = await registerMachine(server.id, owner.id, "facts-computer");
  const cindy = await createAgent(server.id, "cindy", { runtime: "claude", machineId: machine.id });
  const other = await createAgent(server.id, "other", { runtime: "claude", machineId: machine.id });
  await updateServerOnboardingAgent(server.id, cindy.id);
  await updateAgentStatus(cindy.id, "active");
  await resetAgentScopesToDefault({ agentId: cindy.id, updatedByUserId: owner.id });
  await resetAgentScopesToDefault({ agentId: other.id, updatedByUserId: owner.id });

  const orchestrator = new RecordingOrchestrator();
  const warnings: string[] = [];
  const originalWarn = console.warn;
  console.warn = (...args: unknown[]) => {
    warnings.push(args.map((part) => (part instanceof Error ? part.message : String(part))).join(" "));
  };
  const stop = startOnboardingBriefingOnActivation({
    io: {} as never,
    orchestrator,
    trigger: async () => false,
  });
  try {
    orchestrator.emit("machine:online", { machineId: machine.id, serverId: server.id });
    for (let attempt = 0; attempt < 50 && orchestrator.lastResult === null; attempt += 1) {
      await new Promise((resolve) => setImmediate(resolve));
    }
    assert.equal(
      orchestrator.lastResult && typeof orchestrator.lastResult === "object"
        ? (orchestrator.lastResult as { status?: string }).status
        : null,
      "queued",
      JSON.stringify({ result: orchestrator.lastResult, warnings }),
    );
    const facts = orchestrator.queued.find((message) => message.channel_id === "onboarding-context");
    assert.ok(facts, "owner facts were queued for the onboarding agent");
    assert.match(facts.content, /Ada Owner/);

    warnings.length = 0;
    const bad = await orchestrator.deliverMessage(cindy.id, contextMessage("not-a-channel"));
    assert.deepEqual(bad, { status: "dropped", reason: "target_access_changed" });
    const warningText = warnings.join("\n");
    assert.match(warningText, /channel id is not a uuid/);
    assert.doesNotMatch(warningText, /invalid input syntax for type uuid/);
    assert.doesNotMatch(warningText, /DrizzleQueryError/);

    warnings.length = 0;
    const wrongAgent = await orchestrator.deliverMessage(other.id, contextMessage("onboarding-context"));
    assert.deepEqual(wrongAgent, { status: "dropped", reason: "target_access_changed" });
    assert.match(warnings.join("\n"), /channel id is not a uuid/);
    assert.equal(
      orchestrator.queued.filter((message) => message.message_id === "probe-onboarding-context").length,
      0,
    );
  } finally {
    stop();
    console.warn = originalWarn;
  }
});
