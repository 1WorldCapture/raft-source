import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { agentCredentials, agents, channelAgents, channels, externalAgentClaims, externalAgentConnections, externalAgentInboxReceipts, externalAgentRuns, externalAgentWakeAttempts, externalAgentWakes, inboxNotificationFacts, messages, serverAgentMembers, serverMembers, servers, users } from "../../db/schema.js";
import { assertAgentTransaction, DelegationError, requireAgentBusinessAuthority, withAgentTransaction, type ExecutionContext } from "../../services/agentTransactionAuthority.js";
import { ExternalAgentConnectionService, WebhookSecretBox } from "../../services/externalAgentConnectionService.js";
import { ExternalAgentDelegationService } from "../../services/externalAgentDelegationService.js";
import { admitNotificationFact, ExternalAgentInboxReceiptService } from "../../services/externalAgentInboxReceiptService.js";
import type { Database } from "../../db/index.js";

const config = { strategy: "proxy_delegation" as const, delivery: { adapter: "grokbot_webhook" as const, protocolVersion: 1 as const, endpointUrl: "https://provider.invalid/webhook" },
  policy: { debounceMs: 0, startupTimeoutMs: 10000, leaseTtlMs: 60000, maxRunDurationMs: 120000, maxDeliveryAttempts: 3, maxRunStartsPerCycle: 2, maxWakesPerHour: 30 } };

export async function delegationFixture(db: Database) {
  const [owner] = await db.insert(users).values({ email: `${randomUUID()}@delegation.invalid`, name: `owner-${randomUUID()}`, passwordHash: "test" }).returning();
  const [server] = await db.insert(servers).values({ name: "Delegation test", slug: randomUUID(), ownerId: owner.id }).returning();
  await db.insert(serverMembers).values({ serverId: server.id, userId: owner.id, role: "owner" });
  const human = { serverId: server.id, userId: owner.id };
  const secretBox = new WebhookSecretBox("fixture", new Map([["fixture", randomBytes(32)]]));
  const connectionService = new ExternalAgentConnectionService(secretBox, db);
  const provisioned = await connectionService.createEnabledExternalAgent(human, "grok-test", config, "fixture-webhook-secret", randomUUID());
  const agent = provisioned.agent;
  const [credential] = await db.select().from(agentCredentials).where(eq(agentCredentials.id, provisioned.credential.credentialId));
  const identity = { serverId: server.id, agentId: agent.id, credentialId: credential.id };
  const connection = provisioned.connection;
  const [channel] = await db.insert(channels).values({ serverId: server.id, name: "delegation", type: "private" }).returning();
  await db.insert(channelAgents).values({ channelId: channel.id, agentId: agent.id });
  const delegation = new ExternalAgentDelegationService(db);
  const inbox = new ExternalAgentInboxReceiptService(db);
  async function input() {
    return withAgentTransaction([agent.id], async (context) => {
      const [message] = await context.tx.insert(messages).values({ channelId: channel.id, senderType: "user", senderId: owner.id, content: "isolated input", messageType: "chat" }).returning();
      const [fact] = await context.tx.insert(inboxNotificationFacts).values({ receiverType: "agent", receiverId: agent.id, serverId: server.id, kind: "channel", sourceChannelId: channel.id, messageId: message.id, messageSeq: message.seq, activityAt: message.createdAt }).returning();
      const receipt = await admitNotificationFact(context, server.id, agent.id, fact.id);
      return { receipt: receipt!, fact };
    }, db);
  }
  async function start(ownerToken = randomBytes(32).toString("hex"), beginRequestKey = randomUUID()) {
    const reservation = await delegation.reserveDispatch(server.id, agent.id, "fixture-worker");
    assert.ok(reservation);
    const begin = { wakeId: reservation.payload.wakeId, attemptId: reservation.attemptId, epoch: connection.epoch, beginRequestKey, ownerToken };
    const result = await delegation.beginRun(identity, begin);
    assert.ok(result.kind !== "denied");
    const execution: ExecutionContext = { runId: result.run.id, epoch: result.run.connectionEpoch, fence: result.run.fence, ownerToken };
    return { begin, result, execution, reservation };
  }
  return { owner, server, agent, channel, credential, human, identity, secretBox, connectionService, delegation, inbox, connection, input, start };
}
