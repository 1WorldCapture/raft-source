// Web message-cache bridge (desktop-data-cache task #9 / P2b).
//
// The ONLY module packages/web's stores are allowed to touch. It owns:
//   - the active-cache holder (repo + scopeId). Task #7 wires the lifecycle
//     (per-account+server scopes, logout wipe, multi-tab coordination) and
//     will inject the IndexedDB repo; until then the in-memory repo from
//     webCacheRepo.ts is the default. Keeping the holder here means the
//     store wiring does not change again when #7 lands.
//   - translation between web `Message` rows and cache rows, reusing the
//     shared boot helpers (rawPageForCache / messageFetchPlan) so merge and
//     window semantics stay identical to mobile.
//
// Store integration contract (messageStore):
//   - loadMessages: seed the pane from the cache before the network answers
//     (cold start paints instantly), then continue fetching from the cached
//     coverage tail (after=tail, drained page by page) instead of re-pulling
//     the latest page;
//   - loadOlderMessages / loadNewerMessages: every fetched page is recorded
//     (appendPage grows coverage downward/upward);
//   - thread summaries bundled with pages are persisted alongside.
import type {
  AppendPage,
  CacheRepo,
  CachedMessage,
  RawRecord,
} from "@botiverse/raft-shared/src/cacheRepoContract.js";
import { messageFetchPlan, rawPageForCache } from "@botiverse/raft-shared/src/cacheBoot.js";
import { createWebCacheRepo } from "./webCacheRepo";

export type ActiveCache = {
  repo: CacheRepo;
  scopeId: number;
  /**
   * The attached scope's serverId (Firstmate naming ruling): consumers that
   * know "the current server" compare against it so a load started for
   * server B never reads/writes server A's scope mid-transition.
   */
  serverId: string | null;
  /**
   * Invalidation era (P2c review; ruling name: "generation" — the store
   * layer already has a serverEpoch): changes whenever the active scope is
   * detached or replaced. Long-running writers capture it with the scopeId
   * and re-verify before each write so a logout wipe or server switch
   * invalidates them immediately. With the provider path it mirrors the
   * runtime's generation; the stopgap holder bumps its own counter on every
   * set/clear.
   */
  generation: number;
};

type ActiveCacheProvider = () => ActiveCache | null;

// Holder split (Firstmate ruling, desktop-data-cache #6 thread aa568281):
// lifecycle belongs to #7's runtime, which injects a provider here. Until
// then an internal fallback serves tests and the pre-#7 stopgap wiring.
let provider: ActiveCacheProvider | null = null;
let fallbackActive: ActiveCache | null = null;
let fallbackGeneration = 0;

// Boot gate. loadMessages may run while IndexedDB open + scope attach are
// still in flight. Waiters block only while this gate is armed; once the
// attach attempt settles (or times out) later loads stay synchronous.
let bootGate: { pending: Promise<void>; resolve: () => void } | null = null;

/** Arm the boot gate. Idempotent until noteActiveCacheSettled. */
export function beginActiveCacheBoot(): void {
  if (bootGate) return;
  let resolve!: () => void;
  const pending = new Promise<void>((done) => {
    resolve = done;
  });
  bootGate = { pending, resolve };
}

/** True while boot has started and the attach attempt has not settled. */
export function isActiveCacheBootPending(): boolean {
  return bootGate !== null;
}

/** Attach finished, failed, or was skipped. Unblocks whenActiveCache. */
export function noteActiveCacheSettled(): void {
  const gate = bootGate;
  bootGate = null;
  gate?.resolve();
}

/**
 * Resolves when the boot attach attempt settles, or after timeoutMs.
 * Already-active caches and processes that never booted a cache resolve
 * immediately, so loadMessages adds no await before api.get in those cases.
 */
export function whenActiveCache(timeoutMs: number): Promise<void> {
  if (!bootGate || activeWebCache()) return Promise.resolve();
  const gate = bootGate;
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      noteActiveCacheSettled();
      resolve();
    }, timeoutMs);
    gate.pending.then(() => {
      clearTimeout(timer);
      resolve();
    });
  });
}

