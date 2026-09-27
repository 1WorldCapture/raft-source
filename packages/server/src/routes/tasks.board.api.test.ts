import { fixturePasswordHash, tokenForHuman } from "../test/integration/credentials.js";
import { createApiTest } from "../test/integration/apiTest.js";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

import { eq } from "drizzle-orm";
import { getDb } from "../db/index.js";
import { messageMentions, messages, serverMembers, taskEvents, tasks, userChannelReadCursors, users } from "../db/schema.js";
import { createAgent } from "../services/agentService.js";
import { addAgent, addHuman, createChannel, getOrCreateThread } from "../services/channelService.js";
import { createMessage } from "../services/messageService.js";
import { createServer } from "../services/serverService.js";
import * as taskService from "../services/taskService.js";

const test = createApiTest({ humanActivityMuteFlagDefaultEnabled: true, onboardingOpenerFlagDefaultEnabled: false });

type BoardTask = {
  id: string;
  title: string;
  status: string;
  channelType: string;
  threadChannelId: string | null;
  lastActivityAt: string;
  latestActivity: {
    kind: "reply" | "task_event";
    at: string;
    actorType: string;
    actorId: string | null;
    actorName: string | null;
    snippet: string | null;
    eventType: string | null;
  } | null;
  replyCount: number;
  unreadCount: number;
  mentionsMe: boolean;
  description?: unknown;
};
type BoardBody = { tasks: BoardTask[]; next_cursor: string | null };

const T0 = Date.parse("2026-09-27T08:00:00.000Z");
const at = (minutes: number) => new Date(T0 + minutes * 60_000);

async function seedUser(name: string) {
  const [user] = await getDb().insert(users).values({
    email: `${name}@slock.test`,
    name,
    displayName: name,
    passwordHash: await fixturePasswordHash("password123"),
    emailVerified: true,
    profileSetupCompletedAt: new Date(),
  }).returning();
  return user;
}

async function setTaskTime(taskId: string, when: Date) {
  const db = getDb();
  await db.update(tasks).set({ updatedAt: when }).where(eq(tasks.id, taskId));
  await db.update(taskEvents).set({ createdAt: when }).where(eq(taskEvents.taskId, taskId));
}

async function reply(threadId: string, senderType: "user" | "agent", senderId: string, content: string, when: Date) {
  const message = await createMessage(threadId, senderType, senderId, content);
  await getDb().update(messages).set({ createdAt: when }).where(eq(messages.id, message.id));
  return message;
}

async function seedBoard() {
  const suffix = randomUUID().slice(0, 8);
  const owner = await seedUser(`board-owner-${suffix}`);
  const outsider = await seedUser(`board-outsider-${suffix}`);
  const server = await createServer("Task Board", `task-board-${suffix}`, owner.id);
  await getDb().insert(serverMembers).values({ serverId: server.id, userId: outsider.id, role: "member" });
  const agent = await createAgent(server.id, `BoardWorker${suffix}`, { runtime: "claude", model: "sonnet" });

  const pub = await createChannel(server.id, `board-pub-${suffix}`);
  const priv = await createChannel(server.id, `board-priv-${suffix}`, undefined, "private");
  await addHuman(pub.id, owner.id);
  await addAgent(pub.id, agent.id);
  await addHuman(priv.id, owner.id);

  const { tasks: pubTasks } = await taskService.createTasks(pub.id, "user", owner.id, [
    { title: "t1", description: "long body that board must not return" },
    { title: "t2" },
    { title: "t3" },
  ]);
  const { tasks: privTasks } = await taskService.createTasks(priv.id, "user", owner.id, [{ title: "p1" }]);
  const [t1, t2, t3] = pubTasks as [typeof pubTasks[number], typeof pubTasks[number], typeof pubTasks[number]];
  const p1 = privTasks[0]!;
  await setTaskTime(t1.id, at(0));
  await setTaskTime(t2.id, at(1));
  await setTaskTime(t3.id, at(2));
  await setTaskTime(p1.id, at(3));

  // t1's thread: an agent reply at +10m that directly mentions the owner.
  const thread = await getOrCreateThread(t1.messageId!, owner.id, "user");
  const agentReply = await reply(
    thread.id,
    "agent",
    agent.id,
    `**Done** with \`step 1\`\n\n\`\`\`ts\nconst x = 1;\n\`\`\`\n@${owner.name} please review`,
    at(10),
  );
  await getDb().insert(messageMentions).values({
    messageId: agentReply.id,
    messageSeq: agentReply.seq,
    serverId: server.id,
    channelId: thread.id,
    targetType: "user",
    targetId: owner.id,
    handleAtSendTime: owner.name,
  });

  return {
    server,
    owner,
    outsider,
    agent,
    thread,
    agentReply,
    t1,
    t2,
    t3,
    p1,
    ownerToken: await tokenForHuman(owner.email),
    outsiderToken: await tokenForHuman(outsider.email),
  };
}

