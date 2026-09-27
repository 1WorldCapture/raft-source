// Realtime board store (task #2 step 6). Holds BoardTasks loaded from the
// server's view=board endpoint and keeps them fresh from socket events:
//
//   thread:updated / task:*  →  optimistic patch (see applyThreadActivityToTask)
//                           →  debounced ids recalibration: fetch the affected
//                              ids with the board's status filter and reconcile
//                              (replace returned rows, DROP requested-but-missing
//                              ids — e.g. the task was closed mid-session).
//
// The per-minute tick bumps so screens re-render rows whose relative times
// ("5 minutes ago") and stale flags are computed against the wall clock.
//
// Fetch failures are best-effort: the board keeps its current rows and the
// next event / tick / pull-to-refresh retries.
//
// The store is a factory so tests can inject deterministic timers instead of
// relying on the runner's mock-timer lifecycle.

import { create } from "zustand";
import type { ApiClient } from "../api/client";
import { isRecord } from "../model/messages";
import { applyThreadActivityToTask, boardStatusParam, parseBoardTask, reconcileByIds, taskMatchesThread, type BoardTask, type BoardViewer, type ThreadActivityEvent } from "./board";
import { parseTask } from "./model";

/** Contract §ids: at most this many ids per recalibration request. */
const IDS_BATCH_LIMIT = 50;

/** Coalesce a burst of socket events into one ids fetch. */
const RECALIBRATE_DEBOUNCE_MS = 1_500;

/** Row-relative times ("5 分钟前") move to the next bucket at most a minute late. */
export const BOARD_TICK_MS = 60_000;

export interface BoardStore {
  tasks: BoardTask[];
  loading: boolean;
  loaded: boolean;
  tick: number;
  error: string | null;
  /** Full reload from page 1 — initial load, pull-to-refresh, reconnect. */
  load: (client: ApiClient) => Promise<void>;
  /**
   * Advance the tick so rows recompute relative times and staleness. When the
   * local calendar day rolled over since the last load and a client is given,
   * reloads: completedAfter moves to the new midnight so yesterday's done
   * tasks leave "done today".
   */
  bumpTick: (client?: ApiClient) => void;
  /** Optimistic patch + schedule recalibration for a thread:updated event. */
  noteThreadActivity: (client: ApiClient, event: ThreadActivityEvent, me: BoardViewer | null) => void;
  /** Schedule recalibration for a task:created/updated/deleted event. */
  noteTaskActivity: (client: ApiClient, taskId: string) => void;
  /**
   * Approve (mark done) through the status PATCH: optimistic row moves into
   * doneToday immediately (completedAt = now), the server value wins on
   * success, and the row reverts on failure (the screen alerts). Returns
   * whether the task ended up done.
   */
  approveTask: (client: ApiClient, taskId: string) => Promise<boolean>;
  reset: () => void;
}

export type BoardStoreDeps = {
  setTimeout?: (fn: () => void, ms: number) => unknown;
  clearTimeout?: (handle: unknown) => void;
  /** Injectable clock for deterministic day-rollover tests. */
  now?: () => Date;
};

function parseBoardPage(data: unknown): { tasks: BoardTask[]; nextCursor: string | null } {
  if (!isRecord(data)) return { tasks: [], nextCursor: null };
  const tasks = Array.isArray(data.tasks)
    ? data.tasks.flatMap((item) => {
      const task = parseBoardTask(item);
      return task ? [task] : [];
    })
    : [];
  return { tasks, nextCursor: typeof data.next_cursor === "string" && data.next_cursor ? data.next_cursor : null };
}

/** completedAfter = the viewer's local midnight, so "done today" is the local day. */
function localMidnightIso(now: Date): string {
  return new Date(now.getFullYear(), now.getMonth(), now.getDate()).toISOString();
}

function dayKeyOf(now: Date): string {
  return `${now.getFullYear()}-${now.getMonth()}-${now.getDate()}`;
}

