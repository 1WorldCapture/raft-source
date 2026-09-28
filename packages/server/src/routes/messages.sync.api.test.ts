import { tokenForHuman } from "../test/integration/credentials.js";
import { createApiTest } from "../test/integration/apiTest.js";
/**
 * #client-data-cache task #7: GET /messages/sync must return the same wire
 * types as GET /messages/channel — numeric `seq` and ISO-8601 timestamps —
 * on every path: server-wide (raw SQL), channel-scoped, and joint channels.
 * The response stays a bare array for existing clients.
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { getDb } from "../db/index.js";
import { jointChannels, jointChannelServers } from "../db/schema.js";
import * as channelService from "../services/channelService.js";
import { createMessage, normalizeRawMessageRow } from "../services/messageService.js";
import { createServer, headers, seedUser } from "./channels.api.fixtures.js";

const test = createApiTest({ humanActivityMuteFlagDefaultEnabled: true, onboardingOpenerFlagDefaultEnabled: false });

const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/;

type WireMessage = Record<string, unknown> & { id: string; seq: unknown; channelId: string };

async function sync(baseUrl: string, token: string, serverId: string, query: string): Promise<WireMessage[]> {
  const res = await fetch(`${baseUrl}/api/messages/sync?${query}`, { headers: headers(token, serverId) });
  assert.equal(res.status, 200, await res.clone().text());
  const body = await res.json() as unknown;
  assert.ok(Array.isArray(body), "the sync response stays a bare array");
  return body as WireMessage[];
}

function assertWireTypes(rows: WireMessage[], label: string) {
  assert.ok(rows.length > 0, `${label}: expected rows`);
  for (const row of rows) {
    assert.equal(typeof row.seq, "number", `${label}: seq must be a number, got ${JSON.stringify(row.seq)}`);
    assert.match(String(row.createdAt), ISO_RE, `${label}: createdAt must be ISO, got ${String(row.createdAt)}`);
    assert.match(String(row.updatedAt), ISO_RE, `${label}: updatedAt must be ISO, got ${String(row.updatedAt)}`);
  }
}

test("GET /messages/sync returns numeric seq and ISO timestamps, server-wide and channel-scoped, like /messages/channel", async ({ app }) => {
  const suffix = randomUUID().slice(0, 8);
  const owner = await seedUser(`sync-owner-${suffix}@slock.test`, `sync-owner-${suffix}`);
  const server = await createServer("Sync Types", `sync-types-${suffix}`, owner.id);
  const channel = await channelService.createChannel(server.id, `sync-room-${suffix}`);
  await channelService.addHuman(channel.id, owner.id);
  const first = await createMessage(channel.id, "user", owner.id, "one");
  await createMessage(channel.id, "user", owner.id, "two");
  const token = await tokenForHuman(owner.email);

  const serverWide = await sync(app.baseUrl, token, server.id, "since_seq=0&limit=50");
  assertWireTypes(serverWide.filter((row) => row.channelId === channel.id), "server-wide (raw SQL path)");
  const scoped = await sync(app.baseUrl, token, server.id, `since_seq=0&limit=50&channel_id=${channel.id}`);
  assertWireTypes(scoped, "channel-scoped");

  // Same entity, same values across endpoints.
  const channelRes = await fetch(`${app.baseUrl}/api/messages/channel/${channel.id}`, { headers: headers(token, server.id) });
  assert.equal(channelRes.status, 200);
  const channelBody = await channelRes.json() as { messages: WireMessage[] };
  const fromChannel = channelBody.messages.find((row) => row.id === first.id)!;
  const fromSync = serverWide.find((row) => row.id === first.id)!;
  assert.equal(fromSync.seq, fromChannel.seq);
  assert.equal(fromSync.createdAt, fromChannel.createdAt);

  // since_seq paging still works with the numeric cursor.
  const after = await sync(app.baseUrl, token, server.id, `since_seq=${fromSync.seq as number}&limit=50&channel_id=${channel.id}`);
  assert.ok(after.every((row) => (row.seq as number) > (fromSync.seq as number)));
  assert.equal(after.length, 1);
});

test("GET /messages/sync on a joint channel projection returns numeric seq and ISO timestamps", async ({ app }) => {
  const suffix = randomUUID().slice(0, 8);
  const hostOwner = await seedUser(`sync-joint-host-${suffix}@slock.test`, `sync-joint-host-${suffix}`);
  const peerOwner = await seedUser(`sync-joint-peer-${suffix}@slock.test`, `sync-joint-peer-${suffix}`);
  const hostServer = await createServer("Joint Host", `sync-joint-${suffix}-host`, hostOwner.id);
  const peerServer = await createServer("Joint Peer", `sync-joint-${suffix}-peer`, peerOwner.id);
  const canonical = await channelService.createChannel(hostServer.id, `sync-joint-${suffix}-storage`, undefined, "channel");
  const hostProjection = await channelService.createChannel(hostServer.id, `sync-joint-${suffix}`, undefined, "joint");
  const peerProjection = await channelService.createChannel(peerServer.id, `sync-joint-${suffix}`, undefined, "joint");
  await channelService.addHuman(hostProjection.id, hostOwner.id);
  await channelService.addHuman(peerProjection.id, peerOwner.id);
  const db = getDb();
  const [joint] = await db.insert(jointChannels).values({
    canonicalChannelId: canonical.id,
    createdByServerId: hostServer.id,
    createdByUserId: hostOwner.id,
  }).returning();
  await db.insert(jointChannelServers).values([
    { jointChannelId: joint!.id, serverId: hostServer.id, localChannelId: hostProjection.id, role: "host", joinedByUserId: hostOwner.id },
    { jointChannelId: joint!.id, serverId: peerServer.id, localChannelId: peerProjection.id, role: "participant", joinedByUserId: peerOwner.id },
  ]);
  await createMessage(canonical.id, "user", hostOwner.id, "joint hello");

  const peerToken = await tokenForHuman(peerOwner.email);
  const rows = await sync(app.baseUrl, peerToken, peerServer.id, `since_seq=0&limit=50&channel_id=${peerProjection.id}`);
  assertWireTypes(rows, "joint projection");
  assert.ok(rows.every((row) => row.channelId === peerProjection.id), "rows are projected to the local joint channel");
});

test("normalizeRawMessageRow maps node-postgres raw types (string bigint, pg timestamps) to the Drizzle wire types", () => {
  // PGlite returns int8 as a number, so the API test above cannot show the
  // production symptom; pin the conversion node-postgres needs directly.
  const row = normalizeRawMessageRow({
    id: "m-1",
    seq: "8",
    createdAt: "2026-09-28 11:34:17.509+00",
    updatedAt: "2026-09-28 11:34:18+00",
    taskClaimedAt: null,
    taskCompletedAt: "2026-09-28 12:00:00+00",
    content: "hi",
  });
  assert.equal(row.seq, 8);
  assert.equal(JSON.stringify(row.createdAt), JSON.stringify("2026-09-28T11:34:17.509Z"));
  assert.equal(JSON.stringify(row.updatedAt), JSON.stringify("2026-09-28T11:34:18.000Z"));
  assert.equal(row.taskClaimedAt, null);
  assert.equal(JSON.stringify(row.taskCompletedAt), JSON.stringify("2026-09-28T12:00:00.000Z"));
  assert.equal(row.content, "hi");
  // Already-typed rows pass through unchanged.
  const typed = normalizeRawMessageRow({ seq: 9, createdAt: new Date("2026-01-01T00:00:00Z") });
  assert.equal(typed.seq, 9);
  assert.equal((typed.createdAt as Date).toISOString(), "2026-01-01T00:00:00.000Z");
});
