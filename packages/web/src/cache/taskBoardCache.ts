// Web task-board cache bridge (desktop-data-cache task #10 / P2c).
//
// Connects taskStore's two load paths (server-wide board + per-channel list)
// and the realtime task events to the #7 IndexedDB cache via #9's holder
// (activeWebCache). Three responsibilities, all best-effort — a cache failure
// must never break the UI:
//   - SEED: read cached rows so a cold start (offline included) paints the
//     board before the network answers. Seeds do NOT mark anything loaded —
//     completeness still comes from a committed /tasks/server load.
//   - WRITE-BACK: a committed snapshot is written per row through the repo's
//     revision gate (applyTaskEvent), so a stale page can never regress a
//     newer live row.
//   - WRITE-THROUGH: socket task:created/updated/deleted land in the cache
//     immediately, keeping rows fresh between full loads.
//
// Deletion domain subtlety (server taskService.listServerTasks): the server
// list covers NON-DM, NON-THREAD, NON-ARCHIVED channel|joint surfaces only —
// private-channel tasks are NOT in the /tasks/server snapshot. Deleting "any
// cached id absent from the snapshot" would therefore wipe DM/thread/private
// rows cached by per-channel loads. Snapshot deletions are scoped to rows
// whose own channelType is channel|joint — exactly the snapshot's domain.
//
// Race invalidation (P2c review): every write re-verifies the captured
// {scopeId, generation} against the live holder BEFORE each repo call, so a
// logout wipe or a server switch aborts an in-flight write-back immediately
// (no exited user's rows surviving the wipe, no server A's snapshot landing
// in server B's scope). A same-tick generation check + the repo's synchronous
// transaction creation leave no interleave window between check and write.
//
// Event/snapshot interleaving (P2c review): realtime writes record a ledger
// entry (monotonic seq + scope). Snapshot write-backs skip rows whose ledger
// entry is NEWER than the write-back's start (a task:deleted that landed
// mid-loop must not be resurrected by the older snapshot list) and the
// absence purge spares ids with a newer ledger entry (a task:created that
// landed mid-loop must not be purged as "absent").

import type { TaskEventInput, RawRecord } from "@botiverse/raft-shared/src/cacheRepoContract.js";
import { activeWebCache } from "./messageCache";
import type { Task } from "../store/taskStore";

/**
 * Snapshot domain (server listServerTasks): the /tasks/server list covers
 * exactly channel|joint surfaces. It bounds BOTH what the board seed may
 * paint (private rows would flash: the snapshot that follows never contains
 * them) and which cached rows a snapshot's absence may purge.
 */
function inServerSnapshotDomain(task: Task): boolean {
  return task.channelType === "channel" || task.channelType === "joint";
}

/**
 * Monotonic revision for the cache gate. Message-based tasks carry it at the
 * top level or on the current projection; legacy-table tasks carry none —
 * they land at 0 (always overwritable, never regressing a gated row).
 */
export function taskRevisionOf(task: Task): number {
  if (typeof task.revision === "number" && Number.isFinite(task.revision)) return task.revision;
  const projected = task.taskCurrentProjection?.revision;
  if (typeof projected === "number" && Number.isFinite(projected)) return projected;
  return 0;
}

/** Defensive row validation: a cached raw that stopped looking like a Task is
 *  skipped, never seeded into the store. */
function rawAsTask(raw: RawRecord): Task | null {
  if (!raw || typeof raw !== "object") return null;
  const record = raw as Partial<Task>;
  if (typeof record.id !== "string" || typeof record.status !== "string" || typeof record.messageId !== "string") {
    return null;
  }
  if (typeof record.channelId !== "string" || typeof record.title !== "string") return null;
  return raw as unknown as Task;
}

function toEventInput(task: Task, opts: { allowTie: boolean }): TaskEventInput | null {
  if (typeof task.id !== "string" || !task.id) return null;
  return { id: task.id, revision: taskRevisionOf(task), raw: task as unknown as RawRecord, allowTie: opts.allowTie };
}

/** The scope era a load belongs to: captured synchronously when the load's
 *  fetch fires, re-verified before every cache read/write of that load. The
 *  ledger seq freezes the live-write frontier AT FETCH START so events that
 *  land any time after the fetch was issued (not just after the write-back
 *  began — review 6) win over the snapshot list. */
