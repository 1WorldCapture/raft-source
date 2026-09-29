// Web directory-cache wiring behavior tests (desktop-data-cache task #8 / P2a).
//
// Covers the five entry points through their real stores against the
// in-memory CacheRepo: cache-first seed into an empty store, network
// overwrite, write-back of the authoritative payload, plus the reconcile
// guards (one failed/throwing list never wipes the cache; an epoch/scope
// change between the two channel lists skips the reconcile).
import assert from "node:assert/strict";
import test from "node:test";
import api from "../src/api/client";
import {
  attachMemoryWebCache,
  beginActiveCacheBoot,
  clearActiveWebCache,
  noteActiveCacheSettled,
  setActiveCacheProvider,
} from "../src/cache/messageCache";
import {
  beginDirectoryAttachWait,
  cachedServers,
  CHANNEL_UNREAD_KV_KEY,
  currentDirectoryCacheScope,
  noteDirectoryAttachSettled,
  recordChannels,
  recordServers,
  recordUnread,
  recordUnreadSummary,
  resetDirectorySeedClaims,
  serversFromCacheValue,
  UNREAD_SUMMARY_KV_KEY,
} from "../src/cache/directoryCache";
import { createWebCacheRuntime } from "../src/cache/webCache";
import { createWebCacheRepo } from "../src/cache/webCacheRepo";
import type { WebCacheRepo } from "../src/cache/webCacheRepo";
import { useChannelStore } from "../src/store/channelStore";
import type { ApiChannel } from "../src/store/channelStore";
import { useMessageStore } from "../src/store/messageStore";
import { useServerStore } from "../src/store/serverStore";
import type { Server } from "../src/store/serverStore";
import { useServerUnreadSummaryStore } from "../src/store/serverUnreadSummaryStore";
import { MissingRefreshTokenError } from "../src/utils/authErrors";

function networkDown(): Error {
  return Object.assign(new Error("network down"), { code: "ERR_NETWORK" });
}

function serverFixture(overrides: Partial<Server> = {}): Server {
  return {
    id: "server-1",
    name: "Core",
    avatarUrl: null,
    slug: "core",
    ownerId: "user-1",
    onboardingAgentId: null,
    hideHumansFromMembers: false,
    plan: "free",
    planDowngradedAt: null,
    role: "owner",
    createdAt: "2026-07-07T00:00:00.000Z",
    ...overrides,
  };
}

