// IndexedDB CacheRepo tests (desktop-data-cache task #7 / P1).
//
// Runs against fake-indexeddb with a FRESH factory per test (isolation) and
// a shared factory for the two-connection (multi-tab) test. Covers the
// acceptance list: reads/writes, coverage ranges, clearing, schema
// downgrade-rebuild, degradation, concurrent two-tab writes — plus the
// semantic parity spots (dropMissing cascade, overlay LWW, gates, prune).
import "fake-indexeddb/auto";
import { IDBFactory } from "fake-indexeddb";
import { openDB } from "idb";
import assert from "node:assert/strict";
import test from "node:test";
import { createIdbCacheRepo, WEB_CACHE_DB_NAME, WEB_CACHE_SCHEMA_VERSION } from "../src/cache/idbRepo";
import { createWebCacheRuntime } from "../src/cache/webCache";
import { wireWebCacheLifecycle, wipeOnExplicitLogout } from "../src/cache/webCacheLifecycle";
import { RUNTIME_API_BASE } from "../src/desktopRuntimeEnvironment";

type Globals = { indexedDB?: IDBFactory };

function freshDb(): void {
  (globalThis as Globals).indexedDB = new IDBFactory();
}

async function repo(now?: () => string) {
  return createIdbCacheRepo(now ? { now } : {});
}

async function scope(r: Awaited<ReturnType<typeof repo>>): Promise<number> {
  return r.openScope("https://raft.example", "user-1", "srv-a");
}

test("openScope is idempotent per identity and partitions by server", async () => {
  freshDb();
  const r = await repo();
  const a1 = await r.openScope("https://raft.example", "user-1", "srv-a");
  const a2 = await r.openScope("https://raft.example", "user-1", "srv-a");
  const b = await r.openScope("https://raft.example", "user-1", "srv-b");
  const other = await r.openScope("https://raft.example", "user-2", "srv-a");
  assert.equal(a1, a2, "same identity → same scope id");
  assert.notEqual(a1, b);
  assert.notEqual(a1, other);
});

test("channels: put, read, type filter, and dropMissing scoped to the batch type set", async () => {
  freshDb();
  const r = await repo();
  const s = await scope(r);
  await r.putChannels(s, [
    { id: "c1", type: "channel", lastMessageAt: "2026-01-02T00:00:00Z", raw: { id: "c1", name: "one" } },
    { id: "c2", type: "channel", lastMessageAt: null, raw: { id: "c2", name: "two" } },
  ]);
  await r.putChannels(s, [{ id: "d1", type: "dm", lastMessageAt: null, raw: { id: "d1" } }]);
  assert.deepEqual((await r.getChannels(s)).map((c) => c.id).sort(), ["c1", "c2", "d1"]);
  assert.deepEqual((await r.getChannels(s, ["dm"])).map((c) => c.id), ["d1"], "type filter");
  // A channel-list refresh that no longer lists c2 drops it (and its data),
  // while the dm batch never touches channels.
  await r.putChannels(s, [{ id: "c1", type: "channel", lastMessageAt: null, raw: { id: "c1", name: "one" } }]);
  assert.deepEqual((await r.getChannels(s)).map((c) => c.id).sort(), ["c1", "d1"], "dropMissing removes c2, keeps dm");
});

