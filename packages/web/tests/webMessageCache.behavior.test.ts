// Web message-cache bridge behavior tests (desktop-data-cache task #9).
//
// Layer 1: the in-memory CacheRepo stopgap against the shared contract
// semantics (coverage growth, live-tail gate, version/revision gates,
// once-per-boot overlay bookkeeping).
// Layer 2: the bridge translation (record → seed → fetch plan).
// Layer 3: messageStore wiring — cold-start seed paints before the network
// answers, the catch-up drains after=tail to the newest page, older/newer
// pagination grows coverage, and a network failure leaves the seed on screen.
import assert from "node:assert/strict";
import test from "node:test";
import api from "../src/api/client";
import type { Message } from "../src/store/messageStore";
import { useMessageStore } from "../src/store/messageStore";
import {
  activeWebCache,
  attachMemoryWebCache,
  cachedThreadSummaries,
  channelFetchPlan,
  clearActiveWebCache,
  hydrateSeedRows,
  recordMessagePage,
  seedChannel,
} from "../src/cache/messageCache";
import { createWebCacheRepo } from "../src/cache/webCacheRepo";

function msg(seq: number, channelId = "c1"): Message & { seq: number } {
  return {
    id: `m${seq}`,
    seq,
    channelId,
    senderType: "user",
    senderId: "user-1",
    senderName: "Tester",
    content: `message ${seq}`,
    createdAt: `2026-09-29T00:00:${String(seq % 60).padStart(2, "0")}.000Z`,
  } as Message & { seq: number };
}

function page(messages: Message[], extra: Record<string, unknown> = {}) {
  return { messages, threadSummariesByParentMessageId: {}, ...extra };
}

function resetMessageStoreState() {
  useMessageStore.setState({
    channelMessages: {},
    channelWindowMeta: {},
    messages: [],
    loading: false,
    loadingOlder: false,
    loadingNewer: false,
    hasMore: true,
    hasNewer: false,
    hasGap: false,
    historyLimited: false,
    lastSeq: 0,
    currentChannelId: null,
  });
}

async function freshCache() {
  clearActiveWebCache();
  return attachMemoryWebCache("https://raft.example", "user-1", "srv-1");
}

test("memory repo: appendPage builds and merges coverage; latest reads newest-first", async () => {
  const repo = createWebCacheRepo();
  const scopeId = await repo.openScope("https://a.example", "u1", "s1");
  await repo.appendPage(scopeId, "c1", {
    messages: [{ seq: 1, id: "m1", raw: {} }, { seq: 2, id: "m2", raw: {} }],
  });
  await repo.appendPage(scopeId, "c1", {
    messages: [{ seq: 3, id: "m3", raw: {} }],
  });
  assert.deepEqual(await repo.getCoverage(scopeId, "c1"), [{ fromSeq: 1, throughSeq: 3 }]);
  const latest = await repo.getLatestMessages(scopeId, "c1", 10);
  assert.deepEqual(latest.map((row) => row.seq), [3, 2, 1], "newest-first like the mobile repo");
});

test("memory repo: a live message extends the tail only when directly following it while connected", async () => {
  const repo = createWebCacheRepo();
  const scopeId = await repo.openScope("https://a.example", "u1", "s1");
  await repo.appendPage(scopeId, "c1", { messages: [{ seq: 5, id: "m5", raw: {} }] });
  await repo.appendLiveMessage(scopeId, "c1", { seq: 7, id: "m7", raw: {} }, { connected: true });
  assert.deepEqual(await repo.getCoverage(scopeId, "c1"), [{ fromSeq: 5, throughSeq: 5 }],
    "a gap stays open — 7 is stored but does not create coverage");
  await repo.appendLiveMessage(scopeId, "c1", { seq: 6, id: "m6", raw: {} }, { connected: true });
  assert.deepEqual(await repo.getCoverage(scopeId, "c1"), [{ fromSeq: 5, throughSeq: 6 }],
    "6 bridges onto the tail; the earlier out-of-order 7 stays stored outside coverage until the next sync fills it");
  await repo.appendLiveMessage(scopeId, "c1", { seq: 9, id: "m9", raw: {} }, { connected: false });
  assert.deepEqual(await repo.getCoverage(scopeId, "c1"), [{ fromSeq: 5, throughSeq: 6 }],
    "disconnected messages never extend coverage");
});

