import { fixturePasswordHash, tokenForHuman } from "../test/integration/credentials.js";
import { createApiTest } from "../test/integration/apiTest.js";
/**
 * #unread-badges task #3 / #6:
 * - Guests only count unread from channels they can read — the Activity
 *   total (getActivityUnreadTotalsBatch) must equal what the Activity list
 *   shows, and /channels/unread must not list channels hidden from them.
 * - A mention the user already marked Done must not come back into the
 *   Activity list through the latest-mention fallback rows.
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { SERVER_GUEST_FEATURE_FLAG_KEY } from "@botiverse/raft-shared";
import { getDb } from "../db/index.js";
import { channels, featureFlagRules, messageMentions, serverMembers, users } from "../db/schema.js";
import { createMessage } from "./messageService.js";
import { createServer } from "./serverService.js";
import {
  addHuman,
  createChannel,
  getActivityUnreadTotalsBatch,
  getInboxItems,
} from "./channelService.js";

const test = createApiTest({ humanActivityMuteFlagDefaultEnabled: true, onboardingOpenerFlagDefaultEnabled: false });

async function seedUser(name: string) {
  const [user] = await getDb().insert(users).values({
    email: `${name}@slock.test`,
    name,
    displayName: name,
    passwordHash: await fixturePasswordHash("password123"),
    emailVerified: true,
    profileSetupCompletedAt: new Date(),
  }).returning();
  return user!;
}

function headers(token: string, serverId: string) {
  return { Authorization: `Bearer ${token}`, "Content-Type": "application/json", "X-Server-Id": serverId };
}

/** Send through the HTTP route so the inbox notification pipeline runs. */
async function post(baseUrl: string, token: string, serverId: string, channelId: string, content: string) {
  const res = await fetch(`${baseUrl}/api/messages`, {
    method: "POST",
    headers: headers(token, serverId),
    body: JSON.stringify({ channelId, content }),
  });
  assert.equal(res.status, 200, await res.clone().text());
  const body = await res.json() as { id?: string; seq?: number; message?: { id: string; seq: number } };
  const message = body.message ?? (body as { id: string; seq: number });
  assert.ok(message.id, "send response carries the message id");
  return { id: message.id, seq: Number(message.seq) };
}

async function enableGuestFlag(serverId: string) {
  await getDb().insert(featureFlagRules).values({
    id: randomUUID(),
    flagKey: SERVER_GUEST_FEATURE_FLAG_KEY,
    stage: "server",
    priority: 0,
    decision: "allow",
    values: [serverId],
  });
}

async function listTotal(serverId: string, userId: string) {
  const result = await getInboxItems(serverId, userId, { filter: "all", limit: 50 });
  return result.totalUnreadCount ?? 0;
}

async function batchTotal(serverId: string, userId: string) {
  const totals = await getActivityUnreadTotalsBatch([{ serverId }], userId);
  return totals.get(serverId)?.totalUnreadCount ?? 0;
}

async function channelUnread(baseUrl: string, token: string, serverId: string) {
  const res = await fetch(`${baseUrl}/api/channels/unread`, { headers: headers(token, serverId) });
  assert.equal(res.status, 200);
  return await res.json() as Record<string, number>;
}

test("guest with the guest gate off: no readable channels, so the Activity total and /channels/unread are empty", async ({ app }) => {
  const suffix = randomUUID().slice(0, 8);
  const owner = await seedUser(`gu-owner-${suffix}`);
  const guest = await seedUser(`gu-guest-${suffix}`);
  const server = await createServer("Guest Unread", `guest-unread-${suffix}`, owner.id);
  await getDb().insert(serverMembers).values({ serverId: server.id, userId: guest.id, role: "guest" });
  const channel = await createChannel(server.id, `gu-room-${suffix}`);
  await addHuman(channel.id, owner.id);
  await addHuman(channel.id, guest.id);
  const ownerToken = await tokenForHuman(owner.email);
  await post(app.baseUrl, ownerToken, server.id, channel.id, "hello guest");
  await post(app.baseUrl, ownerToken, server.id, channel.id, "second");

  assert.equal(await listTotal(server.id, guest.id), 0, "the Activity list hides everything while the gate is off");
  assert.equal(await batchTotal(server.id, guest.id), 0, "the badge total must match the list");
  const guestToken = await tokenForHuman(guest.email);
  assert.deepEqual(await channelUnread(app.baseUrl, guestToken, server.id), {});

  // Ordinary members are unaffected.
  const member = await seedUser(`gu-member-${suffix}`);
  await getDb().insert(serverMembers).values({ serverId: server.id, userId: member.id, role: "member" });
  await addHuman(channel.id, member.id);
  await post(app.baseUrl, ownerToken, server.id, channel.id, "for the member");
  assert.equal(await batchTotal(server.id, member.id), await listTotal(server.id, member.id));
  assert.ok(await batchTotal(server.id, member.id) > 0);
  const memberToken = await tokenForHuman(member.email);
  assert.ok((await channelUnread(app.baseUrl, memberToken, server.id))[channel.id]! > 0);
});