/**
 * #7's runtime injects its live holder: `setActiveCacheProvider(() =>
 * runtime.scopeId === null ? null : { repo, runtime.repo, ... })`. Called
 * once from bootWebCache; scope switches flow through the provider, this
 * module owns no lifecycle at all.
 */
export function setActiveCacheProvider(next: ActiveCacheProvider | null): void {
  provider = next;
  // Clearing the provider is how tests fall back to the stopgap holder.
  // Arming the boot gate on that path would make the next load wait until
  // timeout. A real provider still arms the gate (cold start).
  if (next) beginActiveCacheBoot();
  else noteActiveCacheSettled();
}

/** Stopgap/test-only direct holder — real app wiring goes through #7. */
export function setActiveWebCache(repo: CacheRepo, scopeId: number, serverId: string | null = null): void {
  fallbackGeneration += 1;
  fallbackActive = { repo, scopeId, serverId, generation: fallbackGeneration };
  noteActiveCacheSettled();
}

/** Stopgap/test-only direct holder clear (bumps the era like a real detach). */
export function clearActiveWebCache(): void {
  fallbackGeneration += 1;
  fallbackActive = null;
}

/**
 * The active cache, or null when no scope is attached (logged out etc.).
 * Deliberately SYNCHRONOUS — loadMessages must add zero await boundaries
 * before api.get when no cache is mounted (receiver-private tests capture
 * the pending request synchronously); repo methods themselves stay async.
 */
export function activeWebCache(): ActiveCache | null {
  if (provider) return provider();
  return fallbackActive;
}

/**
 * Attach an in-memory cache for a scope (tests + the pre-#7 stopgap).
 * Returns the scopeId. Idempotent: re-attaching the same identity reuses the
 * same repo scope (identity is handled inside the repo).
 */
export async function attachMemoryWebCache(
  origin: string,
  userId: string,
  serverId: string,
  repo: CacheRepo = createWebCacheRepo(),
): Promise<number> {
  const scopeId = await repo.openScope(origin, userId, serverId);
  setActiveWebCache(repo, scopeId, serverId);
  return scopeId;
}

// ---- row translation ---------------------------------------------------------

/** A row (raw response item or normalized Message) is cacheable when it carries a real server seq. */
export function rowToCacheRow(item: unknown): {
  seq: number;
  id: string;
  raw: Record<string, unknown>;
} | null {
  if (!item || typeof item !== "object") return null;
  const record = item as { id?: unknown; seq?: unknown };
  if (typeof record.id !== "string") return null;
  if (typeof record.seq !== "number" || !Number.isFinite(record.seq) || record.seq <= 0) return null;
  return { seq: record.seq, id: record.id, raw: record as Record<string, unknown> };
}

/**
 * Extract an AppendPage from a raw `/messages/channel` response WITHOUT
 * disturbing the screen's own parsing (shared helper: absent or malformed
 * windows degrade to the row span, the repo rule).
 */
export function pageForCache(data: unknown): AppendPage {
  return rawPageForCache(data, rowToCacheRow);
}

/** Record one fetched page (grows coverage) + its bundled thread summaries. */
export async function recordMessagePage(channelId: string, data: unknown): Promise<void> {
  const cache = activeWebCache();
  if (!cache) return;
  const page = pageForCache(data);
  if (page.messages.length > 0) {
    await cache.repo.appendPage(cache.scopeId, channelId, page);
  }
  await recordThreadSummaries(channelId, data);
}

/** Persist `threadSummariesByParentMessageId` bundled with a page response. */
export async function recordThreadSummaries(parentChannelId: string, data: unknown): Promise<void> {
  const cache = activeWebCache();
  if (!cache) return;
  const summaries = (data as { threadSummariesByParentMessageId?: Record<string, unknown> }).threadSummariesByParentMessageId;
  if (!summaries || typeof summaries !== "object") return;
  for (const [parentMessageId, summary] of Object.entries(summaries)) {
    if (!summary || typeof summary !== "object") continue;
    await cache.repo.applyThreadSummary(cache.scopeId, {
      parentChannelId,
      parentMessageId,
      raw: summary as RawRecord,
    });
  }
}

