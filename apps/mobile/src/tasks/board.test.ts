import assert from "node:assert/strict";
import test from "node:test";
import type { RaftTask, TaskStatus } from "./model";
import {
  boardFromTasks,
  buildBoard,
  isDoneToday,
  parseBoardTask,
  STALE_MS,
  type BoardTask,
} from "./board.ts";

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
    threadChannelId: null,
    lastActivityAt: "2026-09-27T10:00:00.000Z",
    latestActivity: null,
    replyCount: 0,
    unreadCount: 0,
    mentionsMe: false,
    ...overrides,
  };
}

const NOW = new Date("2026-09-27T12:00:00.000Z");

test("buildBoard groups into the four sections and drops closed", () => {
  const board = buildBoard(
    [
      boardTask("t1", { status: "in_review" }),
      boardTask("t2", { status: "in_progress" }),
      boardTask("t3", { status: "done", completedAt: new Date(2026, 8, 27, 9, 0).toISOString() }), // local today
      boardTask("t4", { status: "todo" }),
      boardTask("t5", { status: "closed" }),
      boardTask("t6", { status: "done", completedAt: new Date(2026, 8, 26, 9, 0).toISOString() }), // yesterday local → hidden
    ],
    NOW,
  );
  assert.deepEqual(board.needsMe.map((r) => r.task.id), ["t1"]);
  assert.deepEqual(board.inProgress.map((r) => r.task.id), ["t2"]);
  assert.deepEqual(board.doneToday.map((r) => r.task.id), ["t3"]);
  assert.deepEqual(board.todo.map((r) => r.task.id), ["t4"]);
});

test("needsMe wins once per task; pagination duplicates dedup by id", () => {
  const inReviewAndMentioned = boardTask("t1", { status: "in_review", mentionsMe: true });
  const board = buildBoard([inReviewAndMentioned, { ...inReviewAndMentioned }, boardTask("t2", { mentionsMe: true })], NOW);
  assert.equal(board.needsMe.length, 2, "mentioned task joins in_review task; the duplicated row counts once");
  assert.equal(board.inProgress.length, 0, "nothing leaks into inProgress");
});

test("inProgress orders by lastActivityAt desc, taskNumber breaks ties (all fresh)", () => {
  const board = buildBoard(
    [
      boardTask("t1", { taskNumber: 1, lastActivityAt: "2026-09-27T11:45:00.000Z" }),
      boardTask("t2", { taskNumber: 2, lastActivityAt: "2026-09-27T11:35:00.000Z" }),
      boardTask("t3", { taskNumber: 3, lastActivityAt: "2026-09-27T11:35:00.000Z" }),
    ],
    NOW,
  );
  assert.deepEqual(board.inProgress.map((r) => r.task.id), ["t1", "t3", "t2"], "newest first; tie → higher taskNumber");
});

test("stale: strictly beyond STALE_MS flags and pins to top, longest-stuck first", () => {
  const board = buildBoard(
    [
      boardTask("fresh", { lastActivityAt: new Date(NOW.getTime() - STALE_MS).toISOString() }), // exactly 30min → not stale
      boardTask("justStale", { lastActivityAt: new Date(NOW.getTime() - STALE_MS - 1).toISOString() }),
      boardTask("veryStale", { lastActivityAt: new Date(NOW.getTime() - STALE_MS * 10).toISOString() }),
      boardTask("active", { lastActivityAt: new Date(NOW.getTime() - 60_000).toISOString() }),
    ],
    NOW,
  );
  const ids = board.inProgress.map((r) => r.task.id);
  assert.deepEqual(ids, ["veryStale", "justStale", "active", "fresh"]);
  assert.deepEqual(board.inProgress.map((r) => r.stale), [true, true, false, false]);
});

test("doneToday uses the LOCAL calendar day boundaries", () => {
  const localNow = new Date(2026, 8, 28, 0, 30); // local Sep 28 00:30
  assert.equal(isDoneToday(new Date(2026, 8, 28, 0, 0).toISOString(), localNow), true, "local midnight counts");
  assert.equal(isDoneToday(new Date(2026, 8, 27, 23, 59).toISOString(), localNow), false, "yesterday 23:59 does not");
  assert.equal(isDoneToday(null, localNow), false);
  assert.equal(isDoneToday("not-a-date", localNow), false);
});

test("boardFromTasks fills neutral board defaults from plain tasks", () => {
  const plain: RaftTask = {
    id: "r1",
    messageId: "r1",
    channelId: "c",
    channelName: "all",
    channelType: "channel",
    taskNumber: 7,
    title: "T",
    description: "d",
    status: "todo",
    createdByType: "user",
    createdById: "u",
    createdByName: null,
    claimedByType: null,
    claimedById: null,
    claimedByName: null,
    createdAt: "2026-09-27T07:00:00.000Z",
    updatedAt: "2026-09-27T07:30:00.000Z",
    revision: 0,
    isLegacy: false,
  };
  const [adapted] = boardFromTasks([plain]);
  assert.equal(adapted.lastActivityAt, "2026-09-27T07:30:00.000Z", "falls back to updatedAt");
  assert.equal(adapted.mentionsMe, false);
  assert.equal(adapted.unreadCount, 0);
  assert.equal(adapted.latestActivity, null);
  assert.equal(adapted.threadChannelId, null);
});

