import { fixturePasswordHash } from "../test/integration/credentials.js";
import { createApiTest } from "../test/integration/apiTest.js";
// Fork patch (ZCode integration): process-then-ack inbox and queryable send
// receipts.
//   1. GET /events/claim selects the same batch as /events but acks nothing;
//      a second claim without ack returns the same batch.
//   2. POST /events/ack applies the batch's ack token (volatile buffer removal +
//      durable per-channel watermark) and is idempotent.
//   3. Legacy /events keeps draining in one request.
//   4. A v2/send retry whose idempotency key already committed replays the
//      original message even when newer unread messages would hold a fresh send.
//   5. GET /send-receipts/:key reports sent / not_found.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

import { getDb } from "../db/index.js";
import { messages, users } from "../db/schema.js";
import { createServer } from "../services/serverService.js";
import { createAgent } from "../services/agentService.js";
import { createChannel, addAgent, addHuman, markAgentLegacyRead, getAgentLegacyReadCursor } from "../services/channelService.js";
import { createMessage } from "../services/messageService.js";
import { mintAgentCredential } from "../services/agentCredentialService.js";
import { AgentOrchestrator } from "../services/agentOrchestrator.js";
import { recordInboxNotificationFacts } from "../services/inboxNotificationService.js";
import { and, eq } from "drizzle-orm";

const test = createApiTest({ humanActivityMuteFlagDefaultEnabled: true, onboardingOpenerFlagDefaultEnabled: false });

async function seedFixture() {
  const db = getDb();
  const suffix = randomUUID();
  const [owner] = await db.insert(users).values({
    email: `claim-ack-${suffix}@slock.test`,
    name: `claim-ack-${suffix}`,
    displayName: "Claim Ack Owner",
    passwordHash: await fixturePasswordHash("password123"),
    emailVerified: true,
  }).returning();
  const server = await createServer("Claim Ack Test", `claim-ack-${suffix}`, owner!.id);
  const agent = await createAgent(server.id, "ClaimAckExt", { runtime: "external", model: "external" });
  const channel = await createChannel(server.id, "claim-ack-room");
  await addHuman(channel.id, owner!.id);
  await addAgent(channel.id, agent.id);
  const minted = await mintAgentCredential({
    agentId: agent.id,
    scopes: ["send", "read"],
    name: "claim-ack-test",
    createdByUserId: null,
  });
  return {
    ownerId: owner!.id,
    serverId: server.id,
    channelId: channel.id,
    channelName: channel.name,
    agentId: agent.id,
    apiKey: minted.apiKey,
  };
}

type Fixture = Awaited<ReturnType<typeof seedFixture>>;

async function sendHumanMessage(f: Fixture, content: string) {
  const message = await createMessage(f.channelId, "user", f.ownerId, content);
  await recordInboxNotificationFacts([{
    receiverType: "agent",
    receiverId: f.agentId,
    serverId: f.serverId,
    kind: "channel",
    sourceChannelId: f.channelId,
    messageId: message.id,
    messageSeq: message.seq,
    activityAt: message.createdAt,
    personalMention: false,
    unreadEligible: true,
  }]);
  return message;
}

