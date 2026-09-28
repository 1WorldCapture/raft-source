import assert from "node:assert/strict";
import test from "node:test";
import { openNodeSqliteDb } from "./portNode.ts";
import { createCacheRepo, type CacheRepo } from "./repo.ts";
import {
  createCacheSync,
  shouldExtendLiveTail,
  SYNC_PAGE_LIMIT,
  type SyncWireMessage,
} from "./cacheSync.ts";

// client-data-cache task #3 — the sync scheduler against a REAL node:sqlite
// repo (same no-mock discipline as repo.test.ts). Network is faked at the
// fetcher boundary only.

const SCOPE = { origin: "https://a.example", userId: "user-1", serverId: "srv-1" };

function msg(seq: number, extra: Record<string, unknown> = {}) {
  return {
    seq,
    id: `m-${seq}`,
    raw: { id: `m-${seq}`, seq, senderId: "u1", senderType: "user", createdAt: "2026-09-01T00:00:00Z", ...extra },
  };
}

function wire(seq: number, channelId: string): SyncWireMessage {
  return { ...msg(seq), channelId };
}

function makeSync(pages: Array<readonly SyncWireMessage[] | Error>) {
  const repo = createCacheRepo({ db: openNodeSqliteDb(":memory:") });
  const scopeId = repo.openScope(SCOPE.origin, SCOPE.userId, SCOPE.serverId);
  let call = 0;
  const calls: Array<{ sinceSeq: number; limit: number }>[] = [];
  const sync = createCacheSync({
    repo,
    fetchSyncPage: async (sinceSeq, limit) => {
      calls.push({ sinceSeq, limit });
      const page = pages[call];
      call += 1;
      if (page instanceof Error) throw page;
      if (page === undefined) return [];
      return page;
    },
  });
  return { repo: repo as CacheRepo, scopeId, sync, calls };
}

test("syncAll loops pages until a short page and advances the cursor once", async () => {
  // Two full pages + a short tail across two channels; interleaved seqs make
  // the per-channel span contain holes from the OTHER channel — the channel
  // coverage range must still cover its own messages.
  const full = (offset: number): SyncWireMessage[] =>
    Array.from({ length: SYNC_PAGE_LIMIT }, (_, i) => wire(offset + i + 1, (offset + i) % 2 === 0 ? "c1" : "c2"));
  const { repo, scopeId, sync, calls } = makeSync([full(0), full(SYNC_PAGE_LIMIT), [wire(3000, "c1")]]);

  const outcome = await sync.syncAll(scopeId);

  assert.equal(outcome.pulled, SYNC_PAGE_LIMIT * 2 + 1);
  assert.equal(outcome.cursor, 3000);
  // Loop shape: three fetches, each sinceSeq = previous batch max.
  assert.deepEqual(calls.map((c) => c.sinceSeq), [0, SYNC_PAGE_LIMIT, SYNC_PAGE_LIMIT * 2]);
  assert.equal(calls.every((c) => c.limit === SYNC_PAGE_LIMIT), true);
  // Per-channel coverage spans exist and contain the channel's own messages.
  const c1 = repo.getLatestMessages(scopeId, "c1", 10_000);
  const c2 = repo.getLatestMessages(scopeId, "c2", 10_000);
  assert.ok(c1.length >= 500 && c2.length >= 500, `both channels persisted (c1=${c1.length}, c2=${c2.length})`);
  // Cursor persists in kv for the next cold boot.
  assert.equal(sync.readCursor(scopeId), 3000);
});

test("syncAll with an empty first page keeps the cursor at zero", async () => {
  const { scopeId, sync } = makeSync([[]]);
  const outcome = await sync.syncAll(scopeId);
  assert.deepEqual(outcome, { pulled: 0, cursor: 0, aborted: false });
});