test("memory repo: read state and task rows are version/revision gated", async () => {
  const repo = createWebCacheRepo();
  const scopeId = await repo.openScope("https://a.example", "u1", "s1");
  await repo.applyReadState(scopeId, "c1", 10, 4);
  await repo.applyReadState(scopeId, "c1", 5, 3); // stale version
  await repo.applyReadState(scopeId, "c1", 20, 6);
  assert.deepEqual((await repo.getReadStates(scopeId)).c1, { maxReadSeq: 20, version: 6 });
  await repo.applyTaskEvent(scopeId, { id: "t1", revision: 2, raw: { status: "done" } });
  await repo.applyTaskEvent(scopeId, { id: "t1", revision: 1, raw: { status: "todo" } }); // stale revision
  assert.deepEqual((await repo.getTaskRows(scopeId)).map((row) => row.revision), [2]);
});

test("memory repo: overlay page bookkeeping is boot-gated and invalidation reopens it", async () => {
  const repoA = createWebCacheRepo();
  const scopeId = await repoA.openScope("https://a.example", "u1", "s1");
  await repoA.applyOverlayPage(scopeId, "c1", { fromSeq: 1, throughSeq: 5, messages: [] });
  const info = await repoA.getOverlayPageInfo(scopeId, "c1", 1);
  assert.equal(info?.bootId, repoA.bootId, "stamped with the repo's boot id");
  await repoA.invalidateOverlayPageMarks(scopeId);
  assert.equal(await repoA.getOverlayPageInfo(scopeId, "c1", 1), null, "invalidation drops markers only");
});

test("bridge: recordMessagePage stores rows + bundled summaries; seedChannel reads them back", async () => {
  await freshCache();
  await recordMessagePage("c1", page([msg(1), msg(2), msg(3)], {
    threadSummariesByParentMessageId: {
      m1: { threadChannelId: "t1", replyCount: 2 },
    },
  }));
  const seed = await seedChannel("c1", 50);
  assert.ok(seed);
  assert.deepEqual(seed.rows.map((row) => row.seq), [3, 2, 1]);
  assert.deepEqual(seed.coverage, [{ fromSeq: 1, throughSeq: 3 }]);
  assert.deepEqual(await channelFetchPlan("c1"), { after: 3 });
  assert.deepEqual(await cachedThreadSummaries("c1"), {
    m1: { threadChannelId: "t1", replyCount: 2 },
  });
  const hydrated = hydrateSeedRows(seed.rows, (value) => value as unknown as Message);
  assert.deepEqual(hydrated.map((message) => message.seq), [3, 2, 1]);
});

test("bridge: without an attached cache everything degrades to null/empty", async () => {
  clearActiveWebCache();
  assert.equal(activeWebCache(), null);
  assert.equal(await seedChannel("c1", 50), null);
  assert.equal(await channelFetchPlan("c1"), null);
  assert.deepEqual(await cachedThreadSummaries("c1"), {});
  await recordMessagePage("c1", page([msg(1)])); // must not throw
});

