// Web directory-cache bridge (desktop-data-cache task #8 / P2a).
//
// The ONLY module packages/web's stores may touch for directory caching
// (server list, channel/DM lists, unread counts, cross-server unread
// summary). Mirrors the mobile directory-cache conventions:
//   - cache-first seed ONLY into an empty store, then the network answer
//     overwrites wholesale and is written back (mobile home.tsx parity);
//   - kv keys align with mobile: `serverList`, `channelUnread`;
//   - channel lists are recorded in type-scoped putChannels batches so the
//     repo's type-scoped dropMissing never crosses the joined/DM lists;
//   - reconcile (promoted to packages/shared, cacheReconcile.ts) runs only
//     when BOTH channel lists landed for the same epoch with the scope
//     unchanged — one failed or partial refresh must never wipe the cache.
//
// Lifecycle: this module owns NO lifecycle. It reads the active-cache holder
// from messageCache.ts (#7's runtime injects the provider there); every op
// degrades to a silent no-op when no scope is attached. Like webCache.ts,
// no browser globals are touched at module scope so node store tests can
// import the stores directly.
import type { RawRecord } from "@botiverse/raft-shared/src/cacheRepoContract.js";
import { reconcileChannels } from "@botiverse/raft-shared/src/cacheReconcile.js";
import type { LiveChannel } from "@botiverse/raft-shared/src/cacheReconcile.js";
import type { ApiChannel } from "../store/channelStore";
import type { Server } from "../store/serverStore";
import { activeWebCache } from "./messageCache";

// kv keys — aligned with mobile (serverRailCache.ts / home wiring).
export const SERVER_LIST_KV_KEY = "serverList";
export const CHANNEL_UNREAD_KV_KEY = "channelUnread";
export const UNREAD_SUMMARY_KV_KEY = "unreadSummary";

export type ChannelListKind = "channel" | "dm";

// ---- server list ---------------------------------------------------------------

/**
 * Validate a cached `serverList` kv value into renderable servers; junk rows
 * degrade to [] (port of mobile serverRailCache.serversFromCacheValue — a
 * poisoned cache entry must never crash or blank the seed path).
 */
export function serversFromCacheValue(value: unknown): Server[] {
  if (!value || typeof value !== "object" || !Array.isArray((value as { servers?: unknown }).servers)) {
    return [];
  }
  const out: Server[] = [];
  for (const row of (value as { servers: unknown[] }).servers) {
    if (!row || typeof row !== "object") continue;
    const record = row as Record<string, unknown>;
    if (typeof record.id !== "string" || typeof record.name !== "string" || typeof record.slug !== "string") {
      continue;
    }
    out.push(row as Server);
  }
  return out;
}

/** Cached server list for the attached scope, [] when absent or detached. */
export async function cachedServers(): Promise<Server[]> {
  const cache = activeWebCache();
  if (!cache) return [];
  return serversFromCacheValue(await cache.repo.getKv(cache.scopeId, SERVER_LIST_KV_KEY));
}

/** Record the authoritative GET /servers payload (raw rows, one snapshot). */
export async function recordServers(servers: readonly Server[]): Promise<void> {
  const cache = activeWebCache();
  if (!cache) return;
  await cache.repo.putKv(cache.scopeId, SERVER_LIST_KV_KEY, {
    servers: servers as unknown as RawRecord[],
  });
}

// ---- channel / DM lists ----------------------------------------------------------

/** Validate cached channel rows back into ApiChannel raws; junk rows dropped. */
function channelsFromRows(rows: readonly { raw: RawRecord }[]): ApiChannel[] {
  const out: ApiChannel[] = [];
  for (const row of rows) {
    if (!row.raw || typeof row.raw !== "object" || typeof (row.raw as { id?: unknown }).id !== "string") {
      continue;
    }
    out.push(row.raw as unknown as ApiChannel);
  }
  return out;
}

/** Cached list for one kind ("channel" | "dm"), [] when absent or detached. */
export async function cachedChannels(kind: ChannelListKind): Promise<ApiChannel[]> {
  const cache = activeWebCache();
  if (!cache) return [];
  return channelsFromRows(await cache.repo.getChannels(cache.scopeId, [kind]));
}

/**
 * One cached channel row by id across both list kinds (channel detail
 * fallback, task #8 scope addendum): the list rows ARE the directory cache,
 * so a channel the server once listed resolves offline without a network
 * round-trip. Null when absent or detached.
 */
export async function cachedChannelById(channelId: string): Promise<ApiChannel | null> {
  const cache = activeWebCache();
  if (!cache) return null;
  const rows = channelsFromRows(await cache.repo.getChannels(cache.scopeId));
  return rows.find((channel) => channel.id === channelId) ?? null;
}

/**
 * Record one authoritative channel list in a type-scoped putChannels batch
 * (the repo's dropMissing only touches rows of the written type(s), so the
 * joined list can never wipe the DM list and vice versa).
 */
