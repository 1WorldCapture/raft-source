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
import { activeWebCache, isActiveCacheBootPending, whenActiveCache } from "./messageCache";
import type { ActiveCache } from "./messageCache";

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

/**
 * The attached cache, but only when it was opened for `serverId`.
 * Store resets are synchronous and scope attach is async, so a load that
 * starts on server B can still see A's holder. Reading or writing in that
 * gap paints A's rows as B's and, on putChannels, deletes A's cached
 * channels (and their messages) as "missing".
 */
function cacheBoundTo(serverId: string | null | undefined): ActiveCache | null {
  if (!serverId) return null;
  const cache = activeWebCache();
  if (!cache || cache.serverId !== serverId) return null;
  return cache;
}

/** Re-read immediately before a write so a logout that already detached cannot land. */
function cacheStillBound(serverId: string, seen: ActiveCache): ActiveCache | null {
  const cache = cacheBoundTo(serverId);
  if (!cache || cache.generation !== seen.generation || cache.scopeId !== seen.scopeId) return null;
  return cache;
}

/**
 * The attached scope captured at REQUEST START. Writes compare it against
 * the CURRENT attach scope — a server switch mid-flight must not persist
 * the previous scope's snapshot into the new one.
 */
export type DirectoryCacheScope = { scopeId: number; serverId: string; userId: string | null; generation: number };

/** Capture the active scope token for a request about to start (sync, no I/O). */
export function currentDirectoryCacheScope(): DirectoryCacheScope | null {
  const cache = activeWebCache();
  if (!cache || cache.serverId === null) return null;
  return {
    scopeId: cache.scopeId,
    serverId: cache.serverId,
    userId: cache.userId ?? null,
    generation: cache.generation,
  };
}

// Session user published by the lifecycle. Null before /me. The server list
// is account-scoped, so a scope opened for a different user must not seed
// or receive that list (logout wipe interrupted, next /me is another account,
// current still null so the lifecycle has not re-attached yet).
let sessionUserId: string | null = null;

// GET /servers often finishes before any scope exists (cold login: current
// is still null and nothing was persisted yet). The account list has to be
// written once that user's scope attaches, or the next offline boot finds
// channels in IndexedDB and an empty server list, and the shell falls
// through to "create your first server".
let pendingServerList: readonly Server[] | null = null;
let pendingServerListUser: string | null = null;

export function noteDirectorySessionUser(userId: string | null): void {
  if (userId !== sessionUserId) {
    pendingServerList = null;
    pendingServerListUser = null;
  }
  sessionUserId = userId;
}

/** The user the directory cache is recording for. Null before /me. */
export function directorySessionUser(): string | null {
  return sessionUserId;
}

/**
 * The attached scope when it is safe to read or write the server list for
 * the signed-in user. Null when nothing is attached, or when the scope
 * belongs to a different account than the current session.
 */
export function serverListScopeForSession(): DirectoryCacheScope | null {
  const scope = currentDirectoryCacheScope();
  if (!scope) return null;
  if (sessionUserId && scope.userId && scope.userId !== sessionUserId) return null;
  return scope;
}

function scopeStillCurrent(token: DirectoryCacheScope | null): ActiveCache | null {
  if (!token) return null;
  const cache = activeWebCache();
  if (!cache || cache.serverId === null) return null;
  if (cache.scopeId !== token.scopeId || cache.generation !== token.generation || cache.serverId !== token.serverId) {
    return null;
  }
  if ((cache.userId ?? null) !== token.userId) return null;
  return cache;
}

// Server-switch attach is async and nulls the holder at entry. Directory
// loads that start in that window must wait for the new scope; the boot
// gate only covers the cold start. Armed synchronously by the lifecycle
// before openScope, settled when the newest attach attempt finishes.
let directoryAttachGate: { pending: Promise<void>; resolve: () => void } | null = null;

/** Arm the server-switch attach wait. Idempotent until noteDirectoryAttachSettled. */
export function beginDirectoryAttachWait(): void {
  if (directoryAttachGate) return;
  let resolve!: () => void;
  const pending = new Promise<void>((done) => {
    resolve = done;
  });
  directoryAttachGate = { pending, resolve };
}

/** The in-flight attach attempt finished (or failed). Unblocks directory loads. */
export function noteDirectoryAttachSettled(): void {
  const gate = directoryAttachGate;
  directoryAttachGate = null;
  gate?.resolve();
  flushPendingServerList();
}