test("a mid-loop failure leaves the cursor untouched and a retry re-pulls the overlap", async () => {
  const boom = new Error("network down");
  const repo = createCacheRepo({ db: openNodeSqliteDb(":memory:") });
  const scopeId = repo.openScope(SCOPE.origin, SCOPE.userId, SCOPE.serverId);
  const fullPage = Array.from({ length: SYNC_PAGE_LIMIT }, (_, i) => wire(i + 1, "c1"));
  let callCount = 0;
  let failSecondCall = true;
  const fetcher = async () => {
    callCount += 1;
    if (callCount === 2 && failSecondCall) throw boom;
    return callCount === 1 ? fullPage : [wire(900, "c1")];
  };
  const sync = createCacheSync({ repo, fetchSyncPage: fetcher });

  // Round 1: page 1 succeeds, page 2 throws.
  await assert.rejects(() => sync.syncAll(scopeId), /network down/);
  // Cursor NOT advanced: the failed round stored its page but the gap
  // accounting must re-pull from the old cursor next time.
  assert.equal(sync.readCursor(scopeId), 0);
  assert.ok(repo.getLatestMessages(scopeId, "c1", 10).length > 0, "already-pulled page stays stored (idempotent upserts)");

  // Round 2: network repaired — the overlap page is re-pulled, cursor lands on the tail.
  failSecondCall = false;
  callCount = 0;
  const outcome = await sync.syncAll(scopeId);
  assert.ok(outcome.pulled >= SYNC_PAGE_LIMIT, "retry re-pulled the overlap");
  assert.equal(outcome.cursor, 900);
});

test("live write-through extends the tail only when continuity allows it", async () => {
  // One full page so the loop shape is simple: covered [1..500] after sync.
  const fullPage = Array.from({ length: SYNC_PAGE_LIMIT }, (_, i) => wire(i + 1, "c1"));
  const { repo, scopeId, sync } = makeSync([fullPage]);
  await sync.syncAll(scopeId);
  assert.deepEqual(repo.getCoverage(scopeId, "c1"), [{ fromSeq: 1, throughSeq: SYNC_PAGE_LIMIT }]);

  // connected tail extension: seq 501 directly follows the covered tail.
  await sync.onLiveMessage(scopeId, "c1", msg(SYNC_PAGE_LIMIT + 1), shouldExtendLiveTail(true, true));
  assert.deepEqual(
    repo.getCoverage(scopeId, "c1"),
    [{ fromSeq: 1, throughSeq: SYNC_PAGE_LIMIT + 1 }],
    "connected live message extends the covered range",
  );

  // disconnected message is stored but never bridges a gap.
  await sync.onLiveMessage(scopeId, "c1", msg(SYNC_PAGE_LIMIT + 9), shouldExtendLiveTail(false, false));
  assert.deepEqual(
    repo.getCoverage(scopeId, "c1"),
    [{ fromSeq: 1, throughSeq: SYNC_PAGE_LIMIT + 1 }],
    "gap stays open for the next sync",
  );
  assert.ok(
    repo.getLatestMessages(scopeId, "c1", 1).some((m) => m.seq === SYNC_PAGE_LIMIT + 9),
    "the disconnected message itself is still stored",
  );
});

test("overlay refresh is gated to once per boot per page", async () => {
  const { repo, scopeId, sync } = makeSync([[wire(1, "c1")]]);
  await sync.syncAll(scopeId);

  let fetches = 0;
  const gated = createCacheSync({
    repo,
    fetchSyncPage: async () => [],
    fetchOverlayPage: async (_channelId, fromSeq) => {
      fetches += 1;
      return {
        fromSeq,
        throughSeq: fromSeq + 49,
        messages: [{ seq: fromSeq, id: `m-${fromSeq}`, raw: { reactions: { "👍": 2 } } }],
      };
    },
  });

  const first = await gated.refreshOverlayPageOncePerBoot(scopeId, "c1", 1, 50);
  assert.equal(first.refreshed, true);
  assert.equal(first.reason, "done");
  assert.ok(first.page, "the fetched page is returned so callers can upsert it into the store");
  const second = await gated.refreshOverlayPageOncePerBoot(scopeId, "c1", 1, 50);
  assert.deepEqual(second, { refreshed: false, reason: "already" }, "same boot, same page: skipped");
  assert.equal(fetches, 1);

  // A different page fromSeq is a different gate.
  const other = await gated.refreshOverlayPageOncePerBoot(scopeId, "c1", 51, 100);
  assert.equal(other.refreshed, true);
  assert.equal(other.reason, "done");
  assert.equal(fetches, 2);

  // Overlay data is readable through the repo's message projection.
  const refreshed = repo.getLatestMessages(scopeId, "c1", 1)[0];
  assert.deepEqual(refreshed?.overlay, { reactions: { "👍": 2 } });
});