test("messages + coverage: pages build ranges, live tail extends only when connected and adjacent", async () => {
  freshDb();
  const r = await repo();
  const s = await scope(r);
  const ch = "c1";
  await r.appendPage(s, ch, {
    messages: [
      { seq: 1, id: "m1", raw: { id: "m1", createdAt: "2026-01-01T00:00:01Z" } },
      { seq: 2, id: "m2", raw: { id: "m2", createdAt: "2026-01-01T00:00:02Z" } },
    ],
    window: { coveredFromSeq: 1, coveredThroughSeq: 2, hasGap: false },
  });
  await r.appendPage(s, ch, {
    messages: [
      { seq: 5, id: "m5", raw: { id: "m5", createdAt: "2026-01-01T00:00:05Z" } },
      { seq: 6, id: "m6", raw: { id: "m6", createdAt: "2026-01-01T00:00:06Z" } },
    ],
  });
  assert.deepEqual(await r.getCoverage(s, ch), [
    { fromSeq: 1, throughSeq: 2 },
    { fromSeq: 5, throughSeq: 6 },
  ], "server-contiguous pages each form their own range");
  await r.appendLiveMessage(s, ch, { seq: 7, id: "m7", raw: { id: "m7" } }, { connected: true });
  assert.deepEqual(await r.getCoverage(s, ch), [
    { fromSeq: 1, throughSeq: 2 },
    { fromSeq: 5, throughSeq: 7 },
  ], "adjacent connected live message extends the tail");
  await r.appendLiveMessage(s, ch, { seq: 10, id: "m10", raw: { id: "m10" } }, { connected: true });
  assert.deepEqual(await r.getCoverage(s, ch).then((ranges) => ranges.map((x) => `${x.fromSeq}-${x.throughSeq}`)), ["1-2", "5-7"], "non-adjacent live message is stored but opens no range");
  await r.appendLiveMessage(s, ch, { seq: 8, id: "m8", raw: { id: "m8" } }, { connected: false });
  assert.deepEqual(await r.getCoverage(s, ch).then((ranges) => ranges.map((x) => `${x.fromSeq}-${x.throughSeq}`)), ["1-2", "5-7"], "disconnected live message never extends coverage");
  const latest = await r.getLatestMessages(s, ch, 3);
  assert.deepEqual(latest.map((m) => m.seq), [10, 8, 7], "newest-first");
});

test("overlays: last-write-wins on server updatedAt, once-per-boot marks with bootId, invalidate keeps data", async () => {
  freshDb();
  const r = await repo();
  const s = await scope(r);
  const ch = "c1";
  await r.appendPage(s, ch, { messages: [{ seq: 1, id: "m1", raw: { id: "m1", body: "hi" } }] });
  await r.applyOverlayPage(s, ch, {
    fromSeq: 1,
    throughSeq: 1,
    messages: [{ seq: 1, raw: { body: "v2" }, updatedAt: "2026-01-02T00:00:00Z" }],
  });
  assert.equal((await r.getLatestMessages(s, ch, 1))[0].overlay?.body, "v2");
  let info = await r.getOverlayPageInfo(s, ch, 1);
  assert.equal(info?.bootId, r.bootId);
  assert.equal(info?.throughSeq, 1);
  // A stale (older updatedAt) write-through must NOT regress the overlay.
  await r.applyMessageUpdated(s, ch, { seq: 1, raw: { body: "v1-stale" }, updatedAt: "2026-01-01T00:00:00Z" });
  assert.equal((await r.getLatestMessages(s, ch, 1))[0].overlay?.body, "v2", "older updatedAt loses");
  await r.invalidateOverlayPageMarks(s);
  assert.equal(await r.getOverlayPageInfo(s, ch, 1), null, "marks dropped");
  assert.equal((await r.getLatestMessages(s, ch, 1))[0].overlay?.body, "v2", "overlay data kept");
});

test("thread summaries and links: write-through keyed by parent message", async () => {
  freshDb();
  const r = await repo();
  const s = await scope(r);
  await r.appendPage(s, "c1", { messages: [{ seq: 1, id: "m1", raw: { id: "m1" } }] });
  await r.applyThreadSummary(s, { parentChannelId: "c1", parentMessageId: "m1", raw: { replyCount: 3, threadChannelId: "t1" } });
  assert.deepEqual(await r.getThreadSummaries(s, "c1"), { m1: { replyCount: 3, threadChannelId: "t1" } });
});

test("tasks: revision gate blocks stale events; delete removes", async () => {
  freshDb();
  const r = await repo();
  const s = await scope(r);
  await r.applyTaskEvent(s, { id: "t1", revision: 5, raw: { title: "five" } });
  await r.applyTaskEvent(s, { id: "t1", revision: 3, raw: { title: "three-stale" } });
  let rows = await r.getTaskRows(s);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].revision, 5);
  assert.equal(rows[0].raw.title, "five", "stale revision ignored");
  await r.applyTaskEvent(s, { id: "t1", revision: 6, raw: { title: "six" } });
  rows = await r.getTaskRows(s);
  assert.equal(rows[0].revision, 6);
  await r.deleteTask(s, "t1");
  assert.deepEqual(await r.getTaskRows(s), []);
});