function waitForSignal(signal: Promise<void>, timeoutMs: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      // Same as whenActiveCache: a stuck openScope must not make every
      // later load wait out another full timeout.
      noteDirectoryAttachSettled();
      resolve();
    }, timeoutMs);
    signal.then(() => {
      clearTimeout(timer);
      resolve();
    });
  });
}

/**
 * True only when a load must wait before touching the cache. Callers await
 * only in that case: an already-bound scope, or a holder on another server
 * with nothing in flight, must not add an await before api.get.
 */
export function directoryCacheBindPending(serverId: string): boolean {
  if (!serverId || cacheBoundTo(serverId)) return false;
  return directoryAttachGate !== null || (!activeWebCache() && isActiveCacheBootPending());
}

/**
 * Resolves when `serverId`'s scope is attached, or after timeoutMs.
 * Call only when directoryCacheBindPending is true.
 */
export async function whenDirectoryCacheBound(serverId: string, timeoutMs = 4000): Promise<void> {
  const attachPending = directoryAttachGate?.pending ?? null;
  const bootPending = !activeWebCache() && isActiveCacheBootPending();
  if (bootPending) await whenActiveCache(timeoutMs);
  if (cacheBoundTo(serverId)) return;
  if (attachPending) await waitForSignal(attachPending, timeoutMs);
}

/**
 * True when the server-list load must wait for an in-flight attach.
 * The list lives in the attached scope (the persisted serverId when
 * current is still null), so a cold start waits; a live scope does not.
 */
export function serverListCachePending(): boolean {
  if (activeWebCache() && !directoryAttachGate) return false;
  return isActiveCacheBootPending() || directoryAttachGate !== null;
}

/** Call only when serverListCachePending is true. */
export async function whenServerListCacheReady(timeoutMs = 4000): Promise<void> {
  if (!activeWebCache() && isActiveCacheBootPending()) await whenActiveCache(timeoutMs);
  if (activeWebCache() && !directoryAttachGate) return;
  const attachPending = directoryAttachGate?.pending;
  if (attachPending) await waitForSignal(attachPending, timeoutMs);
}

/**
 * Cached server list from the attached scope, [] when absent or detached.
 * Not bound to the current server: on a cold start `current` is still null
 * and the list is the one stored for the persisted scope.
 */
export async function cachedServers(): Promise<Server[]> {
  const seen = activeWebCache();
  if (!seen) return [];
  const value = await seen.repo.getKv(seen.scopeId, SERVER_LIST_KV_KEY);
  const cache = activeWebCache();
  if (!cache || cache.scopeId !== seen.scopeId || cache.generation !== seen.generation) return [];
  return serversFromCacheValue(value);
}

/**
 * Record the authoritative GET /servers payload into the scope captured
 * when the load decided to fetch. With no scope attached yet, the list is
 * held for the requesting user and written once that user's scope attaches
 * (a session-user change drops it, so another account never receives it).
 */
export async function recordServers(
  servers: readonly Server[],
  requestScope: DirectoryCacheScope | null = currentDirectoryCacheScope(),
  recordedForUser: string | null = sessionUserId,
): Promise<void> {
  // The response belongs to the user who started the request. An account
  // switch during the await must not land that list in the new scope.
  if (recordedForUser !== sessionUserId) return;
  const cache = scopeStillCurrent(requestScope) ?? scopeStillCurrent(serverListScopeForSession());
  if (!cache) {
    pendingServerList = servers;
    pendingServerListUser = recordedForUser;
    return;
  }
  pendingServerList = null;
  pendingServerListUser = null;
  await cache.repo.putKv(cache.scopeId, SERVER_LIST_KV_KEY, {
    servers: servers as unknown as RawRecord[],
  });
}

