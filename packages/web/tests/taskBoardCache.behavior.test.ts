import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import api from "../src/api/client";
import { useTaskStore } from "../src/store/taskStore";
import { registerTaskRealtimeHandlers } from "../src/store/taskRealtimeSync";
import { attachMemoryWebCache, clearActiveWebCache, activeWebCache } from "../src/cache/messageCache";
import { createWebCacheRepo } from "../src/cache/webCacheRepo";
import { createWebCacheRuntime } from "../src/cache/webCache";
import {
  taskRevisionOf,
  captureTaskCacheToken,
  persistServerTasksSnapshot,
} from "../src/cache/taskBoardCache";
import type { CacheRepo } from "@botiverse/raft-shared/src/cacheRepoContract.js";
import type { Task } from "../src/store/taskStore";

/**
 * Behavior (desktop-data-cache task #10 / P2c): the task board reads the
 * #7/#9 cache so a cold start paints instantly (offline included) and every
 * committed snapshot / realtime event writes back through the revision gate.
 *
 *   - seed: loadServerTasks/loadTasks paint cached rows BEFORE the network
 *     answers, without marking anything loaded;
 *   - correct: a landing snapshot replaces the seed (stale rows updated,
 *     gone rows dropped) and is persisted per-row through the gate;
 *   - deletion domain: only channel|joint rows may be purged by a server
 *     snapshot's absence (the server list covers exactly that domain —
 *     DM/private rows belong to per-channel loads, not the board snapshot);
 *   - write-through: socket task:created/updated/deleted land in the cache;
 *   - offline: a failed fetch leaves the seed visible and nothing loaded.
 *
 * Run: `pnpm --filter @botiverse/raft-web test`.
 */

const originalGet = api.get.bind(api);

afterEach(() => {
  api.get = originalGet;
  clearActiveWebCache();
  useTaskStore.setState({
    tasks: [], loading: false, currentChannelId: null,
    tasksByChannelId: {}, loadingByChannelId: {}, loadedByChannelId: {},
    serverTasks: [], serverLoading: false, serverTasksLoaded: false, serverTasksGeneration: 0,
    serverTasksActiveConsumers: 0,
    taskMetadataByMessageId: {}, taskMessageIdByTaskId: {},
  });
});

const flush = () => new Promise((r) => setTimeout(r, 0));
/** Drain the fire-and-forget cache writes (several awaited repo calls deep). */
async function settle() {
  for (let i = 0; i < 25; i++) await flush();
}

async function attachFreshCache(): Promise<number> {
  return attachMemoryWebCache("http://test", "user-1", "server-1", createWebCacheRepo());
}

function taskFixture(overrides: Partial<Task> = {}): Task {
  return {
    id: "t1",
    messageId: "m1",
    channelId: "c1",
    channelType: "channel",
    taskNumber: 1,
    title: "title",
    status: "todo",
    createdById: "u1",
    createdByType: "user",
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z",
    ...overrides,
  } as Task;
}

function wireSocket() {
  const handlers: Record<string, (data: unknown) => void> = {};
  const socket = {
    on: (event: string, handler: (data: unknown) => void) => { handlers[event] = handler; },
    off: () => {},
  };
  registerTaskRealtimeHandlers(socket);
  return handlers;
}

test("taskRevisionOf: top-level revision, projection fallback, 0 floor", () => {
  assert.equal(taskRevisionOf(taskFixture({ revision: 7 })), 7);
  assert.equal(taskRevisionOf(taskFixture({
    revision: undefined,
    taskCurrentProjection: {
      title: "t", description: null, revision: 3, superseded: false, amendedAt: null,
      amendedByType: null, amendedByName: null, source: "tasks_current_projection",
    },
  })), 3);
  assert.equal(taskRevisionOf(taskFixture()), 0, "legacy row without any revision lands at 0");
});

test("server board: cached rows paint before the network answers, snapshot then corrects them", async () => {
  const scopeId = await attachFreshCache();
  const repo = activeWebCache()!.repo;
  const stale = taskFixture({ id: "t1", title: "stale title", revision: 1 });
  await repo.applyTaskEvent(scopeId, { id: stale.id, revision: 1, raw: stale as never });

  const fresh = taskFixture({ id: "t1", title: "fresh title", revision: 2 });
  const resolvers: (() => void)[] = [];
  api.get = ((url: string) => {
    assert.equal(url, "/tasks/server");
    return new Promise((res) => { resolvers.push(() => res({ data: { tasks: [fresh] } })); });
  }) as typeof api.get;
  const loading = useTaskStore.getState().loadServerTasks();
  await settle();
  // Seed visible while the fetch is still pending; nothing is "loaded".
  assert.equal(useTaskStore.getState().serverTasks.length, 1, "seed did not paint during the fetch");
  assert.equal(useTaskStore.getState().serverTasks[0].title, "stale title");
  assert.equal(useTaskStore.getState().serverTasksLoaded, false, "seed must not mark the board loaded");

  resolvers.forEach((r) => r());
  await loading;
  await settle();
  assert.equal(useTaskStore.getState().serverTasks[0].title, "fresh title", "snapshot did not correct the seed");
  assert.equal(useTaskStore.getState().serverTasksLoaded, true);
  const rows = await repo.getTaskRows(scopeId);
  assert.equal(rows.find((r) => r.id === "t1")?.revision, 2, "snapshot was not written back through the gate");
});