export type TaskCacheToken = { scopeId: number; generation: number; ledgerSeq: number };

/** Capture the current era (null = no cache mounted). */
export function captureTaskCacheToken(): TaskCacheToken | null {
  const active = activeWebCache();
  if (!active) return null;
  return { scopeId: active.scopeId, generation: active.generation, ledgerSeq: liveLedgerSeq };
}

/** True while the captured era is still the live one. */
function holderMatches(token: TaskCacheToken | null): boolean {
  if (!token) return false;
  const active = activeWebCache();
  return !!active && active.scopeId === token.scopeId && active.generation === token.generation;
}

// ---- live-write ledger --------------------------------------------------------
//
// Every realtime write-through records (synchronously, before any await) a
// monotonic seq for its task id + scope. Snapshot write-backs capture the
// current seq at entry; a ledger entry newer than that capture means a live
// event landed while the write-back was in flight, and the event wins.
// Entries never expire semantically (an OLD entry can never suppress a LATER
// write-back — only newer-than-capture entries do); the size cap just bounds
// memory.

let liveLedgerSeq = 0;
const liveLedger = new Map<string, { seq: number; scopeId: number }>();
const LIVE_LEDGER_CAP = 4096;

function recordLiveWrite(scopeId: number, taskId: string): void {
  liveLedgerSeq += 1;
  // Delete first: Map.set on an existing key keeps its ORIGINAL insertion
  // position, so re-recording a hot id would leave it at the front where
  // the oldest-quarter eviction could drop the freshest entry (review 5).
  liveLedger.delete(taskId);
  liveLedger.set(taskId, { seq: liveLedgerSeq, scopeId });
  if (liveLedger.size > LIVE_LEDGER_CAP) {
    // Map iterates in insertion order; drop the oldest quarter.
    const excess = liveLedger.size - Math.floor(LIVE_LEDGER_CAP * 3 / 4);
    let dropped = 0;
    for (const key of liveLedger.keys()) {
      if (dropped >= excess) break;
      liveLedger.delete(key);
      dropped += 1;
    }
  }
}

/** True when a live event for this id landed in this scope after `sinceSeq`. */
function liveWriteAfter(scopeId: number, taskId: string, sinceSeq: number): boolean {
  const entry = liveLedger.get(taskId);
  return !!entry && entry.scopeId === scopeId && entry.seq > sinceSeq;
}

// ---- seed readers ---------------------------------------------------------------

/** Read cached rows and project them to board-seed Tasks (null = no cache
 *  mounted or nothing valid cached). The seed is board-domain only
 *  (channel|joint): private rows are outside the /tasks/server snapshot, so
 *  seeding them would flash content the committing snapshot then removes. */
export async function readSeededServerTasks(token: TaskCacheToken | null = captureTaskCacheToken()): Promise<Task[] | null> {
  const active = activeWebCache();
  if (!active || !holderMatches(token)) return null;
  try {
    const rows = await active.repo.getTaskRows(active.scopeId);
    if (!holderMatches(token)) return null; // era changed mid-read — drop the seed
    const tasks: Task[] = [];
    for (const row of rows) {
      const task = rawAsTask(row.raw);
      if (task && inServerSnapshotDomain(task)) tasks.push(task);
    }
    return tasks;
  } catch {
    return null;
  }
}

/** Read cached rows for one channel (channel-view seed, includes DM/thread). */
export async function readSeededChannelTasks(
  channelId: string,
  token: TaskCacheToken | null = captureTaskCacheToken(),
): Promise<Task[] | null> {
  const active = activeWebCache();
  if (!active || !holderMatches(token)) return null;
  try {
    const rows = await active.repo.getTaskRows(active.scopeId);
    if (!holderMatches(token)) return null; // era changed mid-read — drop the seed
    const tasks: Task[] = [];
    for (const row of rows) {
      const task = rawAsTask(row.raw);
      if (task && task.channelId === channelId) tasks.push(task);
    }
    return tasks;
  } catch {
    return null;
  }
}

// ---- snapshot write-back --------------------------------------------------------

