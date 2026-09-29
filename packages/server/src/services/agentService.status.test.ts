import { fixturePasswordHash } from "../test/integration/credentials.js";
import { createApiTest } from "../test/integration/apiTest.js";
import assert from "node:assert/strict";

import { eq } from "drizzle-orm";
import { getDb } from "../db/index.js";
import { agents, channelAgents, machines, notificationEvents, serverAgentMembers, users } from "../db/schema.js";
import { countActiveAgentsMissingServerMembership, createServer, getAgentMemberRole } from "./serverService.js";
import { createAgent, deleteAgent, getAgent, invalidateAgentSessionFromSignal, resetAgentSession, resetAllAgentStatuses, updateAgent, updateAgentStatus, updateAgentStatusFromSignal } from "./agentService.js";
import { addAgent, createChannel, findOrCreateAgentDM } from "./channelService.js";

const test = createApiTest({ humanActivityMuteFlagDefaultEnabled: true, onboardingOpenerFlagDefaultEnabled: false });

async function seedAgent(name: string) {
  const db = getDb();
  const [owner] = await db.insert(users).values({
    email: `${name}@slock.test`,
    name,
    displayName: "Owner",
    passwordHash: await fixturePasswordHash("password123"),
    emailVerified: true,
  }).returning();

  const server = await createServer(`${name} server`, `${name}-server`, owner.id);
  const agent = await createAgent(server.id, `${name}-agent`, { runtime: "codex" });
  return agent;
}

test("updateAgentStatus keeps manually stopped status sticky against inactive updates", async ({ app }) => {
  const agent = await seedAgent("status-sticky");

  await updateAgentStatus(agent.id, "stopped");
  await updateAgentStatus(agent.id, "inactive");

  const updated = await getAgent(agent.id);
  assert.equal(updated?.status, "stopped");
});

test("updateAgentStatus still allows active updates after a stopped state", async ({ app }) => {
  const agent = await seedAgent("status-active-after-stop");

  await updateAgentStatus(agent.id, "stopped");
  await updateAgentStatus(agent.id, "active");

  const updated = await getAgent(agent.id);
  assert.equal(updated?.status, "active");
});

test("resetAgentSession can clear a session while preserving stopped status", async ({ app }) => {
  const agent = await seedAgent("status-reset-stopped");

  await updateAgentStatus(agent.id, "stopped", "session-old");
  await resetAgentSession(agent.id, "stopped");

  const updated = await getAgent(agent.id);
  assert.equal(updated?.status, "stopped");
  assert.equal(updated?.sessionId, null);
});

test("updateAgentStatusFromSignal keeps stopped sticky against active signals", async ({ app }) => {
  const agent = await seedAgent("status-signal-active");

  await updateAgentStatus(agent.id, "stopped");
  const applied = await updateAgentStatusFromSignal(agent.id, "active", "session-late");

  const updated = await getAgent(agent.id);
  assert.equal(applied, false);
  assert.equal(updated?.status, "stopped");
  // sessionId must not leak through either — late session bound to stopped is stale.
  assert.equal(updated?.sessionId, null);
});

test("updateAgentStatusFromSignal keeps stopped sticky against inactive signals", async ({ app }) => {
  const agent = await seedAgent("status-signal-inactive");

  await updateAgentStatus(agent.id, "stopped");
  const applied = await updateAgentStatusFromSignal(agent.id, "inactive");

  const updated = await getAgent(agent.id);
  assert.equal(applied, false);
  assert.equal(updated?.status, "stopped");
});

test("updateAgentStatusFromSignal still applies when the agent is not stopped", async ({ app }) => {
  const agent = await seedAgent("status-signal-applies");

  const activeApplied = await updateAgentStatusFromSignal(agent.id, "active", "session-fresh");
  const afterActive = await getAgent(agent.id);
  assert.equal(activeApplied, true);
  assert.equal(afterActive?.status, "active");
  assert.equal(afterActive?.sessionId, "session-fresh");

  const inactiveApplied = await updateAgentStatusFromSignal(agent.id, "inactive");
  const afterInactive = await getAgent(agent.id);
  assert.equal(inactiveApplied, true);
  assert.equal(afterInactive?.status, "inactive");
});

