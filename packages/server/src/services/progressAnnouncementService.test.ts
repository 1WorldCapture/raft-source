import { createApiTest } from "../test/integration/apiTest.js";

import assert from "node:assert/strict";
import { and, eq, isNull } from "drizzle-orm";
import { getDb } from "../db/index.js";
import { channels, messages, users } from "../db/schema.js";
import { createServer, updateServerAnnouncementSettings } from "./serverService.js";
import { createAgent } from "./agentService.js";
import { createMessage } from "./messageService.js";
import {
  ANNOUNCEMENT_HOUR_MS,
  ANNOUNCEMENT_PROXY_KIND,
  buildIdleAnnouncement,
  buildNudgeNotice,
  createProgressAnnouncementDeps,
  runProgressAnnouncementTick,
  type ProgressAnnouncementDeps,
} from "./progressAnnouncementService.js";

const test = createApiTest({ humanActivityMuteFlagDefaultEnabled: true, onboardingOpenerFlagDefaultEnabled: false });

let seq = 0;
async function seedServer(enabled = true) {
  seq += 1;
  const [owner] = await getDb().insert(users).values({
    email: `pa-owner-${seq}@slock.test`, name: `pa-owner-${seq}`, displayName: "owner", passwordHash: "x", emailVerified: true,
  }).returning();
  const server = await createServer(`PA ${seq}`, `pa-${seq}`, owner.id);
  if (enabled) await updateServerAnnouncementSettings(server.id, { announcementsEnabled: true });
  const [announcement] = await getDb().select().from(channels).where(and(
    eq(channels.serverId, server.id), eq(channels.systemKind, "announcement"), isNull(channels.deletedAt),
  ));
  return { server, owner, announcement };
}

type Fake = {
  deps: ProgressAnnouncementDeps;
  nudges: string[];
  idlePosts: Array<{ agentId: string; idleSince: Date }>;
  setNow: (date: Date) => void;
  setPresence: (agentId: string, presence: "working" | "idle" | "offline" | null, sinceMs: number | null) => void;
};

function fakeDeps(start: Date): Fake {
  let now = start;
  const presence = new Map<string, { presence: "working" | "idle" | "offline" | null; presenceSinceMs: number | null }>();
  const nudges: string[] = [];
  const idlePosts: Array<{ agentId: string; idleSince: Date }> = [];
  return {
    nudges,
    idlePosts,
    setNow: (date) => { now = date; },
    setPresence: (agentId, p, sinceMs) => { presence.set(agentId, { presence: p, presenceSinceMs: sinceMs }); },
    deps: {
      now: () => now,
      getPresence: async (agentId) => presence.get(agentId) ?? { presence: null, presenceSinceMs: null },
      nudge: async ({ agentId }) => { nudges.push(agentId); },
      postIdle: async ({ agentId, idleSince }) => { idlePosts.push({ agentId, idleSince }); },
    },
  };
}

const T0 = new Date("2026-10-01T09:00:00.000Z");
const at = (hours: number, minutes = 0) => new Date(T0.getTime() + hours * ANNOUNCEMENT_HOUR_MS + minutes * 60_000);

test("a working agent is nudged an hour after tracking began, then once per hour", async ({ app }) => {
  const { server } = await seedServer();
  const agent = await createAgent(server.id, "worker", { runtime: "codex" });
  const fake = fakeDeps(T0);
  fake.setPresence(agent.id, "working", T0.getTime());

  assert.equal((await runProgressAnnouncementTick(fake.deps)).nudged, 0, "first sight starts the clock");
  fake.setNow(at(0, 59));
  assert.equal((await runProgressAnnouncementTick(fake.deps)).nudged, 0, "59 minutes is not an hour");
  fake.setNow(at(1, 0));
  assert.equal((await runProgressAnnouncementTick(fake.deps)).nudged, 1, "an hour without an announcement: nudged");
  assert.deepEqual(fake.nudges, [agent.id]);

  fake.setNow(at(1, 5));
  assert.equal((await runProgressAnnouncementTick(fake.deps)).nudged, 0, "not again within the hour");
  fake.setNow(at(1, 59));
  assert.equal((await runProgressAnnouncementTick(fake.deps)).nudged, 0);
  fake.setNow(at(2, 0));
  assert.equal((await runProgressAnnouncementTick(fake.deps)).nudged, 1, "an hour after the last nudge: nudged again");
  assert.deepEqual(fake.nudges, [agent.id, agent.id]);
});

