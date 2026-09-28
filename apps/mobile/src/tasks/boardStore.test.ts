import assert from "node:assert/strict";
import test from "node:test";
import { createBoardStore, type BoardStoreDeps } from "./boardStore.ts";
import type { BoardTask } from "./board.ts";

/**
 * Deterministic timer double: scheduled callbacks queue up (with only the
 * latest debounce timer live, matching clearTimeout semantics) and the test
 * drains them on demand. No dependence on the runner's mock-timer lifecycle.
 */
function manualTimers() {
  const timers: Array<{ cancelled: boolean; fn: () => void }> = [];
  const deps: BoardStoreDeps = {
    setTimeout: (fn) => {
      const entry = { cancelled: false, fn };
      timers.push(entry);
      return entry;
    },
    clearTimeout: (handle) => {
      for (const entry of timers) if (entry === handle) entry.cancelled = true;
    },
  };
  return {
    deps,
    async fire() {
      const due = timers.splice(0).filter((entry) => !entry.cancelled);
      for (const entry of due) entry.fn();
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    },
  };
}

function boardTask(id: string, overrides: Partial<BoardTask> = {}): BoardTask {
  return {
    id,
    messageId: id,
    channelId: "c1",
    channelName: "all",
    channelType: "channel",
    taskNumber: Number(id.replace(/\D/g, "")) || 1,
    title: `Task ${id}`,
    description: null,
    status: "in_progress",
    createdByType: "user",
    createdById: "u1",
    createdByName: "Lyon",
    claimedByType: "agent",
    claimedById: "a1",
    claimedByName: "Dev",
    createdAt: "2026-09-27T08:00:00.000Z",
    updatedAt: "2026-09-27T08:00:00.000Z",
    revision: 1,
    isLegacy: false,
    completedAt: null,
    threadChannelId: `thread-${id}`,
    lastActivityAt: "2026-09-27T10:00:00.000Z",
    latestActivity: null,
    replyCount: 0,
    unreadCount: 0,
    mentionsMe: false,
    ...overrides,
  };
}

function fakeClient(responder: (path: string) => { tasks: unknown[]; next_cursor: string | null } | Promise<{ tasks: unknown[]; next_cursor: string | null }>) {
  const calls: string[] = [];
  return {
    calls,
    async get<T>(path: string): Promise<T> {
      calls.push(path);
      return responder(path) as T;
    },
    async patch<T>(path: string): Promise<T> {
      calls.push(path);
      return responder(path) as unknown as T;
    },
  };
}

const ME = { type: "user" as const, id: "u1" };

function replyMessage(overrides: Record<string, unknown> = {}) {
  return {
    id: "m2",
    channelId: "thread-t1",
    senderType: "agent",
    senderId: "a1",
    senderName: "Dev",
    content: "fixed the build",
    createdAt: "2026-09-27T11:30:00.000Z",
    ...overrides,
  } as never;
}

test("load pages through view=board until no cursor and stores the tasks", async () => {
  const store = createBoardStore();
  let page = 0;
  const client = fakeClient(() => {
    page += 1;
    if (page === 1) return { tasks: [boardTask("t1")], next_cursor: "c1" };
    return { tasks: [boardTask("t2")], next_cursor: null };
  });
  await store.getState().load(client);
  assert.equal(store.getState().loaded, true);
  assert.deepEqual(store.getState().tasks.map((task) => task.id), ["t1", "t2"]);
  assert.equal(client.calls.length, 2);
  assert.ok(client.calls[0].includes("view=board"), client.calls[0]);
  assert.ok(client.calls[0].includes("status=todo%2Cin_progress%2Cin_review%2Cdone"), "board status filter present");
  assert.ok(client.calls[0].includes("completedAfter="));
  assert.ok(client.calls[1].includes("cursor=c1"));
});