/** Cached thread summaries for one parent channel (store hydrates them as-is). */
export async function cachedThreadSummaries(parentChannelId: string): Promise<Record<string, RawRecord>> {
  const cache = activeWebCache();
  if (!cache) return {};
  return cache.repo.getThreadSummaries(cache.scopeId, parentChannelId);
}

// ---- realtime write-through (desktop-data-cache #11 P3) ----------------------

/**
 * message:new / sync:resume write-through. The message is ALWAYS stored;
 * coverage-tail extension deliberately does NOT happen here (appendLiveMessage
 * with connected:false — mobile semantics when socket continuity is unknown):
 * ranges grow only from appendPage (HTTP pages), so a live burst that skipped
 * seqs can never punch a false hole-free range. The cost — a cold start re-
 * pulls from the older tail — is idempotent upserts, never wrong data.
 */
export function noteLiveMessage(message: { id: string; seq?: number; channelId: string }): void {
  const cache = activeWebCache();
  if (!cache) return;
  const row = rowToCacheRow(message);
  if (!row) return; // optimistic rows carry no server seq
  void cache.repo.appendLiveMessage(cache.scopeId, message.channelId, row, { connected: false });
}

/**
 * message:updated write-through — reactions and other projections land in the
 * overlay layer, last-write-wins on the server updatedAt inside the repo.
 */
export function noteMessageUpdated(
  message: { id: string; seq?: number; channelId: string } & Record<string, unknown>,
): void {
  const cache = activeWebCache();
  if (!cache) return;
  if (typeof message.seq !== "number" || !Number.isFinite(message.seq) || message.seq <= 0) return;
  const { id: _id, seq, channelId, ...rest } = message;
  void cache.repo.applyMessageUpdated(cache.scopeId, channelId, {
    seq,
    raw: rest as RawRecord,
    updatedAt: typeof message.updatedAt === "string" ? message.updatedAt : null,
  });
}

// ---- seed + fetch plan --------------------------------------------------------

export type ChannelSeed = {
  /** Newest-first cache rows, already overlay-merged and row-validated. */
  rows: CachedMessage[];
  /** The cached coverage after this seed read. */
  coverage: Array<{ fromSeq: number; throughSeq: number }>;
};

/**
 * Read the cached tail of a channel for first paint. Degrades to null when
 * no cache is attached or nothing is stored — the caller then proceeds with
 * its plain network path unchanged.
 */
export async function seedChannel(channelId: string, limit: number): Promise<ChannelSeed | null> {
  const cache = activeWebCache();
  if (!cache) return null;
  const rows = await cache.repo.getLatestMessages(cache.scopeId, channelId, limit);
  const coverage = await cache.repo.getCoverage(cache.scopeId, channelId);
  if (rows.length === 0) return null;
  return { rows, coverage };
}

/**
 * Merge a cached row (base + overlay) into a displayable record. The web
 * Message IS a plain object, so this is a shallow merge with the same legacy
 * string-seq coercion the shared hydrator applies; rows that fail a minimal
 * shape check are dropped, never thrown.
 */
export function hydrateSeedRows<T>(rows: readonly CachedMessage[], asMessage: (value: Record<string, unknown>) => T | null): T[] {
  const out: T[] = [];
  for (const row of rows) {
    const merged = { ...row.raw, ...(row.overlay ?? {}) } as Record<string, unknown>;
    if (typeof merged.seq === "string" && /^\d+$/.test(merged.seq)) merged.seq = Number(merged.seq);
    if (typeof merged.seq !== "number") continue;
    if (typeof merged.id !== "string") continue;
    const message = asMessage(merged);
    if (message) out.push(message);
  }
  return out;
}

/** Coverage → fetch plan: continue from the tail, or request the latest page. */
export async function channelFetchPlan(
  channelId: string,
): Promise<{ after: number } | { latest: true } | null> {
  const cache = activeWebCache();
  if (!cache) return null;
  const coverage = await cache.repo.getCoverage(cache.scopeId, channelId);
  if (coverage.length === 0) return null;
  return messageFetchPlan(coverage);
}