/**
 * Write a committed server snapshot: gated upsert per row + delete stale
 * channel|joint rows the snapshot no longer contains. Every repo call is
 * preceded by an era check — a logout or server switch mid-loop aborts the
 * write-back instead of writing into the wiped/new scope. Live events that
 * landed after the token's ledger seq (frozen at fetch start — review 6)
 * win over the snapshot: their rows are skipped (not resurrected) and never
 * purged by absence.
 */
export async function persistServerTasksSnapshot(
  tasks: Task[],
  token: TaskCacheToken | null = captureTaskCacheToken(),
): Promise<void> {
  if (!holderMatches(token)) return;
  const active = activeWebCache()!;
  const { repo, scopeId } = active;
  // holderMatches(token) returning true implies token non-null (TS can't see it).
  const sinceSeq = token!.ledgerSeq; // frozen at fetch start, not write-back start
  try {
    for (const task of tasks) {
      if (!holderMatches(token)) return;
      if (liveWriteAfter(scopeId, task.id, sinceSeq)) continue; // live event already superseded this row
      const input = toEventInput(task, { allowTie: taskRevisionOf(task) === 0 });
      if (input) await repo.applyTaskEvent(scopeId, input);
    }
    const present = new Set(tasks.map((task) => task.id));
    if (!holderMatches(token)) return;
    const cached = await repo.getTaskRows(scopeId);
    for (const row of cached) {
      if (present.has(row.id)) continue;
      if (!holderMatches(token)) return;
      if (liveWriteAfter(scopeId, row.id, sinceSeq)) continue; // created/updated live mid-loop — not "absent"
      const task = rawAsTask(row.raw);
      // Only snapshot-domain rows may be purged by absence; a DM/thread/private
      // row is simply not this snapshot's business.
      if (task && inServerSnapshotDomain(task)) await repo.deleteTask(scopeId, row.id);
    }
  } catch {
    // Best-effort — the store already committed its own state.
  }
}

/** Write a committed per-channel snapshot: gated upsert per row + delete this
 *  channel's rows the response no longer contains (the per-channel list IS
 *  unfiltered, so absence within the channel means deleted). Same era and
 *  ledger protections as the server snapshot. */
export async function persistChannelTasksSnapshot(
  channelId: string,
  tasks: Task[],
  token: TaskCacheToken | null = captureTaskCacheToken(),
): Promise<void> {
  if (!holderMatches(token)) return;
  const active = activeWebCache()!;
  const { repo, scopeId } = active;
  // holderMatches(token) returning true implies token non-null (TS can't see it).
  const sinceSeq = token!.ledgerSeq; // frozen at fetch start, not write-back start
  try {
    for (const task of tasks) {
      if (!holderMatches(token)) return;
      if (liveWriteAfter(scopeId, task.id, sinceSeq)) continue;
      const input = toEventInput(task, { allowTie: taskRevisionOf(task) === 0 });
      if (input) await repo.applyTaskEvent(scopeId, input);
    }
    const present = new Set(tasks.map((task) => task.id));
    if (!holderMatches(token)) return;
    const cached = await repo.getTaskRows(scopeId);
    for (const row of cached) {
      if (present.has(row.id)) continue;
      if (!holderMatches(token)) return;
      if (liveWriteAfter(scopeId, row.id, sinceSeq)) continue;
      const task = rawAsTask(row.raw);
      if (task && task.channelId === channelId) await repo.deleteTask(scopeId, row.id);
    }
  } catch {
    // Best-effort.
  }
}

// ---- realtime write-through -------------------------------------------------------

/** Realtime task:created/updated write-through (revision-gated in the repo).
 *  Live events tie-break equal revisions — they are newer in time than
 *  anything cached, so a rename that did not bump the revision still lands. */
export async function persistTaskUpsert(task: Task): Promise<void> {
  const active = activeWebCache();
  if (!active) return;
  try {
    const input = toEventInput(task, { allowTie: true });
    if (!input) return;
    recordLiveWrite(active.scopeId, input.id);
    await active.repo.applyTaskEvent(active.scopeId, input);
  } catch {
    // Best-effort.
  }
}

/** Realtime task:deleted write-through. */
export async function persistTaskDelete(taskId: string): Promise<void> {
  const active = activeWebCache();
  if (!active) return;
  try {
    recordLiveWrite(active.scopeId, taskId);
    await active.repo.deleteTask(active.scopeId, taskId);
  } catch {
    // Best-effort.
  }
}
