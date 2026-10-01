import { createApiTest } from "../test/integration/apiTest.js";

import assert from "node:assert/strict";
import { and, eq, isNull } from "drizzle-orm";
import { getDb } from "../db/index.js";
import { users, channels, channelAgents, channelHumans } from "../db/schema.js";
import { addMember, createServer, getServerAnnouncementSettings, updateServerAnnouncementSettings } from "./serverService.js";
import { createAgent } from "./agentService.js";
import {
  AnnouncementNoThreadsError,
  addAgent,
  addHuman,
  archiveChannel,
  canAgentReceiveChannelDelivery,
  createChannel,
  deleteChannel,
  ensureAnnouncementChannel,
  getChannel,
  getChannelAgents,
  getChannelHumans,
  getOrCreateThread,
  hasImplicitServerMembership,
  isAnnouncementChannel,
  listChannels,
  removeAgent,
  removeHuman,
  updateChannel,
  canUserPostToChannel,
  canAgentPostToChannel,
  getInboxTargetActivityMuteState,
  setInboxTargetActivityMuteState,
} from "./channelService.js";
import { broadcastAndDeliver, listMessagesBySender } from "./messageService.js";

const test = createApiTest({ humanActivityMuteFlagDefaultEnabled: true, onboardingOpenerFlagDefaultEnabled: false });

let userSeq = 0;
async function seedUser(label: string) {
  userSeq += 1;
  const [user] = await getDb()
    .insert(users)
    .values({
      email: `${label}-${userSeq}@slock.test`,
      name: `${label}-${userSeq}`,
      displayName: label,
      passwordHash: "test-hash",
      emailVerified: true,
    })
    .returning();
  return user;
}

function createNoopIo() {
  const chain = { in() { return chain; }, to() { return chain; }, socketsJoin() {}, emit() {} };
  return chain as any;
}

async function announcementOf(serverId: string) {
  const [row] = await getDb()
    .select()
    .from(channels)
    .where(and(eq(channels.serverId, serverId), eq(channels.systemKind, "announcement"), isNull(channels.deletedAt)));
  assert.ok(row, "expected the #announcement channel to exist");
  return row;
}

async function seedServer(slug: string) {
  const owner = await seedUser(`${slug}-owner`);
  const member = await seedUser(`${slug}-member`);
  const guest = await seedUser(`${slug}-guest`);
  const server = await createServer(`Server ${slug}`, slug, owner.id);
  await addMember(server.id, member.id);
  await addMember(server.id, guest.id, "guest");
  const agentA = await createAgent(server.id, "agent-a", { runtime: "codex" });
  const agentB = await createAgent(server.id, "agent-b", { runtime: "codex" });
  return { owner, member, guest, server, agentA, agentB };
}

test("createServer creates #announcement and tags #all", async ({ app }) => {
  const owner = await seedUser("create-owner");
  const server = await createServer("Create Server", "ann-create", owner.id);
  const announcement = await announcementOf(server.id);
  assert.equal(announcement.name, "announcement");
  assert.equal(announcement.type, "channel");
  assert.equal(isAnnouncementChannel(announcement), true);
  const [all] = await getDb().select().from(channels).where(and(eq(channels.serverId, server.id), eq(channels.name, "all")));
  assert.equal(all?.systemKind, "all");
  const settings = await getServerAnnouncementSettings(server.id);
  assert.deepEqual(settings, { announcementsEnabled: false }, "feature is off by default");
  assert.deepEqual(await updateServerAnnouncementSettings(server.id, { announcementsEnabled: true }), { announcementsEnabled: true });
});

test("listChannels backfills a missing #announcement and retires a same-named user channel", async ({ app }) => {
  const owner = await seedUser("backfill-owner");
  const server = await createServer("Backfill Server", "ann-backfill", owner.id);
  const db = getDb();
  await db.delete(channels).where(and(eq(channels.serverId, server.id), eq(channels.systemKind, "announcement")));
  await db.insert(channels).values({ serverId: server.id, name: "announcement", type: "channel" });

  const listed = (await listChannels(server.id, owner.id)) as Array<{ id: string; name: string; systemKind: string | null; joined?: boolean }>;
  const system = listed.filter((channel) => channel.systemKind === "announcement");
  assert.equal(system.length, 1, "exactly one system announcement channel");
  assert.equal(system[0]?.joined, true, "implicit membership counts as joined");
  assert.equal(listed.filter((channel) => channel.name === "announcement").length, 1, "the user's same-named channel was retired");

  // Idempotent.
  const again = await ensureAnnouncementChannel(server.id);
  assert.equal(again.id, system[0]?.id);
});

