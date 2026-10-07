import { ApiError } from "../api/client";
import { isRecord } from "../model/messages";

export const TASK_STATUSES = ["todo", "in_progress", "in_review", "done", "closed"] as const;
export type TaskStatus = (typeof TASK_STATUSES)[number];

export const ASSIGNEE_CONFLICT = "已被别人修改";

const TRANSITIONS: Record<TaskStatus, readonly TaskStatus[]> = {
  todo: ["in_progress", "closed"],
  in_progress: ["in_review", "done", "closed"],
  in_review: ["done", "in_progress", "closed"],
  done: ["todo", "in_progress", "in_review", "closed"],
  closed: ["todo", "in_progress"],
};

const STATUS_LABEL = {
  todo: "task.status.todo",
  in_progress: "task.status.inProgress",
  in_review: "task.status.inReview",
  done: "task.status.done",
  closed: "task.status.closed",
} as const;

export interface RaftTask {
  id: string;
  messageId: string;
  channelId: string;
  channelName: string | null;
  channelType: string | null;
  taskNumber: number;
  title: string;
  description: string | null;
  status: TaskStatus;
  createdByType: string | null;
  createdById: string | null;
  createdByName: string | null;
  claimedByType: string | null;
  claimedById: string | null;
  claimedByName: string | null;
  createdAt: string | null;
  updatedAt: string | null;
  revision: number | null;
  isLegacy: boolean;
}

export interface TaskStatusOption {
  id: TaskStatus;
  labelId: (typeof STATUS_LABEL)[TaskStatus] | "task.status.reopenToTodo";
}

export type StatusWrite =
  | { kind: "claim" }
  | { kind: "status"; status: TaskStatus }
  | { kind: "same" };

export interface TaskAssignee {
  type: "user" | "agent";
  id: string;
}

export function isTaskStatus(value: unknown): value is TaskStatus {
  return typeof value === "string" && (TASK_STATUSES as readonly string[]).includes(value);
}

export function canManageTasks(role: string | null | undefined): boolean {
  return role === "owner" || role === "admin";
}

/** Guest is read-only. Owner and admin can force any status. Members get the legal transitions plus the current one. */
export function taskStatusOptions(status: TaskStatus, role: string | null | undefined): TaskStatusOption[] {
  if (role === "guest") return [];
  const allowed: readonly TaskStatus[] = canManageTasks(role) ? TASK_STATUSES : [status, ...TRANSITIONS[status]];
  return allowed.map((id) => ({
    id,
    labelId: status === "closed" && id === "todo" ? "task.status.reopenToTodo" : STATUS_LABEL[id],
  }));
}

/** Unassigned todo → in_progress is a claim, matching the web store. */
export function statusWrite(task: Pick<RaftTask, "status" | "claimedById">, next: TaskStatus): StatusWrite {
  if (next === task.status) return { kind: "same" };
  if (task.status === "todo" && next === "in_progress" && !task.claimedById) return { kind: "claim" };
  return { kind: "status", status: next };
}

export function parseTask(value: unknown): RaftTask | null {
  if (!isRecord(value) || typeof value.id !== "string" || typeof value.channelId !== "string" || !isTaskStatus(value.status)) return null;
  if (typeof value.taskNumber !== "number" || !Number.isFinite(value.taskNumber)) return null;
  return {
    id: value.id,
    messageId: typeof value.messageId === "string" ? value.messageId : value.id,
    channelId: value.channelId,
    channelName: text(value.channelName),
    channelType: text(value.channelType),
    taskNumber: value.taskNumber,
    title: typeof value.title === "string" ? value.title : "",
    description: text(value.description),
    status: value.status,
    createdByType: text(value.createdByType),
    createdById: text(value.createdById),
    createdByName: text(value.createdByName),
    claimedByType: text(value.claimedByType),
    claimedById: text(value.claimedById),
    claimedByName: text(value.claimedByName),
    createdAt: text(value.createdAt),
    updatedAt: text(value.updatedAt),
    revision: typeof value.revision === "number" && Number.isFinite(value.revision) ? value.revision : null,
    isLegacy: value.isLegacy === true,
  };
}

export function parseTaskPage(data: unknown): { tasks: RaftTask[]; nextCursor: string | null } {
  if (!isRecord(data)) return { tasks: [], nextCursor: null };
  const tasks = Array.isArray(data.tasks)
    ? data.tasks.flatMap((item) => {
      const task = parseTask(item);
      return task ? [task] : [];
    })
    : [];
  return { tasks, nextCursor: typeof data.next_cursor === "string" && data.next_cursor ? data.next_cursor : null };
}

export function isInvalidCursor(error: unknown): boolean {
  return error instanceof ApiError && error.status === 400 && error.message === "Invalid cursor";
}

export function groupTasks(tasks: readonly RaftTask[]): Array<{ status: TaskStatus; tasks: RaftTask[] }> {
  return TASK_STATUSES.map((status) => ({
    status,
    tasks: tasks.filter((task) => task.status === status).sort((left, right) => right.taskNumber - left.taskNumber),
  }));
}

export function upsertTasks(existing: readonly RaftTask[], incoming: readonly RaftTask[]): RaftTask[] {
  if (incoming.length === 0) return existing as RaftTask[];
  const next = new Map(existing.map((task) => [task.id, task]));
  for (const task of incoming) next.set(task.id, task);
  return [...next.values()];
}

export function removeTask(existing: readonly RaftTask[], taskId: string): RaftTask[] {
  if (!existing.some((task) => task.id === taskId)) return existing as RaftTask[];
  return existing.filter((task) => task.id !== taskId);
}

export function replaceTask(existing: readonly RaftTask[], taskId: string, patch: Partial<RaftTask>): RaftTask[] {
  return existing.map((task) => (task.id === taskId ? { ...task, ...patch } : task));
}

export function withAssignee(task: RaftTask, assignee: TaskAssignee | null): RaftTask {
  if (!assignee) return { ...task, claimedByType: null, claimedById: null, claimedByName: null };
  return {
    ...task,
    claimedByType: assignee.type,
    claimedById: assignee.id,
    claimedByName: task.claimedById === assignee.id ? task.claimedByName : null,
  };
}

/** Keep live inserts, edits, and deletes that happened while a page fetch was in flight. */
export function mergeFetchedTasks(fetched: readonly RaftTask[], live: readonly RaftTask[], touchedIds: ReadonlySet<string>): RaftTask[] {
  if (touchedIds.size === 0) return fetched as RaftTask[];
  const next = new Map(fetched.map((task) => [task.id, task]));
  for (const id of touchedIds) {
    const current = live.find((task) => task.id === id);
    if (current) next.set(id, current);
    else next.delete(id);
  }
  return [...next.values()];
}

export function tasksFromCreated(payload: unknown): RaftTask[] {
  if (!isRecord(payload) || !Array.isArray(payload.tasks)) return [];
  return payload.tasks.flatMap((item) => {
    const task = parseTask(item);
    return task ? [task] : [];
  });
}

export function taskFromUpdated(payload: unknown): RaftTask | null {
  if (!isRecord(payload)) return null;
  return parseTask(payload.task);
}

export function taskIdFromDeleted(payload: unknown): string | null {
  if (!isRecord(payload) || typeof payload.taskId !== "string") return null;
  return payload.taskId;
}

function text(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}
