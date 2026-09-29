// Shared cacheSync scheduler tests (desktop-data-cache task #6 / P0).
//
// The scheduler is exercised against an in-memory ASYNC CacheRepo (Maps +
// resolved/deferred promises — the same shape an IndexedDB implementation
// will have). This doubles as proof that the async contract in
// cacheRepoContract.ts is implementable without synchronous storage.
import assert from "node:assert/strict";
import test from "node:test";
import { createCacheSync, shouldExtendLiveTail, SYNC_PAGE_LIMIT, type CacheSync, type SyncWireMessage } from "./cacheSync.js";
import type { AppendPage, CacheRepo, OverlayPage, RawRecord, TaskEventInput, ThreadSummaryInput } from "./cacheRepoContract.js";

/** In-memory async repo: Maps keyed by scope; enough storage semantics for
 * the scheduler tests (cursor kv + per-channel appended pages + overlay
 * marker rows with a fixed bootId). */
function makeMemoryRepo(): CacheRepo & { appended: Map<string, AppendPage[]>; overlayMarks: Map<string, string> } {
  const kv = new Map<string, RawRecord>();
  const appended = new Map<string, AppendPage[]>();
  const overlayMarks = new Map<string, string>(); // `${scope}:${channel}:${from}` -> bootId
  const repo: CacheRepo = {
    bootId: "boot-test-1",
    openScope: async () => 1,
    wipeScope: async () => {},
    wipeAll: async () => {},
    getChannels: async () => [],
    putChannels: async () => {},
    deleteChannel: async () => {},
    getCoverage: async () => [],
    getLatestMessages: async () => [],
    appendPage: async (scopeId, channelId, page) => {
      const list = appended.get(`${scopeId}:${channelId}`) ?? [];
      list.push(page);
      appended.set(`${scopeId}:${channelId}`, list);
    },
    appendLiveMessage: async () => {},
    pruneMessages: async () => {},
    applyOverlayPage: async (scopeId, channelId, page) => {
      overlayMarks.set(`${scopeId}:${channelId}:${page.fromSeq}`, repo.bootId);
    },
    getOverlayPageInfo: async (scopeId, channelId, fromSeq) => {
      const bootId = overlayMarks.get(`${scopeId}:${channelId}:${fromSeq}`);
      return bootId ? { throughSeq: 0, refreshedAt: "t", bootId } : null;
    },
    invalidateOverlayPageMarks: async () => {
      overlayMarks.clear();
    },
    applyMessageUpdated: async () => {},
    applyThreadSummary: async () => {},
    getThreadSummaries: async () => ({}),
    applyTaskEvent: async () => {},
    deleteTask: async () => {},
    getTaskRows: async () => [],
    applyReadState: async () => {},
    getReadStates: async () => ({}),
    getInboxPage: async () => null,
    putInboxPage: async () => {},
    getKv: async (scopeId, key) => kv.get(`${scopeId}:${key}`) ?? null,
    putKv: async (scopeId, key, value) => {
      kv.set(`${scopeId}:${key}`, value);
    },
  };
  return Object.assign(repo, { appended, overlayMarks });
}

function msg(seq: number, channelId = "c1"): SyncWireMessage {
  return { seq, id: `m${seq}`, channelId, raw: { seq, id: `m${seq}`, channelId } };
}

test("syncAll pages until a short page and advances the cursor once at the end", async () => {
  const repo = makeMemoryRepo();
  let call = 0;
  const full = Array.from({ length: SYNC_PAGE_LIMIT }, (_, i) => msg(i + 1));
  const sync = createCacheSync({
    repo,
    fetchSyncPage: async () => {
      call += 1;
      return call === 1 ? full : [msg(SYNC_PAGE_LIMIT + 1)]; // short second page
    },
  });
  const out = await sync.syncAll(1);
  assert.equal(out.aborted, false);
  assert.equal(out.pulled, SYNC_PAGE_LIMIT + 1);
  assert.equal(out.cursor, SYNC_PAGE_LIMIT + 1);
  assert.deepEqual(await repo.getKv(1, "syncCursor"), { maxSeq: SYNC_PAGE_LIMIT + 1 });
  assert.equal(repo.appended.get("1:c1")?.length, 2, "one appendPage per batch");
});

