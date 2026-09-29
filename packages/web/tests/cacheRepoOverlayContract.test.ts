// desktop-data-cache task #8: one overlay-gate contract, run against both
// web CacheRepo implementations (IndexedDB and the in-memory fallback) so
// they cannot drift apart again.
import "fake-indexeddb/auto";
import { IDBFactory } from "fake-indexeddb";
import { openDB } from "idb";
import assert from "node:assert/strict";
import test from "node:test";
import type { CacheRepo } from "@botiverse/raft-shared/src/cacheRepoContract.js";
import { createIdbCacheRepo, createStores, WEB_CACHE_DB_NAME } from "../src/cache/idbRepo";
import { createWebCacheRepo } from "../src/cache/webCacheRepo";

type Globals = { indexedDB?: IDBFactory };

// The local clock runs far ahead of every server updatedAt below: a repo that
// stored its local write time as the watermark rejects all later ties.
const LOCAL_NOW = () => "2099-01-01T00:00:00.000Z";
const T1 = "2026-09-29T00:00:01.000Z";
const T2 = "2026-09-29T00:00:02.000Z";

const IMPLEMENTATIONS: Array<{ name: string; make: () => Promise<CacheRepo> }> = [
  {
    name: "IndexedDB repo",
    make: async () => {
      (globalThis as Globals).indexedDB = new IDBFactory();
      return createIdbCacheRepo({ now: LOCAL_NOW });
    },
  },
  { name: "in-memory repo", make: async () => createWebCacheRepo({ now: LOCAL_NOW }) },
];

async function setup(make: () => Promise<CacheRepo>) {
  const repo = await make();
  const scopeId = await repo.openScope("https://raft.example", "user-1", "srv-1");
  await repo.appendPage(scopeId, "c1", { messages: [{ seq: 10, id: "m10", raw: { id: "m10", seq: 10 } }] });
  const reactions = async () => (
    (await repo.getLatestMessages(scopeId, "c1", 1))[0]?.overlay as { reactions?: Array<{ emoji: string }> } | null
  )?.reactions?.[0]?.emoji;
  return { repo, scopeId, reactions };
}

for (const impl of IMPLEMENTATIONS) {
  test(`${impl.name}: a reaction change with an unchanged updatedAt replaces the overlay`, async () => {
    const { repo, scopeId, reactions } = await setup(impl.make);
    await repo.applyMessageUpdated(scopeId, "c1", { seq: 10, raw: { reactions: [{ emoji: "👀" }] }, updatedAt: T1 });
    await repo.applyMessageUpdated(scopeId, "c1", { seq: 10, raw: { reactions: [{ emoji: "🎉" }] }, updatedAt: T1 });
    assert.equal(await reactions(), "🎉", "live update with the same updatedAt");
    await repo.applyOverlayPage(scopeId, "c1", {
      fromSeq: 10,
      throughSeq: 10,
      messages: [{ seq: 10, raw: { reactions: [{ emoji: "🔥" }] }, updatedAt: T1 }],
    });
    assert.equal(await reactions(), "🔥", "refreshed page with the same updatedAt");
  });

  test(`${impl.name}: an older updatedAt loses, for live updates and pages alike`, async () => {
    const { repo, scopeId, reactions } = await setup(impl.make);
    await repo.applyMessageUpdated(scopeId, "c1", { seq: 10, raw: { reactions: [{ emoji: "✏️" }] }, updatedAt: T2 });
    await repo.applyMessageUpdated(scopeId, "c1", { seq: 10, raw: { reactions: [{ emoji: "👀" }] }, updatedAt: T1 });
    await repo.applyOverlayPage(scopeId, "c1", {
      fromSeq: 10,
      throughSeq: 10,
      messages: [{ seq: 10, raw: { reactions: [{ emoji: "👀" }] }, updatedAt: T1 }],
    });
    assert.equal(await reactions(), "✏️");
  });

  test(`${impl.name}: a write without updatedAt is accepted and keeps the server watermark`, async () => {
    const { repo, scopeId, reactions } = await setup(impl.make);
    await repo.applyMessageUpdated(scopeId, "c1", { seq: 10, raw: { reactions: [{ emoji: "👀" }] }, updatedAt: T2 });
    await repo.applyMessageUpdated(scopeId, "c1", { seq: 10, raw: { reactions: [{ emoji: "✅" }] }, updatedAt: null });
    assert.equal(await reactions(), "✅", "accepted");
    await repo.applyMessageUpdated(scopeId, "c1", { seq: 10, raw: { reactions: [{ emoji: "👀" }] }, updatedAt: T1 });
    assert.equal(await reactions(), "✅", "the T2 watermark survived, so an older T1 write still loses");
    await repo.applyMessageUpdated(scopeId, "c1", { seq: 10, raw: { reactions: [{ emoji: "🎉" }] }, updatedAt: T2 });
    assert.equal(await reactions(), "🎉", "a tie with the kept watermark wins");
  });
}

test("IndexedDB v1 -> v2 upgrade clears only overlays and their marks", async () => {
  (globalThis as Globals).indexedDB = new IDBFactory();
  const v1 = await openDB(WEB_CACHE_DB_NAME, 1, { upgrade: (db) => createStores(db) });
  const scopeId = await v1.add("scopes", { origin: "https://raft.example", userId: "user-1", serverId: "srv-1" });
  await v1.put("messages", { scopeId, channelId: "c1", seq: 10, messageId: "m10", raw: { id: "m10", seq: 10 } });
  await v1.put("channel_ranges", { scopeId, channelId: "c1", fromSeq: 10, throughSeq: 10 });
  await v1.put("message_overlays", { scopeId, channelId: "c1", seq: 10, raw: { reactions: [{ emoji: "👀" }] }, updatedAt: "2099-01-01T00:00:00.000Z" });
  await v1.put("overlay_pages", { scopeId, channelId: "c1", fromSeq: 10, throughSeq: 10, refreshedAt: "x", bootId: "old" });
  v1.close();

  const repo = await createIdbCacheRepo({ now: LOCAL_NOW });
  const reopened = await repo.openScope("https://raft.example", "user-1", "srv-1");
  assert.equal(reopened, scopeId, "the scope survives the upgrade");
  const rows = await repo.getLatestMessages(reopened, "c1", 10);
  assert.equal(rows.length, 1, "messages survive");
  assert.equal(rows[0]!.overlay, null, "v1 overlays (local-time watermarks) are dropped");
  assert.equal(await repo.getOverlayPageInfo(reopened, "c1", 10), null, "their marks too");
  assert.deepEqual(await repo.getCoverage(reopened, "c1"), [{ fromSeq: 10, throughSeq: 10 }], "coverage survives");
});