test("server board: offline cold start keeps the seed and stays not-loaded", async () => {
  const scopeId = await attachFreshCache();
  const repo = activeWebCache()!.repo;
  const cached = taskFixture({ id: "t1", channelType: "joint" });
  await repo.applyTaskEvent(scopeId, { id: cached.id, revision: 1, raw: cached as never });

  api.get = (async () => {
    throw new Error("offline");
  }) as typeof api.get;
  await useTaskStore.getState().loadServerTasks();
  await settle();
  assert.equal(useTaskStore.getState().serverTasks.length, 1, "offline cold start lost the cached seed");
  assert.equal(useTaskStore.getState().serverTasksLoaded, false);
  assert.equal(useTaskStore.getState().serverLoading, false);
});

test("snapshot deletion is scoped to its channel|joint domain — DM/private rows survive", async () => {
  const scopeId = await attachFreshCache();
  const repo = activeWebCache()!.repo;
  const boardRow = taskFixture({ id: "board-1", channelType: "channel", channelId: "board-channel", revision: 1 });
  const goneBoardRow = taskFixture({ id: "board-gone", channelType: "joint", channelId: "joint-channel", revision: 1 });
  const dmRow = taskFixture({ id: "dm-1", channelType: "dm", channelId: "dm-channel", revision: 1 });
  const privateRow = taskFixture({ id: "priv-1", channelType: "private", channelId: "priv-channel", revision: 1 });
  for (const t of [boardRow, goneBoardRow, dmRow, privateRow]) {
    await repo.applyTaskEvent(scopeId, { id: t.id, revision: 1, raw: t as never });
  }

  api.get = (async () => ({ data: { tasks: [boardRow] } })) as typeof api.get;
  await useTaskStore.getState().loadServerTasks();
  await settle();

  const ids = (await repo.getTaskRows(scopeId)).map((r) => r.id).sort();
  assert.deepEqual(ids, ["board-1", "dm-1", "priv-1"], "snapshot absence must purge only channel|joint rows");
});

test("server board seed only includes board-domain rows (dm/thread stay out)", async () => {
  const scopeId = await attachFreshCache();
  const repo = activeWebCache()!.repo;
  const board = taskFixture({ id: "b1", channelType: "channel", channelId: "board-channel", revision: 1 });
  const thread = taskFixture({ id: "th1", channelType: "thread", channelId: "thread-channel", revision: 1 });
  for (const t of [board, thread]) {
    await repo.applyTaskEvent(scopeId, { id: t.id, revision: 1, raw: t as never });
  }

  api.get = (async () => {
    throw new Error("offline");
  }) as typeof api.get;
  await useTaskStore.getState().loadServerTasks();
  const seeded = useTaskStore.getState().serverTasks.map((t) => t.id);
  assert.deepEqual(seeded, ["b1"], "thread/dm rows must not be seeded into the server board");
});

test("realtime events write through: update is gated, delete leaves no ghost", async () => {
  const scopeId = await attachFreshCache();
  const repo = activeWebCache()!.repo;
  const handlers = wireSocket();
  const created = taskFixture({ id: "t9", revision: 1 });
  handlers["task:created"]({ channelId: "c1", tasks: [created] });
  await settle();
  assert.equal((await repo.getTaskRows(scopeId)).length, 1, "task:created did not write through");

  const updated = taskFixture({ id: "t9", revision: 2, title: "renamed" });
  handlers["task:updated"]({ channelId: "c1", task: updated });
  await settle();
  let rows = await repo.getTaskRows(scopeId);
  assert.equal(rows[0].revision, 2);

  // A stale lower-revision write must not regress the cached row.
  const stale = taskFixture({ id: "t9", revision: 1, title: "stale" });
  handlers["task:updated"]({ channelId: "c1", task: stale });
  await settle();
  rows = await repo.getTaskRows(scopeId);
  assert.equal(rows[0].revision, 2, "revision gate failed: stale event regressed the cache");
  assert.equal((rows[0].raw as { title?: string }).title, "renamed");

  handlers["task:deleted"]({ channelId: "c1", taskId: "t9" });
  await settle();
  assert.equal((await repo.getTaskRows(scopeId)).length, 0, "task:deleted did not purge the cache row");
});

