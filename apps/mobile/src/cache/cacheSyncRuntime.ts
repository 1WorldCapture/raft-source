// Bridge between the realtime session layer and the cacheSync scheduler
// (client-data-cache task #3). The session's socket handlers call the
// note*/run* functions here; everything funnels through the shared cache
// runtime singleton (task #2) for the repo and scope id, and through the
// injected ApiClient for the two network fetchers.
//
// Socket continuity gate (review note #1): a live message may extend the
// channel's coverage tail only while the socket stayed connected AND the
// post-reconnect gap sync has finished. `tailExtendable` encodes exactly
// that: cleared on disconnect, cleared again on connect, set once
// runGapSync completes for the currently attached scope.

import type { ApiClient } from "../api/client";
import { parseMessage, parseMessagePage, type RaftMessage } from "../model/messages";
import { getCacheRuntime } from "./runtime";
import { createCacheSync, type CacheSync } from "./cacheSync";
import type { RawRecord } from "./repo";

let cacheSync: CacheSync | null = null;
let cacheSyncClient: ApiClient | null = null;

function ensureCacheSync(client: ApiClient): CacheSync | null {
  // Rebind when the client instance changes (re-login builds a new client).
  if (cacheSync && cacheSyncClient === client) return cacheSync;
  try {
    getCacheRuntime();
  } catch {
    return null; // runtime not initialized yet (task #2 wires initCacheRuntime)
  }
  cacheSync = createCacheSync({
    repo: getCacheRuntime().repo,
    fetchSyncPage: async (sinceSeq, limit) => {
      const data = await client.get<unknown>(`/messages/sync?since_seq=${sinceSeq}&limit=${limit}`);
      return parseMessagePage(data).flatMap((message) => (
        typeof message.seq === "number"
          ? [{ seq: message.seq, id: message.id, channelId: message.channelId, raw: message as unknown as RawRecord }]
          : []
      ));
    },
    fetchOverlayPage: async (channelId, fromSeq) => {
      const data = await client.get<unknown>(
        `/messages/channel/${encodeURIComponent(channelId)}?after=${fromSeq - 1}&limit=50`,
      );
      const messages = parseMessagePage(data);
      const window = (data as { messageWindow?: { coveredFromSeq?: unknown; coveredThroughSeq?: unknown } }).messageWindow;
      const throughSeq = typeof window?.coveredThroughSeq === "number"
        ? window.coveredThroughSeq
        : (messages.length > 0 ? messages[messages.length - 1]!.seq ?? fromSeq : fromSeq);
      const summaries = (data as { threadSummariesByParentMessageId?: Record<string, unknown> }).threadSummariesByParentMessageId;
      return {
        fromSeq,
        throughSeq,
        messages: messages.flatMap((message) => (
          typeof message.seq === "number"
            ? [{ seq: message.seq, id: message.id, raw: message as unknown as RawRecord }]
            : []
        )),
        ...(summaries ? { threadSummaries: summaries as Record<string, RawRecord> } : {}),
      };
    },
  });
  cacheSyncClient = client;
  return cacheSync;
}

function scope(): number | null {
  try {
    return getCacheRuntime().scopeId;
  } catch {
    return null;
  }
}

// ---- socket continuity + cancellation + single-flight ------------------------

let tailExtendable = false;

/** Bumped by cancelCacheSync(); in-flight sync loops abort on the next check. */
let syncGeneration = 0;

export function markCacheSocketDisconnected(): void {
  tailExtendable = false;
}

/**
 * Cancel any in-flight gap sync (logout / scope switch path). The #2 logout
 * hook must call this BEFORE runtime.logout() so a wiping sweep cannot be
 * followed by a late batch writing data back into the fresh scope.
 */
export function cancelCacheSync(): void {
  syncGeneration += 1;
  tailExtendable = false;
}

let gapInFlight: Promise<void> | null = null;
let gapRerunRequested = false;

/**
 * Post-(re)connect / foreground-return gap sync, single-flight: while one
 * round is running, further calls join it and request (at most) one more
 * round afterwards — two loops never interleave on the same scope.
 */
export function runCacheGapSync(client: ApiClient): Promise<void> {
  if (gapInFlight !== null) {
    gapRerunRequested = true;
    return gapInFlight;
  }
  gapInFlight = (async () => {
    for (;;) {
      gapRerunRequested = false;
      const generation = syncGeneration;
      const startedScope = scope();
      tailExtendable = false;
      const sync = ensureCacheSync(client);
      if (sync && startedScope !== null) {
        try {
          await sync.syncAll(startedScope, {
            stillActive: () => generation === syncGeneration && scope() === startedScope,
          });
          if (generation === syncGeneration && scope() === startedScope) tailExtendable = true;
        } catch {
          // Cursor stays put — the next connect/foreground attempt re-pulls.
        }
      }
      if (!gapRerunRequested || generation !== syncGeneration) break;
    }
  })().finally(() => {
    gapInFlight = null;
  });
  return gapInFlight;
}

