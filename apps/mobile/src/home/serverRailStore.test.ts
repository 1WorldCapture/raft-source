import assert from "node:assert/strict";
import test from "node:test";
import type { RaftServer } from "../model/messages.ts";
import { orderServersByStoredIds, useServerRailStore, type ServerRailClient } from "./serverRailStore.ts";

function server(id: string, name = id): RaftServer {
  return { id, name, slug: id };
}

/** Fake client with per-path deferred responses so staleness is observable. */
function deferredClient() {
  let calls = 0;
  const pending: Array<{ path: string; resolve: (value: unknown) => void }> = [];
  const client: ServerRailClient = {
    get: (path) => new Promise((resolve) => {
      calls += 1;
      pending.push({ path, resolve });
    }),
  };
  return {
    client,
    count: () => calls,
    respond(index: number, value: unknown) {
      pending[index].resolve(value);
    },
  };
}

function resetStore() {
  useServerRailStore.getState().reset();
}

test("orderServersByStoredIds reorders known ids, drops duplicates and appends the rest", () => {
  const servers = [server("a"), server("b"), server("c"), server("d")];
  assert.deepEqual(
    orderServersByStoredIds(servers, ["c", "a"]).map((s) => s.id),
    ["c", "a", "b", "d"],
  );
  assert.deepEqual(
    orderServersByStoredIds(servers, ["b", "b", "x-unknown", "d"]).map((s) => s.id),
    ["b", "d", "a", "c"],
    "unknown ids ignored, duplicates dropped, unseen servers appended in order",
  );
  assert.deepEqual(
    orderServersByStoredIds(servers, []).map((s) => s.id),
    ["a", "b", "c", "d"],
    "empty stored order keeps the current order",
  );
});

test("applyServerOrder reorders the stored list and ignores garbage payloads", () => {
  resetStore();
  useServerRailStore.setState({ servers: [server("a"), server("b"), server("c")] });
  useServerRailStore.getState().applyServerOrder(["c", "b", "a"]);
  assert.deepEqual(useServerRailStore.getState().servers.map((s) => s.id), ["c", "b", "a"]);
  useServerRailStore.getState().applyServerOrder(null);
  useServerRailStore.getState().applyServerOrder("nope");
  useServerRailStore.getState().applyServerOrder([42, "b"]);
  assert.deepEqual(useServerRailStore.getState().servers.map((s) => s.id), ["b", "c", "a"], "non-strings dropped; rest still applied");
});

test("loadServers applies the ordered list and selects the preferred server", async () => {
  resetStore();
  const fake = deferredClient();
  const selectedPromise = useServerRailStore.getState().loadServers(fake.client, "b");
  fake.respond(0, [{ id: "a", name: "A", slug: "a" }, { id: "b", name: "B", slug: "b" }]);
  fake.respond(1, [{ serverId: "a", unreadCount: 3 }, { serverId: "b", unreadCount: 0 }]);
  const selected = await selectedPromise;
  assert.equal(selected?.id, "b");
  const state = useServerRailStore.getState();
  assert.deepEqual(state.servers.map((s) => s.id), ["a", "b"]);
  assert.equal(state.serverUnread.a, 3);
  assert.equal(state.serverUnread.b, 0);
});

test("a stale loadServers response is dropped entirely (rapid A→B switch)", async () => {
  resetStore();
  useServerRailStore.setState({ servers: [server("old")] });
  const fakeA = deferredClient();
  const promiseA = useServerRailStore.getState().loadServers(fakeA.client, "a");
  const fakeB = deferredClient();
  const promiseB = useServerRailStore.getState().loadServers(fakeB.client, "b");
  // B resolves first; A's responses land afterwards and must be discarded.
  fakeB.respond(0, [{ id: "b", name: "B", slug: "b" }]);
  fakeB.respond(1, [{ serverId: "b", unreadCount: 7 }]);
  assert.equal((await promiseB)?.id, "b");
  fakeA.respond(0, [{ id: "a", name: "A", slug: "a" }]);
  fakeA.respond(1, [{ serverId: "a", unreadCount: 99 }]);
  assert.equal(await promiseA, null, "stale load resolves to null");
  const state = useServerRailStore.getState();
  assert.deepEqual(state.servers.map((s) => s.id), ["b"]);
  assert.equal(state.serverUnread.a, undefined);
  assert.equal(state.serverUnread.b, 7);
});

test("refreshBadges updates unread only and the later call wins", async () => {
  resetStore();
  useServerRailStore.setState({ servers: [server("a"), server("b")] });
  const first = deferredClient();
  const firstPromise = useServerRailStore.getState().refreshBadges(first.client);
  const second = deferredClient();
  const secondPromise = useServerRailStore.getState().refreshBadges(second.client);
  // The second call carries the newer ticket; resolve it first, then let the
  // first call's response land — it must be discarded.
  second.respond(0, [{ serverId: "a", unreadCount: 5 }, { serverId: "b", unreadCount: 6 }]);
  await secondPromise;
  first.respond(0, [{ serverId: "a", unreadCount: 1 }, { serverId: "b", unreadCount: 2 }]);
  await firstPromise;
  const state = useServerRailStore.getState();
  assert.deepEqual(state.serverUnread, { a: 5, b: 6 }, "the later refresh wins");
  assert.deepEqual(state.servers.map((s) => s.id), ["a", "b"], "server list untouched");
});

test("reset clears everything", () => {
  resetStore();
  useServerRailStore.setState({ servers: [server("a")], serverUnread: { a: 1 }, activityUnread: { a: 2 }, loadTicket: 9 });
  useServerRailStore.getState().reset();
  const state = useServerRailStore.getState();
  assert.deepEqual(state.servers, []);
  assert.deepEqual(state.serverUnread, {});
  assert.deepEqual(state.activityUnread, {});
  assert.equal(state.loadTicket, 0);
});
