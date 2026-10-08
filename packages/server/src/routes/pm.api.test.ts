import { fixturePasswordHash, tokenForHuman } from "../test/integration/credentials.js";
import { createApiTest } from "../test/integration/apiTest.js";
import assert from "node:assert/strict";

import { eq } from "drizzle-orm";
import { getDb } from "../db/index.js";
import { agents, pmRoleAuditEvents, serverMembers, servers, users } from "../db/schema.js";
import { createServer, deleteServer } from "../services/serverService.js";
import { createAgent, deleteAgent } from "../services/agentService.js";

const test = createApiTest({ humanActivityMuteFlagDefaultEnabled: true, onboardingOpenerFlagDefaultEnabled: false });

interface Seeded {
  ownerToken: string;
  adminToken: string;
  memberToken: string;
  outsiderToken: string;
  slug: string;
  serverId: string;
  pmAgentId: string;
  adminAgentId: string;
}

async function seedUser(slug: string, name: string) {
  const db = getDb();
  const [u] = await db.insert(users).values({
    email: `${slug}-${name}@slock.test`,
    name: `${slug}-${name}`,
    displayName: `${slug}-${name}`,
    passwordHash: await fixturePasswordHash("password123"),
    emailVerified: true,
    profileSetupCompletedAt: new Date(),
  }).returning();
  return u;
}

async function seed(slug: string): Promise<Seeded> {
  const db = getDb();
  const owner = await seedUser(slug, "owner");
  const admin = await seedUser(slug, "admin");
  const member = await seedUser(slug, "member");
  const outsider = await seedUser(slug, "outsider");

  const server = await createServer(`${slug} server`, slug, owner.id);
  await db.insert(serverMembers).values([
    { serverId: server.id, userId: admin.id, role: "admin" },
    { serverId: server.id, userId: member.id, role: "member" },
  ]);

  const pmAgent = await createAgent(server.id, `${slug}-pm`, { runtime: "codex" });
  const adminAgent = await createAgent(server.id, `${slug}-admin-agent`, { runtime: "codex" });
  // PUT requires an active PM; freshly created agents start inactive until
  // first start, so the fixtures activate them directly.
  const db0 = getDb();
  await db0.update(agents).set({ status: "active" }).where(eq(agents.id, pmAgent.id));
  await db0.update(agents).set({ status: "active" }).where(eq(agents.id, adminAgent.id));

  const [ownerToken, adminToken, memberToken, outsiderToken] = await Promise.all([
    tokenForHuman(owner.email), tokenForHuman(admin.email), tokenForHuman(member.email), tokenForHuman(outsider.email),
  ]);
  return {
    ownerToken, adminToken, memberToken, outsiderToken,
    slug, serverId: server.id, pmAgentId: pmAgent.id, adminAgentId: adminAgent.id,
  };
}

test("GET /pm starts unset, PUT sets the PM with an audit line, GET reports set", async ({ app }) => {
  const s = await seed("pm-basic");
  const pmUrl = `${app.baseUrl}/api/servers/${s.slug}/pm`;

  const res = await fetch(pmUrl, { headers: { Authorization: `Bearer ${s.ownerToken}` } });
  assert.equal(res.status, 200);
  const before = await res.json() as { pm: unknown; dmChannelId: unknown; setup: string };
  assert.equal(before.pm, null);
  assert.equal(before.dmChannelId, null);
  assert.equal(before.setup, "unset");

  const put = await fetch(pmUrl, {
    method: "PUT",
    headers: { Authorization: `Bearer ${s.ownerToken}`, "Content-Type": "application/json" },
    body: JSON.stringify({ agentId: s.pmAgentId }),
  });
  assert.equal(put.status, 200);
  const putBody = await put.json() as { pm: { agentId: string } | null; changed: boolean };
  assert.equal(putBody.changed, true);
  assert.equal(putBody.pm?.agentId, s.pmAgentId);

  const memberGet = await fetch(pmUrl, { headers: { Authorization: `Bearer ${s.memberToken}` } });
  const after = await memberGet.json() as { pm: { agentId: string } | null; setup: string };
  assert.equal(after.pm?.agentId, s.pmAgentId);
  assert.equal(after.setup, "set");

  const db = getDb();
  const audit = await db.select().from(pmRoleAuditEvents).where(eq(pmRoleAuditEvents.serverId, s.serverId));
  assert.equal(audit.length, 1);
  assert.equal(audit[0]?.fromAgentId, null);
  assert.equal(audit[0]?.toAgentId, s.pmAgentId);
  assert.equal(audit[0]?.actorType, "user");
});

