import { tokenForHuman } from "../test/integration/credentials.js";
import { createApiTest } from "../test/integration/apiTest.js";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

import { getDb } from "../db/index.js";
import { attachments } from "../db/schema.js";
import { addMember } from "../services/serverService.js";
import { createAgent } from "../services/agentService.js";
import { addAgent, addHuman, createChannel, findOrCreateDM } from "../services/channelService.js";
import { createMessage } from "../services/messageService.js";
import * as taskService from "../services/taskService.js";
import { createServer, headers, seedUser } from "./channels.api.fixtures.js";

const test = createApiTest({ humanActivityMuteFlagDefaultEnabled: true, onboardingOpenerFlagDefaultEnabled: false });

type Preview = {
  messageId: string;
  kind: string;
  text: string;
  senderType: string;
  senderId: string | null;
  senderName: string | null;
  attachmentCount: number;
  taskNumber: number | null;
};
type Row = { id: string; name: string; lastMessageAt: string | null; lastMessagePreview?: Preview | null };

async function attach(channelId: string, messageId: string, uploaderId: string, filename: string, mimeType: string) {
  await getDb().insert(attachments).values({
    channelId,
    messageId,
    uploaderId,
    uploaderType: "user",
    filename,
    mimeType,
    sizeBytes: 10,
    storageKey: `test/${randomUUID()}`,
  });
}

async function listChannels(baseUrl: string, token: string, serverId: string): Promise<Row[]> {
  const res = await fetch(`${baseUrl}/api/channels`, { headers: headers(token, serverId) });
  assert.equal(res.status, 200);
  return await res.json() as Row[];
}

