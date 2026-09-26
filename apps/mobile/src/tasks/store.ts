import { create } from "zustand";
import { ApiError, StaleRequestError, type ApiClient } from "../api/client";
import {
  ASSIGNEE_CONFLICT,
  isInvalidCursor,
  mergeFetchedTasks,
  parseTask,
  parseTaskPage,
  replaceTask,
  removeTask,
  statusWrite,
  taskFromUpdated,
  taskIdFromDeleted,
  tasksFromCreated,
  upsertTasks,
  withAssignee,
  type RaftTask,
  type TaskAssignee,
  type TaskStatus,
} from "./model";

const PAGE_LIMIT = 200;

interface TaskState {
  tasks: RaftTask[];
  loading: boolean;
  loaded: boolean;
  visible: boolean;
  generation: number;
  error: string | null;
  load: (client: ApiClient) => Promise<void>;
  setVisible: (visible: boolean) => void;
  markStale: () => void;
  catchUp: (client: ApiClient) => Promise<void>;
  setStatus: (client: ApiClient, taskId: string, status: TaskStatus) => Promise<void>;
  setAssignee: (client: ApiClient, taskId: string, assignee: TaskAssignee | null) => Promise<void>;
  applyCreated: (payload: unknown) => void;
  applyUpdated: (payload: unknown) => void;
  applyDeleted: (payload: unknown) => void;
  reset: () => void;
}

let requestSeq = 0;
let touchedDuringLoad: Set<string> | null = null;

function noteTouch(id: string) {
  touchedDuringLoad?.add(id);
}

function messageOf(caught: unknown): string {
  return caught instanceof Error && caught.message ? caught.message : "Request failed";
}

async function fetchAll(client: ApiClient): Promise<RaftTask[]> {
  let cursor: string | null = null;
  let tasks: RaftTask[] = [];
  let restarted = false;
  for (let page = 0; page < 50; page += 1) {
    const path = cursor
      ? `/tasks/server?limit=${PAGE_LIMIT}&cursor=${encodeURIComponent(cursor)}`
      : `/tasks/server?limit=${PAGE_LIMIT}`;
    try {
      const parsed = parseTaskPage(await client.get<unknown>(path));
      tasks = upsertTasks(tasks, parsed.tasks);
      if (!parsed.nextCursor) return tasks;
      cursor = parsed.nextCursor;
    } catch (caught) {
      if (isInvalidCursor(caught) && !restarted) {
        restarted = true;
        cursor = null;
        tasks = [];
        page = -1;
        continue;
      }
      throw caught;
    }
  }
  return tasks;
}

function commitTask(data: unknown) {
  const task = parseTask(data && typeof data === "object" ? (data as { task?: unknown }).task : null);
  if (!task) return;
  useTaskStore.setState({ tasks: upsertTasks(useTaskStore.getState().tasks, [task]) });
}

export const useTaskStore = create<TaskState>((set, get) => ({
  tasks: [],
  loading: false,
  loaded: false,
  visible: false,
  generation: 0,
  error: null,

  async load(client) {
    const generation = get().generation;
    const seq = ++requestSeq;
    const touched = new Set<string>();
    touchedDuringLoad = touched;
    set({ loading: true, error: null });
    try {
      const fetched = await fetchAll(client);
      if (seq !== requestSeq || get().generation !== generation) return;
      set({
        tasks: mergeFetchedTasks(fetched, get().tasks, touched),
        loading: false,
        loaded: true,
        error: null,
      });
    } catch (caught) {
      if (seq !== requestSeq || get().generation !== generation || caught instanceof StaleRequestError) return;
      set({ loading: false, error: messageOf(caught) });
    } finally {
      if (touchedDuringLoad === touched) touchedDuringLoad = null;
    }
  },

  setVisible(visible) {
    set({ visible });
  },

  markStale() {
    requestSeq += 1;
    set((state) => ({ loaded: false, generation: state.generation + 1 }));
  },

  async catchUp(client) {
    const state = get();
    if (!state.visible || state.loaded || state.generation === 0) return;
    await get().load(client);
  },

  async setStatus(client, taskId, status) {
    const current = get().tasks.find((task) => task.id === taskId);
    if (!current) return;
    const write = statusWrite(current, status);
    if (write.kind === "same") return;
    const previous = get().tasks;
    noteTouch(taskId);
    set({
      tasks: replaceTask(previous, taskId, { status: write.kind === "claim" ? "in_progress" : write.status }),
      error: null,
    });
    try {
      const data = write.kind === "claim"
        ? await client.patch<unknown>(`/tasks/${encodeURIComponent(taskId)}/claim`, {})
        : await client.patch<unknown>(`/tasks/${encodeURIComponent(taskId)}/status`, { status: write.status });
      commitTask(data);
    } catch (caught) {
      if (caught instanceof StaleRequestError) return;
      set({ tasks: previous, error: messageOf(caught) });
    }
  },

  async setAssignee(client, taskId, assignee) {
    const current = get().tasks.find((task) => task.id === taskId);
    if (!current) return;
    const previous = get().tasks;
    noteTouch(taskId);
    set({ tasks: replaceTask(previous, taskId, withAssignee(current, assignee)), error: null });
    try {
      const data = await client.patch<unknown>(`/tasks/${encodeURIComponent(taskId)}/assignee`, {
        assignee,
        ...(current.revision === null ? {} : { expectedRevision: current.revision }),
      });
      commitTask(data);
    } catch (caught) {
      if (caught instanceof StaleRequestError) return;
      const conflict = caught instanceof ApiError && caught.status === 409;
      set({ tasks: previous, error: conflict ? ASSIGNEE_CONFLICT : messageOf(caught) });
      if (conflict) {
        await get().load(client);
        set({ error: ASSIGNEE_CONFLICT });
      }
    }
  },

  applyCreated(payload) {
    const incoming = tasksFromCreated(payload);
    if (incoming.length === 0) return;
    for (const task of incoming) noteTouch(task.id);
    set({ tasks: upsertTasks(get().tasks, incoming) });
  },

  applyUpdated(payload) {
    const task = taskFromUpdated(payload);
    if (!task) return;
    noteTouch(task.id);
    set({ tasks: upsertTasks(get().tasks, [task]) });
  },

  applyDeleted(payload) {
    const taskId = taskIdFromDeleted(payload);
    if (!taskId) return;
    noteTouch(taskId);
    set({ tasks: removeTask(get().tasks, taskId) });
  },

  reset() {
    requestSeq += 1;
    touchedDuringLoad = null;
    set({ tasks: [], loading: false, loaded: false, visible: false, generation: 0, error: null });
  },
}));