test("invalidateAgentSessionFromSignal clears only the exact current non-stopped session", async ({ app }) => {
  const agent = await seedAgent("session-invalidation-cas");
  const db = getDb();
  const [owner] = await db.select().from(users)
    .where(eq(users.email, "session-invalidation-cas@slock.test"))
    .limit(1);
  const [sourceMachine, targetMachine] = await db.insert(machines).values([
    { serverId: agent.serverId, userId: owner.id, name: "source", apiKeyHash: "source-hash" },
    { serverId: agent.serverId, userId: owner.id, name: "target", apiKeyHash: "target-hash" },
  ]).returning();
  await db.update(agents).set({ machineId: sourceMachine.id }).where(eq(agents.id, agent.id));
  await updateAgentStatus(agent.id, "active", "session-newer");

  assert.equal(await invalidateAgentSessionFromSignal(agent.id, "session-stale", sourceMachine.id), false);
  assert.equal((await getAgent(agent.id))?.sessionId, "session-newer");

  assert.equal(await invalidateAgentSessionFromSignal(agent.id, "session-newer", sourceMachine.id), true);
  const cleared = await getAgent(agent.id);
  assert.equal(cleared?.status, "active");
  assert.equal(cleared?.sessionId, null);

  await updateAgentStatus(agent.id, "stopped", "session-stopped");
  assert.equal(await invalidateAgentSessionFromSignal(agent.id, "session-stopped", sourceMachine.id), false);
  const stopped = await getAgent(agent.id);
  assert.equal(stopped?.status, "stopped");
  assert.equal(stopped?.sessionId, "session-stopped");

  await db.update(agents).set({
    status: "active",
    sessionId: "session-shared",
    machineId: targetMachine.id,
  }).where(eq(agents.id, agent.id));
  assert.equal(await invalidateAgentSessionFromSignal(agent.id, "session-shared", sourceMachine.id), false);
  const migrated = await getAgent(agent.id);
  assert.equal(migrated?.machineId, targetMachine.id);
  assert.equal(migrated?.sessionId, "session-shared");
});

test("real agent status, profile, runtime, and model mutations emit exact app notification events", async ({ app }) => {
  const db = getDb();
  const agent = await seedAgent("status-app-notifications");

  await updateAgentStatus(agent.id, "active");
  await updateAgentStatus(agent.id, "active");
  await updateAgent(agent.id, {
    displayName: "Notification Agent",
    runtime: "claude",
    model: "sonnet",
  });
  await updateAgent(agent.id, {
    displayName: "Notification Agent",
    runtime: "claude",
    model: "sonnet",
  });

  const events = await db.select().from(notificationEvents)
    .where(eq(notificationEvents.subjectId, agent.id));
  assert.deepEqual(events.map((event) => event.eventType).sort(), [
    "agent.model_changed",
    "agent.profile_updated",
    "agent.runtime_changed",
    "agent.status_changed",
  ]);
  assert.deepEqual(
    Object.fromEntries(events.map((event) => [event.eventType, event.provenance.changed_fields])),
    {
      "agent.status_changed": ["status"],
      "agent.profile_updated": ["display_name"],
      "agent.runtime_changed": ["runtime"],
      "agent.model_changed": ["model"],
    },
  );
});

test("deleteAgent removes channel membership rows for the soft-deleted agent", async ({ app }) => {
  const db = getDb();
  const [owner] = await db.insert(users).values({
    email: "delete-membership-owner@slock.test",
    name: "delete-membership-owner",
    displayName: "Owner",
    passwordHash: await fixturePasswordHash("password123"),
    emailVerified: true,
  }).returning();

  const server = await createServer("Delete Membership", "delete-membership", owner.id);
  const agentA = await createAgent(server.id, "delete-membership-a", { runtime: "codex" });
  const agentB = await createAgent(server.id, "delete-membership-b", { runtime: "codex" });
  const channel = await createChannel(server.id, "delete-membership-channel");
  await addAgent(channel.id, agentA.id);
  const dm = await findOrCreateAgentDM(server.id, agentA.id, agentB.id);
  assert.ok(dm, "expected an agent-to-agent DM");

  const beforeDelete = await db
    .select({ channelId: channelAgents.channelId })
    .from(channelAgents)
    .where(eq(channelAgents.agentId, agentA.id));
  assert.ok(beforeDelete.length >= 2, "agent should be in the explicit channel and its DM before deletion");
  assert.equal(await getAgentMemberRole(server.id, agentA.id), "member");

  await deleteAgent(agentA.id);

  const afterDelete = await db
    .select({ channelId: channelAgents.channelId })
    .from(channelAgents)
    .where(eq(channelAgents.agentId, agentA.id));
  assert.deepEqual(afterDelete, []);
  const serverMembershipAfterDelete = await db
    .select({ agentId: serverAgentMembers.agentId })
    .from(serverAgentMembers)
    .where(eq(serverAgentMembers.agentId, agentA.id));
  assert.deepEqual(serverMembershipAfterDelete, []);
  assert.equal(await getAgentMemberRole(server.id, agentA.id), null);
});

