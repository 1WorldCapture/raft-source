// Open-channel overlay refresh (desktop-data-cache task #5, the page-refresh
// half). Same rules as mobile: the latest 200 messages (4 pages of 50) refresh
// when a channel opens; scrolling up to an older page refreshes that page
// once per boot; a failed fetch does not stamp anything; a disconnect clears
// the marks so the next open/scroll refreshes again.
//
// "Once per boot" is tracked as seq coverage, not page boundaries. seq is one
// sequence across the whole server, so a channel's messages are sparse in it:
// any boundary cut from the messages currently in memory (or a fixed seq
// bucket) shifts or fragments as messages arrive or older pages load. A fetch
// `after=fromSeq-1&limit=50` proves the channel's rows from fromSeq through
// the last returned seq (through the end of the channel when the page is
// short), so a visible message is refreshed iff no fetch this boot covered it.

import type { OverlayPage, RawRecord } from "@botiverse/raft-shared/src/cacheRepoContract.js";
import api from "../api/client";
import {
  captureReceiverPrivateIngressContext,
  hydrateBundledThreadSummaries,
  normalizeReceiverPrivateMessagesIfEnabled,
  useMessageStore,
} from "../store/messageStore";
import type { Message, MessagesPageThreadSummaryPayload } from "../store/messageStore";
import {
  activeWebCache,
  isActiveCacheBootPending,
  whenActiveCache,
} from "./messageCache";
import type { ActiveCache } from "./messageCache";

export const OVERLAY_PAGE_SIZE = 50;
export const OVERLAY_OPEN_MESSAGE_LIMIT = OVERLAY_PAGE_SIZE * 4;
/** A failed page waits this long (doubling per failure) before it may retry. */
export const OVERLAY_RETRY_BASE_MS = 30_000;
/** After this many failures a page is left alone until the next disconnect/boot. */
export const OVERLAY_MAX_FAILURES = 3;

type CacheToken = {
  scopeId: number;
  serverId: string | null;
  userId: string | null;
  generation: number;
  /** Disconnect epoch: a response that straddles a disconnect marks nothing. */
  epoch: number;
};

type Coverage = { fromSeq: number; throughSeq: number };
type Failure = { count: number; retryAt: number };

// Per-boot, per-scope state. Keys are `${scopeId}:${generation}:${channelId}`.
const covered = new Map<string, Coverage[]>();
const failures = new Map<string, Failure>();
const inflight = new Map<string, { fromSeq: number; expectedThroughSeq: number; run: Promise<void> }>();
let disconnectEpoch = 0;
let stateScopeKey: string | null = null;
let now = () => Date.now();

/** @internal test seam for the retry backoff clock. */
export function setOverlayRefreshClockForTest(clock: (() => number) | null): void {
  now = clock ?? (() => Date.now());
}

function captureToken(): CacheToken | null {
  const cache = activeWebCache();
  if (!cache) return null;
  // Coverage, failures and flights belong to one scope attachment; drop
  // them as soon as another scope (server switch, reattach) is in use.
  const scopeKey = `${cache.scopeId}:${cache.generation}`;
  if (stateScopeKey !== scopeKey) {
    covered.clear();
    failures.clear();
    inflight.clear();
    stateScopeKey = scopeKey;
  }
  return {
    scopeId: cache.scopeId,
    serverId: cache.serverId,
    userId: cache.userId ?? null,
    generation: cache.generation,
    epoch: disconnectEpoch,
  };
}

function tokenCurrent(token: CacheToken): ActiveCache | null {
  if (token.epoch !== disconnectEpoch) return null;
  const cache = activeWebCache();
  if (!cache) return null;
  if (cache.scopeId !== token.scopeId || cache.generation !== token.generation) return null;
  if (cache.serverId !== token.serverId) return null;
  if ((cache.userId ?? null) !== token.userId) return null;
  return cache;
}

function channelKey(token: CacheToken, channelId: string): string {
  return `${token.scopeId}:${token.generation}:${channelId}`;
}

function isCovered(key: string, seq: number): boolean {
  return (covered.get(key) ?? []).some((span) => seq >= span.fromSeq && seq <= span.throughSeq);
}

function isInflight(key: string, seq: number): boolean {
  for (const [flightKey, flight] of inflight) {
    if (flightKey.startsWith(`${key}:`) && seq >= flight.fromSeq && seq <= flight.expectedThroughSeq) {
      // An in-flight fetch is expected to cover seq; wait for its answer
      // rather than issuing an overlapping one.
      return true;
    }
  }
  return false;
}