test("noteThreadActivity patches optimistically then recalibrates by ids after debounce", async () => {
  const timers = manualTimers();
  const store = createBoardStore(timers.deps);
  const t1 = boardTask("t1");
  let responderPayload: { tasks: unknown[]; next_cursor: string | null } = { tasks: [t1], next_cursor: null };
  const client = fakeClient(() => responderPayload);
  await store.getState().load(client);
  assert.equal(client.calls.length, 1, "load fetched once");

  store.getState().noteThreadActivity(client, { threadChannelId: "thread-t1", parentMessageId: "t1", latestReply: replyMessage() }, ME);
  const patched = store.getState().tasks[0];
  assert.equal(patched.unreadCount, 1, "reply from someone else bumps unread immediately");
  assert.equal(patched.latestActivity?.actorName, "Dev");
  assert.equal(patched.latestActivity?.snippet, "fixed the build");
  assert.equal(client.calls.length, 1, "no fetch before the debounce fires");

  responderPayload = { tasks: [{ ...t1, status: "in_review" as const, unreadCount: 2 }], next_cursor: null };
  await timers.fire();
  assert.equal(client.calls.length, 2, "one recalibration fetch after debounce");
  assert.ok(client.calls[1].includes("ids=t1"), client.calls[1]);
  assert.ok(client.calls[1].includes("status="), "recalibration keeps the status filter");
  const recalibrated = store.getState().tasks[0];
  assert.equal(recalibrated.unreadCount, 2, "server truth replaces the optimistic patch");
  assert.equal(recalibrated.status, "in_review");
});

test("a thread event whose id the recalibration drops removes the row (closed elsewhere)", async () => {
  const timers = manualTimers();
  const store = createBoardStore(timers.deps);
  const client = fakeClient(() => ({ tasks: [], next_cursor: null }));
  await store.getState().load(client);
  store.getState().noteThreadActivity(client, { threadChannelId: "thread-t1", parentMessageId: "t1", latestReply: replyMessage() }, ME);
  await timers.fire();
  assert.deepEqual(store.getState().tasks.map((task) => task.id), [], "requested-but-missing id is removed");
});

test("my own reply clears mentionsMe and does not bump unread", async () => {
  const timers = manualTimers();
  const store = createBoardStore(timers.deps);
  const t1 = boardTask("t1", { mentionsMe: true, status: "todo" });
  const client = fakeClient(() => ({ tasks: [t1], next_cursor: null }));
  await store.getState().load(client);
  store.getState().noteThreadActivity(client, { threadChannelId: "thread-t1", parentMessageId: "t1", latestReply: replyMessage({ senderType: "user", senderId: "u1", senderName: "Lyon" }) }, ME);
  const patched = store.getState().tasks[0];
  assert.equal(patched.unreadCount, 0, "own reply never counts unread");
  assert.equal(patched.mentionsMe, false, "my reply clears the mention lift");
});

test("out-of-order thread events leave the row untouched", async () => {
  const timers = manualTimers();
  const store = createBoardStore(timers.deps);
  const t1 = boardTask("t1", { lastActivityAt: "2026-09-27T11:00:00.000Z" });
  const client = fakeClient(() => ({ tasks: [t1], next_cursor: null }));
  await store.getState().load(client);
  store.getState().noteThreadActivity(client, { threadChannelId: "thread-t1", parentMessageId: "t1", latestReply: replyMessage({ createdAt: "2026-09-27T10:30:00.000Z" }) }, ME);
  const patched = store.getState().tasks[0];
  assert.equal(patched.lastActivityAt, "2026-09-27T11:00:00.000Z", "older event does not regress activity");
  assert.equal(patched.unreadCount, 0);
});

test("noteTaskActivity batches bursts into one fetch and chunks past 50 ids", async () => {
  const timers = manualTimers();
  const store = createBoardStore(timers.deps);
  const many = Array.from({ length: 55 }, (_, i) => boardTask(`t${i + 1}`));
  const client = fakeClient(() => ({ tasks: many, next_cursor: null }));
  await store.getState().load(client);
  client.calls.length = 0;
  for (let i = 1; i <= 55; i += 1) store.getState().noteTaskActivity(client, `t${i}`);
  await timers.fire();
  assert.equal(client.calls.length, 2, "55 ids split into two ≤50 batches");
  const first = new URLSearchParams(client.calls[0].split("?")[1]);
  const second = new URLSearchParams(client.calls[1].split("?")[1]);
  assert.equal(first.get("ids").split(",").length, 50);
  assert.equal(second.get("ids").split(",").length, 5);
});