test("parseBoardTask validates the contract payload", () => {
  const base = boardTask("p1");
  const parsed = parseBoardTask({ ...base, latestActivity: { kind: "reply", at: base.lastActivityAt, actorType: "agent", actorId: "a", actorName: "Dev", snippet: "done", eventType: null }, unreadCount: 120 });
  assert.ok(parsed);
  assert.equal(parsed.unreadCount, 120);
  assert.equal(parsed.latestActivity?.kind, "reply");
  assert.equal(parsed.latestActivity?.snippet, "done");
  assert.equal(parseBoardTask({ ...base, lastActivityAt: undefined }), null, "lastActivityAt is required");
  assert.equal(parseBoardTask({ ...base, status: "bogus" }), null, "invalid status rejected");
  const negative = parseBoardTask({ ...base, unreadCount: -3, replyCount: 1.5 });
  assert.ok(negative);
  assert.equal(negative.unreadCount, 0, "negative clamps to 0");
  assert.equal(negative.replyCount, 1, "fractional floors");
});

test("board status query covers todo..done but never closed", async () => {
  const { BOARD_QUERY_STATUSES, boardStatusParam } = await import("./board.ts");
  assert.equal(boardStatusParam(), "todo,in_progress,in_review,done");
  assert.ok(!BOARD_QUERY_STATUSES.includes("closed" as TaskStatus));
});

test("BOARD_SECTIONS lists exactly the TaskBoard keys in display order", async () => {
  const { BOARD_SECTIONS } = await import("./board.ts");
  assert.deepEqual([...BOARD_SECTIONS], ["needsMe", "inProgress", "doneToday", "todo"]);
});

test("sectionHighlighted glows only for a non-empty needsMe", async () => {
  const { sectionHighlighted } = await import("./board.ts");
  assert.equal(sectionHighlighted("needsMe", 1), true);
  assert.equal(sectionHighlighted("needsMe", 0), false, "empty needsMe must not glow");
  assert.equal(sectionHighlighted("inProgress", 5), false);
  assert.equal(sectionHighlighted("doneToday", 3), false);
  assert.equal(sectionHighlighted("todo", 2), false);
});

test("a mention only lifts unfinished tasks; done stays in doneToday, closed stays hidden", () => {
  const board = buildBoard(
    [
      boardTask("t1", { status: "done", mentionsMe: true, completedAt: new Date(2026, 8, 27, 9, 0).toISOString() }),
      boardTask("t2", { status: "closed", mentionsMe: true }),
      boardTask("t3", { status: "todo", mentionsMe: true, lastActivityAt: "2026-09-27T11:00:00.000Z" }),
      boardTask("t4", { status: "in_progress", mentionsMe: true, lastActivityAt: "2026-09-27T10:30:00.000Z" }),
    ],
    NOW,
  );
  assert.deepEqual(board.needsMe.map((r) => r.task.id), ["t3", "t4"], "only todo/in_progress mentions lift");
  assert.deepEqual(board.doneToday.map((r) => r.task.id), ["t1"], "done+mention lands in doneToday, not needsMe");
  assert.equal(board.todo.length, 0);
  assert.equal(board.inProgress.length, 0);
});

test("stale flags apply to in_progress rows only", () => {
  const old = "2026-09-27T06:00:00.000Z"; // 6h before NOW
  const board = buildBoard(
    [
      boardTask("t1", { status: "in_progress", lastActivityAt: old }),
      boardTask("t2", { status: "in_review", lastActivityAt: old }),
      boardTask("t3", { status: "todo", lastActivityAt: old }),
      boardTask("t4", { status: "done", completedAt: new Date(2026, 8, 27, 9, 0).toISOString(), lastActivityAt: old }),
    ],
    NOW,
  );
  assert.equal(board.inProgress[0].stale, true);
  assert.equal(board.needsMe[0].stale, false, "in_review rows never flag stale");
  assert.equal(board.todo[0].stale, false);
  assert.equal(board.doneToday[0].stale, false);
});

test("doneToday orders by completedAt desc, immune to later thread replies", () => {
  const board = buildBoard(
    [
      boardTask("early", { status: "done", completedAt: new Date(2026, 8, 27, 9, 0).toISOString(), lastActivityAt: "2026-09-27T11:55:00.000Z" }),
      boardTask("late", { status: "done", completedAt: new Date(2026, 8, 27, 10, 0).toISOString(), lastActivityAt: "2026-09-27T08:00:00.000Z" }),
    ],
    NOW,
  );
  assert.deepEqual(board.doneToday.map((r) => r.task.id), ["late", "early"], "completion time rules, not activity");
});

test("reconcileByIds updates returned rows and drops requested-but-missing ids", async () => {
  const { reconcileByIds } = await import("./board.ts");
  const t1 = boardTask("t1");
  const t2 = boardTask("t2");
  const t3 = boardTask("t3");
  const t2Updated = { ...t2, status: "done" as const, completedAt: new Date(2026, 8, 27, 9, 0).toISOString() };
  const next = reconcileByIds([t1, t2, t3], [t2Updated], ["t2", "t3"]);
  assert.deepEqual(
    next.map((task) => task.id).sort(),
    ["t1", "t2"],
    "t3 was requested but not returned (closed) → removed; untouched t1 stays",
  );
  assert.equal(next.find((task) => task.id === "t2")?.status, "done", "returned row is the fresh one");
});
