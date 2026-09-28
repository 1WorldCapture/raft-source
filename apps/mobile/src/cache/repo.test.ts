import assert from "node:assert/strict";
import test from "node:test";
import { openNodeSqliteDb } from "./portNode.ts";
import { createCacheRepo, type CacheRepo } from "./repo.ts";

/**
 * Deterministic clock: tests control time explicitly so updatedAt gates and
 * prune cutoffs never depend on the wall clock.
 */
function makeFixture() {
  let clock = 0;
  const iso = () => new Date(clock).toISOString();
  const repo = createCacheRepo({
    db: openNodeSqliteDb(":memory:"),
    now: iso,
  });
  const advance = (ms: number) => {
    clock += ms;
  };
  const setClock = (ms: number) => {
    clock = ms;
  };
  return { repo: repo as CacheRepo, advance, setClock, iso };
}

const SCOPE_A = { origin: "https://a.example", userId: "user-1", serverId: "srv-1" };
const SCOPE_B = { origin: "https://a.example", userId: "user-1", serverId: "srv-2" };

function msg(seq: number, extra: Record<string, unknown> = {}) {
  return {
    seq,
    id: `m-${seq}`,
    raw: { id: `m-${seq}`, seq, senderId: "u1", senderType: "user", createdAt: "2026-09-01T00:00:00Z", ...extra },
  };
}

test("openScope is idempotent and scopes are isolated", async () => {
  const { repo } = makeFixture();
  const a1 = repo.openScope(SCOPE_A.origin, SCOPE_A.userId, SCOPE_A.serverId);
  const a2 = repo.openScope(SCOPE_A.origin, SCOPE_A.userId, SCOPE_A.serverId);
  assert.equal(a1, a2);
  const b = repo.openScope(SCOPE_B.origin, SCOPE_B.userId, SCOPE_B.serverId);
  assert.notEqual(a1, b);

  await repo.putChannels(a1, [{ id: "c1", type: "channel", raw: { id: "c1", name: "one" } }]);
  await repo.putChannels(b, [{ id: "c2", type: "channel", raw: { id: "c2", name: "two" } }]);
  assert.deepEqual(
    repo.getChannels(a1).map((c) => c.id),
    ["c1"],
  );
  assert.deepEqual(
    repo.getChannels(b).map((c) => c.id),
    ["c2"],
  );
});

test("putChannels dropMissing is scoped to the batch's type set", async () => {
  const { repo } = makeFixture();
  const scope = repo.openScope(SCOPE_A.origin, SCOPE_A.userId, SCOPE_A.serverId);
  await repo.putChannels(scope, [
    { id: "c1", type: "channel", raw: { id: "c1" } },
    { id: "c2", type: "channel", raw: { id: "c2" } },
    { id: "dm1", type: "dm", raw: { id: "dm1" } },
  ]);
  // Refresh of the joined-channel list without c2: c2 goes, dm1 stays.
  await repo.putChannels(scope, [{ id: "c1", type: "channel", raw: { id: "c1", name: "renamed" } }]);
  const channels = repo.getChannels(scope);
  assert.deepEqual(
    channels.map((c) => c.id).sort(),
    ["c1", "dm1"],
  );
  assert.equal(channels.find((c) => c.id === "c1")?.raw.name, "renamed");
});

test("appendPage stores messages and coverage; gaps never get covered", async () => {
  const { repo } = makeFixture();
  const scope = repo.openScope(SCOPE_A.origin, SCOPE_A.userId, SCOPE_A.serverId);
  await repo.appendPage(scope, "c1", { messages: [msg(10), msg(11), msg(12)] });
  await repo.appendPage(scope, "c1", { messages: [msg(30), msg(31)] });
  assert.deepEqual(repo.getCoverage(scope, "c1"), [
    { fromSeq: 10, throughSeq: 12 },
    { fromSeq: 30, throughSeq: 31 },
  ]);
  // A page bridging the gap fuses it.
  await repo.appendPage(scope, "c1", { messages: [msg(13), msg(14), msg(29)] });
  assert.deepEqual(repo.getCoverage(scope, "c1"), [{ fromSeq: 10, throughSeq: 31 }]);
  // Idempotent re-append.
  await repo.appendPage(scope, "c1", { messages: [msg(30), msg(31)] });
  assert.deepEqual(repo.getCoverage(scope, "c1"), [{ fromSeq: 10, throughSeq: 31 }]);
  const latest = repo.getLatestMessages(scope, "c1", 2);
  assert.deepEqual(latest.map((m) => m.seq), [31, 30]);
});