test("flicker between working and idle, every stretch under an hour, is still nudged after an hour", async ({ app }) => {
  const { server } = await seedServer();
  const agent = await createAgent(server.id, "flicker", { runtime: "codex" });
  const fake = fakeDeps(T0);
  const tick = async (minutes: number) => {
    fake.setNow(at(0, minutes));
    const working = (minutes / 10) % 2 === 0;
    // 20 min of work, 10 idle ... each segment starts at its own tick, none reaches an hour.
    fake.setPresence(agent.id, working ? "working" : "idle", at(0, minutes).getTime());
    return runProgressAnnouncementTick(fake.deps);
  };
  for (const minutes of [0, 10, 20, 30, 40, 50]) {
    const result = await tick(minutes);
    assert.equal(result.nudged, 0, `minute ${minutes}`);
    assert.equal(result.idlePosted, 0, `minute ${minutes}: no idle segment lasts an hour`);
  }
  const atHour = await tick(60);
  assert.equal(atHour.nudged, 1, "an hour with nothing announced: nudged although no single stretch lasted an hour");
  assert.deepEqual(fake.nudges, [agent.id]);
  assert.equal((await tick(70)).nudged, 0);
});

test("turning the switch on, or coming back from offline, restarts the clock instead of waking everyone", async ({ app }) => {
  const { server, announcement } = await seedServer();
  const longSilent = await createAgent(server.id, "silent", { runtime: "codex" });
  const returning = await createAgent(server.id, "returning", { runtime: "codex" });
  const unknown = await createAgent(server.id, "unknown", { runtime: "codex" });
  await createMessage(announcement.id, "agent", longSilent.id, "ancient update");
  await getDb().update(messages).set({ createdAt: new Date(T0.getTime() - 5 * ANNOUNCEMENT_HOUR_MS) }).where(eq(messages.channelId, announcement.id));
  const fake = fakeDeps(T0);
  fake.setPresence(longSilent.id, "working", T0.getTime());
  fake.setPresence(returning.id, "working", T0.getTime());
  fake.setPresence(unknown.id, null, null);

  assert.equal((await runProgressAnnouncementTick(fake.deps)).nudged, 0, "last post hours ago, but tracking only just began");

  // returning goes offline for a while; the clock restarts when it is back.
  fake.setNow(at(0, 30));
  fake.setPresence(returning.id, "offline", at(0, 30).getTime());
  await runProgressAnnouncementTick(fake.deps);
  fake.setNow(at(1, 0));
  fake.setPresence(returning.id, "working", at(1, 0).getTime());
  const result = await runProgressAnnouncementTick(fake.deps);
  assert.deepEqual(fake.nudges, [longSilent.id], "longSilent has been tracked for an hour; returning only just came back");
  assert.equal(result.nudged, 1);

  fake.setNow(at(2, 0));
  await runProgressAnnouncementTick(fake.deps);
  assert.deepEqual(fake.nudges.sort(), [longSilent.id, returning.id, longSilent.id].sort(), "returning is due an hour after it returned; unknown presence never is");

  // Switch off and on: tracking restarts from the next tick.
  await updateServerAnnouncementSettings(server.id, { announcementsEnabled: false });
  await updateServerAnnouncementSettings(server.id, { announcementsEnabled: true });
  const before = fake.nudges.length;
  fake.setNow(at(9, 0));
  await runProgressAnnouncementTick(fake.deps);
  assert.equal(fake.nudges.length, before, "nobody is due right after the switch is turned back on");
  fake.setNow(at(10, 0));
  await runProgressAnnouncementTick(fake.deps);
  assert.equal(fake.nudges.length, before + 2, "an hour later both working agents are due");
});

test("a working agent that announced within the hour is left alone", async ({ app }) => {
  const { server, announcement } = await seedServer();
  const agent = await createAgent(server.id, "writer", { runtime: "codex" });
  await createMessage(announcement.id, "agent", agent.id, "doing / done / next");
  const fake = fakeDeps(new Date());
  fake.setPresence(agent.id, "working", Date.now());

  assert.equal((await runProgressAnnouncementTick(fake.deps)).nudged, 0, "it just announced");
  fake.setNow(new Date(Date.now() + ANNOUNCEMENT_HOUR_MS + 60_000));
  assert.equal((await runProgressAnnouncementTick(fake.deps)).nudged, 1, "an hour after its own announcement it is due");
});

