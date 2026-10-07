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
import { getCacheRuntime } from "../cache/runtime";
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
  /** The server the current tasks belong to; null when the board is empty. */
  serverId: string | null;
  /** Full reload from page 1 — initial load, pull-to-refresh, reconnect. */
  load: (client: ApiClient) => Promise<void>;
  /**
   * Load the board unless it is already loaded for this server. Server
   * switches (A→B→A) always reload: the tasks on screen must never outlive
   * the server they came from. Supersedes any load still in flight for a
   * different server — the newest request wins.
   */
  ensureLoadedForServer: (client: ApiClient, serverId: string) => Promise<void>;
  /**
   * Advance the tick so rows recompute relative times and staleness. When the
   * local calendar day rolled over since the last load and a client is given,
   * reloads: completedAfter moves to the new midnight so yesterday's done
   * tasks leave "done today".
   */
  bumpTick: (client?: ApiClient) => void;
  /** Optimistic patch + schedule recalibration for a thread:updated event. */
  noteThreadActivity: (client: ApiClient, event: ThreadActivityEvent, me: BoardViewer | null) => void;
  /**
   * A thread channel was just read (TaskDetail / thread pane markRead):
   * clear the board row's unread lift immediately instead of waiting for the
   * next thread event / recalibration / pull-to-refresh.
   */
  noteThreadRead: (threadChannelId: string) => void;
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
  /**
   * Local cache access for the boot fast-path (#client-data-cache task #2):
   * seed the board from `board_page` before the network answers and persist
   * each successful load. Absent in tests and when the cache is unavailable.
   */
  cache?: {
    scopeFor(serverId: string): number | null;
    readBoardPage(scope: number): unknown;
    writeBoardPage(scope: number, tasks: BoardTask[]): void;
  };
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
  // Loads are last-writer-wins: a load started for another server (or before
  // a reset) must never write its rows back. Every load captures the current
  // ticket and drops its result if a newer load (or reset) has started since.
  let loadTicket = 0;
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
    serverId: null,

    async load(client) {
      // No in-flight guard on purpose: a load for a newly selected server
      // must supersede (not wait behind) one still in flight for the old
      // server; the ticket check below makes that safe.
      const ticket = ++loadTicket;
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
        if (ticket !== loadTicket) return;
        loadedDay = dayKeyOf(now());
        set({ tasks, loading: false, loaded: true, error: null });
        const writeScope = deps.cache && get().serverId !== null ? deps.cache.scopeFor(get().serverId as string) : null;
        if (deps.cache && writeScope !== null) deps.cache.writeBoardPage(writeScope, tasks);
      } catch (caught) {
        if (ticket !== loadTicket) return;
        set({ loading: false, error: caught instanceof Error && caught.message ? caught.message : "Request failed" });
      }
    },

    async ensureLoadedForServer(client, serverId) {
      const state = get();
      if (state.loaded && state.serverId === serverId) return;
      set({ serverId });
      // Boot fast-path: show the cached board rows immediately, then let the
      // network load below correct them (server switches included — each
      // server's cache is its own scope).
      const seedScope = deps.cache ? deps.cache.scopeFor(serverId) : null;
      if (deps.cache && seedScope !== null) {
        const cachedPage = deps.cache.readBoardPage(seedScope);
        const parsed = parseBoardPage(cachedPage);
        if (parsed.tasks.length > 0) set({ tasks: parsed.tasks, loaded: true });
      }
      await get().load(client);
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

    noteThreadRead(threadChannelId) {
      const state = get();
      // Bail before map(): a no-op read must keep the tasks reference stable
      // so untouched boards don't re-render.
      if (!state.tasks.some((task) => task.threadChannelId === threadChannelId && task.unreadCount > 0)) return;
      // Clear only unreadCount: per the server contract (task #1), mentionsMe
      // means "I was mentioned and have not replied since" — reading does not
      // clear it, and a local false would flicker back on the next
      // recalibration.
      set({
        tasks: state.tasks.map((task) => (
          task.threadChannelId === threadChannelId
            ? { ...task, unreadCount: 0 }
            : task
        )),
      });
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
      // Any load still in flight belongs to the pre-reset board; its rows
      // must not land in the freshly cleared one.
      loadTicket += 1;
      set({ tasks: [], loading: false, loaded: false, tick: 0, error: null, serverId: null });
    },
  }));

  return useBoardStore;
}

export const useBoardStore = createBoardStore({
  cache: {
    scopeFor(serverId) {
      try {
        return getCacheRuntime().scopeFor(serverId);
      } catch {
        return null;
      }
    },
    readBoardPage(scope) {
      try {
        return getCacheRuntime().repo.getKv(scope, "board_page");
      } catch {
        return null;
      }
    },
    writeBoardPage(scope, tasks) {
      try {
        void getCacheRuntime().repo.putKv(scope, "board_page", { tasks: tasks as unknown as Record<string, unknown>[] });
      } catch {
        // Cache unavailable — the board works from the network.
      }
    },
  },
});