test("live messages extend the tail only while connected (review note #1)", async () => {
  const { repo } = makeFixture();
  const scope = repo.openScope(SCOPE_A.origin, SCOPE_A.userId, SCOPE_A.serverId);
  await repo.appendPage(scope, "c1", { messages: [msg(10), msg(11)] });

  // Connected tail extension.
  await repo.appendLiveMessage(scope, "c1", msg(12), { connected: true });
  assert.deepEqual(repo.getCoverage(scope, "c1"), [{ fromSeq: 10, throughSeq: 12 }]);

  // Disconnected: message is stored but the gap stays open for sync.
  await repo.appendLiveMessage(scope, "c1", msg(15), { connected: false });
  assert.deepEqual(repo.getCoverage(scope, "c1"), [{ fromSeq: 10, throughSeq: 12 }]);
  assert.equal(repo.getLatestMessages(scope, "c1", 1)[0]?.seq, 15);

  // The follow-up sync page closes the gap and everything fuses.
  await repo.appendPage(scope, "c1", { messages: [msg(13), msg(14), msg(15)] });
  assert.deepEqual(repo.getCoverage(scope, "c1"), [{ fromSeq: 10, throughSeq: 15 }]);
});

test("overlays hydrate messages and stale updates lose", async () => {
  const { repo, setClock } = makeFixture();
  const scope = repo.openScope(SCOPE_A.origin, SCOPE_A.userId, SCOPE_A.serverId);
  await repo.appendPage(scope, "c1", { messages: [msg(10, { reactions: [] })] });

  setClock(1_000);
  await repo.applyMessageUpdated(scope, "c1", {
    seq: 10,
    raw: msg(10, { reactions: [{ emoji: "🎉" }] }).raw,
    updatedAt: new Date(1_000).toISOString(),
  });
  setClock(2_000);
  const hydrated = repo.getLatestMessages(scope, "c1", 1)[0];
  assert.deepEqual(hydrated?.overlay?.reactions, [{ emoji: "🎉" }]);

  // A stale page arriving late must not roll the overlay back.
  await repo.applyOverlayPage(scope, "c1", {
    fromSeq: 10,
    throughSeq: 10,
    messages: [{ seq: 10, raw: msg(10, { reactions: [] }).raw, updatedAt: new Date(500).toISOString() }],
  });
  assert.deepEqual(repo.getLatestMessages(scope, "c1", 1)[0]?.overlay?.reactions, [{ emoji: "🎉" }]);
});

test("thread summaries persist and channel deletion cascades into threads", async () => {
  const { repo } = makeFixture();
  const scope = repo.openScope(SCOPE_A.origin, SCOPE_A.userId, SCOPE_A.serverId);
  await repo.putChannels(scope, [{ id: "c1", type: "channel", raw: { id: "c1" } }]);
  await repo.appendPage(scope, "c1", { messages: [msg(10)] });
  await repo.appendPage(scope, "thread-1", { messages: [msg(101), msg(102)] });
  await repo.applyThreadSummary(scope, {
    parentChannelId: "c1",
    parentMessageId: "m-10",
    raw: { threadChannelId: "thread-1", replyCount: 2 },
  });
  assert.equal(repo.getThreadSummaries(scope, "c1")["m-10"]?.replyCount, 2);

  await repo.deleteChannel(scope, "c1");
  assert.deepEqual(repo.getThreadSummaries(scope, "c1"), {});
  assert.deepEqual(repo.getCoverage(scope, "thread-1"), []);
  assert.deepEqual(repo.getLatestMessages(scope, "thread-1", 10), []);
  assert.deepEqual(repo.getChannels(scope), []);
});

test("task rows move forward by revision only", async () => {
  const { repo } = makeFixture();
  const scope = repo.openScope(SCOPE_A.origin, SCOPE_A.userId, SCOPE_A.serverId);
  await repo.applyTaskEvent(scope, { id: "t1", revision: 3, raw: { id: "t1", status: "todo" } });
  await repo.applyTaskEvent(scope, { id: "t1", revision: 2, raw: { id: "t1", status: "stale" } });
  assert.equal(repo.getTaskRows(scope)[0]?.raw.status, "todo");
  await repo.applyTaskEvent(scope, { id: "t1", revision: 4, raw: { id: "t1", status: "done" } });
  assert.equal(repo.getTaskRows(scope)[0]?.raw.status, "done");
  await repo.deleteTask(scope, "t1");
  assert.deepEqual(repo.getTaskRows(scope), []);
});