test("messageStore: cold start seeds from the cache and drains after=tail to the newest page", async (t) => {
  const scopeId = await freshCache();
  // A previous session cached seq 1..50.
  await recordMessagePage("c1", page(Array.from({ length: 50 }, (_, i) => msg(i + 1))));
  resetMessageStoreState();

  const calls: string[] = [];
  const full = Array.from({ length: 50 }, (_, i) => msg(51 + i));
  const tail = [msg(101), msg(102), msg(103)];
  t.mock.method(api, "get", async (url: string) => {
    calls.push(url);
    if (url.includes("after=50")) {
      return { data: page(full, { messageWindow: { coveredFromSeq: 51, coveredThroughSeq: 100, hasGap: false } }) };
    }
    if (url.includes("after=100")) {
      return { data: page(tail, { messageWindow: { coveredFromSeq: 101, coveredThroughSeq: 103, hasGap: false } }) };
    }
    return { data: page([]) };
  });

  await useMessageStore.getState().loadMessages("c1");

  assert.deepEqual(calls, [
    `/messages/channel/c1?limit=50&after=50`,
    `/messages/channel/c1?limit=50&after=100`,
  ], "catch-up continues from the cached tail, never re-pulls the latest window");
  const bucket = useMessageStore.getState().channelMessages["c1"] ?? [];
  assert.equal(bucket.length, 103, "seed (1..50) + drained pages (51..103) all present");
  assert.equal(bucket[0]!.seq, 1);
  assert.equal(bucket[102]!.seq, 103);
  assert.equal(useMessageStore.getState().loading, false);
  assert.equal(useMessageStore.getState().hasNewer, false, "a short drain page means the tail is current");
  assert.deepEqual(await activeWebCache()!.repo.getCoverage(scopeId, "c1"), [{ fromSeq: 1, throughSeq: 103 }],
    "drained pages grew the coverage contiguously");
  assert.deepEqual(await cachedThreadSummaries("c1"), {});
});

test("messageStore: without cached coverage the plain latest path runs and is recorded", async (t) => {
  await freshCache();
  resetMessageStoreState();

  const calls: string[] = [];
  const fresh = Array.from({ length: 30 }, (_, i) => msg(200 + i));
  t.mock.method(api, "get", async (url: string) => {
    calls.push(url);
    return { data: page(fresh, { messageWindow: { coveredFromSeq: 200, coveredThroughSeq: 229, hasGap: false } }) };
  });

  await useMessageStore.getState().loadMessages("c1");

  assert.deepEqual(calls, [`/messages/channel/c1?limit=50`], "no coverage → original latest request");
  const bucket = useMessageStore.getState().channelMessages["c1"] ?? [];
  assert.equal(bucket.length, 30);
  assert.deepEqual(await channelFetchPlan("c1"), { after: 229 }, "the fetched page is now cached");
});

test("messageStore: loadOlderMessages grows coverage downward", async (t) => {
  const scopeId = await freshCache();
  await recordMessagePage("c1", page(Array.from({ length: 50 }, (_, i) => msg(200 + i))));
  resetMessageStoreState();
  useMessageStore.setState({
    channelMessages: { c1: Array.from({ length: 50 }, (_, i) => msg(200 + i)) },
    currentChannelId: "c1",
    messages: Array.from({ length: 50 }, (_, i) => msg(200 + i)),
  });

  const older = Array.from({ length: 50 }, (_, i) => msg(150 + i));
  t.mock.method(api, "get", async () => ({
    data: page(older, { messageWindow: { coveredFromSeq: 150, coveredThroughSeq: 199, hasGap: false } }),
  }));

  await useMessageStore.getState().loadOlderMessages("c1");
  assert.deepEqual(await activeWebCache()!.repo.getCoverage(scopeId, "c1"), [{ fromSeq: 150, throughSeq: 249 }]);
});

test("messageStore: a network failure keeps the seeded pane readable", async (t) => {
  await freshCache();
  await recordMessagePage("c1", page(Array.from({ length: 50 }, (_, i) => msg(i + 1))));
  resetMessageStoreState();

  t.mock.method(api, "get", async () => {
    throw new Error("offline");
  });

  await useMessageStore.getState().loadMessages("c1");

  const bucket = useMessageStore.getState().channelMessages["c1"] ?? [];
  assert.equal(bucket.length, 50, "the cold-start seed stays painted");
  assert.equal(useMessageStore.getState().loading, false);
});