function headers(apiKey: string): Record<string, string> {
  return { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" };
}

async function getJson(baseUrl: string, apiKey: string, path: string) {
  const res = await fetch(`${baseUrl}/internal/agent-api${path}`, { headers: headers(apiKey) });
  return { status: res.status, body: await res.json() as any };
}

async function postJson(baseUrl: string, apiKey: string, path: string, body: unknown) {
  const res = await fetch(`${baseUrl}/internal/agent-api${path}`, {
    method: "POST",
    headers: headers(apiKey),
    body: JSON.stringify(body),
  });
  return { status: res.status, body: await res.json() as any };
}

// Start from a durable watermark + empty volatile buffer so delivery comes from
// the cursor rebuild, the same path a restarted server takes.
async function seedUnread(app: { app: { set(key: string, value: unknown): void } }, f: Fixture) {
  const baseline = await sendHumanMessage(f, "baseline");
  await markAgentLegacyRead(f.agentId, f.channelId, baseline.seq);
  const one = await sendHumanMessage(f, "unread one");
  const two = await sendHumanMessage(f, "unread two");
  app.app.set("agentOrchestrator", new AgentOrchestrator() as any);
  return { baseline, one, two };
}

test("claim without ack returns the same batch again and does not advance the watermark", async ({ app }) => {
  const f = await seedFixture();
  const { baseline, one, two } = await seedUnread(app, f);

  const first = await getJson(app.baseUrl, f.apiKey, "/events/claim");
  assert.equal(first.status, 200);
  assert.deepEqual(first.body.events.map((e: any) => e.seq), [one.seq, two.seq]);
  assert.deepEqual(first.body.ack.seqs, [one.seq, two.seq]);
  assert.deepEqual(first.body.ack.message_ids, [], "message_ids only carries seq-less events");
  assert.equal(await getAgentLegacyReadCursor(f.agentId, f.channelId), baseline.seq);

  const second = await getJson(app.baseUrl, f.apiKey, "/events/claim");
  assert.deepEqual(second.body.events.map((e: any) => e.message_id), [one.id, two.id]);

  // Simulated crash: the volatile buffer is lost before ack; the rebuild must
  // still return the claimed-but-unacked batch.
  app.app.set("agentOrchestrator", new AgentOrchestrator() as any);
  const afterRestart = await getJson(app.baseUrl, f.apiKey, "/events/claim");
  assert.deepEqual(afterRestart.body.events.map((e: any) => e.message_id), [one.id, two.id]);

  const hints = await getJson(app.baseUrl, f.apiKey, "/wake-hints");
  assert.equal(hints.status, 200);
  assert.ok(hints.body.wake_hints.length > 0, "unacked batch still produces wake hints");
});

test("ack removes the claimed batch, advances the watermark, and is idempotent", async ({ app }) => {
  const f = await seedFixture();
  const { two } = await seedUnread(app, f);

  const claimed = await getJson(app.baseUrl, f.apiKey, "/events/claim");
  const acked = await postJson(app.baseUrl, f.apiKey, "/events/ack", claimed.body.ack);
  assert.equal(acked.status, 200);
  assert.equal(acked.body.ok, true);
  assert.equal(acked.body.removed_count, 2);
  assert.equal(await getAgentLegacyReadCursor(f.agentId, f.channelId), two.seq);

  const empty = await getJson(app.baseUrl, f.apiKey, "/events/claim");
  assert.deepEqual(empty.body.events, []);

  const again = await postJson(app.baseUrl, f.apiKey, "/events/ack", claimed.body.ack);
  assert.equal(again.status, 200);
  assert.equal(again.body.removed_count, 0);
  assert.equal(await getAgentLegacyReadCursor(f.agentId, f.channelId), two.seq);

  // Survives restart: acked rows are not rebuilt.
  app.app.set("agentOrchestrator", new AgentOrchestrator() as any);
  const rebuilt = await getJson(app.baseUrl, f.apiKey, "/events/claim");
  assert.deepEqual(rebuilt.body.events, []);
});

test("ack rejects malformed bodies", async ({ app }) => {
  const f = await seedFixture();
  const bad = await postJson(app.baseUrl, f.apiKey, "/events/ack", { seqs: ["x"], message_ids: [], third_party_event_ids: [] });
  assert.equal(bad.status, 400);
});

test("legacy /events still drains and acks in one request", async ({ app }) => {
  const f = await seedFixture();
  const { one, two } = await seedUnread(app, f);

  const drained = await getJson(app.baseUrl, f.apiKey, "/events");
  assert.deepEqual(drained.body.events.map((e: any) => e.seq), [one.seq, two.seq]);
  assert.equal("ack" in drained.body, false);
  assert.equal(await getAgentLegacyReadCursor(f.agentId, f.channelId), two.seq);
  const after = await getJson(app.baseUrl, f.apiKey, "/events/claim");
  assert.deepEqual(after.body.events, []);
});

test("send retry with a committed idempotency key replays even when newer messages would hold it", async ({ app }) => {
  const f = await seedFixture();
  const baseline = await sendHumanMessage(f, "baseline");
  await markAgentLegacyRead(f.agentId, f.channelId, baseline.seq);
  const request = {
    target: `#${f.channelName}`,
    content: "reply once",
    seenUpToSeq: baseline.seq,
    idempotencyKey: "zcode:claim-ack:retry-1",
  };

  const first = await postJson(app.baseUrl, f.apiKey, "/v2/send", request);
  assert.equal(first.status, 200);
  assert.equal(first.body.state, "sent");

  await sendHumanMessage(f, "arrived after the first attempt");

  const retry = await postJson(app.baseUrl, f.apiKey, "/v2/send", request);
  assert.equal(retry.status, 200);
  assert.equal(retry.body.state, "sent");
  assert.equal(retry.body.messageId, first.body.messageId);
  const rows = await getDb().select({ id: messages.id }).from(messages).where(
    and(eq(messages.channelId, f.channelId), eq(messages.senderId, f.agentId)),
  );
  assert.equal(rows.length, 1, "retry must not insert a second message");

  // A new key is still subject to the freshness gate.
  const fresh = await postJson(app.baseUrl, f.apiKey, "/v2/send", { ...request, idempotencyKey: "zcode:claim-ack:retry-2" });
  assert.equal(fresh.body.state, "held");
});

test("send receipt reports sent for a committed key and not_found otherwise", async ({ app }) => {
  const f = await seedFixture();
  const missing = await getJson(app.baseUrl, f.apiKey, "/send-receipts/zcode%3Anever-sent");
  assert.equal(missing.status, 200);
  assert.deepEqual(missing.body, { status: "not_found" });

  const sent = await postJson(app.baseUrl, f.apiKey, "/v2/send", {
    target: `#${f.channelName}`,
    content: "receipt me",
    idempotencyKey: "zcode:receipt-1",
  });
  assert.equal(sent.body.state, "sent");

  const receipt = await getJson(app.baseUrl, f.apiKey, "/send-receipts/zcode%3Areceipt-1");
  assert.equal(receipt.status, 200);
  assert.equal(receipt.body.status, "sent");
  assert.equal(receipt.body.message_id, sent.body.messageId);
  assert.equal(receipt.body.channel_id, f.channelId);
  assert.equal(typeof receipt.body.message_seq, "number");

  // Receipts are scoped to the calling agent.
  const other = await seedFixture();
  const foreign = await getJson(app.baseUrl, other.apiKey, "/send-receipts/zcode%3Areceipt-1");
  assert.deepEqual(foreign.body, { status: "not_found" });
});