test("a failing recalibration keeps the current rows for the next retry", async () => {
  const timers = manualTimers();
  const store = createBoardStore(timers.deps);
  const t1 = boardTask("t1");
  const client = fakeClient((path) => {
    if (path.includes("ids=")) throw new Error("offline");
    return { tasks: [t1], next_cursor: null };
  });
  await store.getState().load(client);
  store.getState().noteTaskActivity(client, "t1");
  await timers.fire();
  assert.deepEqual(store.getState().tasks.map((task) => task.id), ["t1"], "row survives the failed recalibration");
  assert.equal(store.getState().error, null, "recalibration failures are not surfaced as load errors");
});

test("bumpTick advances the tick counter for relative-time rerenders", () => {
  const store = createBoardStore();
  const before = store.getState().tick;
  store.getState().bumpTick();
  assert.equal(store.getState().tick, before + 1);
});

test("approveTask moves the row into done optimistically, server truth wins", async () => {
  const fakeNow = new Date(2026, 8, 27, 12, 0);
  const timers = manualTimers();
  const store = createBoardStore({ ...timers.deps, now: () => fakeNow });
  const t1 = boardTask("t1", { status: "in_review" });
  const serverDone = { ...t1, status: "done", completedAt: new Date(2026, 8, 27, 11, 58).toISOString(), title: "Server title" };
  const client = fakeClient((path) => (path.includes("/status") ? { task: serverDone } : { tasks: [t1], next_cursor: null }));
  await store.getState().load(client);
  const ok = await store.getState().approveTask(client, "t1");
  assert.equal(ok, true);
  const row = store.getState().tasks[0];
  assert.equal(row.status, "done");
  assert.equal(row.completedAt, serverDone.completedAt, "server completedAt replaces the optimistic one");
  assert.equal(row.title, "Server title", "server base fields merge into the board row");
  assert.ok(client.calls.some((path) => path.includes("/tasks/t1/status")), "PATCH hit the status endpoint");
});

test("approveTask reverts the row and reports failure when the PATCH fails", async () => {
  const fakeNow = new Date(2026, 8, 27, 12, 0);
  const timers = manualTimers();
  const store = createBoardStore({ ...timers.deps, now: () => fakeNow });
  const t1 = boardTask("t1", { status: "in_review" });
  const client = fakeClient((path) => {
    if (path.includes("/status")) throw new Error("conflict");
    return { tasks: [t1], next_cursor: null };
  });
  await store.getState().load(client);
  const ok = await store.getState().approveTask(client, "t1");
  assert.equal(ok, false);
  const row = store.getState().tasks[0];
  assert.equal(row.status, "in_review", "row reverts to its original section");
  assert.equal(row.completedAt, null);
});

test("bumpTick reloads with the new midnight after the calendar day rolls over", async () => {
  let fakeNow = new Date(2026, 8, 27, 23, 59);
  const timers = manualTimers();
  const store = createBoardStore({ ...timers.deps, now: () => fakeNow });
  const t1 = boardTask("t1", { status: "done", completedAt: new Date(2026, 8, 27, 9, 0).toISOString() });
  const client = fakeClient(() => ({ tasks: [t1], next_cursor: null }));
  await store.getState().load(client);
  assert.equal(client.calls.length, 1);
  const beforeCompletedAfter = new URLSearchParams(client.calls[0].split("?")[1]).get("completedAfter");

  fakeNow = new Date(2026, 8, 28, 0, 1); // next local day
  store.getState().bumpTick(client);
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(client.calls.length, 2, "day rollover triggers a reload from page 1");
  const afterCompletedAfter = new URLSearchParams(client.calls[1].split("?")[1]).get("completedAfter");
  assert.notEqual(afterCompletedAfter, beforeCompletedAfter, "completedAfter moved to the new midnight");

  store.getState().bumpTick(client); // same day now — no extra fetch
  await Promise.resolve();
  assert.equal(client.calls.length, 2, "ticks within the same day do not reload");
});