test("channel view: seed paints, network commits and corrects the channel bucket", async () => {
  const scopeId = await attachFreshCache();
  const repo = activeWebCache()!.repo;
  const staleChannel = taskFixture({ id: "t1", channelId: "c1", title: "old", revision: 1 });
  const otherChannel = taskFixture({ id: "t2", channelId: "c2" });
  for (const t of [staleChannel, otherChannel]) {
    await repo.applyTaskEvent(scopeId, { id: t.id, revision: 1, raw: t as never });
  }

  const resolvers: (() => void)[] = [];
  api.get = ((url: string) => {
    assert.equal(url, "/tasks/channel/c1");
    return new Promise((res) => { resolvers.push(() => res({ data: { tasks: [] } })); });
  }) as typeof api.get;
  const loading = useTaskStore.getState().loadTasks("c1");
  await settle();
  assert.deepEqual(
    useTaskStore.getState().tasksByChannelId.c1?.map((t) => t.id),
    ["t1"],
    "channel seed did not paint during the fetch",
  );

  resolvers.forEach((r) => r());
  await loading;
  await settle();
  assert.equal(useTaskStore.getState().tasksByChannelId.c1?.length, 0, "network list did not replace the seed");
  const ids = (await repo.getTaskRows(scopeId)).map((r) => r.id).sort();
  assert.deepEqual(ids, ["t2"], "absent channel row was not purged; other channels must survive");
});

test("no cache mounted: loads behave exactly as before", async () => {
  const task = taskFixture({ id: "t1", revision: 1 });
  api.get = (async () => ({ data: { tasks: [task] } })) as typeof api.get;
  await useTaskStore.getState().loadServerTasks();
  assert.equal(useTaskStore.getState().serverTasks.length, 1);
  assert.equal(useTaskStore.getState().serverTasksLoaded, true);
});

// ---- P2c review: race protections ------------------------------------------
//
// Four failure classes from the PR #95 review: (1) logout wipe racing an
// in-flight write-back, (2) a server switch mid-load writing server A's rows
// into server B's scope, (3) task:deleted mid write-back resurrecting the row,
// (4) task:created mid write-back being purged as "absent". Plus the revision
// tie semantics (events tie-break, snapshots don't except revision 0) and the
// runtime's synchronous era invalidation.

/** A repo wrapper that lets a test act exactly when a specific row is being
 *  written — the deterministic stand-in for "the event/logout landed while
 *  the write-back loop was mid-flight". */
function wrapRepo(repo: CacheRepo, hooks: {
  beforeApply?: (id: string, repo: CacheRepo) => void;
  afterApply?: (id: string, repo: CacheRepo) => Promise<void> | void;
}): CacheRepo {
  return {
    ...repo,
    async applyTaskEvent(scopeId: number, task: { id: string }) {
      hooks.beforeApply?.(task.id, repo);
      const done = repo.applyTaskEvent(scopeId, task as never);
      const result = await done;
      await hooks.afterApply?.(task.id, repo);
      return result;
    },
  } as CacheRepo;
}

test("review#1: a logout wipe mid write-back aborts the loop and leaves no rows behind", async () => {
  const base = createWebCacheRepo();
  // The wipe fires while row t3 is in flight — after its put has landed, like
  // a real resetAll racing the loop — and the holder detach makes every
  // subsequent per-write era check fail.
  let applied = 0;
  const repo = wrapRepo(base, {
    async afterApply(id) {
      applied += 1;
      if (id === "t3") {
        await base.wipeAll();
        clearActiveWebCache();
      }
    },
  });
  const scopeId = await attachMemoryWebCache("http://test", "user-1", "server-1", repo);
  const tasks = ["t1", "t2", "t3", "t4", "t5"].map((id, i) =>
    taskFixture({ id, channelId: `c${i}`, revision: 1 }));
  const token = captureTaskCacheToken();
  await persistServerTasksSnapshot(tasks, token);
  await settle();
  assert.equal(applied, 3, "write-back must stop at the first post-detach era check");
  assert.deepEqual((await base.getTaskRows(scopeId)).map((r) => r.id), [],
    "the wipe must be the last word — no exited user's rows may survive");
});

