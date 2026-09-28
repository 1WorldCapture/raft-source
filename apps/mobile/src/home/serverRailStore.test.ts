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
  const result = await selectedPromise;
  assert.equal(result.stale, false);
  assert.equal(result.server?.id, "b");
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
  assert.equal((await promiseB).server?.id, "b");
  fakeA.respond(0, [{ id: "a", name: "A", slug: "a" }]);
  fakeA.respond(1, [{ serverId: "a", unreadCount: 99 }]);
  assert.deepEqual(await promiseA, { stale: true, server: null }, "stale load reports stale, not empty");
  const state = useServerRailStore.getState();
  assert.deepEqual(state.servers.map((s) => s.id), ["b"]);
  assert.equal(state.serverUnread.a, undefined);
  assert.equal(state.serverUnread.b, 7);
});

test("a badge refresh during an in-flight load does not invalidate it (cold-start race)", async () => {
  resetStore();
  const load = deferredClient();
  const loadPromise = useServerRailStore.getState().loadServers(load.client, "a");
  const badges = deferredClient();
  const badgePromise = useServerRailStore.getState().refreshBadges(badges.client);
  // The badge response lands first; the load must still apply.
  badges.respond(0, [{ serverId: "a", unreadCount: 4 }]);
  await badgePromise;
  load.respond(0, [{ id: "a", name: "A", slug: "a" }]);
  load.respond(1, [{ serverId: "a", unreadCount: 1 }]);
  const result = await loadPromise;
  assert.equal(result.stale, false, "mount-time focus badge refresh cannot stale the initial load");
  assert.equal(result.server?.id, "a");
  assert.equal(useServerRailStore.getState().serverUnread.a, 1, "load's fresher summary wins over the badge response");
});

test("a load supersedes an older in-flight badge response", async () => {
  resetStore();
  const badges = deferredClient();
  const badgePromise = useServerRailStore.getState().refreshBadges(badges.client);
  const load = deferredClient();
  const loadPromise = useServerRailStore.getState().loadServers(load.client, null);
  load.respond(0, [{ id: "a", name: "A", slug: "a" }]);
  load.respond(1, [{ serverId: "a", unreadCount: 2 }]);
  await loadPromise;
  badges.respond(0, [{ serverId: "a", unreadCount: 8 }]);
  await badgePromise;
  assert.equal(useServerRailStore.getState().serverUnread.a, 2, "the older badge response is dropped");
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

/** Fake patch client for reorder tests. */
function patchClient(mode: "ok-confirm" | "ok-same" | "fail"): ServerRailClient {
  return {
    get: async () => ({}),
    patch: async () => {
      if (mode === "fail") throw new Error("boom");
      if (mode === "ok-same") return { notAnOrder: true };
      return { serverOrder: ["b", "a", "c"], serverOrderVersion: 4 };
    },
  };
}

test("reorderServers applies optimistically, then adopts the server-confirmed order", async () => {
  resetStore();
  useServerRailStore.setState({ servers: [server("a"), server("b"), server("c")] });
  const saved = await useServerRailStore.getState().reorderServers(patchClient("ok-confirm"), ["c", "a", "b"]);
  assert.equal(saved, true);
  assert.deepEqual(useServerRailStore.getState().servers.map((s) => s.id), ["b", "a", "c"], "server's canonical order wins");
});

test("reorderServers keeps the optimistic order when the response has no array", async () => {
  resetStore();
  useServerRailStore.setState({ servers: [server("a"), server("b"), server("c")] });
  const saved = await useServerRailStore.getState().reorderServers(patchClient("ok-same"), ["b", "c", "a"]);
  assert.equal(saved, true);
  assert.deepEqual(useServerRailStore.getState().servers.map((s) => s.id), ["b", "c", "a"]);
});

test("reorderServers rolls back to the previous order when the patch fails", async () => {
  resetStore();
  useServerRailStore.setState({ servers: [server("a"), server("b"), server("c")] });
  const saved = await useServerRailStore.getState().reorderServers(patchClient("fail"), ["c", "b", "a"]);
  assert.equal(saved, false);
  assert.deepEqual(useServerRailStore.getState().servers.map((s) => s.id), ["a", "b", "c"], "rolled back");
});