function flushPendingServerList(): void {
  const servers = pendingServerList;
  const recordedForUser = pendingServerListUser;
  if (!servers || recordedForUser !== sessionUserId) return;
  if (!serverListScopeForSession()) return;
  void recordServers(servers, serverListScopeForSession(), recordedForUser);
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

/** Cached list for one kind ("channel" | "dm"), [] when absent, detached, or bound to another server. */
export async function cachedChannels(kind: ChannelListKind, serverId: string): Promise<ApiChannel[]> {
  const cache = cacheBoundTo(serverId);
  if (!cache) return [];
  return channelsFromRows(await cache.repo.getChannels(cache.scopeId, [kind]));
}

/**
 * One cached channel row by id across both list kinds (channel detail
 * fallback, task #8 scope addendum): the list rows ARE the directory cache,
 * so a channel the server once listed resolves offline without a network
 * round-trip. Null when absent or detached.
 */
export async function cachedChannelById(channelId: string, serverId: string): Promise<ApiChannel | null> {
  const cache = cacheBoundTo(serverId);
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
  serverId: string,
): Promise<void> {
  const seen = cacheBoundTo(serverId);
  if (!seen) return;
  const cache = cacheStillBound(serverId, seen);
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
// attach generation + epoch. The holder object itself is not an identity:
// bootWebCache's provider allocates a fresh `{ repo, scopeId, serverId,
// generation }` on every read. `generation` is stable for one attach and
// bumps on re-attach / reset, so a reused numeric scopeId cannot finish a
// reconcile that a previous attach started. Entries are dropped once both
// kinds are present and the reconcile has run, or when the epoch/generation
// changes, so the map cannot grow unboundedly.
type ChannelListEpochEntry = {
  generation: number;
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
  serverId: string,
): Promise<void> {
  const seen = cacheBoundTo(serverId);
  if (!seen) return;
  const scopeId = seen.scopeId;
  const current = channelListLoads.get(scopeId);
  // A newer epoch or a different attach supersedes any partial entry.
  if (!current || current.generation !== seen.generation || current.epoch !== epoch) {
    channelListLoads.set(scopeId, { generation: seen.generation, epoch, [kind]: toLiveChannels(live) });
    return;
  }
  current[kind] = toLiveChannels(live);
  const channelLive = current.channel;
  const dmLive = current.dm;
  if (!channelLive || !dmLive) return;
  channelListLoads.delete(scopeId);
  const cache = cacheStillBound(serverId, seen);
  if (!cache) return;
  await reconcileChannels(cache.repo, cache.scopeId, [...channelLive, ...dmLive]);
}

// ---- unread counts ---------------------------------------------------------------

/**
 * Cached RAW wire payload of GET /channels/unread?summary=1. Stored verbatim
 * so parseUnreadSnapshot runs identically on the cached seed; the read-state
 * ledger folding (consumeReadStateSnapshotRows) stays network-only.
 */
export async function cachedUnread(serverId: string): Promise<unknown> {
  const cache = cacheBoundTo(serverId);
  if (!cache) return null;
  return await cache.repo.getKv(cache.scopeId, CHANNEL_UNREAD_KV_KEY);
}

/** Record the raw unread wire payload (validated: non-object junk skipped). */
export async function recordUnread(data: unknown, serverId: string): Promise<void> {
  const seen = cacheBoundTo(serverId);
  if (!seen) return;
  if (!data || typeof data !== "object") return;
  const cache = cacheStillBound(serverId, seen);
  if (!cache) return;
  await cache.repo.putKv(cache.scopeId, CHANNEL_UNREAD_KV_KEY, data as RawRecord);
}

// One seed per (kind, server, epoch). Keyed by the server the load is FOR,
// not by whether the cache was already bound: a load that runs before
// attach still occupies the epoch, so the reconnect load after attach
// cannot paint a stale cached count the user already cleared.
const directorySeedEpoch = new Map<string, number>();

/**
 * True the first time `kind` is claimed for this server + epoch.
 * Does not require the cache to be bound. Callers seed only when the
 * claim succeeds AND the scope is actually attached.
 */
export function claimDirectorySeed(kind: string, epoch: number, serverId: string): boolean {
  if (!serverId) return false;
  const key = `${kind}:${serverId}`;
  if (directorySeedEpoch.get(key) === epoch) return false;
  directorySeedEpoch.set(key, epoch);
  return true;
}

/** Test isolation: seed claims survive the module for the process lifetime. */
export function resetDirectorySeedClaims(): void {
  directorySeedEpoch.clear();
  pendingServerList = null;
  pendingServerListUser = null;
}

// ---- cross-server unread summary ---------------------------------------------------

/** Cached raw wire payload of GET /servers/unread-summary, null when absent or bound elsewhere. */
export async function cachedUnreadSummary(serverId: string): Promise<unknown> {
  const cache = cacheBoundTo(serverId);
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
  serverId: string | null,
): Promise<void> {
  const seen = cacheBoundTo(serverId);
  if (!seen || !requestScope) return;
  if (requestScope.scopeId !== seen.scopeId) return;
  if (requestScope.serverId !== seen.serverId) return;
  if (requestScope.generation !== seen.generation) return;
  if (!data || typeof data !== "object") return;
  if (!serverId) return;
  const cache = cacheStillBound(serverId, seen);
  if (!cache) return;
  await cache.repo.putKv(cache.scopeId, UNREAD_SUMMARY_KV_KEY, data as RawRecord);
}
