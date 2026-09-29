// Open-channel overlay refresh (desktop-data-cache task #5, the page-refresh
// half). Same rules as mobile: the latest 200 messages (4 pages of 50) refresh
// when a channel opens; scrolling up to an older page refreshes that page if
// its marker is from before this boot; each page at most once per boot; a
// failed fetch does not stamp the marker; a disconnect clears the markers
// so the next refresh can run again.

import type { OverlayPage, RawRecord } from "@botiverse/raft-shared/src/cacheRepoContract.js";
import api from "../api/client";
import {
  captureReceiverPrivateIngressContext,
  mergeIncomingMessage,
  normalizeReceiverPrivateMessagesIfEnabled,
  useMessageStore,
} from "../store/messageStore";
import type { Message } from "../store/messageStore";
import { useThreadStore } from "../store/threadStore";
import type { ThreadSummary } from "../store/threadStore";
import {
  activeWebCache,
  isActiveCacheBootPending,
  whenActiveCache,
} from "./messageCache";
import type { ActiveCache } from "./messageCache";

export const OVERLAY_PAGE_SIZE = 50;
export const OVERLAY_OPEN_MESSAGE_LIMIT = OVERLAY_PAGE_SIZE * 4;

export type OverlayPageSpan = {
  fromSeq: number;
  throughSeq: number;
  seqs: number[];
};

type CacheToken = {
  scopeId: number;
  serverId: string | null;
  userId: string | null;
  generation: number;
};

const inflight = new Map<string, Promise<void>>();

function captureToken(): CacheToken | null {
  const cache = activeWebCache();
  if (!cache) return null;
  return {
    scopeId: cache.scopeId,
    serverId: cache.serverId,
    userId: cache.userId ?? null,
    generation: cache.generation,
  };
}

function tokenCurrent(token: CacheToken): ActiveCache | null {
  const cache = activeWebCache();
  if (!cache) return null;
  if (cache.scopeId !== token.scopeId || cache.generation !== token.generation) return null;
  if (cache.serverId !== token.serverId) return null;
  if ((cache.userId ?? null) !== token.userId) return null;
  return cache;
}

/** Newest-first groups of 50. `maxMessages` keeps the open refresh to 200. */
export function overlayPagesFromSeqs(seqs: readonly number[], maxMessages?: number): OverlayPageSpan[] {
  const unique = [...new Set(seqs.filter((seq) => Number.isSafeInteger(seq) && seq > 0))].sort((a, b) => b - a);
  const capped = maxMessages === undefined ? unique : unique.slice(0, maxMessages);
  const pages: OverlayPageSpan[] = [];
  for (let index = 0; index < capped.length; index += OVERLAY_PAGE_SIZE) {
    const chunk = capped.slice(index, index + OVERLAY_PAGE_SIZE);
    pages.push({
      fromSeq: Math.min(...chunk),
      throughSeq: Math.max(...chunk),
      seqs: chunk,
    });
  }
  return pages;
}

function overlayPageFromResponse(fromSeq: number, data: unknown): OverlayPage | null {
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
  if (messages.length === 0) return null;
  return {
    fromSeq,
    throughSeq: Math.max(...messages.map((message) => message.seq)),
    messages,
    ...(record.threadSummariesByParentMessageId
      ? { threadSummaries: record.threadSummariesByParentMessageId }
      : {}),
  };
}