export function createBoardStore(deps: BoardStoreDeps = {}) {
  const schedule = deps.setTimeout ?? ((fn: () => void, ms: number) => setTimeout(fn, ms));
  const cancel = deps.clearTimeout ?? ((handle: unknown) => clearTimeout(handle as ReturnType<typeof setTimeout>));
  const now = deps.now ?? (() => new Date());
  // Debounce state lives outside zustand: it is transport machinery, not UI state.
  let pendingIds = new Set<string>();
  let recalibrateTimer: unknown = null;
  let recalibrateClient: ApiClient | null = null;
  let loadedDay: string | null = null;

  const flushRecalibration = async (): Promise<void> => {
    const client = recalibrateClient;
    const ids = [...pendingIds];
    pendingIds = new Set();
    recalibrateTimer = null;
    recalibrateClient = null;
    if (!client || ids.length === 0) return;
    for (let offset = 0; offset < ids.length; offset += IDS_BATCH_LIMIT) {
      const batch = ids.slice(offset, offset + IDS_BATCH_LIMIT);
      try {
        const query = new URLSearchParams({ view: "board", ids: batch.join(","), status: boardStatusParam(), limit: String(batch.length) });
        const page = parseBoardPage(await client.get<unknown>(`/tasks/server?${query.toString()}`));
        if (useBoardStore.getState().loaded) {
          useBoardStore.setState({ tasks: reconcileByIds(useBoardStore.getState().tasks, page.tasks, batch) });
        }
      } catch {
        // Keep current rows; the next event, tick, or pull-to-refresh retries.
      }
    }
  };

  const scheduleRecalibration = (client: ApiClient, ids: string[]): void => {
    for (const id of ids) pendingIds.add(id);
    recalibrateClient = client;
    if (recalibrateTimer !== null) cancel(recalibrateTimer);
    recalibrateTimer = schedule(() => void flushRecalibration(), RECALIBRATE_DEBOUNCE_MS);
  };

  const useBoardStore = create<BoardStore>((set, get) => ({
    tasks: [],
    loading: false,
    loaded: false,
    tick: 0,
    error: null,

    async load(client) {
      if (useBoardStore.getState().loading) return;
      set({ loading: true, error: null });
      try {
        let cursor: string | null = null;
        let tasks: BoardTask[] = [];
        for (let page = 0; page < 10; page += 1) {
          const query = new URLSearchParams({ view: "board", status: boardStatusParam(), limit: "100", completedAfter: localMidnightIso(now()) });
          if (cursor) query.set("cursor", cursor);
          const parsed = parseBoardPage(await client.get<unknown>(`/tasks/server?${query.toString()}`));
          tasks = [...tasks, ...parsed.tasks];
          if (!parsed.nextCursor) break;
          cursor = parsed.nextCursor;
        }
        loadedDay = dayKeyOf(now());
        set({ tasks, loading: false, loaded: true, error: null });
      } catch (caught) {
        set({ loading: false, error: caught instanceof Error && caught.message ? caught.message : "Request failed" });
      }
    },

    bumpTick(client) {
      set((state) => ({ tick: state.tick + 1 }));
      // Midnight rollover: yesterday's "done today" rows must go. The reload
      // refetches with the new local midnight as completedAfter.
      if (loadedDay !== null && client && dayKeyOf(now()) !== loadedDay) {
        loadedDay = null;
        void useBoardStore.getState().load(client);
      }
    },

    noteThreadActivity(client, event, me) {
      set((state) => ({
        tasks: state.tasks.map((task) => (taskMatchesThread(task, event) ? applyThreadActivityToTask(task, event, me) : task)),
      }));
      const affected = get().tasks.filter((task) => taskMatchesThread(task, event)).map((task) => task.id);
      if (affected.length > 0) scheduleRecalibration(client, affected);
    },

    noteTaskActivity(client, taskId) {
      scheduleRecalibration(client, [taskId]);
    },

    async approveTask(client, taskId) {
      const previous = useBoardStore.getState().tasks.find((task) => task.id === taskId);
      if (!previous) return false;
      if (previous.status === "done") return true;
      const optimistic: BoardTask = { ...previous, status: "done", completedAt: now().toISOString() };
      useBoardStore.setState({ tasks: reconcileByIds(useBoardStore.getState().tasks, [optimistic], [taskId]) });
      try {
        const data = await client.patch<unknown>(`/tasks/${encodeURIComponent(taskId)}/status`, { status: "done" });
        const raw = isRecord(data) && isRecord(data.task) ? data.task : null;
        const base = parseTask(raw);
        const completedAt = raw && typeof raw.completedAt === "string" ? raw.completedAt : optimistic.completedAt;
        const merged: BoardTask = base ? { ...optimistic, ...base, completedAt } : { ...optimistic, completedAt };
        useBoardStore.setState({ tasks: reconcileByIds(useBoardStore.getState().tasks, [merged], [taskId]) });
        return true;
      } catch {
        // Revert: the row returns to its section; the screen surfaces the failure.
        useBoardStore.setState({ tasks: reconcileByIds(useBoardStore.getState().tasks, [previous], [taskId]) });
        return false;
      }
    },

    reset() {
      pendingIds = new Set();
      if (recalibrateTimer !== null) cancel(recalibrateTimer);
      recalibrateTimer = null;
      recalibrateClient = null;
      loadedDay = null;
      set({ tasks: [], loading: false, loaded: false, tick: 0, error: null });
    },
  }));

  return useBoardStore;
}

export const useBoardStore = createBoardStore();
