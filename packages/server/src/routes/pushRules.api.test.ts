import { fixturePasswordHash } from "../test/integration/credentials.js";
import { createApiTest } from "../test/integration/apiTest.js";
import assert from "node:assert/strict";

import { eq } from "drizzle-orm";
import { getDb } from "../db/index.js";
import { agents, serverMembers, servers, users } from "../db/schema.js";
import { createServer } from "../services/serverService.js";
import { createAgent } from "../services/agentService.js";
import { getServerPushSuppressedUserIds, shouldSuppressServerPush } from "../services/serverService.js";
import { buildPushTargetsFromContext } from "../services/messageService.js";

const test = createApiTest({ humanActivityMuteFlagDefaultEnabled: true, onboardingOpenerFlagDefaultEnabled: false });

async function login(baseUrl: string, email: string): Promise<string> {
  const res = await fetch(`${baseUrl}/api/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, password: "password123" }),
  });
  assert.equal(res.status, 200, `login for ${email} expected 200`);
  return (await res.json() as { accessToken: string }).accessToken;
}

async function seedMemberRow(slug: string) {
  const db = getDb();
  const [owner] = await db.insert(users).values({
    email: `${slug}-owner@slock.test`,
    name: `${slug}-owner`,
    displayName: `${slug}-owner`,
    passwordHash: await fixturePasswordHash("password123"),
    emailVerified: true,
    profileSetupCompletedAt: new Date(),
  }).returning();
  const server = await createServer(`${slug} server`, slug, owner.id);
  return { owner, server };
}

async function seedMember(app: { baseUrl: string }, slug: string) {
  const db = getDb();
  const [owner] = await db.insert(users).values({
    email: `${slug}-owner@slock.test`,
    name: `${slug}-owner`,
    displayName: `${slug}-owner`,
    passwordHash: await fixturePasswordHash("password123"),
    emailVerified: true,
    profileSetupCompletedAt: new Date(),
  }).returning();
  const server = await createServer(`${slug} server`, slug, owner.id);
  const agent = await createAgent(server.id, `${slug}-agent`, { runtime: "codex" });
  // Real login: the registrations route requires a session family, which only
  // an actual auth-issued JWT carries (fixture JWTs do not).
  const token = await login(app.baseUrl, `${slug}-owner@slock.test`);
  return { owner, server, agent, token };
}

test("a rethink-profile registration flips a factory-state membership to pm_dm_mentions", async ({ app }) => {
  const s = await seedMember(app, "push-profile-fresh");
  const res = await fetch(`${app.baseUrl}/api/push/registrations`, {
    method: "POST",
    headers: { Authorization: `Bearer ${s.token}`, "X-Server-Id": s.server.id, "Content-Type": "application/json" },
    body: JSON.stringify({
      provider: "apns",
      env: "sandbox",
      installationId: "install-push-profile-1",
      deviceToken: "a1b2c3d4e5f6g7h8",
      topic: "dev.raft.mobile",
      pushProfile: "rethink",
    }),
  });
  assert.equal(res.status, 200);

  const db = getDb();
  const [member] = await db.select().from(serverMembers)
    .where(eq(serverMembers.serverId, s.server.id));
  assert.equal(member?.serverPushMode, "pm_dm_mentions");
  assert.ok((member?.notificationPrefsVersion ?? 0) > 0, "the switch counts as a preference write");
  assert.equal(member?.serverPushMuted, false);
});

test("an explicitly-set preference is never overridden by a rethink-profile registration", async ({ app }) => {
  const s = await seedMember(app, "push-profile-explicit");
  const db = getDb();
  // The user explicitly chose "mentions" (version bumped away from factory 0).
  await db.update(serverMembers)
    .set({ serverPushMode: "mentions", notificationPrefsVersion: 3 })
    .where(eq(serverMembers.serverId, s.server.id));

  const res = await fetch(`${app.baseUrl}/api/push/registrations`, {
    method: "POST",
    headers: { Authorization: `Bearer ${s.token}`, "X-Server-Id": s.server.id, "Content-Type": "application/json" },
    body: JSON.stringify({
      provider: "apns",
      env: "sandbox",
      installationId: "install-push-profile-2",
      deviceToken: "b2c3d4e5f6g7h8i9",
      topic: "dev.raft.mobile",
      pushProfile: "rethink",
    }),
  });
  assert.equal(res.status, 200);
  const [member] = await db.select().from(serverMembers)
    .where(eq(serverMembers.serverId, s.server.id));
  assert.equal(member?.serverPushMode, "mentions", "user's own choice wins");
  assert.equal(member?.notificationPrefsVersion, 3, "no extra bump either");
});

test("a legacy registration without pushProfile leaves the mode untouched", async ({ app }) => {
  const s = await seedMember(app, "push-profile-legacy");
  const res = await fetch(`${app.baseUrl}/api/push/registrations`, {
    method: "POST",
    headers: { Authorization: `Bearer ${s.token}`, "X-Server-Id": s.server.id, "Content-Type": "application/json" },
    body: JSON.stringify({
      provider: "apns",
      env: "sandbox",
      installationId: "install-push-profile-3",
      deviceToken: "c3d4e5f6g7h8i9j0",
      topic: "dev.raft.mobile",
    }),
  });
  assert.equal(res.status, 200);
  const db = getDb();
  const [member] = await db.select().from(serverMembers)
    .where(eq(serverMembers.serverId, s.server.id));
  assert.equal(member?.serverPushMode, "all", "legacy clients keep the factory default");
});

test("pm_dm_mentions suppression matrix over the real membership table", async ({ db }) => {
  const s = await seedMemberRow("push-rules-matrix");
  await db.update(serverMembers)
    .set({ serverPushMode: "pm_dm_mentions" })
    .where(eq(serverMembers.serverId, s.server.id));

  // Channel traffic without a mention → suppressed even when the PM sent it.
  const channel = await getServerPushSuppressedUserIds(s.server.id, [s.owner.id], new Set(), { channelType: "channel" });
  assert.deepEqual([...channel], [s.owner.id]);

  // DM → delivered.
  const dm = await getServerPushSuppressedUserIds(s.server.id, [s.owner.id], new Set(), { channelType: "dm" });
  assert.deepEqual([...dm], []);

  // Channel mention → delivered.
  const mentioned = await getServerPushSuppressedUserIds(s.server.id, [s.owner.id], new Set([s.owner.id]), { channelType: "channel" });
  assert.deepEqual([...mentioned], []);

  void s.agent;
});

test("buildPushTargetsFromContext stamps pmDirectMessage only for the PM's own DM traffic", () => {
  const base = {
    serverSlug: "pm-fact",
    messageId: "01890a5b-0000-7000-8000-000000000001",
    senderName: "PM",
    body: "hello",
  };
  const channelOf = (type: "dm" | "channel") => ({ id: "ch-1", type, name: type === "dm" ? null : "general" });

  // PM agent speaking in a DM → fact stamped.
  const pmDm = buildPushTargetsFromContext({
    ...base,
    pmAgentId: "agent-pm",
    channel: channelOf("dm"),
    senderId: "agent-pm",
    senderType: "agent",
    dmHumans: [{ id: "human-1", name: "alice" }],
  });
  assert.equal(pmDm.get("human-1")?.pmDirectMessage, true);

  // PM agent speaking in a shared channel → no fact (and no push under the new profile).
  const pmChannel = buildPushTargetsFromContext({
    ...base,
    pmAgentId: "agent-pm",
    channel: channelOf("channel"),
    senderId: "agent-pm",
    senderType: "agent",
    humanScopeMembers: [{ id: "human-1", name: "alice" }],
  });
  assert.equal(pmChannel.get("human-1")?.pmDirectMessage, undefined);

  // Another agent in a DM → no fact.
  const otherDm = buildPushTargetsFromContext({
    ...base,
    pmAgentId: "agent-pm",
    channel: channelOf("dm"),
    senderId: "agent-other",
    senderType: "agent",
    dmHumans: [{ id: "human-1", name: "alice" }],
  });
  assert.equal(otherDm.get("human-1")?.pmDirectMessage, undefined);

  // No PM set → no fact even for a DM from some agent.
  const noPm = buildPushTargetsFromContext({
    ...base,
    channel: channelOf("dm"),
    senderId: "agent-other",
    senderType: "agent",
    dmHumans: [{ id: "human-1", name: "alice" }],
  });
  assert.equal(noPm.get("human-1")?.pmDirectMessage, undefined);
});

test("migration 0276 widens the push mode CHECK (file-level contract)", async ({ db }) => {
  void db;
  const { readFileSync } = await import("node:fs");
  const migration = readFileSync(new URL("../../drizzle/0276_server_push_mode_pm_dm_mentions.sql", import.meta.url), "utf8");
  assert.match(migration, /DROP CONSTRAINT IF EXISTS "server_members_server_push_mode_valid"/);
  assert.match(migration, /CHECK \("server_push_mode" IN \('all', 'mentions', 'none', 'pm_dm_mentions'\)\)/);
});
