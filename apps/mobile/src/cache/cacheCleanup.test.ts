import assert from "node:assert/strict";
import test from "node:test";
import { openNodeSqliteDb } from "./portNode.ts";
import { createCacheRepo, type CacheRepo } from "./repo.ts";
import { historyDaysForPlan, pruneToHistoryLimit, reconcileAfterChannelRefresh, reconcileChannels, useOfflineStore } from "./cacheCleanup.ts";

// client-data-cache task #4 — cleanup and offline state against a real
// node:sqlite repo (same discipline as the cache suite).

const SCOPE = { origin: "https://a.example", userId: "user-1", serverId: "srv-1" };

function fixture() {
  const repo = createCacheRepo({ db: openNodeSqliteDb(":memory:") });
  const scopeId = repo.openScope(SCOPE.origin, SCOPE.userId, SCOPE.serverId);
  return { repo: repo as CacheRepo, scopeId };
}

function msg(seq: number, createdAt: string) {
  return { seq, id: `m-${seq}`, raw: { id: `m-${seq}`, seq, createdAt, senderId: "u1", senderType: "user" } };
}

test("reconcileChannels deletes cached channels missing from the live list", async () => {
  const { repo, scopeId } = fixture();
  await repo.putChannels(scopeId, [
    { id: "c1", type: "channel", raw: { id: "c1" } },
    { id: "c2", type: "channel", raw: { id: "c2" } },
    { id: "c3", type: "private", raw: { id: "c3" } },
  ]);
  await repo.appendPage(scopeId, "c2", {
    messages: [msg(1, "2026-09-01T00:00:00Z")],
    window: { coveredFromSeq: 1, coveredThroughSeq: 1, hasGap: false },
  });

  const report = await reconcileChannels(repo, scopeId, [
    { id: "c1" },
    { id: "c3" },
  ]);

  assert.deepEqual(report.removed, ["c2"], "the revoked channel is removed, order preserved");
  assert.deepEqual(
    repo.getChannels(scopeId).map((c) => c.id),
    ["c1", "c3"],
  );
  assert.deepEqual(repo.getLatestMessages(scopeId, "c2", 10), [], "its messages cascade away");
  assert.deepEqual(repo.getCoverage(scopeId, "c2"), [], "its coverage ranges cascade away");
});

test("reconcileChannels with the full live list removes nothing", async () => {
  const { repo, scopeId } = fixture();
  await repo.putChannels(scopeId, [{ id: "c1", type: "channel", raw: { id: "c1" } }]);
  const report = await reconcileChannels(repo, scopeId, [{ id: "c1" }]);
  assert.deepEqual(report.removed, []);
});

test("reconcileChannels also deletes archived channels still present in the list", async () => {
  const { repo, scopeId } = fixture();
  await repo.putChannels(scopeId, [
    { id: "c1", type: "channel", raw: { id: "c1" } },
    { id: "c9", type: "channel", raw: { id: "c9" } },
  ]);
  // The server still returns c9 — but archived. Requirement: archived goes.
  const report = await reconcileChannels(repo, scopeId, [
    { id: "c1" },
    { id: "c9", archivedAt: "2026-09-28T00:00:00Z" },
  ]);
  assert.deepEqual(report.removed, ["c9"]);
  assert.deepEqual(
    repo.getChannels(scopeId).map((c) => c.id),
    ["c1"],
  );
});

test("historyDaysForPlan mirrors the shared limits table", () => {
  assert.equal(historyDaysForPlan("free"), 30);
  assert.equal(historyDaysForPlan("pro"), -1);
  assert.equal(historyDaysForPlan(null), -1, "unknown plans prune nothing (fail open, not silent data loss)");
});