// The failure budget is per channel: a scrolling window changes fromSeq on
// every step, so a per-page key would restart the budget each time.
function isBackingOff(key: string): boolean {
  const failure = failures.get(key);
  if (!failure) return false;
  return failure.count >= OVERLAY_MAX_FAILURES || now() < failure.retryAt;
}

function noteFailure(key: string): void {
  const count = (failures.get(key)?.count ?? 0) + 1;
  failures.set(key, { count, retryAt: now() + OVERLAY_RETRY_BASE_MS * 2 ** (count - 1) });
}

/** Add a proven span, merging overlapping or touching ones. */
function addCoverage(key: string, span: Coverage): void {
  const spans = [...(covered.get(key) ?? []), span].sort((a, b) => a.fromSeq - b.fromSeq);
  const merged: Coverage[] = [];
  for (const next of spans) {
    const last = merged.at(-1);
    if (last && next.fromSeq <= last.throughSeq + 1) {
      last.throughSeq = Math.max(last.throughSeq, next.throughSeq);
    } else {
      merged.push({ ...next });
    }
  }
  covered.set(key, merged);
}

function sortedUnique(seqs: readonly number[]): number[] {
  return [...new Set(seqs.filter((seq) => Number.isSafeInteger(seq) && seq > 0))].sort((a, b) => a - b);
}

export type OverlayFetch = { fromSeq: number; expectedThroughSeq: number };

/**
 * Plan fetches for the `wanted` seqs that are not done yet, over every seq
 * the channel has in memory (`known`). Each page is aligned to end right
 * below the nearest done (covered or in-flight) seq above it, so scrolling
 * up one message at a time costs one request per 50 messages rather than
 * one per step. A page with nothing done above it runs to the channel end.
 */
export function overlayFetchPlan(
  known: readonly number[],
  wanted: readonly number[],
  isDone: (seq: number) => boolean = () => false,
): OverlayFetch[] {
  const all = sortedUnique([...known, ...wanted]);
  const indexOf = new Map(all.map((seq, index) => [seq, index]));
  const planned: Array<[number, number]> = [];
  const inPlan = (index: number) => planned.some(([from, through]) => index >= from && index <= through);
  const plan: OverlayFetch[] = [];
  const targets = sortedUnique(wanted).filter((seq) => !isDone(seq)).reverse();
  for (const seq of targets) {
    const at = indexOf.get(seq)!;
    if (inPlan(at)) continue;
    let boundary = at + 1;
    while (boundary < all.length && !isDone(all[boundary]!) && !inPlan(boundary)) boundary += 1;
    let below = at - 1;
    while (below >= 0 && !isDone(all[below]!) && !inPlan(below)) below -= 1;
    const doneAbove = boundary < all.length && boundary - at <= OVERLAY_PAGE_SIZE;
    const doneBelow = below >= 0 && at - below <= OVERLAY_PAGE_SIZE;
    let from: number;
    if (doneAbove || (!doneBelow && boundary - at <= OVERLAY_PAGE_SIZE)) {
      // End right below the done range above (scrolling up), or run to the
      // channel end when that is within one page.
      from = Math.max(0, boundary - OVERLAY_PAGE_SIZE);
    } else if (doneBelow) {
      // Above a done range (new tail, scrolling down): start right after it.
      from = below + 1;
    } else {
      // An isolated window: start at the lowest wanted seq this page can reach.
      from = at;
      for (const other of targets) {
        const index = indexOf.get(other)!;
        if (index < from && at - index < OVERLAY_PAGE_SIZE && !inPlan(index)) from = index;
      }
    }
    const through = Math.min(from + OVERLAY_PAGE_SIZE - 1, all.length - 1);
    planned.push([from, through]);
    plan.push({
      fromSeq: all[from]!,
      expectedThroughSeq: through === all.length - 1 ? Number.MAX_SAFE_INTEGER : all[through]!,
    });
  }
  return plan;
}

function overlayPageFromResponse(fromSeq: number, data: unknown): OverlayPage {
  const record = (data ?? {}) as {
    messages?: unknown;
    threadSummariesByParentMessageId?: Record<string, RawRecord>;
  };
  const rows = Array.isArray(record.messages) ? record.messages : [];
  const messages: OverlayPage["messages"] = [];
  for (const row of rows) {
    if (!row || typeof row !== "object") continue;
    const rec = row as Record<string, unknown>;
    const seq = typeof rec.seq === "number" ? rec.seq : null;
    if (seq === null || seq <= 0) continue;
    messages.push({
      seq,
      id: typeof rec.id === "string" ? rec.id : undefined,
      raw: rec,
      updatedAt: typeof rec.updatedAt === "string" ? rec.updatedAt : null,
    });
  }
  return {
    fromSeq,
    throughSeq: messages.length > 0 ? Math.max(...messages.map((message) => message.seq)) : fromSeq,
    messages,
    ...(record.threadSummariesByParentMessageId
      ? { threadSummaries: record.threadSummariesByParentMessageId }
      : {}),
  };
}

