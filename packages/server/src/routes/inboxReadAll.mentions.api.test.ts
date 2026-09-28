import { tokenForHuman } from "../test/integration/credentials.js";
import { createApiTest } from "../test/integration/apiTest.js";
/**
 * #unread-badges task #10: Activity "mark all read"
 * (POST /api/channels/inbox/read-all) must clear every unread item the
 * Activity list shows — ordinary channel unread, a followed thread reply, and
 * personal @ mentions in #all (implicit membership, no channel_humans row)
 * or in a public channel the user has not joined.
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { getDb } from "../db/index.js";
import { serverMembers } from "../db/schema.js";
import { addHuman, createChannel, getInboxItems, getOrCreateThread, getSystemAllChannel } from "../services/channelService.js";
import { createServer, headers, seedUser } from "./channels.api.fixtures.js";

const test = createApiTest({ humanActivityMuteFlagDefaultEnabled: true, onboardingOpenerFlagDefaultEnabled: false });

async function post(baseUrl: string, token: string, serverId: string, channelId: string, content: string) {
  const res = await fetch(`${baseUrl}/api/messages`, {
    method: "POST",
    headers: { ...headers(token, serverId), "Content-Type": "application/json" },
    body: JSON.stringify({ channelId, content }),
  });
  assert.equal(res.status, 200, await res.clone().text());
  const body = await res.json() as { id?: string; message?: { id: string } };
  return body.message?.id ?? body.id!;
}

async function unreadItems(serverId: string, userId: string) {
  const result = await getInboxItems(serverId, userId, { filter: "unread", limit: 50 });
  return { total: result.totalUnreadCount ?? 0, items: result.items as Array<Record<string, unknown>> };
}

test("inbox read-all clears ordinary unread, followed thread replies and personal @ rows (incl. #all)", async ({ app }) => {
  const suffix = randomUUID().slice(0, 8);
  const owner = await seedUser(`ra-owner-${suffix}@slock.test`, `ra-owner-${suffix}`);
  const member = await seedUser(`ra-member-${suffix}@slock.test`, `ra-member-${suffix}`);
  const server = await createServer("Read All", `read-all-${suffix}`, owner.id);
  await getDb().insert(serverMembers).values({ serverId: server.id, userId: member.id, role: "member" });
  const ownerToken = await tokenForHuman(owner.email);
  const memberToken = await tokenForHuman(member.email);

  // 1) Ordinary unread in a joined channel.
  const joined = await createChannel(server.id, `ra-joined-${suffix}`);
  await addHuman(joined.id, owner.id);
  await addHuman(joined.id, member.id);
  await post(app.baseUrl, ownerToken, server.id, joined.id, "plain update");

  // 2) Followed thread reply.
  const parentId = await post(app.baseUrl, ownerToken, server.id, joined.id, "thread parent");
  const thread = await getOrCreateThread(parentId, owner.id, "user");
  await post(app.baseUrl, memberToken, server.id, thread.id, "I'm in"); // member follows by replying
  await post(app.baseUrl, ownerToken, server.id, thread.id, "reply for member");

  // 3) Personal @ in #all (implicit membership).
  const all = await getSystemAllChannel(server.id);
  assert.ok(all, "server has #all");
  await post(app.baseUrl, ownerToken, server.id, all!.id, `@${member.name} please check`);

  // 4) Personal @ in a public channel the member has not joined.
  const unjoined = await createChannel(server.id, `ra-unjoined-${suffix}`);
  await addHuman(unjoined.id, owner.id);
  await post(app.baseUrl, ownerToken, server.id, unjoined.id, `@${member.name} look here`);

  const before = await unreadItems(server.id, member.id);
  assert.ok(before.items.length > 0, "there is unread Activity before read-all");

  const res = await fetch(`${app.baseUrl}/api/channels/inbox/read-all`, {
    method: "POST",
    headers: { ...headers(memberToken, server.id), "Content-Type": "application/json" },
    body: JSON.stringify({}),
  });
  assert.equal(res.status, 200, await res.clone().text());
  const body = await res.json() as { markedCount: number };

  const after = await unreadItems(server.id, member.id);
  // Clients treat a row as unread while its read cursor (maxReadSeq) is
  // behind latestActivitySeq or it has an unread mention (firstMentionMessageId). Mention-only rows (e.g. #all without membership) keep
  // their permanent @ marker, but their cursor must have moved.
  const allAfter = await getInboxItems(server.id, member.id, { filter: "all", limit: 50 });
  const stillUnread = (allAfter.items as Array<Record<string, unknown>>).filter((item) =>
    Number(item.unreadCount ?? 0) > 0
      || Number(item.latestActivitySeq ?? 0) > Number(item.maxReadSeq ?? 0)
      || item.firstMentionMessageId != null).map((item) => ({ kind: item.kind, channelId: item.channelId, channelName: item.channelName }));
  assert.deepEqual(stillUnread, [], "every Activity item is read up to its latest activity");
  assert.deepEqual(
    after.items.map((item) => ({ channelId: item.channelId ?? item.sourceChannelId, unreadCount: item.unreadCount })),
    [],
    "no unread Activity item survives read-all",
  );
  assert.equal(after.total, 0);
  assert.ok(body.markedCount >= 3, `markedCount ${body.markedCount} covers the channel, the thread and #all`);
});