test("an aborted round keeps already-appended pages but leaves the cursor untouched", async () => {
  const repo = makeMemoryRepo();
  await repo.putKv(1, "syncCursor", { maxSeq: 40 });
  let call = 0;
  // Batch 1 must be FULL (SYNC_PAGE_LIMIT rows) or the loop stops on the
  // short page and never issues the second fetch where we cancel.
  const full = Array.from({ length: SYNC_PAGE_LIMIT }, (_, i) => msg(41 + i));
  const sync = createCacheSync({
    repo,
    fetchSyncPage: async () => {
      call += 1;
      return call === 1 ? full : [msg(41 + SYNC_PAGE_LIMIT)];
    },
  });
  const out = await sync.syncAll(1, { stillActive: () => call >= 2 ? false : true });
  assert.equal(out.aborted, true);
  assert.equal(out.cursor, 40, "cursor stays at its pre-run value");
  assert.deepEqual(await repo.getKv(1, "syncCursor"), { maxSeq: 40 });
  assert.equal(repo.appended.get("1:c1")?.length, 1, "batch 1 was already committed and stays");
});

test("groups one batch into per-channel appendPage calls", async () => {
  const repo = makeMemoryRepo();
  const sync = createCacheSync({
    repo,
    fetchSyncPage: async () => [msg(1, "c1"), msg(1, "c2"), msg(2, "c1")],
  });
  await sync.syncAll(1);
  assert.deepEqual(repo.appended.get("1:c1")?.[0]?.messages.map((m) => m.seq), [1, 2]);
  assert.deepEqual(repo.appended.get("1:c2")?.[0]?.messages.map((m) => m.seq), [1]);
});

test("readCursor resumes from the stored maxSeq", async () => {
  const repo = makeMemoryRepo();
  await repo.putKv(1, "syncCursor", { maxSeq: 77 });
  const seen: number[] = [];
  const sync = createCacheSync({
    repo,
    fetchSyncPage: async (since) => {
      seen.push(since);
      return [];
    },
  });
  await sync.syncAll(1);
  assert.deepEqual(seen, [77]);
  assert.equal(await sync.readCursor(1), 77);
});

test("refreshOverlayPageOncePerBoot refreshes once per boot, again after invalidation", async () => {
  const repo = makeMemoryRepo();
  let fetches = 0;
  const page: OverlayPage = { fromSeq: 1, throughSeq: 10, messages: [] };
  const sync: CacheSync = createCacheSync({
    repo,
    fetchSyncPage: async () => [],
    fetchOverlayPage: async () => {
      fetches += 1;
      return page;
    },
  });
  const first = await sync.refreshOverlayPageOncePerBoot(1, "c1", 1, 10);
  assert.deepEqual([first.refreshed, first.reason], [true, "done"]);
  const second = await sync.refreshOverlayPageOncePerBoot(1, "c1", 1, 10);
  assert.deepEqual([second.refreshed, second.reason], [false, "already"], "same boot: gated");
  await repo.invalidateOverlayPageMarks(1);
  const third = await sync.refreshOverlayPageOncePerBoot(1, "c1", 1, 10);
  assert.deepEqual([third.refreshed, third.reason], [true, "done"], "after disconnect invalidation: re-pull");
  assert.equal(fetches, 2);
});

test("refreshOverlayPageOncePerBoot without a fetcher reports no-fetcher", async () => {
  const repo = makeMemoryRepo();
  const sync = createCacheSync({ repo, fetchSyncPage: async () => [] });
  assert.deepEqual(await sync.refreshOverlayPageOncePerBoot(1, "c1", 1, 10), { refreshed: false, reason: "no-fetcher" });
});

test("task/thread/read-state write-throughs are forwarded to the repo verbatim", async () => {
  const repo = makeMemoryRepo();
  const seen: string[] = [];
  const patched = new Proxy(repo, {
    get(target, prop, receiver) {
      const value = Reflect.get(target, prop, receiver);
      if (typeof value === "function" && ["applyTaskEvent", "deleteTask", "applyReadState", "applyThreadSummary"].includes(String(prop))) {
        return (...args: unknown[]) => {
          seen.push(String(prop));
          return (value as (...a: unknown[]) => unknown).apply(target, args);
        };
      }
      return value;
    },
  }) as CacheRepo;
  const sync = createCacheSync({ repo: patched, fetchSyncPage: async () => [] });
  const task: TaskEventInput = { id: "t1", revision: 3, raw: {} };
  await sync.onTaskEvent(1, task);
  await sync.onTaskDeleted(1, "t1");
  await sync.onReadState(1, "c1", 9, 2);
  const summary: ThreadSummaryInput = { parentChannelId: "c1", parentMessageId: "m1", raw: {} };
  await sync.onThreadSummary(1, summary);
  assert.deepEqual(seen, ["applyTaskEvent", "deleteTask", "applyReadState", "applyThreadSummary"]);
});

test("shouldExtendLiveTail requires connection AND a completed post-connect sync", () => {
  assert.equal(shouldExtendLiveTail(true, false), false, "connected but sync not finished yet");
  assert.equal(shouldExtendLiveTail(false, true), false, "sync finished but socket since dropped");
  assert.equal(shouldExtendLiveTail(true, true), true);
});
