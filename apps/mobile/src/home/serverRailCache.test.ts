// Server-rail cache tests (#desktop-data-cache task #1): the store persists
// the ordered list through the REAL cache runtime (node:sqlite), a cold start
// reads it back, and logout/origin-change wipes it.
import assert from "node:assert/strict";
import test from "node:test";
import { openNodeSqliteDb } from "../cache/portNode.ts";
import { __resetCacheRuntimeSingleton, getCacheRuntime, initCacheRuntime } from "../cache/runtime.ts";
import { serversFromCacheValue } from "./serverRailCache.ts";
import { useServerRailStore, type ServerRailClient } from "./serverRailStore.ts";

function freshRuntime() {
  const runtime = initCacheRuntime({ openDb: () => openNodeSqliteDb(":memory:") });
  runtime.attach("https://raft.example", "user-1", "srv-a");
  return runtime;
}

/** Immediate-responder client for the two loadServers GETs. */
function liveClient(servers: unknown, unread: unknown = []): ServerRailClient {
  return { get: async (path) => (path === "/servers" ? servers : unread), patch: async () => ({}) };
}

/** persistServersToCache is fire-and-forget; poll until the kv write lands. */
async function untilKv(scope: number, ms = 1000): Promise<Record<string, unknown>> {
  const deadline = Date.now() + ms;
  for (;;) {
    const value = getCacheRuntime().repo.getKv(scope, "serverList");
    if (value !== null) return value;
    if (Date.now() > deadline) assert.fail("serverList kv write did not land");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

test("serversFromCacheValue round-trips a cached list and degrades junk to empty", () => {
  const servers = [{ id: "a", name: "Alpha", slug: "alpha", role: "member", plan: "free" }, { id: "b", name: "Beta", slug: "beta" }];
  const normalized = servers.map((server) => ({ avatarUrl: null, role: null, plan: null, ...server }));
  assert.deepEqual(serversFromCacheValue({ servers }), normalized, "parsed servers survive the kv round-trip (parseServers normalizes absent fields to null)");
  assert.deepEqual(serversFromCacheValue(null), []);
  assert.deepEqual(serversFromCacheValue({ servers: "nope" }), []);
  assert.deepEqual(serversFromCacheValue({ servers: [{ id: 1 }, "junk", { id: "ok", name: "OK", slug: "ok" }] }).map((s) => s.id), ["ok"], "invalid rows dropped, valid ones kept");
});

test("loadServers persists the list exactly once, to the attached scope (review: no per-server copies)", async () => {
  __resetCacheRuntimeSingleton();
  const runtime = freshRuntime(); // attached to srv-a
  useServerRailStore.getState().reset();
  await useServerRailStore.getState().loadServers(
    liveClient([{ id: "srv-a", name: "A", slug: "a" }, { id: "srv-b", name: "B", slug: "b" }]),
    "srv-a",
  );
  const scopeA = runtime.scopeFor("srv-a");
  const scopeB = runtime.scopeFor("srv-b");
  assert.notEqual(scopeA, null);
  assert.deepEqual(serversFromCacheValue(await untilKv(scopeA as number)).map((s) => s.id), ["srv-a", "srv-b"]);
  assert.equal(runtime.repo.getKv(scopeB as number, "serverList"), null, "other servers' scopes are NOT written");
});

test("a newer loadServers overwrites the cached list (removed servers disappear)", async () => {
  __resetCacheRuntimeSingleton();
  const runtime = freshRuntime();
  useServerRailStore.getState().reset();
  await useServerRailStore.getState().loadServers(liveClient([{ id: "srv-a", name: "A", slug: "a" }, { id: "srv-b", name: "B", slug: "b" }]), "srv-a");
  const scope = runtime.scopeFor("srv-a") as number;
  await untilKv(scope);
  await useServerRailStore.getState().loadServers(liveClient([{ id: "srv-a", name: "A2", slug: "a" }]), "srv-a");
  // Wait until the kv value CHANGES to the single-server list.
  const deadline = Date.now() + 1000;
  let cached = serversFromCacheValue(runtime.repo.getKv(scope, "serverList"));
  while (cached.length !== 1 && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 5));
    cached = serversFromCacheValue(runtime.repo.getKv(scope, "serverList"));
  }
  assert.deepEqual(cached.map((s) => s.id), ["srv-a"], "network truth replaces the cache wholesale");
  assert.equal(cached[0].name, "A2");
});

test("applyServerOrder re-persists the new order for offline cold starts", async () => {
  __resetCacheRuntimeSingleton();
  const runtime = freshRuntime();
  useServerRailStore.getState().reset();
  await useServerRailStore.getState().loadServers(liveClient([{ id: "srv-a", name: "A", slug: "a" }, { id: "srv-b", name: "B", slug: "b" }]), "srv-a");
  const scope = runtime.scopeFor("srv-a") as number;
  await untilKv(scope);
  useServerRailStore.getState().applyServerOrder(["srv-b", "srv-a"]);
  const deadline = Date.now() + 1000;
  let ids = serversFromCacheValue(runtime.repo.getKv(scope, "serverList")).map((s) => s.id);
  while (ids.join(",") !== "srv-b,srv-a" && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 5));
    ids = serversFromCacheValue(runtime.repo.getKv(scope, "serverList")).map((s) => s.id);
  }
  assert.deepEqual(ids, ["srv-b", "srv-a"], "cached order tracks the live reorder");
});

test("switching servers re-runs loadServers against the newly attached scope", async () => {
  __resetCacheRuntimeSingleton();
  const runtime = freshRuntime(); // attached to srv-a
  useServerRailStore.getState().reset();
  await useServerRailStore.getState().loadServers(liveClient([{ id: "srv-a", name: "A", slug: "a" }]), "srv-a");
  const scopeA = runtime.scopeFor("srv-a") as number;
  await untilKv(scopeA);
  // Server switch: the session re-attaches, then loadServers runs again —
  // the same in-memory list lands in the NEW scope, one write at a time.
  runtime.attach("https://raft.example", "user-1", "srv-b");
  await useServerRailStore.getState().loadServers(liveClient([{ id: "srv-a", name: "A", slug: "a" }, { id: "srv-b", name: "B", slug: "b" }]), "srv-b");
  const scopeB = runtime.scopeFor("srv-b") as number;
  assert.deepEqual(serversFromCacheValue(await untilKv(scopeB)).map((s) => s.id), ["srv-a", "srv-b"], "a cold start on the switched-to server finds the list");
});

test("resetAll (logout / origin change) clears the cached server list", async () => {
  __resetCacheRuntimeSingleton();
  const runtime = freshRuntime();
  useServerRailStore.getState().reset();
  await useServerRailStore.getState().loadServers(liveClient([{ id: "srv-a", name: "A", slug: "a" }]), "srv-a");
  const scope = runtime.scopeFor("srv-a") as number;
  await untilKv(scope);
  await runtime.resetAll();
  assert.equal(runtime.repo.getKv(scope, "serverList"), null, "kv snapshot gone after resetAll");
  useServerRailStore.getState().reset();
});

test("loadServers and applyServerOrder stay functional without an initialized cache runtime", async () => {
  __resetCacheRuntimeSingleton();
  useServerRailStore.getState().reset();
  await useServerRailStore.getState().loadServers(liveClient([{ id: "srv-a", name: "A", slug: "a" }]), "srv-a");
  useServerRailStore.getState().applyServerOrder(["srv-a"]);
  assert.deepEqual(useServerRailStore.getState().servers.map((s) => s.id), ["srv-a"], "no cache runtime → persist is skipped, store still works");
});