test("guest with the gate on: counts only guest-readable channels; hidden public channels are excluded", async ({ app }) => {
  const suffix = randomUUID().slice(0, 8);
  const owner = await seedUser(`gv-owner-${suffix}`);
  const guest = await seedUser(`gv-guest-${suffix}`);
  const server = await createServer("Guest Visible", `guest-visible-${suffix}`, owner.id);
  await getDb().insert(serverMembers).values({ serverId: server.id, userId: guest.id, role: "guest" });
  await enableGuestFlag(server.id);
  const visible = await createChannel(server.id, `gv-open-${suffix}`);
  await getDb().update(channels).set({ guestVisible: true }).where(eq(channels.id, visible.id));
  await addHuman(visible.id, owner.id);
  await addHuman(visible.id, guest.id);
  const hidden = await createChannel(server.id, `gv-hidden-${suffix}`);
  await getDb().update(channels).set({ guestVisible: false, guestJoinable: false }).where(eq(channels.id, hidden.id));
  await addHuman(hidden.id, owner.id);
  const ownerToken = await tokenForHuman(owner.email);
  await post(app.baseUrl, ownerToken, server.id, visible.id, "visible to guest");
  await post(app.baseUrl, ownerToken, server.id, hidden.id, "hidden from guest");

  const list = await listTotal(server.id, guest.id);
  assert.ok(list > 0);
  assert.equal(await batchTotal(server.id, guest.id), list);
  const guestToken = await tokenForHuman(guest.email);
  const counts = await channelUnread(app.baseUrl, guestToken, server.id);
  assert.ok(counts[visible.id]! > 0);
  assert.equal(hidden.id in counts, false, "a public channel hidden from guests must not be counted");

  const summaryRes = await fetch(`${app.baseUrl}/api/channels/unread?summary=1`, { headers: headers(guestToken, server.id) });
  assert.equal(summaryRes.status, 200);
  const summary = await summaryRes.json() as { channels: Record<string, unknown> };
  assert.equal(hidden.id in summary.channels, false);
});

test("a channel mention marked Done does not come back via the mention fallback after later channel activity", async ({ app }) => {
  const suffix = randomUUID().slice(0, 8);
  const owner = await seedUser(`dm-owner-${suffix}`);
  const outsider = await seedUser(`dm-outsider-${suffix}`);
  const server = await createServer("Done Mention", `done-mention-${suffix}`, owner.id);
  await getDb().insert(serverMembers).values({ serverId: server.id, userId: outsider.id, role: "member" });
  // Public channel the outsider has NOT joined: a notified mention reaches
  // them only through the latest-mention fallback rows.
  const channel = await createChannel(server.id, `dm-room-${suffix}`);
  await addHuman(channel.id, owner.id);
  const ownerToken = await tokenForHuman(owner.email);
  const mention = await post(app.baseUrl, ownerToken, server.id, channel.id, `@${outsider.name} please look`);
  // A non-member mention is recorded as not notifiable at send; the explicit
  // "notify" action later stamps notified_at. Model that end state directly.
  const updated = await getDb().update(messageMentions)
    .set({ notifiedAt: new Date() })
    .where(and(eq(messageMentions.messageId, mention.id), eq(messageMentions.targetId, outsider.id)))
    .returning({ id: messageMentions.id });
  if (updated.length === 0) {
    await getDb().insert(messageMentions).values({
      messageId: mention.id,
      messageSeq: mention.seq,
      serverId: server.id,
      channelId: channel.id,
      targetType: "user",
      targetId: outsider.id,
      handleAtSendTime: outsider.name,
      notifiableAtSend: false,
      notifiedAt: new Date(),
    });
  }

  const includesChannel = async () =>
    JSON.stringify((await getInboxItems(server.id, outsider.id, { filter: "all", limit: 50 })).items).includes(channel.id);
  assert.equal(await includesChannel(), true, "the notified mention shows in Activity before Done");

  const outsiderToken = await tokenForHuman(outsider.email);
  const done = await fetch(`${app.baseUrl}/api/channels/inbox/done`, {
    method: "POST",
    headers: headers(outsiderToken, server.id),
    body: JSON.stringify({ channelId: channel.id }),
  });
  assert.equal(done.status, 200, await done.clone().text());
  assert.equal(await includesChannel(), false, "Done hides it");

  // messageService.createMessage clears every user's channel Done flag
  // (user_channel_inbox_states.done_at) but leaves the Done frontier
  // (done_through_seq). Only that frontier keeps the old mention from
  // resurfacing through the fallback rows.
  await createMessage(channel.id, "user", owner.id, "unrelated follow-up");
  assert.equal(await includesChannel(), false, "a Done mention must not resurface after later activity");
  const after = await getInboxItems(server.id, outsider.id, { filter: "all", limit: 50 });
  assert.equal(await batchTotal(server.id, outsider.id), after.totalUnreadCount ?? 0);
});