test("appendHistoryPage stores a before-cursor page and grows coverage via its window", async () => {
  const { repo, scopeId, sync } = makeSync([[wire(50, "c1")]]); // covered [50,50]
  await sync.syncAll(scopeId);

  await sync.appendHistoryPage(scopeId, "c1", {
    messages: [msg(30), msg(31), msg(49)],
    // Server window says 30..49 is contiguous for this channel.
    window: { coveredFromSeq: 30, coveredThroughSeq: 49, hasGap: false },
  });

  assert.deepEqual(
    repo.getCoverage(scopeId, "c1"),
    [{ fromSeq: 30, throughSeq: 50 }],
    "history page fuses with the adjacent tail into one covered range",
  );
});

test("read-state and task write-through gates live in the repo and pass through", async () => {
  const { repo, scopeId, sync } = makeSync([]);
  await sync.onReadState(scopeId, "c1", 12, 1);
  await sync.onReadState(scopeId, "c1", 8, 2); // older maxReadSeq, newer version: version gate stores it as-is
  assert.deepEqual(repo.getReadStates(scopeId).c1, { maxReadSeq: 8, version: 2 });

  await sync.onTaskEvent(scopeId, { id: "t1", revision: 2, raw: { id: "t1", title: "v2" } });
  await sync.onTaskEvent(scopeId, { id: "t1", revision: 1, raw: { id: "t1", title: "stale" } });
  const rows = repo.getTaskRows(scopeId);
  assert.equal(rows.length, 1);
  assert.equal((rows[0]!.raw as { title?: string }).title, "v2", "revision gate drops the stale event");

  await sync.onTaskDeleted(scopeId, "t1");
  assert.equal(repo.getTaskRows(scopeId).length, 0);
});

// ---- review fixes: race guards, cancellation, single-flight ------------------

test("syncAll aborts before the next batch write when stillActive turns false", async () => {
  const { repo, scopeId, sync } = makeSync([
    Array.from({ length: SYNC_PAGE_LIMIT }, (_, i) => wire(i + 1, "c1")),
    [wire(900, "c1")],
  ]);
  let batches = 0;
  const outcome = await sync.syncAll(scopeId, {
    stillActive: () => (batches += 1) === 1, // active for batch 1 only
  });
  assert.equal(outcome.aborted, true, "loop reports the abort");
  assert.equal(sync.readCursor(scopeId), 0, "cursor stays at its pre-run value");
  assert.ok(
    !repo.getLatestMessages(scopeId, "c1", 1).some((m) => m.seq === 900),
    "the second batch never landed",
  );
});

test("read-state write-through stores the server-provided maxReadSeq and version", async () => {
  const { repo, scopeId, sync } = makeSync([]);
  await sync.onReadState(scopeId, "c1", 42, 7);
  assert.deepEqual(repo.getReadStates(scopeId).c1, { maxReadSeq: 42, version: 7 });
  // Older version does not overwrite.
  await sync.onReadState(scopeId, "c1", 99, 3);
  assert.deepEqual(repo.getReadStates(scopeId).c1, { maxReadSeq: 42, version: 7 });
});