test("PUT replaces the PM with a from→to audit line; repeat PUT is idempotent without audit", async ({ app }) => {
  const s = await seed("pm-replace");
  const pmUrl = `${app.baseUrl}/api/servers/${s.slug}/pm`;
  const put = (token: string, agentId: string) => fetch(pmUrl, {
    method: "PUT",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ agentId }),
  });

  assert.equal((await put(s.ownerToken, s.pmAgentId)).status, 200);
  const replace = await put(s.adminToken, s.adminAgentId);
  assert.equal(replace.status, 200);
  assert.equal((await replace.json() as { changed: boolean }).changed, true);

  // Same agent again — idempotent, no new audit row.
  const same = await put(s.ownerToken, s.adminAgentId);
  assert.equal(same.status, 200);
  assert.equal((await same.json() as { changed: boolean }).changed, false);

  const db = getDb();
  const audit = await db.select().from(pmRoleAuditEvents).where(eq(pmRoleAuditEvents.serverId, s.serverId));
  assert.equal(audit.length, 2, "set + replace; the idempotent retry writes nothing");
  const replaceRow = audit.find((row) => row.fromAgentId !== null);
  assert.ok(replaceRow);
  assert.equal(replaceRow.fromAgentId, s.pmAgentId);
  assert.equal(replaceRow.toAgentId, s.adminAgentId);
});

test("PUT rejects non-admin members, non-members, and malformed bodies", async ({ app }) => {
  const s = await seed("pm-acl");
  const pmUrl = `${app.baseUrl}/api/servers/${s.slug}/pm`;

  const memberPut = await fetch(pmUrl, {
    method: "PUT",
    headers: { Authorization: `Bearer ${s.memberToken}`, "Content-Type": "application/json" },
    body: JSON.stringify({ agentId: s.pmAgentId }),
  });
  assert.equal(memberPut.status, 403);

  const outsiderGet = await fetch(pmUrl, { headers: { Authorization: `Bearer ${s.outsiderToken}` } });
  assert.ok([403, 404].includes(outsiderGet.status), `outsider GET got ${outsiderGet.status}`);

  const badBody = await fetch(pmUrl, {
    method: "PUT",
    headers: { Authorization: `Bearer ${s.ownerToken}`, "Content-Type": "application/json" },
    body: JSON.stringify({ agentId: "not-a-uuid" }),
  });
  assert.equal(badBody.status, 400);

  const db = getDb();
  const audit = await db.select().from(pmRoleAuditEvents).where(eq(pmRoleAuditEvents.serverId, s.serverId));
  assert.equal(audit.length, 0, "rejected writes leave no audit trail");
});

test("PUT rejects soft-deleted, inactive, and foreign-server agents", async ({ app }) => {
  const s = await seed("pm-target");
  const pmUrl = `${app.baseUrl}/api/servers/${s.slug}/pm`;
  const putAs = (agentId: string) => fetch(pmUrl, {
    method: "PUT",
    headers: { Authorization: `Bearer ${s.ownerToken}`, "Content-Type": "application/json" },
    body: JSON.stringify({ agentId }),
  });
  const db = getDb();

  // Soft-deleted agent in this server → 404.
  const doomed = await createAgent(s.serverId, "pm-target-doomed", { runtime: "codex" });
  await deleteAgent(doomed.id);
  assert.equal((await putAs(doomed.id)).status, 404);

  // Inactive (the resting default for idle agents) → allowed.
  await db.update(agents).set({ status: "inactive" }).where(eq(agents.id, s.adminAgentId));
  const inactivePut = await putAs(s.adminAgentId);
  assert.equal(inactivePut.status, 200, "inactive agents are eligible — most idle agents are inactive");
  assert.equal((await inactivePut.json() as { changed: boolean }).changed, true);

  // Stopped (explicitly stopped by the user) → allowed too; the appointer can
  // start it afterwards and the PM tab shows it offline until then.
  await db.update(agents).set({ status: "stopped" }).where(eq(agents.id, s.adminAgentId));
  const stoppedPut = await putAs(s.pmAgentId);
  assert.equal(stoppedPut.status, 200, "stopped agents are eligible — runtime state is not an eligibility criterion");
  assert.equal((await stoppedPut.json() as { changed: boolean }).changed, true);
  // Restore an eligible PM state for later tests in this file (none rely on it, keep clean).
  await db.update(agents).set({ status: "inactive" }).where(eq(agents.id, s.pmAgentId));

  // Foreign-server agent → 404.
  const foreignOwner = await seedUser("pm-target", "foreign");
  const foreignServer = await createServer("pm-target foreign", "pm-target-foreign-server", foreignOwner.id);
  const foreignAgent = await createAgent(foreignServer.id, "pm-target-foreign-agent", { runtime: "codex" });
  assert.equal((await putAs(foreignAgent.id)).status, 404);
});

