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
  beginActiveCacheBoot,
  cachedThreadSummaries,
  channelFetchPlan,
  clearActiveWebCache,
  hydrateSeedRows,
  noteActiveCacheSettled,
  recordMessagePage,
  seedChannel,
  setActiveWebCache,
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

test("messageStore: cache already current → loading clears and the auto-read fires (PR #91 review)", async (t) => {
  await freshCache();
  await recordMessagePage("c2", page(Array.from({ length: 50 }, (_, i) => msg(i + 1, "c2"))));
  resetMessageStoreState();

  const posts: Array<{ url: string; body: unknown }> = [];
  t.mock.method(api, "get", async (url: string) => {
    assert.ok(url.includes("after=50"), "the catch-up asks after the cached tail");
    return { data: page([]) }; // already current — zero rows
  });
  t.mock.method(api, "post", async (url: string, body: unknown) => {
    posts.push({ url, body });
    return { data: {} };
  });

  await useMessageStore.getState().loadMessages("c2");

  const state = useMessageStore.getState();
  assert.equal((state.channelMessages["c2"] ?? []).length, 50, "seed painted");
  assert.equal(state.loading, false, "an empty drain must NOT leave the spinner stuck");
  assert.equal(state.hasNewer, false);
  assert.equal(state.hasMore, true, "a full seeded bucket implies older history may exist");
  const readCall = posts.find((call) => call.url === "/channels/c2/read");
  assert.ok(readCall, "the auto-read is queued even when the catch-up pulled nothing");
  assert.deepEqual(readCall!.body, { seq: 50 }, "read position = the cached tail's max seq");
});

test("messageStore: non-empty bucket + empty drain → no stuck loading (PR #91 review)", async (t) => {
  await freshCache();
  await recordMessagePage("c3", page(Array.from({ length: 50 }, (_, i) => msg(i + 1, "c3"))));
  resetMessageStoreState();

  // Round 1: the catch-up hits the drain cap (40 full pages), which is the
  // real-world producer of hasNewer=true on the channel meta — the state a
  // re-open lands on with a non-empty bucket.
  let round = 1;
  t.mock.method(api, "get", async (url: string) => {
    const after = Number(/after=(\d+)/.exec(url)?.[1] ?? 0);
    if (round === 1) {
      return { data: page(Array.from({ length: 50 }, (_, i) => msg(after + i + 1, "c3"))) };
    }
    return { data: page([]) }; // re-open: the cache is current
  });
  t.mock.method(api, "post", async () => ({ data: {} }));

  await useMessageStore.getState().loadMessages("c3");
  assert.equal(useMessageStore.getState().hasNewer, true, "fixture: hitting the drain cap sets hasNewer");
  const bucketAfterCap = (useMessageStore.getState().channelMessages["c3"] ?? []).length;
  assert.ok(bucketAfterCap > 50, "fixture: bucket is non-empty");

  // Round 2: re-open. The bucket is non-empty so the seed guard refuses,
  // the drain pulls zero pages — the unified tail must still clear loading.
  round = 2;
  await useMessageStore.getState().loadMessages("c3");

  const state = useMessageStore.getState();
  assert.equal(state.loading, false, "non-empty bucket + empty drain must not stick on loading");
  assert.equal(state.hasNewer, false, "an empty catch-up means the tail is current");
  assert.equal((state.channelMessages["c3"] ?? []).length, bucketAfterCap);
});

// ---- realtime write-through (desktop-data-cache #11) -------------------------

test("live write-through: addMessage stores the row but never extends coverage (#11)", async () => {
  const scopeId = await freshCache();
  await recordMessagePage("c9", page([msg(10, "c9"), msg(11, "c9")]));
  assert.deepEqual(await activeWebCache()!.repo.getCoverage(scopeId, "c9"), [{ fromSeq: 10, throughSeq: 11 }]);

  useMessageStore.getState().addMessage(msg(12, "c9"), "channel-room");
  await new Promise((r) => setTimeout(r, 10));
  const rows = await activeWebCache()!.repo.getLatestMessages(scopeId, "c9", 10);
  assert.deepEqual(rows.map((row) => row.seq), [12, 11, 10], "the live message is stored newest-first");
  assert.deepEqual(await activeWebCache()!.repo.getCoverage(scopeId, "c9"), [{ fromSeq: 10, throughSeq: 11 }],
    "connected:false — a live message must not extend coverage (gap safety)");
});

