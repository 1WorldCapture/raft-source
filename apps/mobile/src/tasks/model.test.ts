import assert from "node:assert/strict";
import test from "node:test";
import { ApiError } from "../api/client";
import {
  groupTasks,
  isInvalidCursor,
  mergeFetchedTasks,
  parseTaskPage,
  statusWrite,
  taskStatusOptions,
  type RaftTask,
} from "./model.ts";

function task(id: string, status: RaftTask["status"], taskNumber: number, claimedById: string | null = null): RaftTask {
  return {
    id,
    messageId: id,
    channelId: "c1",
    channelName: "all",
    channelType: "channel",
    taskNumber,
    title: id,
    description: "notes",
    status,
    createdByType: "user",
    createdById: "u1",
    createdByName: "Lyon",
    claimedByType: claimedById ? "user" : null,
    claimedById,
    claimedByName: claimedById ? "Dev" : null,
    createdAt: null,
    updatedAt: null,
    revision: 3,
    isLegacy: false,
  };
}

test("parseTaskPage keeps full fields and drops a broken row", () => {
  const page = parseTaskPage({
    next_cursor: "cursor-2",
    tasks: [
      { id: "t1", channelId: "c1", taskNumber: 4, title: "Ship", description: "body", status: "todo", claimedByName: "dev", revision: 2, isLegacy: false },
      { id: "bad", status: "nope" },
    ],
  });
  assert.equal(page.nextCursor, "cursor-2");
  assert.equal(page.tasks.length, 1);
  assert.equal(page.tasks[0]?.description, "body");
  assert.equal(page.tasks[0]?.claimedByName, "dev");
  assert.equal(parseTaskPage({ tasks: [] }).nextCursor, null);
});

test("groupTasks orders statuses and sorts each group by task number descending", () => {
  const groups = groupTasks([
    task("a", "done", 1),
    task("b", "todo", 2),
    task("c", "todo", 9),
    task("d", "in_progress", 3),
  ]);
  assert.deepEqual(groups.map((group) => group.status), ["todo", "in_progress", "in_review", "done", "closed"]);
  assert.deepEqual(groups[0]?.tasks.map((item) => item.id), ["c", "b"]);
  assert.deepEqual(groups[3]?.tasks.map((item) => item.id), ["a"]);
  assert.equal(groups[2]?.tasks.length, 0);
});

test("status options follow the member, admin, and guest rules", () => {
  assert.deepEqual(taskStatusOptions("todo", "member").map((option) => option.id), ["todo", "in_progress", "closed"]);
  assert.deepEqual(taskStatusOptions("in_progress", "member").map((option) => option.id), ["in_progress", "in_review", "done", "closed"]);
  assert.deepEqual(taskStatusOptions("in_review", "member").map((option) => option.id), ["in_review", "done", "in_progress", "closed"]);
  assert.deepEqual(taskStatusOptions("done", "member").map((option) => option.id), ["done", "todo", "in_progress", "in_review", "closed"]);
  assert.deepEqual(taskStatusOptions("closed", "member").map((option) => option.labelId), [
    "task.status.closed",
    "task.status.reopenToTodo",
    "task.status.inProgress",
  ]);
  assert.deepEqual(taskStatusOptions("todo", "admin").map((option) => option.id), ["todo", "in_progress", "in_review", "done", "closed"]);
  assert.deepEqual(taskStatusOptions("closed", "owner").map((option) => option.id), ["todo", "in_progress", "in_review", "done", "closed"]);
  assert.equal(taskStatusOptions("closed", "owner").find((option) => option.id === "todo")?.labelId, "task.status.reopenToTodo");
  assert.deepEqual(taskStatusOptions("todo", "guest"), []);
});

test("unassigned todo to in_progress is a claim, and an assigned one is a status write", () => {
  assert.deepEqual(statusWrite(task("a", "todo", 1), "in_progress"), { kind: "claim" });
  assert.deepEqual(statusWrite(task("a", "todo", 1, "u2"), "in_progress"), { kind: "status", status: "in_progress" });
  assert.deepEqual(statusWrite(task("a", "todo", 1), "closed"), { kind: "status", status: "closed" });
  assert.deepEqual(statusWrite(task("a", "todo", 1), "todo"), { kind: "same" });
});

test("an invalid cursor is the 400 the server returns for a stale page token", () => {
  assert.equal(isInvalidCursor(new ApiError("Invalid cursor", 400, { error: "Invalid cursor" })), true);
  assert.equal(isInvalidCursor(new ApiError("Invalid limit value", 400, null)), false);
});

test("mergeFetchedTasks keeps a live edit and drops a live delete", () => {
  const fetched = [task("a", "todo", 1), task("b", "todo", 2)];
  const live = [task("a", "done", 1)];
  const merged = mergeFetchedTasks(fetched, live, new Set(["a", "b"]));
  assert.deepEqual(merged.map((item) => item.id), ["a"]);
  assert.equal(merged[0]?.status, "done");
});