test("every non-guest human and every agent is an implicit member; guests are not", async ({ app }) => {
  const { owner, member, guest, server, agentA, agentB } = await seedServer("ann-members");
  const announcement = await announcementOf(server.id);
  assert.equal(hasImplicitServerMembership(announcement), true);

  const humans = (await getChannelHumans(announcement.id)).map((human) => human.id);
  assert.ok(humans.includes(owner.id) && humans.includes(member.id));
  assert.ok(!humans.includes(guest.id), "guests are not part of the audience");
  const agentIds = (await getChannelAgents(announcement.id)).map((agent) => agent.id);
  assert.deepEqual(agentIds.sort(), [agentA.id, agentB.id].sort());

  // No membership rows exist.
  assert.equal((await getDb().select().from(channelHumans).where(eq(channelHumans.channelId, announcement.id))).length, 0);
  assert.equal((await getDb().select().from(channelAgents).where(eq(channelAgents.channelId, announcement.id))).length, 0);

  // Humans and agents can post.
  assert.equal(await canUserPostToChannel(announcement.id, member.id), true);
  assert.equal(await canAgentPostToChannel(announcement.id, agentA.id), true);
});

test("the channel cannot be left, renamed, archived, deleted or re-membered, and the name is reserved", async ({ app }) => {
  const { member, guest, server, agentA } = await seedServer("ann-protect");
  const announcement = await announcementOf(server.id);

  await assert.rejects(() => removeHuman(announcement.id, member.id), /Cannot remove/);
  await assert.rejects(() => removeAgent(announcement.id, agentA.id), /Cannot remove/);
  await assert.rejects(() => updateChannel(announcement.id, { name: "news" }), /Cannot rename/);
  await assert.rejects(() => updateChannel(announcement.id, { type: "private" }), /Cannot rename or change visibility/);
  await assert.rejects(() => archiveChannel(announcement.id, member.id), /cannot be archived/);
  await assert.rejects(() => deleteChannel(announcement.id), /cannot be deleted/);

  assert.equal(await addHuman(announcement.id, member.id), false, "addHuman is a no-op, like #all");
  assert.equal(await addAgent(announcement.id, agentA.id), false);
  await assert.rejects(() => addHuman(announcement.id, guest.id), /Guest cannot be added/);
  assert.equal((await getDb().select().from(channelHumans).where(eq(channelHumans.channelId, announcement.id))).length, 0);

  await assert.rejects(() => createChannel(server.id, "announcement"), /reserved/);
  const other = await createChannel(server.id, "news");
  await assert.rejects(() => updateChannel(other.id, { name: "announcement" }), /reserved/);
  assert.equal((await getChannel(announcement.id))?.deletedAt, null);
});

test("replies and threads are refused in the announcement channel", async ({ app }) => {
  const { owner, server } = await seedServer("ann-threads");
  const announcement = await announcementOf(server.id);
  const sent = await broadcastAndDeliver(createNoopIo(), { deliverMessage: async () => undefined } as any, {
    channelId: announcement.id,
    senderType: "user",
    senderId: owner.id,
    senderName: owner.name,
    content: "progress: shipping the thing",
  });
  const messageId = (sent as any).id ?? (sent as any).message?.id;
  assert.ok(messageId, "message persisted");
  await assert.rejects(() => getOrCreateThread(messageId, owner.id, "user"), AnnouncementNoThreadsError);

  // Other channels still thread.
  const room = await createChannel(server.id, "room");
  await addHuman(room.id, owner.id);
  const roomMsg = await broadcastAndDeliver(createNoopIo(), { deliverMessage: async () => undefined } as any, {
    channelId: room.id,
    senderType: "user",
    senderId: owner.id,
    senderName: owner.name,
    content: "regular message",
  });
  const roomMessageId = (roomMsg as any).id ?? (roomMsg as any).message?.id;
  const thread = await getOrCreateThread(roomMessageId, owner.id, "user");
  assert.equal(thread.created, true);
});

test("a broadcast is not delivered to agents, but an explicit @mention is", async ({ app }) => {
  const { owner, server, agentA, agentB } = await seedServer("ann-delivery");
  const announcement = await announcementOf(server.id);
  const delivered: string[] = [];
  const orchestrator = { deliverMessage: async (agentId: string) => { delivered.push(agentId); } } as any;

  await broadcastAndDeliver(createNoopIo(), orchestrator, {
    channelId: announcement.id,
    senderType: "user",
    senderId: owner.id,
    senderName: owner.name,
    content: "hello everyone",
  });
  assert.deepEqual(delivered, [], "no agent is woken by a broadcast");

  await broadcastAndDeliver(createNoopIo(), orchestrator, {
    channelId: announcement.id,
    senderType: "user",
    senderId: owner.id,
    senderName: owner.name,
    content: "@agent-a please post your status",
    mentions: [{ type: "agent", id: agentA.id, name: "agent-a" }],
  });
  assert.deepEqual(delivered, [agentA.id], "only the mentioned agent is delivered to");

  // Receive-time gate: a queued broadcast is dropped, a mention is kept.
  assert.equal(await canAgentReceiveChannelDelivery(announcement.id, agentB.id), false);
  assert.equal(await canAgentReceiveChannelDelivery(announcement.id, agentA.id, { personalMention: true }), true);
});

