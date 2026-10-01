import { fixturePasswordHash, tokenForHuman } from "../test/integration/credentials.js";
import { createApiTest } from "../test/integration/apiTest.js";
import assert from "node:assert/strict";
import { and, eq, isNull } from "drizzle-orm";
import { getDb } from "../db/index.js";
import { channels, serverMembers, users } from "../db/schema.js";
import { createServer } from "../services/serverService.js";
import { createAgent } from "../services/agentService.js";
import { createMessage } from "../services/messageService.js";

const test = createApiTest({ humanActivityMuteFlagDefaultEnabled: true, onboardingOpenerFlagDefaultEnabled: false });

async function seed(slug: string) {
  const db = getDb();
  const make = async (email: string) => {
    const [row] = await db.insert(users).values({
      email,
      name: email.split("@")[0],
      displayName: email.split("@")[0],
      passwordHash: await fixturePasswordHash("password123"),
      emailVerified: true,
      profileSetupCompletedAt: new Date(),
    }).returning();
    return row;
  };
  const owner = await make(`owner-${slug}@slock.test`);
  const member = await make(`member-${slug}@slock.test`);
  const server = await createServer(`Server ${slug}`, slug, owner.id);
  await db.insert(serverMembers).values({ serverId: server.id, userId: member.id, role: "member" });
  const agent = await createAgent(server.id, "agent-a", { runtime: "codex" });
  const [announcement] = await db.select().from(channels).where(and(
    eq(channels.serverId, server.id), eq(channels.systemKind, "announcement"), isNull(channels.deletedAt),
  ));
  return { owner, member, server, agent, announcement };
}

function api(baseUrl: string, serverId: string, token: string) {
  return (method: string, path: string, body?: unknown) => fetch(`${baseUrl}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      "X-Server-Id": serverId,
      ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
}

test("announcement settings are readable by members and writable by owners/admins only", async ({ app }) => {
  const { owner, member, server } = await seed("ann-api-settings");
  const asOwner = api(app.baseUrl, server.id, await tokenForHuman(owner.email));
  const asMember = api(app.baseUrl, server.id, await tokenForHuman(member.email));
  const path = `/api/servers/${server.id}/announcement-settings`;

  assert.deepEqual(await (await asOwner("GET", path)).json(), { announcementsEnabled: false, canManageAnnouncements: true });
  assert.deepEqual(await (await asMember("GET", path)).json(), { announcementsEnabled: false, canManageAnnouncements: false });

  assert.equal((await asMember("PATCH", path, { announcementsEnabled: true })).status, 403);
  assert.equal((await asOwner("PATCH", path, { announcementsEnabled: "yes" })).status, 400);
  const patched = await asOwner("PATCH", path, { announcementsEnabled: true });
  assert.equal(patched.status, 200);
  assert.deepEqual(await patched.json(), { announcementsEnabled: true, canManageAnnouncements: true });
  assert.deepEqual(await (await asMember("GET", path)).json(), { announcementsEnabled: true, canManageAnnouncements: false });
});

test("the channel list exposes systemKind and marks the announcement channel joined", async ({ app }) => {
  const { member, server } = await seed("ann-api-list");
  const asMember = api(app.baseUrl, server.id, await tokenForHuman(member.email));
  const res = await asMember("GET", `/api/channels`);
  assert.equal(res.status, 200);
  const list = await res.json() as Array<{ name: string; systemKind: string | null; joined: boolean }>;
  const announcement = list.find((channel) => channel.systemKind === "announcement");
  assert.ok(announcement, "announcement channel is listed");
  assert.equal(announcement.name, "announcement");
  assert.equal(announcement.joined, true);
  assert.equal(list.find((channel) => channel.name === "all")?.systemKind, "all");
});

test("leave, rename, archive and delete are refused over HTTP", async ({ app }) => {
  const { owner, member, server, announcement } = await seed("ann-api-protect");
  const asOwner = api(app.baseUrl, server.id, await tokenForHuman(owner.email));
  const asMember = api(app.baseUrl, server.id, await tokenForHuman(member.email));

  assert.equal((await asMember("POST", `/api/channels/${announcement.id}/leave`)).status, 403);
  assert.equal((await asOwner("PATCH", `/api/channels/${announcement.id}`, { name: "news" })).status, 403);
  assert.equal((await asOwner("POST", `/api/channels/${announcement.id}/archive`)).status, 400);
  assert.equal((await asOwner("DELETE", `/api/channels/${announcement.id}`)).status, 403);
});

test("creating a thread under an announcement answers 400 announcement_no_threads", async ({ app }) => {
  const { owner, server, announcement } = await seed("ann-api-threads");
  const message = await createMessage(announcement.id, "user", owner.id, "progress");
  const asOwner = api(app.baseUrl, server.id, await tokenForHuman(owner.email));
  const res = await asOwner("POST", `/api/channels/${announcement.id}/threads`, { parentMessageId: message.id });
  assert.equal(res.status, 400);
  assert.equal((await res.json() as { code: string }).code, "announcement_no_threads");
});

test("by-sender returns one sender's messages without a message window", async ({ app }) => {
  const { owner, member, server, agent, announcement } = await seed("ann-api-bysender");
  for (const [senderType, senderId, content] of [
    ["agent", agent.id, "agent one"], ["user", owner.id, "human one"], ["agent", agent.id, "agent two"],
  ] as const) {
    await createMessage(announcement.id, senderType, senderId, content);
  }
  const asMember = api(app.baseUrl, server.id, await tokenForHuman(member.email));
  const res = await asMember("GET", `/api/messages/channel/${announcement.id}/by-sender?senderId=${agent.id}&limit=1`);
  assert.equal(res.status, 200);
  const body = await res.json() as { messages: Array<{ content: string }>; hasMore: boolean; messageWindow?: unknown };
  assert.deepEqual(body.messages.map((m) => m.content), ["agent two"]);
  assert.equal(body.hasMore, true);
  assert.equal(body.messageWindow, undefined);

  assert.equal((await asMember("GET", `/api/messages/channel/${announcement.id}/by-sender?senderId=nope`)).status, 400);
});