function headers(token: string, serverId: string) {
  return { Authorization: `Bearer ${token}`, "X-Server-Id": serverId };
}

async function board(baseUrl: string, token: string, serverId: string, query = ""): Promise<BoardBody> {
  const res = await fetch(`${baseUrl}/api/tasks/server?view=board${query}`, { headers: headers(token, serverId) });
  assert.equal(res.status, 200, `board fetch failed with ${res.status}: ${await res.clone().text()}`);
  return await res.json() as BoardBody;
}

test("board orders by latest activity, includes member-only private tasks and thread facts", async ({ app }) => {
  const f = await seedBoard();
  const body = await board(app.baseUrl, f.ownerToken, f.server.id);

  assert.deepEqual(body.tasks.map((task) => task.title), ["t1", "p1", "t3", "t2"]);
  assert.equal(body.next_cursor, null);

  const t1 = body.tasks[0]!;
  assert.equal(t1.threadChannelId, f.thread.id);
  assert.equal(t1.lastActivityAt, at(10).toISOString());
  assert.equal(t1.replyCount, 1);
  assert.equal(t1.unreadCount, 1, "an unopened, unfollowed thread still counts others' replies as unread");
  assert.equal(t1.mentionsMe, true);
  assert.equal(t1.latestActivity?.kind, "reply");
  assert.equal(t1.latestActivity?.actorType, "agent");
  assert.equal(t1.latestActivity?.actorId, f.agent.id);
  assert.equal(t1.latestActivity?.actorName, f.agent.displayName ?? f.agent.name);
  assert.equal(t1.latestActivity?.snippet, `Done with step 1 const x = 1; @${f.owner.name} please review`);
  assert.equal("description" in t1, false, "board items are summaries");

  const p1 = body.tasks[1]!;
  assert.equal(p1.channelType, "private");
  assert.equal(p1.threadChannelId, null);
  assert.equal(p1.replyCount, 0);
  assert.equal(p1.unreadCount, 0);
  assert.equal(p1.mentionsMe, false);
  assert.equal(p1.latestActivity?.kind, "task_event");
  assert.equal(p1.latestActivity?.eventType, "created");
  assert.equal(p1.latestActivity?.actorName, f.owner.displayName);

  const outsiderBody = await board(app.baseUrl, f.outsiderToken, f.server.id);
  assert.deepEqual(outsiderBody.tasks.map((task) => task.title), ["t1", "t3", "t2"], "non-members never see private-channel tasks");
  const outsiderT1 = outsiderBody.tasks[0]!;
  assert.equal(outsiderT1.mentionsMe, false, "mentionsMe is per caller");
  assert.equal(outsiderT1.unreadCount, 1);
});

test("board unread follows the read cursor and own replies; mentionsMe clears after the caller replies", async ({ app }) => {
  const f = await seedBoard();

  await reply(f.thread.id, "user", f.owner.id, "on it", at(11));
  let t1 = (await board(app.baseUrl, f.ownerToken, f.server.id)).tasks.find((task) => task.id === f.t1.id)!;
  assert.equal(t1.replyCount, 2);
  assert.equal(t1.unreadCount, 1, "own replies are never unread");
  assert.equal(t1.mentionsMe, false, "replying after the mention clears it");
  assert.equal(t1.latestActivity?.actorType, "user");
  assert.equal(t1.latestActivity?.snippet, "on it");
  assert.equal(t1.lastActivityAt, at(11).toISOString());

  await getDb().insert(userChannelReadCursors).values({
    userId: f.owner.id,
    channelId: f.thread.id,
    lastReadSeq: f.agentReply.seq,
  });
  t1 = (await board(app.baseUrl, f.ownerToken, f.server.id)).tasks.find((task) => task.id === f.t1.id)!;
  assert.equal(t1.unreadCount, 0, "replies at or before the read cursor are read");

  await reply(f.thread.id, "agent", f.agent.id, "next update", at(12));
  t1 = (await board(app.baseUrl, f.ownerToken, f.server.id)).tasks.find((task) => task.id === f.t1.id)!;
  assert.equal(t1.unreadCount, 1);
});

