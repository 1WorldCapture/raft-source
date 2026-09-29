import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import api from "../src/api/client";
import { useTaskStore } from "../src/store/taskStore";
import { registerTaskRealtimeHandlers } from "../src/store/taskRealtimeSync";
import { attachMemoryWebCache, clearActiveWebCache, activeWebCache } from "../src/cache/messageCache";
import { createWebCacheRepo } from "../src/cache/webCacheRepo";
import { taskRevisionOf } from "../src/cache/taskBoardCache";
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