test("read states: version gate blocks stale writes", async () => {
  freshDb();
  const r = await repo();
  const s = await scope(r);
  await r.applyReadState(s, "c1", 10, 2);
  await r.applyReadState(s, "c1", 5, 1);
  assert.deepEqual(await r.getReadStates(s), { c1: { maxReadSeq: 10, version: 2 } });
  await r.applyReadState(s, "c1", 20, 3);
  assert.deepEqual(await r.getReadStates(s), { c1: { maxReadSeq: 20, version: 3 } });
});

test("kv and inbox pages round-trip", async () => {
  freshDb();
  const r = await repo();
  const s = await scope(r);
  await r.putKv(s, "serverList", { servers: [{ id: "a" }] });
  assert.deepEqual(await r.getKv(s, "serverList"), { servers: [{ id: "a" }] });
  assert.equal(await r.getKv(s, "missing"), null);
  await r.putInboxPage(s, 0, { items: [1, 2] });
  assert.deepEqual(await r.getInboxPage(s, 0), { items: [1, 2] });
  assert.equal(await r.getInboxPage(s, 1), null);
});

test("deleteChannel cascades into the thread channel's data too", async () => {
  freshDb();
  const r = await repo();
  const s = await scope(r);
  await r.putChannels(s, [{ id: "c1", type: "channel", raw: { id: "c1" } }]);
  await r.appendPage(s, "c1", { messages: [{ seq: 1, id: "m1", raw: { id: "m1" } }] });
  await r.applyThreadSummary(s, { parentChannelId: "c1", parentMessageId: "m1", raw: { replyCount: 1, threadChannelId: "t1" } });
  await r.appendPage(s, "t1", { messages: [{ seq: 1, id: "r1", raw: { id: "r1" } }] });
  await r.applyReadState(s, "c1", 1, 1);
  await r.deleteChannel(s, "c1");
  assert.deepEqual(await r.getChannels(s), []);
  assert.deepEqual(await r.getLatestMessages(s, "c1", 10), []);
  assert.deepEqual(await r.getLatestMessages(s, "t1", 10), [], "thread channel rows cascade");
  assert.deepEqual(await r.getCoverage(s, "c1"), []);
  assert.deepEqual(await r.getThreadSummaries(s, "c1"), {});
  assert.deepEqual(await r.getReadStates(s), {});
});

test("pruneMessages cuts old rows, repairs overlays/ranges/marks, drops orphan summaries", async () => {
  freshDb();
  const r = await repo(() => "2026-02-01T00:00:00Z");
  const s = await scope(r);
  const ch = "c1";
  await r.appendPage(s, ch, {
    messages: [
      { seq: 1, id: "m1", raw: { id: "m1", createdAt: "2026-01-01T00:00:01Z" } },
      { seq: 2, id: "m2", raw: { id: "m2", createdAt: "2026-01-01T00:00:02Z" } },
      { seq: 3, id: "m3", raw: { id: "m3", createdAt: "2026-01-15T00:00:03Z" } },
      { seq: 4, id: "m4", raw: { id: "m4", createdAt: "2026-01-15T00:00:04Z" } },
    ],
    window: { coveredFromSeq: 1, coveredThroughSeq: 4, hasGap: false },
  });
  await r.applyOverlayPage(s, ch, { fromSeq: 1, throughSeq: 2, messages: [{ seq: 1, raw: { body: "x" }, updatedAt: "2026-01-02T00:00:00Z" }, { seq: 3, raw: { body: "keep" }, updatedAt: "2026-01-16T00:00:00Z" }] });
  // A page straddling the future floor: its fromSeq must clamp up to 3.
  await r.applyOverlayPage(s, ch, { fromSeq: 2, throughSeq: 5, messages: [{ seq: 4, raw: { body: "straddle" }, updatedAt: "2026-01-16T00:00:00Z" }] });
  await r.applyThreadSummary(s, { parentChannelId: ch, parentMessageId: "m1", raw: { replyCount: 0 } });
  await r.applyThreadSummary(s, { parentChannelId: ch, parentMessageId: "m4", raw: { replyCount: 2 } });
  await r.pruneMessages(s, "2026-01-10T00:00:00Z");
  assert.deepEqual((await r.getLatestMessages(s, ch, 10)).map((m) => m.seq), [4, 3], "old messages cut");
  assert.deepEqual(await r.getCoverage(s, ch), [{ fromSeq: 3, throughSeq: 4 }], "ranges rebuilt from survivors");
  assert.equal((await r.getLatestMessages(s, ch, 10)).find((m) => m.seq === 3)?.overlay?.body, "keep", "survivor overlay kept");
  assert.equal(await r.getOverlayPageInfo(s, ch, 1), null, "page ending below the floor is dropped");
  const info = await r.getOverlayPageInfo(s, ch, 3);
  assert.ok(info && info.fromSeq === 3 && info.throughSeq === 5, "straddling page mark clamped up to the surviving floor");
  assert.deepEqual(await r.getThreadSummaries(s, ch), { m4: { replyCount: 2 } }, "orphan summary dropped, survivor kept");
});