test("pruneToHistoryLimit cuts messages older than the window and no-ops on unlimited", async () => {
  const { repo, scopeId } = fixture();
  await repo.appendPage(scopeId, "c1", {
    messages: [msg(1, "2026-08-01T00:00:00Z"), msg(2, "2026-09-27T00:00:00Z")],
    window: { coveredFromSeq: 1, coveredThroughSeq: 2, hasGap: false },
  });

  const now = new Date("2026-09-28T12:00:00.000Z");
  const outcome = await pruneToHistoryLimit(repo, scopeId, "free", now);
  assert.equal(outcome.pruned, true);
  assert.equal(outcome.cutoffIso, "2026-08-29T12:00:00.000Z");
  assert.deepEqual(
    repo.getLatestMessages(scopeId, "c1", 10).map((m) => m.seq),
    [2],
    "the August message is gone, the fresh one stays",
  );
  assert.deepEqual(repo.getCoverage(scopeId, "c1"), [{ fromSeq: 2, throughSeq: 2 }],
    "pruning rebuilds coverage from the surviving seqs");

  const unlimited = await pruneToHistoryLimit(repo, scopeId, "pro", now);
  assert.deepEqual(unlimited, { pruned: false, cutoffIso: null });
});

test("offline store toggles with a cause and clears it back", () => {
  const store = useOfflineStore.getState();
  store.setOffline(true, "network");
  assert.equal(useOfflineStore.getState().offline, true);
  assert.equal(useOfflineStore.getState().cause, "network");
  useOfflineStore.getState().setOffline(true, "server");
  assert.equal(useOfflineStore.getState().cause, "server");
  useOfflineStore.getState().setOffline(false);
  assert.equal(useOfflineStore.getState().offline, false);
  assert.equal(useOfflineStore.getState().cause, null);
});

test("reconcileAfterChannelRefresh skips entirely when either list fetch fails", async () => {
  const { repo, scopeId } = fixture();
  await repo.putChannels(scopeId, [
    { id: "c1", type: "channel", raw: { id: "c1" } },
    { id: "c2", type: "channel", raw: { id: "c2" } },
  ]);

  const failed = await reconcileAfterChannelRefresh(repo, scopeId, async () => {
    throw new Error("timeout");
  });
  assert.deepEqual(failed, { reconciled: false, removed: [] });
  assert.deepEqual(
    repo.getChannels(scopeId).map((c) => c.id),
    ["c1", "c2"],
    "a failed refresh must not delete anything",
  );

  const switched = await reconcileAfterChannelRefresh(
    repo, scopeId,
    async () => ({ channels: [], dms: [] }),
    { stillActive: () => false },
  );
  assert.deepEqual(switched, { reconciled: false, removed: [] }, "scope switch mid-fetch skips too" );
  assert.deepEqual(repo.getChannels(scopeId).map((c) => c.id), ["c1", "c2"]);

  const ok = await reconcileAfterChannelRefresh(
    repo, scopeId,
    async () => ({ channels: [{ id: "c1" }, { id: "c2", archivedAt: "x" }], dms: [] }),
  );
  assert.deepEqual(ok, { reconciled: true, removed: ["c2"] }, "success path reconciles channels + dms");
});

test("reconcile deletes even right after a concurrent putChannels write", async () => {
  // Regression: the home wiring used to fire putChannels with `void` and
  // then immediately run the reconcile — its deleteChannel db.write opened
  // INSIDE the still-running putChannels transaction ("cannot start a
  // transaction within a transaction") and the delete silently died.
  const { repo, scopeId } = fixture();
  await repo.putChannels(scopeId, [
    { id: "c1", type: "private", raw: { id: "c1" } },
    { id: "c9", type: "channel", raw: { id: "c9" } },
  ]);
  // The exact wiring shape: un-awaited putChannels, then reconcile.
  void repo.putChannels(scopeId, [{ id: "c1", type: "private", raw: { id: "c1" } }]);
  const out = await reconcileAfterChannelRefresh(repo, scopeId, async () => ({
    channels: [{ id: "c1", archivedAt: null }],
    dms: [],
  }));
  assert.deepEqual(out.removed.sort(), ["c9"], "c9 is deleted despite the racing putChannels");
  assert.deepEqual(repo.getChannels(scopeId).map((c) => c.id), ["c1"]);
});