test("review#2: a server switch mid-load writes nothing into the new scope", async () => {
  // Channel-load shape (taskStore.loadTasks): no store generation gate, so
  // the cache era token is the only guard — exercise it end to end.
  const repoA = createWebCacheRepo();
  await attachMemoryWebCache("http://test", "user-1", "server-a", repoA);
  const resolvers: (() => void)[] = [];
  api.get = ((url: string) => {
    assert.equal(url, "/tasks/channel/c1");
    return new Promise((res) => { resolvers.push(() => res({ data: { tasks: [taskFixture({ id: "a1", channelId: "c1", revision: 1 })] } })); });
  }) as typeof api.get;
  const loading = useTaskStore.getState().loadTasks("c1");
  await settle();

  // Switch to server B while A's fetch is still pending.
  const repoB = createWebCacheRepo();
  const scopeB = await attachMemoryWebCache("http://test", "user-1", "server-b", repoB);

  resolvers.forEach((r) => r());
  await loading;
  await settle();
  assert.deepEqual((await repoB.getTaskRows(scopeB)).map((r) => r.id), [],
    "server A's rows must not land in server B's scope after the switch");
  assert.equal(activeWebCache()!.scopeId, scopeB, "precondition: server B's scope is the active one");
});

test("review#3: task:deleted landing mid write-back is not resurrected by the older list", async () => {
  const base = createWebCacheRepo();
  const handlers = wireSocket();
  const victim = taskFixture({ id: "victim", channelId: "c9", revision: 2, title: "doomed" });
  const first = taskFixture({ id: "first", channelId: "c1", revision: 1 });
  // While "first" is being written, the socket delivers victim's deletion.
  const repo = wrapRepo(base, {
    beforeApply(id) {
      if (id === "first") handlers["task:deleted"]({ channelId: "c9", taskId: "victim" });
    },
  });
  const scopeId = await attachMemoryWebCache("http://test", "user-1", "server-1", repo);
  await base.applyTaskEvent(scopeId, { id: victim.id, revision: 2, raw: victim as never });
  const token = captureTaskCacheToken();
  await persistServerTasksSnapshot([first, victim], token);
  await settle();
  const ids = (await base.getTaskRows(scopeId)).map((r) => r.id).sort();
  assert.deepEqual(ids, ["first"], "the deleted task must not be written back by the stale list");
});

test("review#4: task:created landing mid write-back is not purged as absent", async () => {
  const base = createWebCacheRepo();
  const handlers = wireSocket();
  const late = taskFixture({ id: "late", channelId: "c7", revision: 1, title: "born mid-loop" });
  const first = taskFixture({ id: "first", channelId: "c1", revision: 1 });
  // While "first" is being written, the socket delivers a brand-new task.
  const repo = wrapRepo(base, {
    beforeApply(id) {
      if (id === "first") handlers["task:created"]({ channelId: "c7", tasks: [late] });
    },
  });
  const scopeId = await attachMemoryWebCache("http://test", "user-1", "server-1", repo);
  const token = captureTaskCacheToken();
  await persistServerTasksSnapshot([first], token);
  await settle();
  const ids = (await base.getTaskRows(scopeId)).map((r) => r.id).sort();
  assert.deepEqual(ids, ["first", "late"], "a task created mid write-back must survive the absence purge");
});

test("review#6: private-channel rows do not seed the board (they flash — the snapshot never contains them)", async () => {
  const scopeId = await attachFreshCache();
  const repo = activeWebCache()!.repo;
  const channel = taskFixture({ id: "b1", channelType: "channel", channelId: "board-channel", revision: 1 });
  const joint = taskFixture({ id: "j1", channelType: "joint", channelId: "joint-channel", revision: 1 });
  const privateRow = taskFixture({ id: "p1", channelType: "private", channelId: "priv-channel", revision: 1 });
  for (const t of [channel, joint, privateRow]) {
    await repo.applyTaskEvent(scopeId, { id: t.id, revision: 1, raw: t as never });
  }

  api.get = (async () => {
    throw new Error("offline");
  }) as typeof api.get;
  await useTaskStore.getState().loadServerTasks();
  const seeded = useTaskStore.getState().serverTasks.map((t) => t.id).sort();
  assert.deepEqual(seeded, ["b1", "j1"], "the board seed is channel|joint only — private rows must not paint");
});