// ---- write-through bridges ----------------------------------------------------

export function noteLiveMessage(client: ApiClient, message: RaftMessage): void {
  const sync = ensureCacheSync(client);
  const scopeId = scope();
  if (!sync || scopeId === null || typeof message.seq !== "number") return;
  void sync.onLiveMessage(
    scopeId,
    message.channelId,
    { seq: message.seq, id: message.id, raw: message as unknown as RawRecord },
    tailExtendable,
  );
}

export function noteMessageUpdated(client: ApiClient, message: RaftMessage): void {
  const sync = ensureCacheSync(client);
  const scopeId = scope();
  if (!sync || scopeId === null || typeof message.seq !== "number") return;
  void sync.onMessageUpdated(scopeId, message.channelId, {
    seq: message.seq,
    raw: message as unknown as RawRecord,
  });
}

/**
 * thread:updated carries no parentChannelId in the payload the socket layer
 * parses, and thread_summaries is keyed by (parentChannelId, parentMessageId)
 * — the socket delta therefore cannot be written through here. Thread
 * summaries converge via the page-level overlay refresh and the threads
 * endpoint instead (PR "known open questions").
 */

type TaskEventShape = { id: string; revision: number; raw: RawRecord };

function taskFromPayload(payload: unknown): TaskEventShape[] {
  if (typeof payload !== "object" || payload === null) return [];
  const record = payload as Record<string, unknown>;
  const tasks: unknown[] = Array.isArray(record.tasks)
    ? record.tasks
    : record.task !== undefined
      ? [record.task]
      : record.taskId !== undefined
        ? [record]
        : [];
  const out: TaskEventShape[] = [];
  for (const value of tasks) {
    const parsed = parseMessage(value); // not a message — reuse isRecord guard? keep simple below
    void parsed;
    if (typeof value !== "object" || value === null) continue;
    const task = value as Record<string, unknown>;
    if (typeof task.id !== "string") continue;
    const revision = typeof task.revision === "number" && Number.isFinite(task.revision) ? task.revision : null;
    if (revision === null) continue; // revision gate needs a number
    out.push({ id: task.id, revision, raw: task });
  }
  return out;
}

export function noteTaskEvent(client: ApiClient, payload: unknown): void {
  const sync = ensureCacheSync(client);
  const scopeId = scope();
  if (!sync || scopeId === null) return;
  for (const task of taskFromPayload(payload)) void sync.onTaskEvent(scopeId, task);
}

export function noteTaskDeleted(client: ApiClient, payload: unknown): void {
  const sync = ensureCacheSync(client);
  const scopeId = scope();
  if (!sync || scopeId === null) return;
  if (typeof payload !== "object" || payload === null) return;
  const record = payload as Record<string, unknown>;
  const ids: string[] = Array.isArray(record.tasks)
    ? record.tasks.flatMap((t) => (typeof t === "object" && t !== null && typeof (t as Record<string, unknown>).id === "string" ? [(t as Record<string, unknown>).id as string] : []))
    : typeof record.taskId === "string"
      ? [record.taskId]
      : typeof record.id === "string"
        ? [record.id]
        : [];
  for (const id of ids) void sync.onTaskDeleted(scopeId, id);
}

export type ReadStateWire = {
  channelId: string;
  maxReadSeq: number;
  readStateVersion: number;
  serverId: string | null;
};

/**
 * read_state:updated(:_bulk) write-through with the server-provided
 * maxReadSeq / readStateVersion. The caller filters by the session's current
 * serverId BEFORE calling — foreign-server events must not land in this
 * scope (review note #1).
 */
export function noteReadState(client: ApiClient, states: readonly ReadStateWire[]): void {
  const sync = ensureCacheSync(client);
  const scopeId = scope();
  if (!sync || scopeId === null || states.length === 0) return;
  for (const state of states) {
    void sync.onReadState(scopeId, state.channelId, state.maxReadSeq, state.readStateVersion);
  }
}

// ---- overlay refresh hook for the message screen (#2 integration) -----------

export async function refreshOverlayPageOncePerBoot(
  client: ApiClient,
  channelId: string,
  fromSeq: number,
  throughSeq: number,
): Promise<{ refreshed: boolean; reason: string }> {
  const sync = ensureCacheSync(client);
  const scopeId = scope();
  if (!sync || scopeId === null) return { refreshed: false, reason: "no-scope" };
  return sync.refreshOverlayPageOncePerBoot(scopeId, channelId, fromSeq, throughSeq);
}