test("GET /api/channels and /api/channels/dm attach a structured latest-message preview per conversation", async ({ app }) => {
  const suffix = randomUUID().slice(0, 8);
  const owner = await seedUser(`preview-owner-${suffix}@slock.test`, `preview-owner-${suffix}`);
  const peer = await seedUser(`preview-peer-${suffix}@slock.test`, `preview-peer-${suffix}`);
  const server = await createServer("Preview Server", `preview-${suffix}`, owner.id);
  await addMember(server.id, peer.id);
  const agent = await createAgent(server.id, `PreviewBot${suffix}`, { runtime: "codex" });

  const make = async (name: string) => {
    const channel = await createChannel(server.id, `${name}-${suffix}`);
    await addHuman(channel.id, owner.id);
    await addAgent(channel.id, agent.id);
    return channel;
  };
  const textCh = await make("text");
  const imageCh = await make("image");
  const fileCh = await make("file");
  const systemCh = await make("system");
  const taskCh = await make("task");
  const emptyCh = await make("empty");

  // Agent text with Markdown and an angle mention.
  await createMessage(textCh.id, "user", owner.id, "older message");
  const agentText = await createMessage(textCh.id, "agent", agent.id, `**Done** with \`step 1\` <@${peer.name}> see [the PR](https://x.test)`);
  // Image-only (one stored as octet-stream but named .png — same MIME normalisation as realtime).
  const imageMsg = await createMessage(imageCh.id, "user", peer.id, "");
  await attach(imageCh.id, imageMsg.id, peer.id, "a.png", "image/png");
  await attach(imageCh.id, imageMsg.id, peer.id, "b.png", "application/octet-stream");
  // Non-image attachment.
  const fileMsg = await createMessage(fileCh.id, "user", owner.id, "");
  await attach(fileCh.id, fileMsg.id, owner.id, "report.pdf", "application/pdf");
  // System message is the latest.
  await createMessage(systemCh.id, "user", owner.id, "hello");
  await createMessage(systemCh.id, "user", owner.id, "Someone joined the channel", "system");
  // Task host message is the latest.
  const { tasks: [task] } = await taskService.createTasks(taskCh.id, "user", owner.id, [{ title: "修复登录 401" }]);

  const token = await tokenForHuman(owner.email);
  const channels = await listChannels(app.baseUrl, token, server.id);
  const byId = new Map(channels.map((channel) => [channel.id, channel]));

  const text = byId.get(textCh.id)!.lastMessagePreview!;
  assert.deepEqual(text, {
    messageId: agentText.id,
    kind: "text",
    text: `Done with step 1 @${peer.name} see the PR`,
    senderType: "agent",
    senderId: agent.id,
    senderName: agent.displayName || agent.name,
    attachmentCount: 0,
    taskNumber: null,
  });
  assert.equal(byId.get(textCh.id)!.lastMessageAt, agentText.createdAt.toISOString());

  const image = byId.get(imageCh.id)!.lastMessagePreview!;
  assert.equal(image.kind, "image");
  assert.equal(image.text, "");
  assert.equal(image.attachmentCount, 2);
  assert.equal(image.senderType, "user");
  assert.equal(image.senderName, peer.displayName);

  const file = byId.get(fileCh.id)!.lastMessagePreview!;
  assert.equal(file.kind, "attachment");
  assert.equal(file.attachmentCount, 1);

  const system = byId.get(systemCh.id)!.lastMessagePreview!;
  assert.equal(system.kind, "system");
  assert.equal(system.text, "Someone joined the channel");

  const taskPreview = byId.get(taskCh.id)!.lastMessagePreview!;
  assert.equal(taskPreview.kind, "task");
  assert.equal(taskPreview.taskNumber, task!.taskNumber);
  assert.equal(taskPreview.messageId, task!.messageId);

  assert.equal(byId.get(emptyCh.id)!.lastMessagePreview, null);
  assert.equal(byId.get(emptyCh.id)!.lastMessageAt, null);

  // DM list: agent DM whose latest message is from the agent.
  const dm = await findOrCreateDM(server.id, owner.id, agent.id);
  assert.ok(dm);
  await createMessage(dm.id, "agent", agent.id, "status: all green ✅");
  const dmRes = await fetch(`${app.baseUrl}/api/channels/dm`, { headers: headers(token, server.id) });
  assert.equal(dmRes.status, 200);
  const dms = await dmRes.json() as Row[];
  const dmPreview = dms.find((row) => row.id === dm.id)!.lastMessagePreview!;
  assert.equal(dmPreview.kind, "text");
  assert.equal(dmPreview.text, "status: all green ✅");
  assert.equal(dmPreview.senderType, "agent");
  assert.equal(dmPreview.senderName, agent.displayName || agent.name);
});

test("GET /api/channels with 200 channels (timing is logged)", async ({ app }) => {
  const suffix = randomUUID().slice(0, 8);
  const owner = await seedUser(`preview-perf-${suffix}@slock.test`, `preview-perf-${suffix}`);
  const server = await createServer("Preview Perf", `preview-perf-${suffix}`, owner.id);
  const agent = await createAgent(server.id, `PerfBot${suffix}`, { runtime: "codex" });
  for (let i = 0; i < 200; i += 1) {
    const channel = await createChannel(server.id, `perf-${String(i).padStart(3, "0")}-${suffix}`);
    await addHuman(channel.id, owner.id);
    await createMessage(channel.id, "user", owner.id, `hello ${i}`);
    await createMessage(channel.id, "agent", agent.id, `**update** ${i} with some \`code\` and a [link](https://x.test/${i})`);
  }
  const token = await tokenForHuman(owner.email);
  await listChannels(app.baseUrl, token, server.id);
  const samples: number[] = [];
  for (let i = 0; i < 5; i += 1) {
    const started = performance.now();
    const rows = await listChannels(app.baseUrl, token, server.id);
    samples.push(performance.now() - started);
    assert.ok(rows.length >= 200);
  }
  samples.sort((a, b) => a - b);
  console.log(`[channels-preview] 200 channels GET /api/channels median ${samples[2]!.toFixed(1)} ms (samples ${samples.map((ms) => ms.toFixed(0)).join("/")}) (pglite)`);
});