test("wipeScope clears one scope; wipeAll clears everything", async () => {
  freshDb();
  const r = await repo();
  const a = await scope(r);
  const b = await r.openScope("https://raft.example", "user-1", "srv-b");
  await r.putKv(a, "k", { v: 1 });
  await r.putKv(b, "k", { v: 2 });
  await r.wipeScope(b);
  assert.equal(await r.getKv(b, "k"), null);
  assert.deepEqual(await r.getKv(a, "k"), { v: 1 }, "other scope untouched");
  await r.wipeAll();
  assert.equal(await r.getKv(a, "k"), null);
  const reopened = await r.openScope("https://raft.example", "user-1", "srv-a");
  assert.notEqual(reopened, a, "scope row was wiped too — a fresh id is issued");
});

test("schema downgrade: a newer-version database is deleted and rebuilt", async () => {
  freshDb();
  // Simulate a future version of the app having created a v+1 database.
  const future = await openDB(WEB_CACHE_DB_NAME, WEB_CACHE_SCHEMA_VERSION + 1, {
    upgrade(db) {
      db.createObjectStore("scopes", { keyPath: "id", autoIncrement: true });
      db.createObjectStore("from_the_future", { keyPath: "x" });
    },
  });
  future.close();
  const r = await repo();
  const s = await scope(r);
  await r.putKv(s, "after", { rebuilt: true });
  assert.deepEqual(await r.getKv(s, "after"), { rebuilt: true }, "repo rebuilt the database at its own version");
});

test("degradation: without indexedDB the runtime falls back to the in-memory repo", async () => {
  const globals = globalThis as Globals;
  const saved = globals.indexedDB;
  delete globals.indexedDB;
  try {
    const runtime = await createWebCacheRuntime();
    assert.equal(runtime.available, false, "IndexedDB unavailable is reported");
    // #9's in-memory repo keeps session-level cache semantics in RAM.
    const scope = await runtime.attach("https://raft.example", "user-1", "srv-a");
    await runtime.repo.putKv(scope, "session", { ok: true });
    assert.deepEqual(await runtime.repo.getKv(scope, "session"), { ok: true }, "RAM-backed reads work");
  } finally {
    if (saved) globals.indexedDB = saved;
  }
});