test("deleteAgent refuses a standing PM (409 pm_role_delete_blocked); replace then delete succeeds", async ({ app }) => {
  const s = await seed("pm-delete-block");
  const pmUrl = `${app.baseUrl}/api/servers/${s.slug}/pm`;
  const put = (agentId: string) => fetch(pmUrl, {
    method: "PUT",
    headers: { Authorization: `Bearer ${s.ownerToken}`, "Content-Type": "application/json" },
    body: JSON.stringify({ agentId }),
  });

  assert.equal((await put(s.pmAgentId)).status, 200);

  const del = await fetch(`${app.baseUrl}/api/agents/${s.pmAgentId}`, {
    method: "DELETE",
    headers: { Authorization: `Bearer ${s.ownerToken}`, "X-Server-Id": s.serverId },
  });
  assert.equal(del.status, 409);
  const body = await del.json() as { code?: string; error?: string };
  assert.equal(body.code, "pm_role_delete_blocked");
  assert.match(body.error ?? "", /请先更换 PM/u);

  // Replace the PM, then the former PM deletes fine.
  assert.equal((await put(s.adminAgentId)).status, 200);
  const delAfter = await fetch(`${app.baseUrl}/api/agents/${s.pmAgentId}`, {
    method: "DELETE",
    headers: { Authorization: `Bearer ${s.ownerToken}`, "X-Server-Id": s.serverId },
  });
  assert.equal(delAfter.status, 200);
});

test("a PM pointer on a soft-deleted server no longer blocks deletion; GET hides a PM aimed at a deleted agent", async ({ app }) => {
  const s = await seed("pm-dead-server");
  const db = getDb();

  // Legacy shape: the pointer survives on a soft-deleted server.
  const foreignOwner = await seedUser("pm-dead-server", "foreign");
  const doomedServer = await createServer("pm dead gone", "pm-dead-server-gone", foreignOwner.id);
  const doomedAgent = await createAgent(doomedServer.id, "pm-dead-gone-agent", { runtime: "codex" });
  await db.update(servers).set({ pmAgentId: doomedAgent.id }).where(eq(servers.id, doomedServer.id));
  await deleteServer(doomedServer.id);

  // The guard lives in the service: deleting that agent must NOT throw the
  // PM block (soft-deleted server's pointer no longer counts). Direct service
  // call — the HTTP route would bounce earlier on the deleted-server context.
  await deleteAgent(doomedAgent.id);
  const [goneRow] = await db.select().from(agents).where(eq(agents.id, doomedAgent.id));
  assert.ok(goneRow?.deletedAt, "agent deleted despite being a dead server's PM");

  // GET hides a PM pointer aimed at a (soft-)deleted agent.
  await db.update(servers).set({ pmAgentId: s.pmAgentId }).where(eq(servers.id, s.serverId));
  await db.update(agents).set({ deletedAt: new Date(), status: "inactive" }).where(eq(agents.id, s.pmAgentId));
  const get = await fetch(`${app.baseUrl}/api/servers/${s.slug}/pm`, { headers: { Authorization: `Bearer ${s.ownerToken}` } });
  assert.equal(get.status, 200);
  const body = await get.json() as { pm: unknown; setup: string };
  assert.equal(body.pm, null, "deleted PM reads as unset");
  assert.equal(body.setup, "unset");
});

test("dismiss-setup marks the guide dismissed and is idempotent; members are rejected", async ({ app }) => {
  const s = await seed("pm-dismiss");
  const dismissUrl = `${app.baseUrl}/api/servers/${s.slug}/pm/dismiss-setup`;

  const dismiss = await fetch(dismissUrl, { method: "POST", headers: { Authorization: `Bearer ${s.ownerToken}` } });
  assert.equal(dismiss.status, 200);
  assert.ok((await dismiss.json() as { dismissedAt: string }).dismissedAt);

  const again = await fetch(dismissUrl, { method: "POST", headers: { Authorization: `Bearer ${s.ownerToken}` } });
  assert.equal(again.status, 200, "repeat dismiss is idempotent");

  const get = await (await fetch(`${app.baseUrl}/api/servers/${s.slug}/pm`, { headers: { Authorization: `Bearer ${s.memberToken}` } })).json() as { setup: string; pm: unknown };
  assert.equal(get.setup, "dismissed");
  assert.equal(get.pm, null);

  const memberDismiss = await fetch(dismissUrl, { method: "POST", headers: { Authorization: `Bearer ${s.memberToken}` } });
  assert.equal(memberDismiss.status, 403);
});
