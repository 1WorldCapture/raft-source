import assert from "node:assert/strict";
import { mock, test } from "node:test";
import { ApiError, type ApiClient } from "../api/client";
import { ASSIGNEE_CONFLICT } from "./model";
import { useTaskStore } from "./store";

function client(handlers: Record<string, () => unknown>): ApiClient {
  const get = (async (path: string) => {
    const handler = handlers[`GET ${path}`];
    if (!handler) throw new Error(`unexpected GET ${path}`);
    return handler();
  }) as ApiClient["get"];
  const patch = (async (path: string, body?: unknown) => {
    const handler = handlers[`PATCH ${path}`];
    if (!handler) throw new Error(`unexpected PATCH ${path} ${JSON.stringify(body)}`);
    return handler();
  }) as ApiClient["patch"];
  return { get, patch } as ApiClient;
}

function row(id: string, status: string, taskNumber: number, extra: Record<string, unknown> = {}) {
  return { id, channelId: "c1", taskNumber, title: id, description: "notes", status, revision: 4, ...extra };
}

test("load walks cursors and restarts after an invalid cursor", async () => {
  useTaskStore.getState().reset();
  let roots = 0;
  const api = client({
    "GET /tasks/server?limit=200": () => {
      roots += 1;
      if (roots === 1) return { tasks: [row("stale", "todo", 1)], next_cursor: "page-2" };
      return { tasks: [row("fresh", "todo", 2)], next_cursor: null };
    },
    "GET /tasks/server?limit=200&cursor=page-2": () => {
      throw new ApiError("Invalid cursor", 400, { error: "Invalid cursor" });
    },
  });
  await useTaskStore.getState().load(api);
  assert.equal(roots, 2);
  assert.deepEqual(useTaskStore.getState().tasks.map((task) => task.id), ["fresh"]);
  assert.equal(useTaskStore.getState().loaded, true);
});

test("load keeps two pages when every cursor is valid", async () => {
  useTaskStore.getState().reset();
  const api = client({
    "GET /tasks/server?limit=200": () => ({ tasks: [row("a", "todo", 2)], next_cursor: "page-2" }),
    "GET /tasks/server?limit=200&cursor=page-2": () => ({ tasks: [row("b", "in_progress", 1)], next_cursor: null }),
  });
  await useTaskStore.getState().load(api);
  assert.deepEqual(useTaskStore.getState().tasks.map((task) => task.id), ["a", "b"]);
});

test("a delete that arrives during the fetch is not restored by the page", async () => {
  useTaskStore.getState().reset();
  let release: (value: unknown) => void = () => {};
  const api = client({
    "GET /tasks/server?limit=200": () => new Promise((resolve) => {
      release = resolve;
    }),
  });
  const pending = useTaskStore.getState().load(api);
  useTaskStore.getState().applyDeleted({ channelId: "c1", taskId: "a" });
  release({ tasks: [row("a", "todo", 1)], next_cursor: null });
  await pending;
  assert.deepEqual(useTaskStore.getState().tasks, []);
});

test("unassigned todo to in_progress claims, and a failed status write rolls back", async () => {
  useTaskStore.getState().reset();
  useTaskStore.setState({ tasks: [{ ...row("a", "todo", 1), messageId: "a", channelName: null, channelType: null, createdByType: null, createdById: null, createdByName: null, claimedByType: null, claimedById: null, claimedByName: null, createdAt: null, updatedAt: null, revision: 4, isLegacy: false }], loaded: true });
  const claimed = mock.fn(() => ({ task: row("a", "in_progress", 1, { claimedById: "u1", claimedByType: "user" }) }));
  const api = client({ "PATCH /tasks/a/claim": claimed });
  await useTaskStore.getState().setStatus(api, "a", "in_progress");
  assert.equal(claimed.mock.calls.length, 1);
  assert.equal(useTaskStore.getState().tasks[0]?.status, "in_progress");

  const failing = client({
    "PATCH /tasks/a/status": () => {
      throw new ApiError("status rejected", 409, { error: "status rejected" });
    },
  });
  await useTaskStore.getState().setStatus(failing, "a", "done");
  assert.equal(useTaskStore.getState().tasks[0]?.status, "in_progress");
  assert.equal(useTaskStore.getState().error, "status rejected");
});

test("an assignee conflict rolls back, says the task changed, and reloads", async () => {
  useTaskStore.getState().reset();
  useTaskStore.setState({
    tasks: [{
      id: "a", messageId: "a", channelId: "c1", channelName: null, channelType: null, taskNumber: 1, title: "a", description: null,
      status: "todo", createdByType: null, createdById: null, createdByName: null, claimedByType: null, claimedById: null, claimedByName: null,
      createdAt: null, updatedAt: null, revision: 4, isLegacy: false,
    }],
    loaded: true,
  });
  const api = client({
    "PATCH /tasks/a/assignee": () => {
      throw new ApiError("revision mismatch", 409, { error: "revision mismatch" });
    },
    "GET /tasks/server?limit=200": () => ({ tasks: [row("a", "todo", 1, { claimedById: "other", revision: 5 })], next_cursor: null }),
  });
  await useTaskStore.getState().setAssignee(api, "a", { type: "user", id: "me" });
  assert.equal(useTaskStore.getState().error, ASSIGNEE_CONFLICT);
  assert.equal(useTaskStore.getState().tasks[0]?.claimedById, "other");
  assert.equal(useTaskStore.getState().tasks[0]?.revision, 5);
});

test("socket events insert, update, and delete", () => {
  useTaskStore.getState().reset();
  useTaskStore.getState().applyCreated({ channelId: "c1", tasks: [row("a", "todo", 1)] });
  useTaskStore.getState().applyUpdated({ channelId: "c1", task: row("a", "done", 1) });
  assert.equal(useTaskStore.getState().tasks[0]?.status, "done");
  useTaskStore.getState().applyDeleted({ channelId: "c1", taskId: "a" });
  assert.deepEqual(useTaskStore.getState().tasks, []);
});