test("multi-tab: two connections over one factory see each other's committed writes", async () => {
  freshDb();
  const tabA = await repo();
  const tabB = await repo();
  const a = await tabA.openScope("https://raft.example", "user-1", "srv-a");
  const b = await tabB.openScope("https://raft.example", "user-1", "srv-a");
  assert.equal(a, b, "identity index resolves the same scope across connections");
  // Concurrent writes from both tabs land without corrupting either store.
  await Promise.all([
    tabA.putKv(a, "fromA", { v: "a" }),
    tabB.putKv(b, "fromB", { v: "b" }),
    tabA.appendPage(a, "c1", { messages: [{ seq: 1, id: "m1", raw: { id: "m1" } }] }),
    tabB.appendPage(b, "c2", { messages: [{ seq: 1, id: "n1", raw: { id: "n1" } }] }),
  ]);
  assert.deepEqual(await tabB.getKv(a, "fromA"), { v: "a" }, "B sees A's kv write");
  assert.deepEqual(await tabA.getKv(b, "fromB"), { v: "b" }, "A sees B's kv write");
  assert.equal((await tabA.getLatestMessages(a, "c1", 5)).length, 1);
  assert.equal((await tabB.getLatestMessages(b, "c2", 5)).length, 1);
});

test("lifecycle: startup user=null never wipes; persisted identity attaches before /me", async () => {
  freshDb();
  const runtime = await createWebCacheRuntime();
  // A previous session left data behind (the refresh scenario).
  const previous = await runtime.attach(RUNTIME_API_BASE, "user-1", "srv-a");
  await runtime.repo.putKv(previous, "serverList", { v: "cached" });
  const storage = memoryStorage({ "raft_web_cache_last_scope": JSON.stringify({ userId: "user-1", serverId: "srv-a" }) });

  const { store, setState } = fakeStores({ user: null, current: null });
  const wired = wireWebCacheLifecycle(
    runtime,
    store as unknown as Parameters<typeof wireWebCacheLifecycle>[1],
    store as unknown as Parameters<typeof wireWebCacheLifecycle>[2],
    { storage },
  );
  await flush();
  assert.equal(runtime.scopeId, previous, "attached the persisted identity while /me is still pending");
  assert.deepEqual(await runtime.repo.getKv(previous, "serverList"), { v: "cached" }, "startup never wipes");

  // /me returns with the SAME user: attach continues, still no wipe.
  setState({ user: { id: "user-1" }, current: { id: "srv-a" } });
  await flush();
  assert.deepEqual(await runtime.repo.getKv(previous, "serverList"), { v: "cached" });

  // Server switch re-attaches without wiping the other server's data.
  await runtime.repo.putKv(await runtime.attach(RUNTIME_API_BASE, "user-1", "srv-b"), "serverList", { v: "b" });
  setState({ current: { id: "srv-a" } });
  await flush();
  const aScope = await runtime.repo.openScope(RUNTIME_API_BASE, "user-1", "srv-a");
  assert.deepEqual(await runtime.repo.getKv(aScope, "serverList"), { v: "cached" }, "switch never wipes");

  // A 401-style clear (user → null, no logout call) keeps the cache.
  setState({ user: null });
  await flush();
  assert.deepEqual(await runtime.repo.getKv(aScope, "serverList"), { v: "cached" }, "session expiry does not wipe");
  wired.unsubscribe();
});

test("lifecycle: user already known attaches the persisted scope while current is null", async () => {
  freshDb();
  const seeded = await createWebCacheRuntime();
  const previous = await seeded.attach(RUNTIME_API_BASE, "user-1", "srv-a");
  await seeded.repo.putKv(previous, "serverList", { servers: [{ id: "s", name: "Raft", slug: "raft" }] });
  const storage = memoryStorage({
    "raft_web_cache_last_scope": JSON.stringify({ userId: "user-1", serverId: "srv-a" }),
  });

  // Offline admission can publish the user before wiring's first sync, and
  // current is still null because the list has not seeded yet.
  const runtime = await createWebCacheRuntime();
  assert.equal(runtime.scopeId, null);
  const { store } = fakeStores({ user: { id: "user-1" }, current: null });
  const wired = wireWebCacheLifecycle(
    runtime,
    store as unknown as Parameters<typeof wireWebCacheLifecycle>[1],
    store as unknown as Parameters<typeof wireWebCacheLifecycle>[2],
    { storage },
  );
  await flush();
  assert.equal(runtime.scopeId, previous, "persisted scope attaches even though current is null");
  assert.equal(runtime.userId, "user-1");
  assert.deepEqual(await runtime.repo.getKv(previous, "serverList"), {
    servers: [{ id: "s", name: "Raft", slug: "raft" }],
  });

  // A different account must not be attached to the previous user's scope
  // just because current has not been chosen yet.
  const other = await createWebCacheRuntime();
  const otherWired = wireWebCacheLifecycle(
    other,
    fakeStores({ user: { id: "user-2" }, current: null }).store as unknown as Parameters<typeof wireWebCacheLifecycle>[1],
    fakeStores({ user: { id: "user-2" }, current: null }).store as unknown as Parameters<typeof wireWebCacheLifecycle>[2],
    { storage },
  );
  await flush();
  assert.equal(other.scopeId, null, "another account does not inherit the persisted scope");
  wired.unsubscribe();
  otherWired.unsubscribe();
});

