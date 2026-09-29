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
import type { TaskEventInput, RawRecord } from "@botiverse/raft-shared/src/cacheRepoContract.js";
import { activeWebCache } from "./messageCache";
import type { Task } from "../store/taskStore";

/** The store's serverTasks membership rule (taskStore's private
 *  shouldIncludeInServerTasks) — duplicated here because the store keeps it
 *  module-private; keep the two in sync. */
function seedEligibleForServerBoard(task: Task): boolean {
  return task.channelType === "channel" || task.channelType === "private" || task.channelType === "joint";
}

/** Snapshot domain (server listServerTasks): deleting an absent id is only
 *  sound for rows the snapshot could have contained. */
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

function toEventInput(task: Task): TaskEventInput | null {
  if (typeof task.id !== "string" || !task.id) return null;
  return { id: task.id, revision: taskRevisionOf(task), raw: task as unknown as RawRecord };
}

/** Read cached rows and project them to board-seed Tasks (null = no cache
 *  mounted or nothing valid cached). */
export async function readSeededServerTasks(): Promise<Task[] | null> {
  const active = activeWebCache();
  if (!active) return null;
  try {
    const rows = await active.repo.getTaskRows(active.scopeId);
    const tasks: Task[] = [];
    for (const row of rows) {
      const task = rawAsTask(row.raw);
      if (task && seedEligibleForServerBoard(task)) tasks.push(task);
    }
    return tasks;
  } catch {
    return null;
  }
}

/** Read cached rows for one channel (channel-view seed, includes DM/thread). */
export async function readSeededChannelTasks(channelId: string): Promise<Task[] | null> {
  const active = activeWebCache();
  if (!active) return null;
  try {
    const rows = await active.repo.getTaskRows(active.scopeId);
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

/** Write a committed server snapshot: gated upsert per row + delete stale
 *  channel|joint rows the snapshot no longer contains. */
export async function persistServerTasksSnapshot(tasks: Task[]): Promise<void> {
  const active = activeWebCache();
  if (!active) return;
  try {
    const { repo, scopeId } = active;
    for (const task of tasks) {
      const input = toEventInput(task);
      if (input) await repo.applyTaskEvent(scopeId, input);
    }
    const present = new Set(tasks.map((task) => task.id));
    const cached = await repo.getTaskRows(scopeId);
    for (const row of cached) {
      if (present.has(row.id)) continue;
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
 *  unfiltered, so absence within the channel means deleted). */
export async function persistChannelTasksSnapshot(channelId: string, tasks: Task[]): Promise<void> {
  const active = activeWebCache();
  if (!active) return;
  try {
    const { repo, scopeId } = active;
    for (const task of tasks) {
      const input = toEventInput(task);
      if (input) await repo.applyTaskEvent(scopeId, input);
    }
    const present = new Set(tasks.map((task) => task.id));
    const cached = await repo.getTaskRows(scopeId);
    for (const row of cached) {
      if (present.has(row.id)) continue;
      const task = rawAsTask(row.raw);
      if (task && task.channelId === channelId) await repo.deleteTask(scopeId, row.id);
    }
  } catch {
    // Best-effort.
  }
}

/** Realtime task:created/updated write-through (revision-gated in the repo). */
export async function persistTaskUpsert(task: Task): Promise<void> {
  const active = activeWebCache();
  if (!active) return;
  try {
    const input = toEventInput(task);
    if (input) await active.repo.applyTaskEvent(active.scopeId, input);
  } catch {
    // Best-effort.
  }
}

/** Realtime task:deleted write-through. */
export async function persistTaskDelete(taskId: string): Promise<void> {
  const active = activeWebCache();
  if (!active) return;
  try {
    await active.repo.deleteTask(active.scopeId, taskId);
  } catch {
    // Best-effort.
  }
}
