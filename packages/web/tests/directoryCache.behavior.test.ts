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
  clearActiveWebCache,
} from "../src/cache/messageCache";
import {
  cachedServers,
  CHANNEL_UNREAD_KV_KEY,
  currentDirectoryCacheScope,
  recordChannels,
  recordServers,
  recordUnread,
  recordUnreadSummary,
  serversFromCacheValue,
  UNREAD_SUMMARY_KV_KEY,
} from "../src/cache/directoryCache";
import { createWebCacheRepo } from "../src/cache/webCacheRepo";
import type { WebCacheRepo } from "../src/cache/webCacheRepo";
import { useChannelStore } from "../src/store/channelStore";
import type { ApiChannel } from "../src/store/channelStore";
import { useMessageStore } from "../src/store/messageStore";
import { useServerStore } from "../src/store/serverStore";
import type { Server } from "../src/store/serverStore";
import { useServerUnreadSummaryStore } from "../src/store/serverUnreadSummaryStore";

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

function resetStores() {
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
  const scopeId = await attachMemoryWebCache("https://raft.example", "user-1", "srv-1", cache);
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
  await recordChannels("channel", [channelFixture("c-cached", "cached")]);
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
  await recordChannels("dm", [channelFixture("dm-cached", "dm-cached")]);
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
  await recordChannels("channel", [channelFixture("c1", "cached-name")]);
  resetStores();
  // Store lists stay EMPTY here — the channel only exists in the cache, so
  // the offline fallback (not the store-hit path) resolves it.
  t.mock.method(api, "get", async (url: string) => {
    if (url.startsWith("/channels/")) throw new Error("network down");
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
  ]);
  await recordChannels("dm", [channelFixture("d1", "dm-one")]);
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
  await recordChannels("channel", [channelFixture("c-stale", "stale")]);
  await recordChannels("dm", [channelFixture("d1", "dm")]);
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
  await recordChannels("channel", [channelFixture("c-arch", "archived")]);
  await recordChannels("dm", [channelFixture("d1", "dm")]);
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
  await recordUnread({ channels: { c1: 3, c2: { unreadCount: 2, hasMention: true } } });
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
  await recordUnreadSummary([{ serverId: "srv-a", unreadCount: 4, serverPushMuted: false }], currentDirectoryCacheScope());
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
  await assert.doesNotReject(recordChannels("channel", [channelFixture("c1", "x")]));
  await assert.doesNotReject(recordUnread({ channels: {} }));
  await assert.doesNotReject(recordUnreadSummary({}, null));
  assert.equal(currentDirectoryCacheScope(), null);
});