test("lifecycle: explicit logout wipes; account switch wipes the old account first", async () => {
  freshDb();
  const runtime = await createWebCacheRuntime();
  const storage = memoryStorage();
  const { store, setState } = fakeStores({ user: { id: "user-1" }, current: { id: "srv-a" } });
  const auth = store as unknown as Parameters<typeof wireWebCacheLifecycle>[1];
  wipeOnExplicitLogout(runtime, auth, { storage });
  wireWebCacheLifecycle(runtime, auth, store as unknown as Parameters<typeof wireWebCacheLifecycle>[2], { storage });
  await flush();
  const aScope = await runtime.repo.openScope(RUNTIME_API_BASE, "user-1", "srv-a");
  await runtime.repo.putKv(aScope, "secret", { v: "user-1-data" });
  assert.equal(JSON.parse(storage.getItem("raft_web_cache_last_scope") ?? "{}").userId, "user-1", "identity persisted");
  storage.setItem("raft_web_offline_user", JSON.stringify({ id: "user-1" }));

  // Explicit logout: the wrapped action wipes and clears the persisted id.
  store.getState().logout("explicit_user_logout");
  await flush();
  assert.equal(runtime.scopeId, null, "logout detaches");
  assert.equal(await runtime.repo.getKv(aScope, "secret"), null, "logout wipes the database");
  assert.equal(storage.getItem("raft_web_cache_last_scope"), null, "persisted identity cleared");
  assert.equal(storage.getItem("raft_web_offline_user"), null, "public profile snapshot cleared");

  // Login as another account: fresh scope, no old data.
  setState({ user: { id: "user-2" }, current: { id: "srv-a" } });
  await flush();
  const bScope = await runtime.repo.openScope(RUNTIME_API_BASE, "user-2", "srv-a");
  assert.equal(await runtime.repo.getKv(bScope, "secret"), null, "new account starts clean");

  // Direct account switch WITHOUT a logout in between wipes the old data.
  await runtime.repo.putKv(bScope, "user2", { v: "data" });
  setState({ user: { id: "user-3" } });
  await flush();
  const cScope = await runtime.repo.openScope(RUNTIME_API_BASE, "user-3", "srv-a");
  assert.equal(await runtime.repo.getKv(cScope, "user2"), null, "account switch wipes the previous account");
  assert.notEqual(cScope, bScope);
});

test("lifecycle: the same serverId for a different user re-attaches", async () => {
  freshDb();
  const runtime = await createWebCacheRuntime();
  await runtime.attach(RUNTIME_API_BASE, "user-1", "srv-a");
  const previous = runtime.scopeId;
  const generation = runtime.generation;
  const { store } = fakeStores({ user: { id: "user-2" }, current: { id: "srv-a" } });
  const wired = wireWebCacheLifecycle(
    runtime,
    store as unknown as Parameters<typeof wireWebCacheLifecycle>[1],
    store as unknown as Parameters<typeof wireWebCacheLifecycle>[2],
    { storage: memoryStorage() },
  );
  await flush();
  assert.equal(runtime.userId, "user-2", "the holder follows the signed-in user");
  assert.notEqual(runtime.scopeId, previous, "user-2 does not keep user-1's scope");
  assert.ok(runtime.generation > generation);
  wired.unsubscribe();
});