test("an idle agent gets a system post for every full hour since it went idle, and is never woken", async ({ app }) => {
  const { server } = await seedServer();
  const agent = await createAgent(server.id, "sleeper", { runtime: "codex" });
  const fake = fakeDeps(T0);
  fake.setPresence(agent.id, "idle", T0.getTime()); // idle from 09:00

  const tick = async (date: Date) => { fake.setNow(date); return runProgressAnnouncementTick(fake.deps); };
  assert.equal((await tick(at(0, 30))).idlePosted, 0, "09:30: not a full hour yet");
  assert.equal((await tick(at(1, 2))).idlePosted, 1, "10:02 -> 10:00 post");
  assert.equal((await tick(at(1, 7))).idlePosted, 0, "no duplicate within the same hour");
  assert.equal((await tick(at(2, 1))).idlePosted, 1, "11:00");
  assert.equal((await tick(at(3, 4))).idlePosted, 1, "12:00");
  assert.equal((await tick(at(4, 0))).idlePosted, 1, "13:00");
  assert.equal(fake.idlePosts.length, 4);
  assert.equal(fake.nudges.length, 0, "an idle agent is never woken");
  assert.ok(fake.idlePosts.every((post) => post.agentId === agent.id && post.idleSince.getTime() === T0.getTime()));

  // Back to work and idle again: a new idle epoch restarts the count.
  const second = new Date(at(5).getTime());
  fake.setPresence(agent.id, "idle", second.getTime());
  assert.equal((await tick(at(5, 30))).idlePosted, 0);
  assert.equal((await tick(at(6, 1))).idlePosted, 1, "one hour into the new idle epoch");
});

test("after downtime an idle agent gets one catch-up post, not one per missed hour", async ({ app }) => {
  const { server } = await seedServer();
  const agent = await createAgent(server.id, "catchup", { runtime: "codex" });
  const fake = fakeDeps(at(5, 10));
  fake.setPresence(agent.id, "idle", T0.getTime());
  assert.equal((await runProgressAnnouncementTick(fake.deps)).idlePosted, 1);
  assert.equal((await runProgressAnnouncementTick(fake.deps)).idlePosted, 0);
});

test("an idle agent that announced itself within the hour is not given a proxy post, but the hour is consumed", async ({ app }) => {
  const { server, announcement } = await seedServer();
  const agent = await createAgent(server.id, "chatty", { runtime: "codex" });
  const start = new Date();
  const idleSince = start.getTime() - ANNOUNCEMENT_HOUR_MS - 5 * 60_000; // idle for 1h05
  await createMessage(announcement.id, "agent", agent.id, "my own update");
  const fake = fakeDeps(start);
  fake.setPresence(agent.id, "idle", idleSince);
  assert.equal((await runProgressAnnouncementTick(fake.deps)).idlePosted, 0, "its own recent post counts");
  fake.setNow(new Date(start.getTime() + 10 * 60_000));
  assert.equal((await runProgressAnnouncementTick(fake.deps)).idlePosted, 0, "and the hour is not retried later");
});

test("offline agents, unknown presence, an unknown idle start, and disabled servers are skipped", async ({ app }) => {
  const enabled = await seedServer();
  const disabled = await seedServer(false);
  const offline = await createAgent(enabled.server.id, "off", { runtime: "codex" });
  const unknown = await createAgent(enabled.server.id, "unk", { runtime: "codex" });
  const noSince = await createAgent(enabled.server.id, "nosince", { runtime: "codex" });
  const inDisabled = await createAgent(disabled.server.id, "dis", { runtime: "codex" });
  const fake = fakeDeps(at(10));
  fake.setPresence(offline.id, "offline", T0.getTime());
  fake.setPresence(unknown.id, null, null);
  fake.setPresence(noSince.id, "idle", null);
  fake.setPresence(inDisabled.id, "working", T0.getTime());

  const result = await runProgressAnnouncementTick(fake.deps);
  assert.equal(result.nudged, 0);
  assert.equal(result.idlePosted, 0);
  assert.deepEqual(fake.nudges, []);
});