export async function recordChannels(
  kind: ChannelListKind,
  channels: readonly ApiChannel[],
): Promise<void> {
  const cache = activeWebCache();
  if (!cache) return;
  await cache.repo.putChannels(
    cache.scopeId,
    channels.map((channel) => ({
      id: channel.id,
      type: kind,
      lastMessageAt: (channel as { lastMessageAt?: string | null }).lastMessageAt ?? null,
      raw: channel as unknown as RawRecord,
    })),
  );
}

// Per-scope record of which channel-list kinds have landed for the CURRENT
// epoch. `owner` holds the activeWebCache() object identity: a re-attach
// (logout/re-login, tests constructing fresh repos) reuses numeric scopeIds,
// so the identity — not the number — decides whether a partial entry is
// still trustworthy. Entries are dropped once both kinds are present and the
// reconcile has run, or when the epoch/owner changes, so the map cannot grow
// unboundedly.
type ChannelListEpochEntry = {
  owner: unknown;
  epoch: number;
  channel?: readonly LiveChannel[];
  dm?: readonly LiveChannel[];
};

const channelListLoads = new Map<number, ChannelListEpochEntry>();

function toLiveChannels(channels: readonly ApiChannel[]): LiveChannel[] {
  return channels.map((channel) => {
    const archivedAt = (channel as { archivedAt?: unknown }).archivedAt;
    return { id: channel.id, archivedAt: typeof archivedAt === "string" ? archivedAt : null };
  });
}

/**
 * Mark one authoritative channel-list fetch as landed. When BOTH kinds have
 * landed for the same epoch and the scope is still attached, the shared
 * reconcile prunes cached channels absent from the live lists (or archived —
 * deleteChannel cascades messages/coverage/read state). Call ONLY from the
 * post-epoch-check success path: one failed or partial refresh must never
 * reach the reconcile (mobile cacheCleanup CONTRACT, now in shared).
 */
export async function noteChannelListLoaded(
  kind: ChannelListKind,
  epoch: number,
  live: readonly ApiChannel[],
): Promise<void> {
  const cache = activeWebCache();
  if (!cache) return;
  const scopeId = cache.scopeId;
  const current = channelListLoads.get(scopeId);
  // A newer epoch or a different attach supersedes any partial entry.
  if (!current || current.owner !== cache || current.epoch !== epoch) {
    channelListLoads.set(scopeId, { owner: cache, epoch, [kind]: toLiveChannels(live) });
    return;
  }
  current[kind] = toLiveChannels(live);
  const channelLive = current.channel;
  const dmLive = current.dm;
  if (!channelLive || !dmLive) return;
  channelListLoads.delete(scopeId);
  if (activeWebCache() !== cache) return;
  await reconcileChannels(cache.repo, scopeId, [...channelLive, ...dmLive]);
}

// ---- unread counts ---------------------------------------------------------------

/**
 * Cached RAW wire payload of GET /channels/unread?summary=1. Stored verbatim
 * so parseUnreadSnapshot runs identically on the cached seed; the read-state
 * ledger folding (consumeReadStateSnapshotRows) stays network-only.
 */
export async function cachedUnread(): Promise<unknown> {
  const cache = activeWebCache();
  if (!cache) return null;
  return await cache.repo.getKv(cache.scopeId, CHANNEL_UNREAD_KV_KEY);
}

/** Record the raw unread wire payload (validated: non-object junk skipped). */
export async function recordUnread(data: unknown): Promise<void> {
  const cache = activeWebCache();
  if (!cache) return;
  if (!data || typeof data !== "object") return;
  await cache.repo.putKv(cache.scopeId, CHANNEL_UNREAD_KV_KEY, data as RawRecord);
}

// ---- cross-server unread summary ---------------------------------------------------

/**
 * The attached scope captured at REQUEST START. recordUnreadSummary compares
 * it against the CURRENT attach scope before writing — a server switch
 * mid-flight must not persist the previous scope's summary snapshot into the
 * new scope (mobile serverRailCache pattern, Firstmate ruling #6 thread).
 */
export type DirectoryCacheScope = { scopeId: number };

/** Capture the active scope token for a request about to start (sync, no I/O). */
export function currentDirectoryCacheScope(): DirectoryCacheScope | null {
  const cache = activeWebCache();
  return cache ? { scopeId: cache.scopeId } : null;
}

/** Cached raw wire payload of GET /servers/unread-summary, null when absent. */
export async function cachedUnreadSummary(): Promise<unknown> {
  const cache = activeWebCache();
  if (!cache) return null;
  return await cache.repo.getKv(cache.scopeId, UNREAD_SUMMARY_KV_KEY);
}

/**
 * Record the raw unread-summary wire payload, but ONLY into the current
 * attach scope and only when the request-start scope token still matches —
 * otherwise the write is skipped silently (server-switch race).
 */
export async function recordUnreadSummary(
  data: unknown,
  requestScope: DirectoryCacheScope | null,
): Promise<void> {
  const cache = activeWebCache();
  if (!cache || !requestScope) return;
  if (requestScope.scopeId !== cache.scopeId) return;
  if (!data || typeof data !== "object") return;
  await cache.repo.putKv(cache.scopeId, UNREAD_SUMMARY_KV_KEY, data as RawRecord);
}