function updatedAtMs(message: unknown): number | null {
  const value = (message as { updatedAt?: unknown }).updatedAt;
  if (typeof value !== "string") return null;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : null;
}

function sameValue(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) return true;
  if (typeof left !== "object" || typeof right !== "object" || !left || !right) return false;
  return JSON.stringify(left) === JSON.stringify(right);
}

/** Field-by-field merge that keeps the row reference when nothing really changed. */
function mergeOverlayRow(existing: Message, incoming: Message): Message {
  let changed = false;
  for (const [key, value] of Object.entries(incoming) as Array<[keyof Message, unknown]>) {
    if (key === "commentRef" && existing.commentRef && value == null) continue;
    if (!sameValue(existing[key], value)) {
      changed = true;
      break;
    }
  }
  if (!changed) return existing;
  const merged: Message = { ...existing, ...incoming };
  if (existing.commentRef && incoming.commentRef == null) merged.commentRef = existing.commentRef;
  return merged;
}

/**
 * Apply fetched rows to the store. A row that changed in the store while the
 * request was in flight (a live message:updated, e.g. a new reaction), or that
 * carries a newer updatedAt, wins over the older response.
 */
function paintOverlay(channelId: string, messages: Message[], before: ReadonlyMap<string, Message>): void {
  useMessageStore.setState((state) => {
    const bucket = state.channelMessages[channelId];
    if (!bucket || bucket.length === 0) return state;
    const incoming = new Map(messages.map((message) => [message.id, message]));
    let changed = false;
    const merged = bucket.map((row) => {
      const next = incoming.get(row.id);
      if (!next) return row;
      const snapshot = before.get(row.id);
      if (snapshot !== undefined && snapshot !== row) return row;
      const rowUpdatedAt = updatedAtMs(row);
      const nextUpdatedAt = updatedAtMs(next);
      if (rowUpdatedAt !== null && nextUpdatedAt !== null && rowUpdatedAt > nextUpdatedAt) return row;
      const updated = mergeOverlayRow(row, next);
      if (updated !== row) changed = true;
      return updated;
    });
    if (!changed) return state;
    const isCurrent = state.currentChannelId === channelId;
    return {
      channelMessages: { ...state.channelMessages, [channelId]: merged },
      messages: isCurrent ? merged : state.messages,
    };
  });
}

async function refreshFromNow(channelId: string, fromSeq: number, token: CacheToken): Promise<void> {
  const key = channelKey(token, channelId);
  const before = new Map(
    (useMessageStore.getState().channelMessages[channelId] ?? []).map((message) => [message.id, message]),
  );
  const ingress = captureReceiverPrivateIngressContext(useMessageStore.getState().currentUserId);
  let data: unknown;
  try {
    const response = await api.get(
      `/messages/channel/${encodeURIComponent(channelId)}?after=${fromSeq - 1}&limit=${OVERLAY_PAGE_SIZE}`,
    );
    data = response.data;
  } catch {
    if (tokenCurrent(token)) noteFailure(key);
    return;
  }
  const cache = tokenCurrent(token);
  if (!cache) return;

  const page = overlayPageFromResponse(fromSeq, data);
  // A short page reached the end of the channel: everything from fromSeq on
  // is fresh, including rows deleted server-side (they simply are not there).
  const throughSeq = page.messages.length < OVERLAY_PAGE_SIZE ? Number.MAX_SAFE_INTEGER : page.throughSeq;
  addCoverage(key, { fromSeq, throughSeq });
  failures.delete(key);

  // Rows the store changed while the request was in flight (a live
  // message:updated) are newer than this response: keep them out of the
  // cache too, or the next boot would paint the stale overlay first.
  const nowRows = new Map(
    (useMessageStore.getState().channelMessages[channelId] ?? []).map((message) => [message.id, message]),
  );
  const cacheRows = page.messages.filter((row) => {
    const id = typeof row.id === "string" ? row.id : null;
    if (!id || !before.has(id)) return true;
    return nowRows.get(id) === before.get(id);
  });
  if (cacheRows.length > 0) {
    await cache.repo.applyOverlayPage(cache.scopeId, channelId, { ...page, messages: cacheRows });
  }
  if (!tokenCurrent(token)) return;

  const normalized = normalizeReceiverPrivateMessagesIfEnabled(
    page.messages.map((message) => message.raw as unknown as Message),
    ingress,
  );
  const rows = normalized ?? page.messages.map((message) => message.raw as unknown as Message);
  if (rows.length > 0) paintOverlay(channelId, rows, before);
  if (page.threadSummaries && Object.keys(page.threadSummaries).length > 0) {
    hydrateBundledThreadSummaries(
      { threadSummariesByParentMessageId: page.threadSummaries } as unknown as MessagesPageThreadSummaryPayload,
      ingress,
    );
  }
}