test("two replicas ticking at once nudge and post only once", async ({ app }) => {
  const { server } = await seedServer();
  const worker = await createAgent(server.id, "racer-w", { runtime: "codex" });
  const idle = await createAgent(server.id, "racer-i", { runtime: "codex" });
  const fake = fakeDeps(T0);
  fake.setPresence(worker.id, "working", T0.getTime());
  fake.setPresence(idle.id, "idle", T0.getTime());
  await runProgressAnnouncementTick(fake.deps); // starts tracking
  fake.setNow(at(2, 3));

  await Promise.all([runProgressAnnouncementTick(fake.deps), runProgressAnnouncementTick(fake.deps)]);
  assert.deepEqual(fake.nudges, [worker.id]);
  assert.equal(fake.idlePosts.length, 1);
});

test("the proxy marker and messages are what the UI expects", async ({ app }) => {
  assert.equal(ANNOUNCEMENT_PROXY_KIND, "announcement-proxy");
  assert.equal(buildIdleAnnouncement(new Date("2026-10-01T09:05:00.000Z")), "当前空闲（自 09:05 UTC 起）");
  const notice = buildNudgeNotice();
  assert.match(notice, /#announcement/);
  assert.match(notice, /Doing now/);
  assert.match(notice, /Done/);
  assert.match(notice, /Next/);
  // Sanity: the marker is queryable the way the nudge logic reads it.
  const { server, announcement } = await seedServer();
  const agent = await createAgent(server.id, "marker", { runtime: "codex" });
  await createMessage(announcement.id, "agent", agent.id, "proxy", "chat", undefined, { actionMetadata: { kind: ANNOUNCEMENT_PROXY_KIND } });
  const rows = await getDb().select({ metadata: messages.actionMetadata }).from(messages).where(eq(messages.channelId, announcement.id));
  assert.equal((rows[0]?.metadata as { kind?: string })?.kind, ANNOUNCEMENT_PROXY_KIND);
});

test("the real deps wake a working agent through the orchestrator and post idle lines as the agent with the proxy marker", async ({ app }) => {
  const { server, announcement } = await seedServer();
  const worker = await createAgent(server.id, "real-w", { runtime: "codex" });
  const idle = await createAgent(server.id, "real-i", { runtime: "codex" });
  const delivered: Array<{ agentId: string; content: string; senderId: string }> = [];
  const chain: any = { in() { return chain; }, to() { return chain; }, socketsJoin() {}, emit() {} };
  const orchestrator = {
    getActivity: async (agentId: string) => agentId === worker.id
      ? { presence: "working", presenceSinceMs: T0.getTime() }
      : { presence: "idle", presenceSinceMs: T0.getTime() },
    deliverMessage: async (agentId: string, message: { content: string; sender_id: string }) => {
      delivered.push({ agentId, content: message.content, senderId: message.sender_id });
    },
  } as any;

  let now = T0;
  const deps = createProgressAnnouncementDeps({ io: chain, orchestrator, now: () => now });
  await runProgressAnnouncementTick(deps); // starts tracking
  now = at(1, 3);
  const result = await runProgressAnnouncementTick(deps);
  assert.equal(result.nudged, 1);
  assert.equal(result.idlePosted, 1);

  const nudge = delivered.find((entry) => entry.agentId === worker.id);
  assert.ok(nudge, "the working agent was woken");
  assert.equal(nudge.senderId, "system");
  assert.match(nudge.content, /Announcement reminder/);
  assert.ok(!delivered.some((entry) => entry.agentId === idle.id && /Announcement reminder/.test(entry.content)), "the idle agent is not woken");

  const posted = await getDb().select().from(messages).where(and(eq(messages.channelId, announcement.id), eq(messages.senderId, idle.id)));
  assert.equal(posted.length, 1);
  assert.equal(posted[0]?.senderType, "agent");
  assert.equal(posted[0]?.content, "当前空闲（自 09:00 UTC 起）");
  assert.deepEqual(posted[0]?.actionMetadata, { kind: ANNOUNCEMENT_PROXY_KIND, idleSince: T0.toISOString() });
  // Broadcasts are not pushed to other agents: nobody was delivered the idle line.
  assert.ok(!delivered.some((entry) => entry.content.includes("当前空闲")));
});