test("live write-through: optimistic rows without a server seq never reach the cache (#11)", async () => {
  const scopeId = await freshCache();
  const before = (await activeWebCache()!.repo.getLatestMessages(scopeId, "c9", 10)).length;
  useMessageStore.getState().addMessage({ ...msg(1, "c9"), id: "optimistic-x", seq: undefined }, "channel-room");
  await new Promise((r) => setTimeout(r, 10));
  const after = (await activeWebCache()!.repo.getLatestMessages(scopeId, "c9", 10)).length;
  assert.equal(after, before, "no server seq ⇒ no cache row");
});

test("live write-through: batchAddMessages (sync:resume) lands every row without coverage (#11)", async () => {
  const scopeId = await freshCache();
  const batch = Array.from({ length: 60 }, (_, i) => msg(100 + i, "c10"));
  useMessageStore.getState().batchAddMessages(batch);
  await new Promise((r) => setTimeout(r, 50));
  const rows = await activeWebCache()!.repo.getLatestMessages(scopeId, "c10", 100);
  assert.equal(rows.length, 60, "the full reconnect catch-up batch is cached");
  assert.deepEqual(await activeWebCache()!.repo.getCoverage(scopeId, "c10"), [],
    "a resume stream may skip seqs — it must never create coverage ranges");
});

test("live write-through: updateMessage lands an overlay for dynamic data (#11)", async () => {
  const scopeId = await freshCache();
  useMessageStore.getState().addMessage(msg(5, "c11"), "channel-room");
  await new Promise((r) => setTimeout(r, 10));
  useMessageStore.getState().updateMessage({
    id: "m5",
    channelId: "c11",
    seq: 5,
    reactions: [{ emoji: "👍", count: 2 }],
    updatedAt: "2026-09-29T05:00:00.000Z",
  } as never);
  await new Promise((r) => setTimeout(r, 10));
  const [row] = await activeWebCache()!.repo.getLatestMessages(scopeId, "c11", 10);
  assert.ok(row, "base row present");
  assert.equal((row!.overlay as { reactions?: Array<{ emoji: string }> } | null)?.reactions?.[0]?.emoji, "👍",
    "reaction projection persists in the overlay layer");
});

test("offline seed advances lastSeq so reconnect can sync:resume (#11 review fix)", async (t) => {
  await freshCache();
  await recordMessagePage("c12", page(Array.from({ length: 30 }, (_, i) => msg(500 + i, "c12"))));
  resetMessageStoreState();
  assert.equal(useMessageStore.getState().lastSeq, 0, "fixture: cold start, lastSeq 0");

  // Offline cold start: the catch-up fetch fails (network down) but the seed
  // has already painted — and MUST have armed sync:resume via lastSeq.
  t.mock.method(api, "get", async () => { throw new Error("offline"); });
  await useMessageStore.getState().loadMessages("c12");
  const state = useMessageStore.getState();
  assert.equal((state.channelMessages["c12"] ?? []).length, 30, "seed painted");
  assert.equal(state.lastSeq, 529,
    "seed advances lastSeq to the cached tail's max seq — roomsJoined's `if (lastSeq > 0)` stays armed for sync:resume");
});

test("messageStore: seed still lands when the cache attaches after loadMessages starts", async (t) => {
  clearActiveWebCache();
  noteActiveCacheSettled();
  resetMessageStoreState();
  const repo = createWebCacheRepo();
  const scopeId = await repo.openScope("https://raft.example", "user-1", "srv-1");
  await repo.appendPage(scopeId, "c-late", {
    messages: [1, 2].map((seq) => ({
      seq,
      id: `m${seq}`,
      raw: msg(seq, "c-late") as unknown as Record<string, unknown>,
    })),
  });
  beginActiveCacheBoot();
  let networkCalls = 0;
  t.mock.method(api, "get", async () => {
    networkCalls += 1;
    throw new Error("offline");
  });
  try {
    const pending = useMessageStore.getState().loadMessages("c-late");
    await Promise.resolve();
    assert.equal(networkCalls, 0, "the fetch waits until the boot attach settles");
    assert.equal(useMessageStore.getState().channelMessages["c-late"], undefined);
    setActiveWebCache(repo, scopeId);
    await pending;
    const bucket = useMessageStore.getState().channelMessages["c-late"] ?? [];
    assert.deepEqual(bucket.map((message) => message.seq), [1, 2]);
    assert.equal(useMessageStore.getState().loading, false);
  } finally {
    noteActiveCacheSettled();
    clearActiveWebCache();
    resetMessageStoreState();
  }
});
