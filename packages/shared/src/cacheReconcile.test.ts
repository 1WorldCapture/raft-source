// Shared cacheReconcile tests (client-data-cache task #8 / P2a).
//
// Exercised against an in-memory ASYNC CacheRepo (Maps + resolved promises —
// the same shape as the shared cacheSync tests and the upcoming IndexedDB
// implementation), proving the reconcile path never leans on synchronous
// reads.
import assert from "node:assert/strict";
import test from "node:test";
import { reconcileAfterChannelRefresh, reconcileChannels } from "./cacheReconcile.js";
import type { CachedChannel, CacheRepo } from "./cacheRepoContract.js";

/** In-memory async repo with just enough channel storage for the reconcile
 * tests: a per-scope channel map and a recorded deleteChannel call log. */
function makeMemoryRepo(initial: CachedChannel[] = []): CacheRepo & { deleted: Array<{ scopeId: number; channelId: string }> } {
  const channels = new Map<number, Map<string, CachedChannel>>();
  const deleted: Array<{ scopeId: number; channelId: string }> = [];
  const repo = {
    getChannels: async (scopeId: number) => [...(channels.get(scopeId)?.values() ?? [])],
    deleteChannel: async (scopeId: number, channelId: string) => {
      deleted.push({ scopeId, channelId });
      channels.get(scopeId)?.delete(channelId);
    },
  } as unknown as CacheRepo;
  if (initial.length > 0) {
    channels.set(1, new Map(initial.map((channel) => [channel.id, channel])));
  }
  return Object.assign(repo, { deleted });
}

function cached(id: string, type = "channel"): CachedChannel {
  return { id, type, lastMessageAt: null, raw: { id } };
}

test("reconcileChannels deletes cached channels missing from the live list", async () => {
  const repo = makeMemoryRepo([cached("c1"), cached("c2"), cached("c3", "private")]);

  const report = await reconcileChannels(repo, 1, [
    { id: "c1" },
    { id: "c3" },
  ]);

  assert.deepEqual(report.removed, ["c2"], "the revoked channel is removed, order preserved");
  assert.deepEqual(
    repo.deleted,
    [{ scopeId: 1, channelId: "c2" }],
    "deleteChannel is awaited for exactly the removed channel",
  );
  assert.deepEqual((await repo.getChannels(1)).map((c) => c.id), ["c1", "c3"]);
});

test("reconcileChannels with the full live list removes nothing", async () => {
  const repo = makeMemoryRepo([cached("c1")]);
  const report = await reconcileChannels(repo, 1, [{ id: "c1" }]);
  assert.deepEqual(report.removed, []);
  assert.deepEqual(repo.deleted, []);
});

test("reconcileChannels also deletes archived channels still present in the list", async () => {
  const repo = makeMemoryRepo([cached("c1"), cached("c9")]);
  // The server still returns c9 — but archived. Requirement: archived goes.
  const report = await reconcileChannels(repo, 1, [
    { id: "c1" },
    { id: "c9", archivedAt: "2026-09-28T00:00:00Z" },
  ]);
  assert.deepEqual(report.removed, ["c9"]);
  assert.deepEqual((await repo.getChannels(1)).map((c) => c.id), ["c1"]);
});

test("reconcileAfterChannelRefresh skips entirely when either list fetch fails", async () => {
  const repo = makeMemoryRepo([cached("c1"), cached("c2")]);

  const failed = await reconcileAfterChannelRefresh(repo, 1, async () => {
    throw new Error("timeout");
  });
  assert.deepEqual(failed, { reconciled: false, removed: [] });
  assert.deepEqual(repo.deleted, [], "a failed refresh must not delete anything");

  const switched = await reconcileAfterChannelRefresh(
    repo, 1,
    async () => ({ channels: [], dms: [] }),
    { stillActive: () => false },
  );
  assert.deepEqual(switched, { reconciled: false, removed: [] }, "scope switch mid-fetch skips too");
  assert.deepEqual(repo.deleted, []);

  const ok = await reconcileAfterChannelRefresh(
    repo, 1,
    async () => ({ channels: [{ id: "c1" }, { id: "c2", archivedAt: "x" }], dms: [] }),
  );
  assert.deepEqual(ok, { reconciled: true, removed: ["c2"] }, "success path reconciles channels + dms");
});
