import { fixturePasswordHash } from "../test/integration/credentials.js";
import { createApiTest } from "../test/integration/apiTest.js";
import assert from "node:assert/strict";

import { and, eq, isNull } from "drizzle-orm";
import { getDb } from "../db/index.js";
import {
  agentActivityEvents,
  agentChannelReadCursors,
  agentCredentials,
  agentKnowledgeEvents,
  agentProviderConnections,
  agents,
  agentScopes,
  attestedSendPendingDrafts,
  channelAgents,
  channels,
  managedMcpAssignments,
  managedMcpServers,
  mentionDeliveryOccurrences,
  messageMentions,
  messages,
  oauthClients,
  oauthGrants,
  providerConnections,
  reminders,
  users,
} from "../db/schema.js";
import { createChannel } from "../services/channelService.js";
import { createServer } from "../services/serverService.js";
import { deleteAgent } from "./agentService.js";
import { findAgentCredentialByApiKey, generateAgentApiKeyMaterial } from "./agentCredentialService.js";
import { applyReclaim, buildReclaimPlan, collectDeletedAgentIds } from "../../scripts/reclaim-deleted-agent-residue.js";

const test = createApiTest({ humanActivityMuteFlagDefaultEnabled: true, onboardingOpenerFlagDefaultEnabled: false });

async function seedAgent(serverId: string, name: string) {
  const db = getDb();
  const [agent] = await db.insert(agents).values({
    serverId,
    name,
    displayName: name,
    status: "active",
    runtime: "claude_code",
    model: "sonnet",
    reasoningEffort: "medium",
    executionMode: "cloud",
    creatorType: "user",
    creatorId: "00000000-0000-0000-0000-000000000000",
  }).returning();
  return agent;
}

// Seeds one residue row in every side table deleteAgent must clean, plus the
// FK parents those rows need (oauth client, MCP server, provider connection,
// channel message). Returns enough handles for the assertions.
async function seedResidue(slug: string) {
  const db = getDb();
  const [owner] = await db.insert(users).values({
    email: `${slug}-owner@slock.test`,
    name: `${slug}-owner`,
    displayName: `${slug}-owner`,
    passwordHash: await fixturePasswordHash("password123"),
    emailVerified: true,
    profileSetupCompletedAt: new Date(),
  }).returning();
  const server = await createServer(`${slug} server`, `${slug}-server`, owner.id);
  const channel = await createChannel(server.id, `${slug}-channel`);
  const agent = await seedAgent(server.id, `${slug}-agent`);
  await db.insert(channelAgents).values({ channelId: channel.id, agentId: agent.id }).onConflictDoNothing();

  const [client] = await db.insert(oauthClients).values({
    serverId: server.id,
    clientId: `${slug}-client`,
    clientSecretHash: "hash",
    name: `${slug} client`,
    createdByUserId: owner.id,
  }).returning();
  const [mcpServer] = await db.insert(managedMcpServers).values({
    serverId: server.id,
    name: `${slug}-mcp`,
    endpointUrl: "https://mcp.test/endpoint",
  }).returning();
  const [connection] = await db.insert(providerConnections).values({
    serverId: server.id,
    name: `${slug}-conn`,
    providerId: "minimax",
  }).returning();
  const [message] = await db.insert(messages).values({
    channelId: channel.id,
    senderType: "user",
    senderId: owner.id,
    content: `hello @${slug}-agent`,
  }).returning();
  const [mention] = await db.insert(messageMentions).values({
    messageId: message.id,
    messageSeq: message.seq,
    serverId: server.id,
    channelId: channel.id,
    targetType: "agent",
    targetId: agent.id,
    handleAtSendTime: `@${slug}-agent`,
  }).returning();

  const liveKey = await generateAgentApiKeyMaterial();
  const staleKey = await generateAgentApiKeyMaterial();
  await db.insert(agentCredentials).values([
    {
      agentId: agent.id,
      apiKeyHash: liveKey.apiKeyHash,
      apiKeyPrefix: liveKey.apiKeyPrefix,
      scopes: ["send", "read"],
      name: `${slug}-live`,
    },
    {
      agentId: agent.id,
      apiKeyHash: staleKey.apiKeyHash,
      apiKeyPrefix: staleKey.apiKeyPrefix,
      scopes: ["send"],
      revokedAt: new Date(Date.now() - 60_000),
      revokedReason: "rotated",
    },
  ]);

  await db.insert(agentScopes).values({
    agentId: agent.id,
    serverId: server.id,
    scopes: ["message:read"],
    mode: "custom",
  });
  await db.insert(oauthGrants).values({
    serverId: server.id,
    agentId: agent.id,
    clientId: client.id,
    scopes: ["message:read"],
    grantedByUserId: owner.id,
  });
  await db.insert(agentChannelReadCursors).values({
    agentId: agent.id,
    channelId: channel.id,
  });
  await db.insert(mentionDeliveryOccurrences).values({
    occurrenceId: mention.id,
    messageId: message.id,
    serverId: server.id,
    agentId: agent.id,
    mentionRecordedAt: new Date(),
  });
  await db.insert(agentKnowledgeEvents).values({
    serverId: server.id,
    agentId: agent.id,
    topicOrPath: "notes/handbook.md",
    docId: "doc-1",
    docVersion: "1",
    docState: "published",
    source: "cli",
    status: "success",
    requestedAt: new Date(),
  });
  await db.insert(managedMcpAssignments).values({
    serverId: server.id,
    agentId: agent.id,
    mcpServerId: mcpServer.id,
  });
  await db.insert(agentProviderConnections).values({
    serverId: server.id,
    agentId: agent.id,
    connectionId: connection.id,
    expectedConfigVersion: 1,
    expectedCredentialVersion: 1,
  });
  await db.insert(attestedSendPendingDrafts).values({
    agentId: agent.id,
    serverId: server.id,
    channelId: channel.id,
    targetType: "channel",
    targetRef: channel.id,
    content: "held draft",
    attestedUpToSeq: message.seq,
    newMessageCountAtHold: 0,
    expiresAt: new Date(Date.now() + 300_000),
  });

  // Three reminders: the still-scheduled one must stop firing with the agent
  // (canceled, not deleted — canceled rows are the audit terminal state), the
  // fired and pre-canceled ones are history and stay.
  await db.insert(reminders).values([
    {
      serverId: server.id,
      ownerAgentId: agent.id,
      title: `${slug} pending reminder`,
      fireAt: new Date(Date.now() + 60_000),
      createdByType: "agent",
      createdById: agent.id,
    },
    {
      serverId: server.id,
      ownerAgentId: agent.id,
      title: `${slug} fired reminder`,
      fireAt: new Date(Date.now() - 60_000),
      status: "fired",
      firedAt: new Date(),
      createdByType: "agent",
      createdById: agent.id,
    },
    {
      serverId: server.id,
      ownerAgentId: agent.id,
      title: `${slug} canceled reminder`,
      fireAt: new Date(Date.now() + 60_000),
      status: "canceled",
      canceledAt: new Date(Date.now() - 30_000),
      createdByType: "agent",
      createdById: agent.id,
    },
  ]);

  // Provenance ledger — kept by design, asserted untouched.
  await db.insert(agentActivityEvents).values({
    agentId: agent.id,
    activity: "working",
    entries: [],
  });

  return { server, channel, agent, liveKey };
}