test("read states move forward by version", async () => {
  const { repo } = makeFixture();
  const scope = repo.openScope(SCOPE_A.origin, SCOPE_A.userId, SCOPE_A.serverId);
  await repo.applyReadState(scope, "c1", 12, 5);
  await repo.applyReadState(scope, "c1", 9, 4);
  assert.deepEqual(repo.getReadStates(scope), { c1: { maxReadSeq: 12, version: 5 } });
  await repo.applyReadState(scope, "c1", 20, 6);
  assert.deepEqual(repo.getReadStates(scope), { c1: { maxReadSeq: 20, version: 6 } });
});

test("pruneMessages repairs ranges, overlays and orphan summaries", async () => {
  const { repo } = makeFixture();
  const scope = repo.openScope(SCOPE_A.origin, SCOPE_A.userId, SCOPE_A.serverId);
  // Old page (August) + new page (October): a gap by date is fine, ranges fuse by seq.
  await repo.appendPage(scope, "c1", {
    messages: [
      { seq: 1, id: "m-1", raw: { id: "m-1", seq: 1, createdAt: "2026-08-01T00:00:00Z" } },
      { seq: 2, id: "m-2", raw: { id: "m-2", seq: 2, createdAt: "2026-08-02T00:00:00Z" } },
    ],
  });
  await repo.appendPage(scope, "c1", {
    messages: [
      { seq: 3, id: "m-3", raw: { id: "m-3", seq: 3, createdAt: "2026-10-01T00:00:00Z" } },
      { seq: 4, id: "m-4", raw: { id: "m-4", seq: 4, createdAt: "2026-10-02T00:00:00Z" } },
    ],
  });
  assert.deepEqual(repo.getCoverage(scope, "c1"), [{ fromSeq: 1, throughSeq: 4 }]);
  // Overlay + summary on a message that will be pruned.
  await repo.applyMessageUpdated(scope, "c1", {
    seq: 1,
    raw: { id: "m-1", seq: 1, reactions: ["x"] },
    updatedAt: "2026-10-05T00:00:00Z",
  });
  await repo.applyThreadSummary(scope, {
    parentChannelId: "c1",
    parentMessageId: "m-1",
    raw: { threadChannelId: "thread-1", replyCount: 1 },
  });

  await repo.pruneMessages(scope, "2026-09-01T00:00:00Z");
  assert.deepEqual(repo.getLatestMessages(scope, "c1", 10).map((m) => m.seq), [4, 3]);
  assert.deepEqual(repo.getCoverage(scope, "c1"), [{ fromSeq: 3, throughSeq: 4 }]);
  assert.equal(repo.getLatestMessages(scope, "c1", 10)[0]?.overlay, null);
  assert.deepEqual(repo.getThreadSummaries(scope, "c1"), {});
});

test("wipeScope clears only its own partition; wipeAll clears everything", async () => {
  const { repo } = makeFixture();
  const a = repo.openScope(SCOPE_A.origin, SCOPE_A.userId, SCOPE_A.serverId);
  const b = repo.openScope(SCOPE_B.origin, SCOPE_B.userId, SCOPE_B.serverId);
  await repo.appendPage(a, "c1", { messages: [msg(1)] });
  await repo.appendPage(b, "c9", { messages: [msg(1)] });
  await repo.wipeScope(a);
  assert.deepEqual(repo.getLatestMessages(a, "c1", 10), []);
  assert.equal(repo.getLatestMessages(b, "c9", 10).length, 1);
  await repo.wipeAll();
  assert.equal(repo.getLatestMessages(b, "c9", 10).length, 0);
});

test("schema mismatch drops and rebuilds the cache", async () => {
  const { repo } = makeFixture();
  const scope = repo.openScope(SCOPE_A.origin, SCOPE_A.userId, SCOPE_A.serverId);
  await repo.appendPage(scope, "c1", { messages: [msg(1)] });
  // Simulate a future schema version on the same file.
  const db = openNodeSqliteDb(":memory:");
  db.exec("CREATE TABLE stale (x)");
  db.exec("PRAGMA user_version = 99");
  const rebuilt = createCacheRepo({ db, now: () => "2026-09-28T00:00:00Z" });
  // Old table must be gone; new schema in place and usable.
  assert.equal(db.all("SELECT name FROM sqlite_master WHERE name = 'stale'").length, 0);
  const freshScope = rebuilt.openScope(SCOPE_A.origin, SCOPE_A.userId, SCOPE_A.serverId);
  await rebuilt.appendPage(freshScope, "c1", { messages: [msg(1)] });
  assert.deepEqual(rebuilt.getCoverage(freshScope, "c1"), [{ fromSeq: 1, throughSeq: 1 }]);
});