test("board pages by (lastActivityAt, id) without repeats and supports status, completedAfter and ids", async ({ app }) => {
  const f = await seedBoard();

  const seen: string[] = [];
  let cursor: string | null = null;
  let pages = 0;
  do {
    const page: BoardBody = await board(app.baseUrl, f.ownerToken, f.server.id, `&limit=1${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`);
    assert.equal(page.tasks.length, 1);
    seen.push(page.tasks[0]!.title);
    cursor = page.next_cursor;
    pages++;
    assert.ok(pages < 10, "pagination did not terminate");
  } while (cursor);
  assert.deepEqual(seen, ["t1", "p1", "t3", "t2"]);

  await getDb().update(tasks).set({ status: "done", completedAt: at(-60) }).where(eq(tasks.id, f.t3.id));
  await getDb().update(tasks).set({ status: "done", completedAt: at(30) }).where(eq(tasks.id, f.p1.id));

  const done = await board(app.baseUrl, f.ownerToken, f.server.id, "&status=done");
  assert.deepEqual(done.tasks.map((task) => task.title).sort(), ["p1", "t3"]);
  const doneToday = await board(app.baseUrl, f.ownerToken, f.server.id, `&status=done&completedAfter=${encodeURIComponent(at(0).toISOString())}`);
  assert.deepEqual(doneToday.tasks.map((task) => task.title), ["p1"]);
  const openOrDoneToday = await board(app.baseUrl, f.ownerToken, f.server.id, `&status=todo,in_progress,done&completedAfter=${encodeURIComponent(at(0).toISOString())}`);
  assert.equal(openOrDoneToday.tasks.some((task) => task.title === "t3"), false, "completedAfter only trims done/closed");
  assert.equal(openOrDoneToday.tasks.some((task) => task.title === "t1"), true);

  const byIds = await board(app.baseUrl, f.ownerToken, f.server.id, `&ids=${f.t2.id},${f.p1.id}`);
  assert.deepEqual(byIds.tasks.map((task) => task.title).sort(), ["p1", "t2"]);
  assert.equal(byIds.next_cursor, null);
  const outsiderByIds = await board(app.baseUrl, f.outsiderToken, f.server.id, `&ids=${f.p1.id}`);
  assert.deepEqual(outsiderByIds.tasks, [], "ids cannot reach a private task the caller cannot see");
});

test("board rejects invalid parameters", async ({ app }) => {
  const f = await seedBoard();
  const expect400 = async (query: string, label: string) => {
    const res = await fetch(`${app.baseUrl}/api/tasks/server?${query}`, { headers: headers(f.ownerToken, f.server.id) });
    assert.equal(res.status, 400, `${label}: expected 400, got ${res.status}`);
  };
  await expect400("view=bogus", "unknown view");
  await expect400("view=board&status=todo,nope", "unknown status");
  await expect400("view=board&status=", "empty status");
  await expect400("view=board&sort=title", "unknown sort");
  await expect400("view=board&limit=0", "limit below range");
  await expect400("view=board&limit=201", "limit above range");
  await expect400("view=board&cursor=%%%", "undecodable cursor");
  await expect400("view=board&completedAfter=yesterday", "bad completedAfter");
  await expect400("view=board&ids=not-a-uuid", "bad id");
  await expect400(`view=board&ids=${Array.from({ length: 51 }, () => randomUUID()).join(",")}`, "too many ids");
});

test("board with 200 tasks answers in one bounded round (timing is logged)", async ({ app }) => {
  const f = await seedBoard();
  const suffix = randomUUID().slice(0, 8);
  const bulk = await createChannel(f.server.id, `board-bulk-${suffix}`);
  await addHuman(bulk.id, f.owner.id);
  const specs = Array.from({ length: 196 }, (_, i) => ({ title: `bulk-${i}` }));
  const created: string[] = [];
  for (let i = 0; i < specs.length; i += 50) {
    const { tasks: chunk } = await taskService.createTasks(bulk.id, "user", f.owner.id, specs.slice(i, i + 50));
    created.push(...chunk.map((task) => task.messageId!).filter(Boolean));
  }
  // Give half of them a thread with a couple of replies.
  for (const messageId of created.slice(0, 98)) {
    const thread = await getOrCreateThread(messageId, f.owner.id, "user");
    await createMessage(thread.id, "agent", f.agent.id, "progress update");
    await createMessage(thread.id, "user", f.owner.id, "thanks");
  }

  // Warm once, then time.
  await board(app.baseUrl, f.ownerToken, f.server.id, "&limit=200");
  const started = performance.now();
  const body = await board(app.baseUrl, f.ownerToken, f.server.id, "&limit=200");
  const elapsedMs = performance.now() - started;
  console.log(`[task-board] 200 tasks: ${elapsedMs.toFixed(1)} ms (pglite)`);
  assert.equal(body.tasks.length, 200);
  assert.equal(body.next_cursor, null);
});