function refreshFrom(
  channelId: string,
  fromSeq: number,
  expectedThroughSeq: number,
  token: CacheToken,
): Promise<void> {
  const key = channelKey(token, channelId);
  const flightKey = `${key}:${token.epoch}:${fromSeq}`;
  const existing = inflight.get(flightKey);
  if (existing) return existing.run;
  const run = refreshFromNow(channelId, fromSeq, token).finally(() => {
    if (inflight.get(flightKey)?.run === run) inflight.delete(flightKey);
  });
  inflight.set(flightKey, { fromSeq, expectedThroughSeq, run });
  return run;
}

/** Refresh whatever of `wanted` this boot has not covered yet. */
function refreshSeqs(
  channelId: string,
  known: readonly number[],
  wanted: readonly number[],
  token: CacheToken,
): Promise<void>[] {
  const key = channelKey(token, channelId);
  if (isBackingOff(key)) return [];
  const isDone = (seq: number) => isCovered(key, seq) || isInflight(key, seq);
  return overlayFetchPlan(known, wanted, isDone)
    .map(({ fromSeq, expectedThroughSeq }) => refreshFrom(channelId, fromSeq, expectedThroughSeq, token));
}

function storeSeqs(channelId: string): number[] {
  return (useMessageStore.getState().channelMessages[channelId] ?? [])
    .flatMap((message) => (typeof message.seq === "number" ? [message.seq] : []));
}

async function readyToken(): Promise<CacheToken | null> {
  if (!activeWebCache() && isActiveCacheBootPending()) await whenActiveCache(4000);
  return captureToken();
}

/**
 * Channel open and reconnect: refresh dynamic data for the newest 200 cached
 * messages. Older pages wait until they are scrolled into view.
 */
export async function refreshLatestOverlayPages(channelId: string): Promise<void> {
  const token = await readyToken();
  if (!token) return;
  const cache = tokenCurrent(token);
  if (!cache) return;
  const latest = await cache.repo.getLatestMessages(cache.scopeId, channelId, OVERLAY_OPEN_MESSAGE_LIMIT);
  if (!tokenCurrent(token)) return;
  const latestSeqs = latest.map((row) => row.seq);
  await Promise.all(refreshSeqs(channelId, [...latestSeqs, ...storeSeqs(channelId)], latestSeqs, token));
}

/** Scroll: refresh visible messages no fetch has covered this boot. */
export function refreshVisibleOverlayPages(channelId: string, messageIds: readonly string[]): void {
  if (messageIds.length === 0) return;
  const token = captureToken();
  if (!token || !tokenCurrent(token)) return;
  const wanted = new Set(messageIds);
  const seqs: number[] = [];
  for (const message of useMessageStore.getState().channelMessages[channelId] ?? []) {
    if (wanted.has(message.id) && typeof message.seq === "number") seqs.push(message.seq);
  }
  if (seqs.length === 0) return;
  void Promise.all(refreshSeqs(channelId, storeSeqs(channelId), seqs, token));
}

/**
 * Disconnect drops the once-per-boot marks (in memory and the repo's page
 * stamps), forgets failures, and invalidates in-flight fetches: a response
 * that lands after the disconnect marks nothing, so the page refreshes again
 * after reconnect. Overlay rows themselves stay.
 */
export async function invalidateOverlayMarksForDisconnect(): Promise<void> {
  disconnectEpoch += 1;
  covered.clear();
  failures.clear();
  inflight.clear();
  const token = captureToken();
  if (!token) return;
  const cache = tokenCurrent(token);
  if (!cache) return;
  await cache.repo.invalidateOverlayPageMarks(cache.scopeId);
}

/** @internal reset module state between tests. */
export function resetOverlayRefreshForTest(): void {
  stateScopeKey = null;
  covered.clear();
  failures.clear();
  inflight.clear();
  disconnectEpoch = 0;
  now = () => Date.now();
}
