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

// ---- socket continuity ------------------------------------------------------

let tailExtendable = false;

export function markCacheSocketDisconnected(): void {
  tailExtendable = false;
}

/**
 * Post-(re)connect gap sync for the attached scope. Runs the full
 * /messages/sync loop; only after it completes do live messages regain the
 * right to extend coverage tails (markCacheSocketTailExtendable below).
 */
export async function runCacheGapSync(client: ApiClient): Promise<void> {
  tailExtendable = false;
  const sync = ensureCacheSync(client);
  const scopeId = scope();
  if (!sync || scopeId === null) return;
  try {
    await sync.syncAll(scopeId);
    tailExtendable = true;
  } catch {
    // Cursor stays put — the next connect/foreground attempt re-pulls.
  }
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

/**
 * read_state carries no version in the socket payload; Date.now() is
 * monotonic per device and the repo's version gate only needs ordering
 * between successive local writes (server read-state lands via page reads).
 */
export function noteReadState(client: ApiClient, channelIds: readonly string[]): void {
  const sync = ensureCacheSync(client);
  const scopeId = scope();
  if (!sync || scopeId === null) return;
  const version = Date.now();
  for (const channelId of channelIds) {
    void sync.onReadState(scopeId, channelId, 0, version);
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