test("active agent membership completeness counts only active agents missing server rows", async ({ app }) => {
  const db = getDb();
  const [owner] = await db.insert(users).values({
    email: "agent-membership-completeness-owner@slock.test",
    name: "agent-membership-completeness-owner",
    displayName: "Owner",
    passwordHash: await fixturePasswordHash("password123"),
    emailVerified: true,
  }).returning();

  const server = await createServer("Agent Membership Completeness", "agent-membership-completeness", owner.id);
  await createAgent(server.id, "complete-new-agent", { runtime: "codex" });

  const [legacyAgent] = await db.insert(agents).values({
    serverId: server.id,
    name: "legacy-agent-without-membership",
    displayName: "Legacy Agent",
    runtime: "codex",
  }).returning();
  await db.insert(agents).values({
    serverId: server.id,
    name: "deleted-legacy-agent-without-membership",
    displayName: "Deleted Legacy Agent",
    runtime: "codex",
    deletedAt: new Date(),
  });

  assert.equal(await countActiveAgentsMissingServerMembership(), 1);

  await db.insert(serverAgentMembers).values({
    serverId: server.id,
    agentId: legacyAgent.id,
    role: "member",
  });

  assert.equal(await countActiveAgentsMissingServerMembership(), 0);
});

async function readStatusChangedAt(agentId: string): Promise<Date | null> {
  const [row] = await getDb().select({ statusChangedAt: agents.statusChangedAt })
    .from(agents).where(eq(agents.id, agentId));
  return row?.statusChangedAt ?? null;
}

async function latestStatusChangedEventAt(agentId: string): Promise<Date | null> {
  const rows = await getDb().select({ occurredAt: notificationEvents.occurredAt })
    .from(notificationEvents)
    .where(eq(notificationEvents.subjectId, agentId));
  const times = rows.map((row) => row.occurredAt.getTime()).sort((a, b) => b - a);
  return times.length ? new Date(times[0]!) : null;
}

test("status_changed_at starts at creation and moves only on real status transitions", async ({ app }) => {
  const agent = await seedAgent("status-since");
  const created = await readStatusChangedAt(agent.id);
  assert.ok(created instanceof Date);

  await updateAgentStatus(agent.id, "active", "session-1");
  const activeSince = await readStatusChangedAt(agent.id);
  assert.ok(activeSince && activeSince.getTime() >= created.getTime());
  assert.deepEqual(activeSince, await latestStatusChangedEventAt(agent.id));

  // Same status (session refresh / signal replay) keeps the since.
  await updateAgentStatus(agent.id, "active", "session-2");
  assert.ok(await updateAgentStatusFromSignal(agent.id, "active"));
  assert.deepEqual(await readStatusChangedAt(agent.id), activeSince);

  assert.ok(await updateAgentStatusFromSignal(agent.id, "inactive"));
  const inactiveSince = await readStatusChangedAt(agent.id);
  assert.ok(inactiveSince && inactiveSince.getTime() >= activeSince.getTime());
  assert.deepEqual(inactiveSince, await latestStatusChangedEventAt(agent.id));

  await updateAgentStatus(agent.id, "stopped");
  const stoppedSince = await readStatusChangedAt(agent.id);
  // Sticky stop: rejected inactive/signal writes leave the since alone.
  await updateAgentStatus(agent.id, "inactive");
  assert.equal(await updateAgentStatusFromSignal(agent.id, "active"), false);
  await resetAgentSession(agent.id, "stopped");
  assert.deepEqual(await readStatusChangedAt(agent.id), stoppedSince);

  await resetAgentSession(agent.id, "inactive");
  const resetSince = await readStatusChangedAt(agent.id);
  assert.ok(resetSince && resetSince.getTime() >= (stoppedSince?.getTime() ?? 0));
  assert.deepEqual(resetSince, await latestStatusChangedEventAt(agent.id));
});

test("startup reset stamps status_changed_at on agents it moves to inactive", async ({ app }) => {
  const agent = await seedAgent("status-since-startup");
  await updateAgentStatus(agent.id, "active");
  const activeSince = await readStatusChangedAt(agent.id);

  await resetAllAgentStatuses();

  const resetSince = await readStatusChangedAt(agent.id);
  assert.equal((await getAgent(agent.id))?.status, "inactive");
  assert.ok(resetSince && activeSince && resetSince.getTime() >= activeSince.getTime());
  assert.deepEqual(resetSince, await latestStatusChangedEventAt(agent.id));
});

test("deleteAgent stamps status_changed_at only when it actually leaves a non-inactive status", async ({ app }) => {
  const idle = await seedAgent("status-since-delete-idle");
  const idleSince = await readStatusChangedAt(idle.id);
  await deleteAgent(idle.id);
  assert.deepEqual(await readStatusChangedAt(idle.id), idleSince);

  const running = await seedAgent("status-since-delete-active");
  await updateAgentStatus(running.id, "active");
  const activeSince = await readStatusChangedAt(running.id);
  await deleteAgent(running.id);
  const deletedSince = await readStatusChangedAt(running.id);
  assert.ok(deletedSince && activeSince && deletedSince.getTime() >= activeSince.getTime());
  assert.notDeepEqual(deletedSince, activeSince);
});