function memoryStorage(initial: Record<string, string> = {}): { getItem(k: string): string | null; setItem(k: string, v: string): void; removeItem(k: string): void } {
  const map = new Map(Object.entries(initial));
  return {
    getItem: (k) => map.get(k) ?? null,
    setItem: (k, v) => map.set(k, v),
    removeItem: (k) => map.delete(k),
  };
}

type FakeStoreState = { user: { id: string } | null; current: { id: string } | null };
function fakeStores(initial: FakeStoreState): { store: unknown; setState(next: Partial<FakeStoreState>): void } {
  const listeners = new Set<(state: FakeStoreState, prev: FakeStoreState) => void>();
  let state: FakeStoreState = { user: null, current: null, ...initial };
  let logoutImpl: (trigger?: string) => void = () => {};
  const store = {
    getState: () => ({ ...state, logout: logoutImpl }),
    setState: (partial: { logout?: (trigger?: string) => void }) => {
      if (partial.logout) logoutImpl = partial.logout;
    },
    subscribe: (listener: (state: FakeStoreState, prev: FakeStoreState) => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    __setState(next: Partial<FakeStoreState>) {
      const prev = state;
      state = { ...state, ...next };
      for (const listener of listeners) listener(state, prev);
    },
  };
  return { store, setState: (next) => store.__setState(next) };
}

async function flush(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 20));
}


test("lifecycle: a logout that clears the user leaves no scope row and no persisted identity (acceptance ③)", async () => {
  freshDb();
  const runtime = await createWebCacheRuntime();
  const storage = memoryStorage();
  const { store, setState } = fakeStores({ user: { id: "user-1" }, current: { id: "srv-a" } });
  // Like the real authStore: logout clears the user synchronously, which
  // fires the lifecycle's user→null sync inside the wrapped action.
  (store as { setState(partial: { logout: () => void }): void }).setState({
    logout: () => setState({ user: null }),
  });
  const auth = store as unknown as Parameters<typeof wireWebCacheLifecycle>[1];
  wipeOnExplicitLogout(runtime, auth, { storage });
  wireWebCacheLifecycle(runtime, auth, store as unknown as Parameters<typeof wireWebCacheLifecycle>[2], { storage });
  await flush();
  const aScope = runtime.scopeId!;
  await runtime.repo.putKv(aScope, "secret", { v: "user-1-data" });

  store.getState().logout("explicit_user_logout");
  await flush();
  await flush();

  assert.equal(runtime.scopeId, null, "stays detached after logout");
  assert.equal(storage.getItem("raft_web_cache_last_scope"), null, "persisted identity stays cleared");
  const db = await openDB(WEB_CACHE_DB_NAME, WEB_CACHE_SCHEMA_VERSION);
  const scopes = await db.getAll("scopes");
  db.close();
  assert.deepEqual(scopes, [], "no scope row is re-created after the wipe");
});

test("lifecycle: an attach still in flight when logout wipes is dropped, not persisted", async () => {
  freshDb();
  const runtime = await createWebCacheRuntime();
  const storage = memoryStorage();
  const { store, setState } = fakeStores({ user: { id: "user-1" }, current: { id: "srv-a" } });
  (store as { setState(partial: { logout: () => void }): void }).setState({
    logout: () => setState({ user: null }),
  });
  const auth = store as unknown as Parameters<typeof wireWebCacheLifecycle>[1];
  wipeOnExplicitLogout(runtime, auth, { storage });
  wireWebCacheLifecycle(runtime, auth, store as unknown as Parameters<typeof wireWebCacheLifecycle>[2], { storage });
  await flush();

  // A server switch starts an attach; logout lands before it completes.
  setState({ current: { id: "srv-b" } });
  store.getState().logout("explicit_user_logout");
  await flush();
  await flush();

  assert.equal(runtime.scopeId, null);
  assert.equal(storage.getItem("raft_web_cache_last_scope"), null);
  const db = await openDB(WEB_CACHE_DB_NAME, WEB_CACHE_SCHEMA_VERSION);
  const scopes = await db.getAll("scopes");
  db.close();
  assert.deepEqual(scopes, []);
});