const residueTables = [
  { label: "agent_scopes", table: agentScopes },
  { label: "oauth_grants", table: oauthGrants },
  { label: "agent_channel_read_cursors", table: agentChannelReadCursors },
  { label: "mention_delivery_occurrences", table: mentionDeliveryOccurrences },
  { label: "agent_knowledge_events", table: agentKnowledgeEvents },
  { label: "managed_mcp_assignments", table: managedMcpAssignments },
  { label: "agent_provider_connections", table: agentProviderConnections },
  { label: "attested_send_pending_drafts", table: attestedSendPendingDrafts },
] as const;

async function countResidueRows(agentId: string): Promise<Record<string, number>> {
  const db = getDb();
  const entries = await Promise.all(residueTables.map(async ({ label, table }) => {
    const rows = await db
      .select({ agentId: table.agentId })
      .from(table)
      .where(eq(table.agentId, agentId));
    return [label, rows.length] as const;
  }));
  return Object.fromEntries(entries);
}

test("deleteAgent purges per-agent residue tables, revokes live credentials, keeps provenance", async ({ db }) => {
  void db; // fixture ensures the global singleton (used by getDb) is initialized
  const { channel, agent, liveKey } = await seedResidue("delete-residue");

  const before = await countResidueRows(agent.id);
  assert.ok(Object.values(before).every((n) => n === 1), `residue seed incomplete: ${JSON.stringify(before)}`);

  await deleteAgent(agent.id);

  const [agentRow] = await db.select().from(agents).where(eq(agents.id, agent.id));
  assert.ok(agentRow?.deletedAt, "agent row must stay (soft delete)");

  // Per-agent side tables: every row bound to the deleted agent is gone.
  const after = await countResidueRows(agent.id);
  for (const [table, count] of Object.entries(after)) {
    assert.equal(count, 0, `${table} rows must be purged`);
  }

  // Reminders: still-scheduled ones are canceled (never fire again, audit
  // row stays); fired and pre-canceled rows are history and stay. All three
  // seeded rows survive — cancel-in-place, not delete.
  const remainingReminders = await db.select().from(reminders)
    .where(eq(reminders.ownerAgentId, agent.id));
  assert.equal(remainingReminders.length, 3, "all reminder rows survive");
  assert.ok(remainingReminders.every((row) => row.status !== "scheduled"), "no reminder stays scheduled");
  const canceledPending = remainingReminders.find((row) => row.title.includes("pending"));
  assert.equal(canceledPending?.status, "canceled", "the pending reminder is canceled, not deleted");
  assert.ok(canceledPending.canceledAt, "canceledAt is stamped");
  const untouched = remainingReminders.filter((row) => !row.title.includes("pending"));
  assert.deepEqual(untouched.map((row) => row.status).sort(), ["canceled", "fired"], "history rows keep their status");

  // Credentials are revoked in place, never deleted — including the already
  // revoked one, whose original revocation metadata must not be overwritten.
  const credentialRows = await db.select().from(agentCredentials)
    .where(eq(agentCredentials.agentId, agent.id));
  assert.equal(credentialRows.length, 2, "credential rows persist for audit");
  const liveRow = credentialRows.find((row) => row.apiKeyPrefix === liveKey.apiKeyPrefix);
  const staleRow = credentialRows.find((row) => row.apiKeyPrefix !== liveKey.apiKeyPrefix);
  assert.ok(liveRow, "previously-live credential row still present");
  assert.ok(liveRow.revokedAt, "previously-live credential must now be revoked");
  assert.equal(liveRow.revokedReason, "agent_deleted");
  assert.ok(staleRow, "pre-revoked credential row still present");
  assert.equal(staleRow.revokedReason, "rotated", "existing revocation metadata is untouched");

  // The revoked key is invisible to credential auth (partial active-prefix
  // lookup skips revoked rows; the deletedAt agent check rejects it again).
  const lookup = await findAgentCredentialByApiKey(liveKey.apiKey);
  assert.equal(lookup, null, "revoked key must not authenticate");

  // Provenance ledger is kept by design.
  const activity = await db.select().from(agentActivityEvents)
    .where(eq(agentActivityEvents.agentId, agent.id));
  assert.equal(activity.length, 1, "activity events are provenance and stay");

  // Membership cleanup + channel preservation (existing deleteAgent behavior).
  const membership = await db.select().from(channelAgents).where(eq(channelAgents.agentId, agent.id));
  assert.equal(membership.length, 0, "channel membership is removed");
  const [channelRow] = await db.select().from(channels).where(eq(channels.id, channel.id));
  assert.equal(channelRow?.deletedAt ?? null, null, "non-DM channel is untouched");
});