test("an agent posting to the channel is never held by other agents' announcements", async ({ app }) => {
  const { server, agentA, agentB } = await seedServer("ann-agentpost");
  const announcement = await announcementOf(server.id);
  const orchestrator = { deliverMessage: async () => undefined } as any;
  await broadcastAndDeliver(createNoopIo(), orchestrator, {
    channelId: announcement.id,
    senderType: "agent",
    senderId: agentA.id,
    senderName: "agent-a",
    content: "doing: X / done: Y / next: Z",
  });
  const { rows } = await getDb().execute<{ count: string }>(
    (await import("drizzle-orm")).sql`SELECT count(*)::text AS count FROM inbox_notification_facts WHERE receiver_type = 'agent' AND receiver_id = ${agentB.id}`,
  );
  assert.equal(rows[0]?.count, "0", "no agent inbox fact is written for another agent's announcement");
});

test("listMessagesBySender returns one sender's messages, newest page last, with hasMore", async ({ app }) => {
  const { owner, server, agentA, agentB } = await seedServer("ann-bysender");
  const announcement = await announcementOf(server.id);
  const orchestrator = { deliverMessage: async () => undefined } as any;
  for (let i = 1; i <= 3; i += 1) {
    await broadcastAndDeliver(createNoopIo(), orchestrator, {
      channelId: announcement.id, senderType: "agent", senderId: agentA.id, senderName: "agent-a", content: `a-${i}`,
    });
    await broadcastAndDeliver(createNoopIo(), orchestrator, {
      channelId: announcement.id, senderType: "agent", senderId: agentB.id, senderName: "agent-b", content: `b-${i}`,
    });
  }
  await broadcastAndDeliver(createNoopIo(), orchestrator, {
    channelId: announcement.id, senderType: "user", senderId: owner.id, senderName: owner.name, content: "human note",
  });

  const page1 = await listMessagesBySender(announcement.id, agentA.id, 2);
  assert.deepEqual(page1.messages.map((m: any) => m.content), ["a-2", "a-3"]);
  assert.equal(page1.hasMore, true);
  const oldestSeq = (page1.messages[0] as any).seq;
  const page2 = await listMessagesBySender(announcement.id, agentA.id, 2, oldestSeq);
  assert.deepEqual(page2.messages.map((m: any) => m.content), ["a-1"]);
  assert.equal(page2.hasMore, false);
});

test("humans see the announcement channel muted until they explicitly change it; other channels and agents are unaffected", async ({ app }) => {
  const { owner, member, server, agentA } = await seedServer("ann-mute");
  const announcement = await announcementOf(server.id);
  const room = await createChannel(server.id, "plain-room");
  await addHuman(room.id, member.id);

  type Row = { id: string; activityMuted?: boolean; muteFromSeq?: number | null };
  const stateOf = async (userId: string, channelId: string) =>
    ((await listChannels(server.id, userId, { humanActivityMuteEnabled: true })) as Row[]).find((channel) => channel.id === channelId);

  // Never set: muted by default for humans, in the list and in the single-channel read.
  assert.equal((await stateOf(member.id, announcement.id))?.activityMuted, true);
  assert.equal((await stateOf(owner.id, announcement.id))?.activityMuted, true);
  assert.deepEqual(
    { muted: (await getInboxTargetActivityMuteState("user", member.id, announcement.id)).activityMuted },
    { muted: true },
  );
  // Other channels keep their default (unmuted), and agents are not defaulted.
  assert.equal((await stateOf(member.id, room.id))?.activityMuted, false);
  assert.equal((await getInboxTargetActivityMuteState("user", member.id, room.id)).activityMuted, false);
  assert.equal((await getInboxTargetActivityMuteState("agent", agentA.id, announcement.id)).activityMuted, false);

  // Explicit unmute wins and is per user.
  await setInboxTargetActivityMuteState({ receiverType: "user", receiverId: member.id, serverId: server.id, sourceChannelId: announcement.id, activityMuted: false });
  assert.equal((await stateOf(member.id, announcement.id))?.activityMuted, false, "an explicit unmute is returned as unmuted");
  assert.equal((await stateOf(owner.id, announcement.id))?.activityMuted, true, "another user keeps the default");

  // Muting again writes a real mute row.
  await setInboxTargetActivityMuteState({ receiverType: "user", receiverId: member.id, serverId: server.id, sourceChannelId: announcement.id, activityMuted: true });
  const muted = await stateOf(member.id, announcement.id);
  assert.equal(muted?.activityMuted, true);
  assert.ok((muted?.muteFromSeq ?? 0) >= 1, "a real mute carries its own boundary");
});