test("review#7: revision ties — live events tie-break, snapshots stay strict, revision 0 overwrites", async () => {
  const scopeId = await attachFreshCache();
  const repo = activeWebCache()!.repo;
  const handlers = wireSocket();

  const base = taskFixture({ id: "t7", revision: 2, title: "original" });
  await repo.applyTaskEvent(scopeId, { id: base.id, revision: 2, raw: base as never });

  // A rename that did NOT bump the revision arrives as a live event: ties go
  // to the event (it is newer in time than anything cached).
  handlers["task:updated"]({ channelId: "c1", task: taskFixture({ id: "t7", revision: 2, title: "renamed" }) });
  await settle();
  let rows = await repo.getTaskRows(scopeId);
  assert.equal((rows[0].raw as { title?: string }).title, "renamed",
    "a same-revision live event must land (renames without a revision bump)");

  // A snapshot carrying the OLD title at the same revision must NOT overwrite
  // the live row (a stale page can never replace same-revision live content).
  const token = captureTaskCacheToken();
  await persistServerTasksSnapshot([taskFixture({ id: "t7", revision: 2, title: "stale page" })], token);
  await settle();
  rows = await repo.getTaskRows(scopeId);
  assert.equal((rows[0].raw as { title?: string }).title, "renamed",
    "a same-revision snapshot row must not regress the live row");

  // Legacy revision-0 rows: the snapshot is server truth and may refresh them
  // (the PR contract: "0 can be overwritten").
  const legacy = taskFixture({ id: "legacy", revision: 0, channelId: "c2", title: "old zero" });
  await repo.applyTaskEvent(scopeId, { id: legacy.id, revision: 0, raw: legacy as never });
  await persistServerTasksSnapshot([taskFixture({ id: "legacy", revision: 0, channelId: "c2", title: "new zero" })], token);
  await settle();
  rows = await repo.getTaskRows(scopeId);
  const legacyRow = rows.find((r) => r.id === "legacy");
  assert.equal((legacyRow!.raw as { title?: string }).title, "new zero",
    "revision-0 snapshot rows must overwrite revision-0 cache rows");
});

test("review#5: attach() detaches the holder synchronously for the whole scope-open window", async () => {
  // A slow openScope stands in for the async IndexedDB open: from the moment
  // attach() is called until it completes, the runtime reports NO scope —
  // neither a stale seed read nor a stale write can slip through.
  const inner = createWebCacheRepo();
  let releaseOpen: (() => void) | null = null;
  const slowRepo: CacheRepo = {
    ...inner,
    openScope(...args: Parameters<CacheRepo["openScope"]>) {
      return new Promise((res) => {
        releaseOpen = () => res(inner.openScope(...args));
      });
    },
  } as CacheRepo;
  const runtime = await createWebCacheRuntime({ repo: slowRepo });
  const generationBefore = runtime.generation;
  const attaching = runtime.attach("http://test", "user-1", "server-1");
  assert.equal(runtime.scopeId, null, "scope must read null during the open window");
  assert.equal(runtime.serverId, null, "serverId must read null during the open window too");
  assert.equal(runtime.generation, generationBefore + 1, "the era must bump synchronously at attach entry");
  releaseOpen!();
  await attaching;
  assert.equal(typeof runtime.scopeId, "number", "the scope adopts once openScope completes");
  assert.equal(runtime.serverId, "server-1");

  const wipeStarted = runtime.resetAll();
  assert.equal(runtime.scopeId, null, "resetAll must detach synchronously too");
  assert.equal(runtime.serverId, null);
  await wipeStarted;
});

test("naming ruling: identical-identity re-attach returns without bumping the generation", async () => {
  // Cold start re-attaches the same persisted identity while a MainLayout
  // load may already be reading the holder — the repeat attach must be a
  // no-op, not a transition (Firstmate ruling on the #95/#97 counter).
  const runtime = await createWebCacheRuntime({ repo: createWebCacheRepo() });
  const scope1 = await runtime.attach("http://test", "user-1", "server-1");
  const generationAfterFirst = runtime.generation;

  const scope2 = await runtime.attach("http://test", "user-1", "server-1");
  assert.equal(scope2, scope1, "same identity must reuse the live scope");
  assert.equal(runtime.generation, generationAfterFirst, "same identity must not bump the generation");
  assert.equal(runtime.serverId, "server-1");

  // A different server is a real transition: bump + switch.
  const scope3 = await runtime.attach("http://test", "user-1", "server-2");
  assert.notEqual(scope3, scope1);
  assert.equal(runtime.generation, generationAfterFirst + 1, "a server switch must bump the generation");
  assert.equal(runtime.serverId, "server-2");

  // After resetAll the identity is gone: re-attaching it is a fresh attach.
  await runtime.resetAll();
  const scope4 = await runtime.attach("http://test", "user-1", "server-2");
  assert.equal(typeof scope4, "number");
  assert.ok(runtime.generation > generationAfterFirst + 1, "post-reset re-attach must be a new era");
});