test("reclaim plan/apply mirrors deleteAgent cleanup on historical residue", async ({ db }) => {
  void db; // fixture ensures the global singleton (used by getDb) is initialized
  // Simulate HISTORICAL residue: soft-delete the agent directly (as the old
  // deleteAgent did) without the new cleanup, so the reclaimer has real work.
  const { agent, liveKey } = await seedResidue("reclaim-residue");
  await db.update(agents)
    .set({ deletedAt: new Date(), status: "inactive" })
    .where(eq(agents.id, agent.id));

  const ids = await collectDeletedAgentIds(db);
  assert.ok(ids.includes(agent.id), "the soft-deleted agent is targeted");

  const plan = await buildReclaimPlan(db, ids);
  const planFor = (table: string) => plan.find((row) => row.table === table)?.count;
  assert.equal(planFor("agent_credentials"), 1, "one live credential to revoke");
  for (const table of ["agent_scopes", "oauth_grants", "agent_channel_read_cursors", "mention_delivery_occurrences", "agent_knowledge_events", "managed_mcp_assignments", "agent_provider_connections", "attested_send_pending_drafts", "reminders (scheduled)"]) {
    assert.equal(planFor(table), 1, `${table} plan count should be 1`);
  }

  // Dry-run semantics: the plan builder mutates nothing.
  const [stillLive] = await db.select().from(agentCredentials)
    .where(and(eq(agentCredentials.agentId, agent.id), isNull(agentCredentials.revokedAt)));
  assert.ok(stillLive, "dry-run must not revoke");

  const { revokedCredentials } = await applyReclaim(db, ids);
  assert.ok(revokedCredentials >= 1, "at least the seeded live credential is revoked");

  const after = await countResidueRows(agent.id);
  for (const [table, count] of Object.entries(after)) {
    assert.equal(count, 0, `${table} rows must be purged by the reclaimer`);
  }
  const scheduledLeft = await db.select().from(reminders)
    .where(and(eq(reminders.ownerAgentId, agent.id), eq(reminders.status, "scheduled")));
  assert.equal(scheduledLeft.length, 0, "no reminder stays scheduled");
  const historyLeft = await db.select().from(reminders).where(eq(reminders.ownerAgentId, agent.id));
  assert.equal(historyLeft.length, 3, "all reminder rows stay (scheduled one now canceled)");
  const credentialRows = await db.select().from(agentCredentials).where(eq(agentCredentials.agentId, agent.id));
  assert.equal(credentialRows.length, 2, "credential rows persist");
  assert.equal(
    credentialRows.find((row) => row.apiKeyPrefix === liveKey.apiKeyPrefix)?.revokedReason,
    "deleted_agent_residue_reclaim",
  );

  // Idempotency: rerunning touches nothing.
  const second = await applyReclaim(db, ids);
  assert.equal(second.revokedCredentials, 0);
  const planAfter = await buildReclaimPlan(db, ids);
  assert.ok(planAfter.every((row) => row.count === 0), "rerun plan reports 0 everywhere");
});