function channelFixture(id: string, name: string, extra: Record<string, unknown> = {}): ApiChannel {
  return { id, name, ...extra } as ApiChannel;
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/** Flush microtasks so in-memory repo awaits inside the store settle. */
const flush = () => new Promise<void>((resolve) => setImmediate(() => setImmediate(resolve)));

const ATTACHED_SERVER = "server-1";

function resetStores() {
  resetDirectorySeedClaims();
  useServerStore.setState({
    servers: [],
    current: serverFixture(),
    loading: true,
    serverEpoch: 1,
  });
  useChannelStore.setState({ channels: [], dmChannels: [], loading: true });
  useMessageStore.setState({ unreadCounts: {}, mentionFlags: {} });
  useServerUnreadSummaryStore.setState({ byServer: {} });
}

async function freshCache(repo?: WebCacheRepo) {
  clearActiveWebCache();
  const cache = repo ?? createWebCacheRepo();
  setActiveCacheProvider(null);
  const scopeId = await attachMemoryWebCache("https://raft.example", "user-1", ATTACHED_SERVER, cache);
  return { repo: cache, scopeId };
}

test("serversFromCacheValue validates rows; junk degrades to []", () => {
  assert.deepEqual(serversFromCacheValue(null), []);
  assert.deepEqual(serversFromCacheValue({ servers: "nope" }), []);
  assert.deepEqual(serversFromCacheValue({ servers: [{ id: 1 }, { name: "x" }] }), []);
  const good = serversFromCacheValue({ servers: [{ id: "s1", name: "N", slug: "n" }] });
  assert.equal(good.length, 1);
  assert.equal(good[0]!.id, "s1");
});

test("loadServers: empty store seeds from cache before the network, network overwrites and is recorded", async (t) => {
  const { repo, scopeId } = await freshCache();
  await recordServers([serverFixture({ id: "cached-1", name: "Cached" })]);
  resetStores();

  const net = deferred<{ data: unknown }>();
  t.mock.method(api, "get", async (url: string) => {
    if (url === "/servers") return net.promise;
    return { data: [] };
  });

  const pending = useServerStore.getState().loadServers();
  await flush();
  assert.deepEqual(
    useServerStore.getState().servers.map((s) => s.id),
    ["cached-1"],
    "cache paints the empty store before the network answers",
  );
  assert.equal(useServerStore.getState().loading, false, "the cached snapshot releases the loading gate");

  net.resolve({ data: [serverFixture({ id: "net-1", name: "Network" })] });
  await pending;
  assert.deepEqual(
    useServerStore.getState().servers.map((s) => s.id),
    ["net-1"],
    "network answer overwrites the seed wholesale",
  );
  const recorded = serversFromCacheValue(await repo.getKv(scopeId, "serverList"));
  assert.deepEqual(recorded.map((s) => s.id), ["net-1"], "authoritative payload written back");
  assert.deepEqual((await cachedServers()).map((s) => s.id), ["net-1"]);
});

test("loadServers: a non-empty store is not seeded from cache", async (t) => {
  await freshCache();
  await recordServers([serverFixture({ id: "cached-1" })]);
  resetStores();
  useServerStore.setState({ servers: [serverFixture({ id: "live-1" })] });

  t.mock.method(api, "get", async () => ({ data: [serverFixture({ id: "net-1" })] }));
  await useServerStore.getState().loadServers();
  assert.deepEqual(
    useServerStore.getState().servers.map((s) => s.id),
    ["net-1"],
    "refresh overwrites live data; the cached snapshot never flickers in",
  );
});

test("loadChannels: empty list seeds from cache; network overwrites and records (type-scoped)", async (t) => {
  const { repo, scopeId } = await freshCache();
  await recordChannels("channel", [channelFixture("c-cached", "cached")], ATTACHED_SERVER);
  resetStores();

  const net = deferred<{ data: unknown }>();
  t.mock.method(api, "get", async (url: string) => {
    if (url === "/channels") return net.promise;
    return { data: [] };
  });

  const pending = useChannelStore.getState().loadChannels();
  await flush();
  assert.deepEqual(
    useChannelStore.getState().channels.map((c) => c.id),
    ["c-cached"],
    "cache paints the empty list first",
  );
  assert.equal(useChannelStore.getState().loading, false, "the cached snapshot releases the loading gate");

  net.resolve({ data: [channelFixture("c-net", "network")] });
  await pending;
  assert.deepEqual(useChannelStore.getState().channels.map((c) => c.id), ["c-net"]);
  const rows = await repo.getChannels(scopeId, ["channel"]);
  assert.deepEqual(rows.map((r) => [r.id, r.type]), [["c-net", "channel"]], "recorded in a channel-type batch");
});

test("loadDMChannels: empty list seeds from cache; network merges and the cache records the authoritative list", async (t) => {
  const { repo, scopeId } = await freshCache();
  await recordChannels("dm", [channelFixture("dm-cached", "dm-cached")], ATTACHED_SERVER);
  resetStores();

  const net = deferred<{ data: unknown }>();
  t.mock.method(api, "get", async (url: string) => {
    if (url === "/channels/dm") return net.promise;
    return { data: [] };
  });
  const pending = useChannelStore.getState().loadDMChannels();
  await flush();
  assert.deepEqual(
    useChannelStore.getState().dmChannels.map((c) => c.id),
    ["dm-cached"],
    "cache paints the empty list first",
  );
  net.resolve({ data: [channelFixture("dm-net", "dm-net")] });
  await pending;
  // hydrateDmChannels deliberately merges (fetched + local-only) — existing
  // store semantics, unchanged by the seed; the CACHE is overwritten wholesale.
  assert.ok(useChannelStore.getState().dmChannels.some((c) => c.id === "dm-net"));
  const rows = await repo.getChannels(scopeId, ["dm"]);
  assert.deepEqual(rows.map((r) => [r.id, r.type]), [["dm-net", "dm"]]);
});

test("ensureChannel falls back to the cached row when the detail request fails", async (t) => {
  await freshCache();
  await recordChannels("channel", [channelFixture("c1", "cached-name")], ATTACHED_SERVER);
  resetStores();
  // Store lists stay EMPTY here — the channel only exists in the cache, so
  // the offline fallback (not the store-hit path) resolves it.
  t.mock.method(api, "get", async (url: string) => {
    if (url.startsWith("/channels/")) throw networkDown();
    return { data: [] };
  });
  const resolved = await useChannelStore.getState().ensureChannel("c1");
  assert.ok(resolved, "the cached row resolves the channel offline");
  assert.equal(resolved.id, "c1");
  assert.equal(
    useChannelStore.getState().channels.find((c) => c.id === "c1")?.name,
    "cached-name",
    "the fallback row hydrates into the store like a network answer",
  );
});

test("reconcile runs once both lists landed: cached channels absent from the live lists are pruned", async (t) => {
  const { repo, scopeId } = await freshCache();
  await recordChannels("channel", [
    channelFixture("c1", "one"),
    channelFixture("c-stale", "stale"),
    channelFixture("c-arch", "archived"),
  ], ATTACHED_SERVER);
  await recordChannels("dm", [channelFixture("d1", "dm-one")], ATTACHED_SERVER);
  resetStores();

  t.mock.method(api, "get", async (url: string) => {
    if (url === "/channels") {
      return { data: [channelFixture("c1", "one"), channelFixture("c-arch", "archived", { archivedAt: "2026-09-01T00:00:00Z" })] };
    }
    if (url === "/channels/dm") return { data: [channelFixture("d1", "dm-one")] };
    return { data: [] };
  });
  await useChannelStore.getState().loadChannels();
  await useChannelStore.getState().loadDMChannels();

  const remaining = (await repo.getChannels(scopeId)).map((r) => r.id).sort();
  assert.deepEqual(remaining, ["c1", "d1"], "stale AND archived cached channels cascade away");
});

test("reconcile failure guard: a throwing channel list never wipes the cache", async (t) => {
  const { repo, scopeId } = await freshCache();
  await recordChannels("channel", [channelFixture("c-stale", "stale")], ATTACHED_SERVER);
  await recordChannels("dm", [channelFixture("d1", "dm")], ATTACHED_SERVER);
  resetStores();

  t.mock.method(api, "get", async (url: string) => {
    if (url === "/channels") throw new Error("timeout");
    if (url === "/channels/dm") return { data: [channelFixture("d1", "dm")] };
    return { data: [] };
  });
  await useChannelStore.getState().loadChannels();
  await useChannelStore.getState().loadDMChannels();

  const remaining = (await repo.getChannels(scopeId)).map((r) => r.id).sort();
  assert.deepEqual(remaining, ["c-stale", "d1"], "one failed list skips the reconcile entirely");
});

test("reconcile scope guard: an epoch change between the two lists skips the prune", async (t) => {
  const { repo, scopeId } = await freshCache();
  // c-arch was cached while unarchived; the live list still contains it but
  // ARCHIVED — putChannels keeps it (it is in the batch), so ONLY the
  // reconcile would delete it. An epoch bump between the two list loads must
  // skip the reconcile and leave the row alone.
  await recordChannels("channel", [channelFixture("c-arch", "archived")], ATTACHED_SERVER);
  await recordChannels("dm", [channelFixture("d1", "dm")], ATTACHED_SERVER);
  resetStores();

  t.mock.method(api, "get", async (url: string) => {
    if (url === "/channels") {
      return { data: [channelFixture("c-arch", "archived", { archivedAt: "2026-09-01T00:00:00Z" })] };
    }
    if (url === "/channels/dm") return { data: [channelFixture("d1", "dm")] };
    return { data: [] };
  });
  await useChannelStore.getState().loadChannels();
  // Server switch bumps the epoch before the DM list lands.
  useServerStore.setState({ serverEpoch: 2 });
  await useChannelStore.getState().loadDMChannels();

  const remaining = (await repo.getChannels(scopeId)).map((r) => r.id).sort();
  assert.deepEqual(remaining, ["c-arch", "d1"], "epoch mismatch: reconcile skipped, archived row kept");
});

test("loadUnreadCounts: empty store seeds from the cached raw wire payload; network overwrites and records", async (t) => {
  const { repo, scopeId } = await freshCache();
  await recordUnread({ channels: { c1: 3, c2: { unreadCount: 2, hasMention: true } } }, ATTACHED_SERVER);
  resetStores();

  const net = deferred<{ data: unknown }>();
  t.mock.method(api, "get", async (url: string) => {
    if (url === "/channels/unread") return net.promise;
    return { data: [] };
  });

  const pending = useMessageStore.getState().loadUnreadCounts();
  await flush();
  assert.deepEqual(useMessageStore.getState().unreadCounts, { c1: 3, c2: 2 }, "counts paint from cache");
  assert.deepEqual(useMessageStore.getState().mentionFlags, { c2: true }, "mention flags paint from cache");

  net.resolve({ data: { channels: { c3: 7 } } });
  await pending;
  assert.deepEqual(useMessageStore.getState().unreadCounts, { c3: 7 }, "network snapshot overwrites");
  const recorded = await repo.getKv(scopeId, CHANNEL_UNREAD_KV_KEY);
  assert.deepEqual(recorded, { channels: { c3: 7 } }, "raw wire payload written back verbatim");
});

test("summary load: empty store seeds from cache; network overwrites and records", async (t) => {
  const { repo, scopeId } = await freshCache();
  await recordUnreadSummary([{ serverId: "srv-a", unreadCount: 4, serverPushMuted: false }], currentDirectoryCacheScope(), ATTACHED_SERVER);
  resetStores();

  t.mock.method(api, "get", async (url: string) => {
    if (url === "/servers/unread-summary") return { data: [{ serverId: "srv-a", unreadCount: 9, serverPushMuted: false }] };
    return { data: [] };
  });
  await useServerUnreadSummaryStore.getState().load();
  assert.equal(useServerUnreadSummaryStore.getState().byServer["srv-a"]?.unreadCount, 9);
  assert.deepEqual(await repo.getKv(scopeId, UNREAD_SUMMARY_KV_KEY), [{ serverId: "srv-a", unreadCount: 9, serverPushMuted: false }]);
});

test("summary write-back is skipped when the scope changed mid-flight", async (t) => {
  const repoA = createWebCacheRepo();
  const { scopeId: scopeA } = await freshCache(repoA);
  resetStores();

  const net = deferred<{ data: unknown }>();
  t.mock.method(api, "get", async (url: string) => {
    if (url === "/servers/unread-summary") return net.promise;
    return { data: [] };
  });

  const pending = useServerUnreadSummaryStore.getState().load();
  await flush();
  // Server switch mid-flight: the active cache attaches a DIFFERENT scope.
  await attachMemoryWebCache("https://raft.example", "user-1", "srv-2", createWebCacheRepo());
  net.resolve({ data: [{ serverId: "srv-a", unreadCount: 9, serverPushMuted: false }] });
  await pending;

  assert.equal(useServerUnreadSummaryStore.getState().byServer["srv-a"]?.unreadCount, 9, "store still gets the network answer");
  assert.equal(await repoA.getKv(scopeA, UNREAD_SUMMARY_KV_KEY), null, "stale scope token blocks the write");
});

test("all directory ops no-op silently with no cache attached", async () => {
  clearActiveWebCache();
  resetStores();
  assert.deepEqual(await cachedServers(), []);
  await assert.doesNotReject(recordServers([serverFixture()]));
  await assert.doesNotReject(recordChannels("channel", [channelFixture("c1", "x")], ATTACHED_SERVER));
  await assert.doesNotReject(recordUnread({ channels: {} }, ATTACHED_SERVER));
  await assert.doesNotReject(recordUnreadSummary({}, null, ATTACHED_SERVER));
  assert.equal(currentDirectoryCacheScope(), null);
});

test("reconcile runs when the provider allocates a fresh holder on every read", async (t) => {
  const repo = createWebCacheRepo();
  const scopeId = await repo.openScope("https://raft.example", "user-1", ATTACHED_SERVER);
  clearActiveWebCache();
  // bootWebCache's provider returns a new object each call. Reconcile must
  // key off generation, not object identity, or archived/absent rows never drop.
  setActiveCacheProvider(() => ({
    repo,
    scopeId,
    serverId: ATTACHED_SERVER,
    generation: 7,
  }));
  t.after(() => setActiveCacheProvider(null));
  await recordChannels("channel", [
    channelFixture("c-keep", "keep"),
    channelFixture("c-gone", "gone"),
  ], ATTACHED_SERVER);
  await recordChannels("dm", [channelFixture("d1", "dm")], ATTACHED_SERVER);
  resetStores();

  t.mock.method(api, "get", async (url: string) => {
    if (url === "/channels") return { data: [channelFixture("c-keep", "keep")] };
    if (url === "/channels/dm") return { data: [channelFixture("d1", "dm")] };
    return { data: [] };
  });
  await useChannelStore.getState().loadChannels();
  await useChannelStore.getState().loadDMChannels();

  const remaining = (await repo.getChannels(scopeId)).map((r) => r.id).sort();
  assert.deepEqual(remaining, ["c-keep", "d1"], "absent cached channel is pruned across fresh holder objects");
});

test("a server switch does not read or write the previous scope while attach is still on the old server", async (t) => {
  const repoA = createWebCacheRepo();
  const { scopeId } = await freshCache(repoA);
  await recordChannels("channel", [channelFixture("a-only", "A")], ATTACHED_SERVER);
  await recordChannels("dm", [channelFixture("a-dm", "Adm")], ATTACHED_SERVER);
  await recordUnread({ channels: { "a-only": 4 } }, ATTACHED_SERVER);
  resetStores();
  // Store reset is synchronous; the cache holder is still server-1.
  useServerStore.setState({
    current: serverFixture({ id: "server-b", slug: "b", name: "B" }),
    serverEpoch: 2,
  });
  useChannelStore.setState({ channels: [], dmChannels: [], loading: true });
  useMessageStore.setState({ unreadCounts: {}, mentionFlags: {} });

  const channelsNet = deferred<{ data: unknown }>();
  const dmsNet = deferred<{ data: unknown }>();
  const unreadNet = deferred<{ data: unknown }>();
  t.mock.method(api, "get", async (url: string) => {
    if (url === "/channels") return channelsNet.promise;
    if (url === "/channels/dm") return dmsNet.promise;
    if (url === "/channels/unread") return unreadNet.promise;
    return { data: [] };
  });

  const channelsPending = useChannelStore.getState().loadChannels();
  const dmsPending = useChannelStore.getState().loadDMChannels();
  const unreadPending = useMessageStore.getState().loadUnreadCounts();
  await flush();
  assert.deepEqual(useChannelStore.getState().channels.map((c) => c.id), [], "B does not paint A's channels");
  assert.equal(useChannelStore.getState().loading, true, "loading stays until B's own response");
  assert.deepEqual(useChannelStore.getState().dmChannels.map((c) => c.id), [], "B does not paint A's DMs");
  assert.deepEqual(useMessageStore.getState().unreadCounts, {}, "B does not paint A's unread");

  channelsNet.resolve({ data: [channelFixture("b-net", "B")] });
  dmsNet.resolve({ data: [channelFixture("b-dm", "Bdm")] });
  unreadNet.resolve({ data: { channels: { "b-net": 1 } } });
  await Promise.all([channelsPending, dmsPending, unreadPending]);

  assert.deepEqual(useChannelStore.getState().channels.map((c) => c.id), ["b-net"]);
  assert.deepEqual(useChannelStore.getState().dmChannels.map((c) => c.id), ["b-dm"]);
  assert.deepEqual(useMessageStore.getState().unreadCounts, { "b-net": 1 });
  assert.deepEqual((await repoA.getChannels(scopeId, ["channel"])).map((r) => r.id), ["a-only"], "B's list does not drop A's channels");
  assert.deepEqual((await repoA.getChannels(scopeId, ["dm"])).map((r) => r.id), ["a-dm"], "B's list does not drop A's DMs");
  assert.deepEqual(await repoA.getKv(scopeId, CHANNEL_UNREAD_KV_KEY), { channels: { "a-only": 4 } }, "B's unread does not overwrite A's scope");
});

test("loadUnreadCounts seeds at most once per epoch", async (t) => {
  await freshCache();
  await recordUnread({ channels: { x: 3 } }, ATTACHED_SERVER);
  resetStores();

  const second = deferred<{ data: unknown }>();
  let calls = 0;
  t.mock.method(api, "get", async (url: string) => {
    if (url === "/channels/unread") {
      calls += 1;
      if (calls === 1) throw new Error("offline");
      return second.promise;
    }
    return { data: [] };
  });

  await useMessageStore.getState().loadUnreadCounts();
  assert.equal(useMessageStore.getState().unreadCounts.x, 3, "the first empty load seeds");
  // The user already read it; a later load in the same epoch must not paint 3 again.
  useMessageStore.setState({ unreadCounts: {}, mentionFlags: {} });
  const pending = useMessageStore.getState().loadUnreadCounts();
  await flush();
  assert.equal(useMessageStore.getState().unreadCounts.x, undefined, "a cleared count is not re-seeded");
  second.resolve({ data: { channels: {} } });
  await pending;
  assert.equal(useMessageStore.getState().unreadCounts.x, undefined);
});

test("unread summary seeds at most once per epoch", async (t) => {
  await freshCache();
  await recordUnreadSummary(
    [{ serverId: "srv-a", unreadCount: 4, serverPushMuted: false }],
    currentDirectoryCacheScope(),
    ATTACHED_SERVER,
  );
  resetStores();

  const first = deferred<{ data: unknown }>();
  const second = deferred<{ data: unknown }>();
  let calls = 0;
  t.mock.method(api, "get", async (url: string) => {
    if (url === "/servers/unread-summary") {
      calls += 1;
      return calls === 1 ? first.promise : second.promise;
    }
    return { data: [] };
  });

  const pending = useServerUnreadSummaryStore.getState().load();
  await flush();
  assert.equal(useServerUnreadSummaryStore.getState().byServer["srv-a"]?.unreadCount, 4, "first load seeds");
  first.reject(new Error("offline"));
  await pending;
  assert.deepEqual(useServerUnreadSummaryStore.getState().byServer, {}, "a failed refresh clears the seed");

  const again = useServerUnreadSummaryStore.getState().load();
  await flush();
  assert.equal(
    useServerUnreadSummaryStore.getState().byServer["srv-a"],
    undefined,
    "the same epoch does not paint the cached summary again",
  );
  second.reject(new Error("offline"));
  await again;
});

test("ensureChannel does not fall back to cache on 403 or 404", async (t) => {
  await freshCache();
  await recordChannels("channel", [channelFixture("c1", "cached-name")], ATTACHED_SERVER);
  resetStores();

  let status = 403;
  t.mock.method(api, "get", async () => {
    throw { response: { status } };
  });
  for (status of [403, 404]) {
    useChannelStore.setState({ channels: [], dmChannels: [] });
    const resolved = await useChannelStore.getState().ensureChannel("c1");
    assert.equal(resolved, null, `status ${status} does not resolve from cache`);
    assert.equal(useChannelStore.getState().channels.find((c) => c.id === "c1"), undefined);
  }
});

test("ensureChannel does not apply the cached row after the server epoch changes", async (t) => {
  await freshCache();
  await recordChannels("channel", [channelFixture("c1", "cached-name")], ATTACHED_SERVER);
  resetStores();

  t.mock.method(api, "get", async () => {
    useServerStore.setState({ serverEpoch: 9 });
    throw networkDown();
  });
  const resolved = await useChannelStore.getState().ensureChannel("c1");
  assert.equal(resolved, null);
  assert.equal(useChannelStore.getState().channels.find((c) => c.id === "c1"), undefined);
});

test("resetAll detaches the scope before the wipe, so a write during the wipe does not land", async (t) => {
  clearActiveWebCache();
  const runtime = await createWebCacheRuntime();
  await runtime.attach("https://raft.example", "user-1", ATTACHED_SERVER);
  setActiveCacheProvider(() => {
    if (runtime.scopeId === null || runtime.serverId === null) return null;
    return {
      repo: runtime.repo,
      scopeId: runtime.scopeId,
      serverId: runtime.serverId,
      generation: runtime.generation,
    };
  });
  t.after(() => setActiveCacheProvider(null));

  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const originalWipe = runtime.repo.wipeAll.bind(runtime.repo);
  runtime.repo.wipeAll = async () => {
    await gate;
    await originalWipe();
  };
  let puts = 0;
  const originalPut = runtime.repo.putChannels.bind(runtime.repo);
  runtime.repo.putChannels = async (scopeId, rows) => {
    puts += 1;
    return originalPut(scopeId, rows);
  };

  const pending = runtime.resetAll();
  await flush();
  assert.equal(runtime.scopeId, null, "scope is cleared before wipeAll resolves");
  assert.equal(runtime.serverId, null);
  await recordChannels("channel", [channelFixture("late", "late")], ATTACHED_SERVER);
  assert.equal(puts, 0, "a directory write during the wipe is refused");
  release();
  await pending;
});

test("loadServers seeds and writes the attached scope when current is still null", async (t) => {
  const { repo, scopeId } = await freshCache();
  await recordServers([serverFixture({ id: "cached-1", name: "Cached" })]);
  resetStores();
  useServerStore.setState({ current: null, servers: [], loading: true });

  t.mock.method(api, "get", async () => ({ data: [serverFixture({ id: "net-1", name: "Network" })] }));
  await useServerStore.getState().loadServers();
  assert.equal(useServerStore.getState().current, null, "hydrating the list does not select a server");
  assert.deepEqual(useServerStore.getState().servers.map((s) => s.id), ["net-1"]);
  const recorded = serversFromCacheValue(await repo.getKv(scopeId, "serverList"));
  assert.deepEqual(recorded.map((s) => s.id), ["net-1"], "write-back does not require a current server");
});

test("loadServers waits for the cold-start attach before reading the server list", async (t) => {
  const repo = createWebCacheRepo();
  const scopeId = await repo.openScope("https://raft.example", "user-1", ATTACHED_SERVER);
  await repo.putKv(scopeId, "serverList", {
    servers: [serverFixture({ id: "cached-1", name: "Cached" })],
  });
  clearActiveWebCache();
  setActiveCacheProvider(null);
  beginActiveCacheBoot();
  t.after(() => {
    noteActiveCacheSettled();
    setActiveCacheProvider(null);
  });
  resetStores();
  useServerStore.setState({ current: null, servers: [], loading: true });

  const net = deferred<{ data: unknown }>();
  t.mock.method(api, "get", async () => net.promise);
  const pending = useServerStore.getState().loadServers();
  await flush();
  assert.deepEqual(useServerStore.getState().servers, [], "no seed until the persisted scope is attached");

  setActiveCacheProvider(() => ({
    repo,
    scopeId,
    serverId: ATTACHED_SERVER,
    generation: 2,
  }));
  noteActiveCacheSettled();
  await flush();
  assert.deepEqual(
    useServerStore.getState().servers.map((s) => s.id),
    ["cached-1"],
    "the attached scope paints the list while current is still null",
  );
  net.resolve({ data: [serverFixture({ id: "net-1", name: "Network" })] });
  await pending;
});

test("loadChannels waits for the in-flight attach before seeding or writing", async (t) => {
  const repo = createWebCacheRepo();
  const scopeId = await repo.openScope("https://raft.example", "user-1", "server-b");
  await repo.putChannels(scopeId, [{
    id: "b-cached",
    type: "channel",
    lastMessageAt: null,
    raw: channelFixture("b-cached", "cached") as unknown as Record<string, unknown>,
  }]);
  clearActiveWebCache();
  setActiveCacheProvider(null);
  beginDirectoryAttachWait();
  t.after(() => noteDirectoryAttachSettled());
  resetStores();
  useServerStore.setState({
    current: serverFixture({ id: "server-b", slug: "b", name: "B" }),
    serverEpoch: 2,
  });
  useChannelStore.setState({ channels: [], dmChannels: [], loading: true });

  const net = deferred<{ data: unknown }>();
  t.mock.method(api, "get", async (url: string) => {
    if (url === "/channels") return net.promise;
    return { data: [] };
  });
  const pending = useChannelStore.getState().loadChannels();
  await flush();
  assert.deepEqual(useChannelStore.getState().channels, [], "B does not seed before its scope is attached");
  assert.equal(useChannelStore.getState().loading, true);

  setActiveCacheProvider(() => ({
    repo,
    scopeId,
    serverId: "server-b",
    generation: 4,
  }));
  noteDirectoryAttachSettled();
  await flush();
  assert.deepEqual(useChannelStore.getState().channels.map((c) => c.id), ["b-cached"]);

  net.resolve({ data: [channelFixture("b-net", "B")] });
  await pending;
  assert.deepEqual(
    (await repo.getChannels(scopeId, ["channel"])).map((row) => row.id),
    ["b-net"],
    "B's first response is written once the scope is attached",
  );
});

test("an unread load that runs before attach occupies the epoch so a later load cannot reseed", async (t) => {
  const repo = createWebCacheRepo();
  const scopeId = await repo.openScope("https://raft.example", "user-1", "server-b");
  await repo.putKv(scopeId, CHANNEL_UNREAD_KV_KEY, { channels: { b1: 9 } });
  clearActiveWebCache();
  setActiveCacheProvider(null);
  resetStores();
  useServerStore.setState({
    current: serverFixture({ id: "server-b", slug: "b", name: "B" }),
    serverEpoch: 2,
  });
  useMessageStore.setState({ unreadCounts: {}, mentionFlags: {} });

  t.mock.method(api, "get", async (url: string) => {
    if (url === "/channels/unread") return { data: { channels: {} } };
    return { data: [] };
  });
  await useMessageStore.getState().loadUnreadCounts();
  assert.deepEqual(useMessageStore.getState().unreadCounts, {}, "the pre-attach load keeps the network snapshot");

  setActiveCacheProvider(() => ({
    repo,
    scopeId,
    serverId: "server-b",
    generation: 3,
  }));
  t.after(() => setActiveCacheProvider(null));
  const second = deferred<{ data: unknown }>();
  t.mock.method(api, "get", async (url: string) => {
    if (url === "/channels/unread") return second.promise;
    return { data: [] };
  });
  const pending = useMessageStore.getState().loadUnreadCounts();
  await flush();
  assert.equal(useMessageStore.getState().unreadCounts.b1, undefined, "stale {b1: 9} is not reseeded");
  second.resolve({ data: { channels: {} } });
  await pending;
  assert.equal(useMessageStore.getState().unreadCounts.b1, undefined);
});

test("ensureChannel does not hydrate a cached row when the server changes during the cache read", async (t) => {
  const repo = createWebCacheRepo();
  const scopeId = await repo.openScope("https://raft.example", "user-1", ATTACHED_SERVER);
  await repo.putChannels(scopeId, [{
    id: "c1",
    type: "channel",
    lastMessageAt: null,
    raw: channelFixture("c1", "cached-name") as unknown as Record<string, unknown>,
  }]);
  clearActiveWebCache();
  const read = repo.getChannels.bind(repo);
  repo.getChannels = async (scope, types) => {
    useServerStore.setState({
      serverEpoch: 9,
      current: serverFixture({ id: "server-b", slug: "b", name: "B" }),
    });
    return read(scope, types);
  };
  setActiveCacheProvider(() => ({
    repo,
    scopeId,
    serverId: ATTACHED_SERVER,
    generation: 1,
  }));
  t.after(() => setActiveCacheProvider(null));
  resetStores();

  t.mock.method(api, "get", async () => {
    throw networkDown();
  });
  const resolved = await useChannelStore.getState().ensureChannel("c1");
  assert.equal(resolved, null);
  assert.equal(useChannelStore.getState().channels.find((c) => c.id === "c1"), undefined);
});

test("ensureChannel does not fall back on cancel, missing refresh token, or an empty resolution", async (t) => {
  await freshCache();
  await recordChannels("channel", [channelFixture("c1", "cached-name")], ATTACHED_SERVER);
  resetStores();

  const failures: Array<() => unknown> = [
    () => {
      throw Object.assign(new Error("canceled"), { code: "ERR_CANCELED" });
    },
    () => {
      throw new MissingRefreshTokenError();
    },
    () => undefined,
  ];
  let mode = 0;
  t.mock.method(api, "get", async () => failures[mode]!());
  for (mode = 0; mode < failures.length; mode += 1) {
    useChannelStore.setState({ channels: [], dmChannels: [] });
    const resolved = await useChannelStore.getState().ensureChannel("c1");
    assert.equal(resolved, null, `case ${mode} does not resolve from cache`);
    assert.equal(useChannelStore.getState().channels.find((c) => c.id === "c1"), undefined);
  }
});

test("ensureChannel falls back to cache on a timeout", async (t) => {
  await freshCache();
  await recordChannels("channel", [channelFixture("c1", "cached-name")], ATTACHED_SERVER);
  resetStores();
  t.mock.method(api, "get", async () => {
    throw Object.assign(new Error("timeout"), { code: "ECONNABORTED" });
  });
  const resolved = await useChannelStore.getState().ensureChannel("c1");
  assert.equal(resolved?.id, "c1");
});