function paintOverlay(channelId: string, messages: Message[]): void {
  useMessageStore.setState((state) => {
    const bucket = state.channelMessages[channelId];
    if (!bucket || bucket.length === 0) return state;
    const incoming = new Map(messages.map((message) => [message.id, message]));
    let changed = false;
    const merged = bucket.map((row) => {
      const next = incoming.get(row.id);
      if (!next) return row;
      const updated = mergeIncomingMessage(row, next);
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

async function refreshOverlayPageNow(channelId: string, fromSeq: number, token: CacheToken): Promise<void> {
  const cache = tokenCurrent(token);
  if (!cache) return;
  const info = await cache.repo.getOverlayPageInfo(cache.scopeId, channelId, fromSeq);
  const current = tokenCurrent(token);
  if (!current) return;
  if (info && info.bootId === current.repo.bootId) return;

  let data: unknown;
  try {
    const response = await api.get(
      `/messages/channel/${encodeURIComponent(channelId)}?after=${fromSeq - 1}&limit=${OVERLAY_PAGE_SIZE}`,
    );
    data = response.data;
  } catch {
    return;
  }

  const page = overlayPageFromResponse(fromSeq, data);
  const afterFetch = tokenCurrent(token);
  if (!afterFetch || !page) return;
  const again = await afterFetch.repo.getOverlayPageInfo(afterFetch.scopeId, channelId, fromSeq);
  if (!tokenCurrent(token)) return;
  if (again && again.bootId === afterFetch.repo.bootId) return;

  await afterFetch.repo.applyOverlayPage(afterFetch.scopeId, channelId, page);
  if (!tokenCurrent(token)) return;

  const ingress = captureReceiverPrivateIngressContext(useMessageStore.getState().currentUserId);
  const normalized = normalizeReceiverPrivateMessagesIfEnabled(
    page.messages.map((message) => message.raw as unknown as Message),
    ingress,
  );
  if (normalized && normalized.length > 0) paintOverlay(channelId, normalized);
  if (page.threadSummaries && Object.keys(page.threadSummaries).length > 0) {
    useThreadStore.getState().hydrateSummaries(page.threadSummaries as unknown as Record<string, ThreadSummary>);
  }
}

function refreshOverlayPage(channelId: string, fromSeq: number, token: CacheToken): Promise<void> {
  const flightKey = `${token.scopeId}:${token.generation}:${channelId}:${fromSeq}`;
  const existing = inflight.get(flightKey);
  if (existing) return existing;
  const run = refreshOverlayPageNow(channelId, fromSeq, token).finally(() => {
    if (inflight.get(flightKey) === run) inflight.delete(flightKey);
  });
  inflight.set(flightKey, run);
  return run;
}

async function readyToken(): Promise<CacheToken | null> {
  if (!activeWebCache() && isActiveCacheBootPending()) await whenActiveCache(4000);
  return captureToken();
}

/** Channel open: refresh dynamic data for the newest 200 cached messages. */
export async function refreshLatestOverlayPages(channelId: string): Promise<void> {
  const token = await readyToken();
  if (!token) return;
  const cache = tokenCurrent(token);
  if (!cache) return;
  const latest = await cache.repo.getLatestMessages(cache.scopeId, channelId, OVERLAY_OPEN_MESSAGE_LIMIT);
  if (!tokenCurrent(token)) return;
  const pages = overlayPagesFromSeqs(latest.map((row) => row.seq), OVERLAY_OPEN_MESSAGE_LIMIT);
  await Promise.all(pages.map((page) => refreshOverlayPage(channelId, page.fromSeq, token)));
}

/** Scroll: refresh the page that contains a newly visible message, once per boot. */
export function refreshVisibleOverlayPages(channelId: string, messageIds: readonly string[]): void {
  if (messageIds.length === 0) return;
  const token = captureToken();
  if (!token) return;
  const bucket = useMessageStore.getState().channelMessages[channelId] ?? [];
  const seqById = new Map(bucket.map((message) => [message.id, message.seq]));
  const visible = new Set<number>();
  for (const id of messageIds) {
    const seq = seqById.get(id);
    if (typeof seq === "number" && seq > 0) visible.add(seq);
  }
  if (visible.size === 0) return;
  const pages = overlayPagesFromSeqs(bucket.flatMap((message) => (typeof message.seq === "number" ? [message.seq] : [])));
  for (const page of pages) {
    if (page.seqs.some((seq) => visible.has(seq))) void refreshOverlayPage(channelId, page.fromSeq, token);
  }
}

/** Reconnect: pages already in memory had their marks cleared and need another pass. */
export async function refreshStoredOverlayPages(channelId: string): Promise<void> {
  const token = await readyToken();
  if (!token) return;
  const bucket = useMessageStore.getState().channelMessages[channelId] ?? [];
  const pages = overlayPagesFromSeqs(bucket.flatMap((message) => (typeof message.seq === "number" ? [message.seq] : [])));
  await Promise.all(pages.map((page) => refreshOverlayPage(channelId, page.fromSeq, token)));
}

/** Disconnect drops the once-per-boot markers. Overlay rows themselves stay. */
export async function invalidateOverlayMarksForDisconnect(): Promise<void> {
  const token = captureToken();
  if (!token) return;
  const cache = tokenCurrent(token);
  if (!cache) return;
  await cache.repo.invalidateOverlayPageMarks(cache.scopeId);
}
