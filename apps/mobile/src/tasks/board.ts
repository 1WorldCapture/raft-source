// Progress board model (task #2, mobile tasks page): tasks grouped into
// "needs me" / "in progress" / "done today" / "todo" sections driven by the
// server's view=board fields (lastActivityAt, latestActivity, unreadCount,
// mentionsMe — see the contract in #mobile-tasks-ux:4a807eb9). Pure logic so
// grouping, ordering, staleness, and the local-timezone "today" boundary are
// unit-testable without a server.

import { parseTask, taskStatusOptions, type RaftTask, type TaskStatus } from "./model";
import { isRecord } from "../model/messages";

/** The server caps nothing; the badge renders "99+" beyond this. */
export const UNREAD_CAP = 99;

/** A task with no activity for this long shows a "may be stuck" flag. */
export const STALE_MS = 30 * 60_000;

export interface TaskActivity {
  kind: "reply" | "task_event";
  at: string;
  actorType: "user" | "agent" | "system";
  actorId: string | null;
  actorName: string | null;
  /** ~120-char reply snippet; null for task events. */
  snippet: string | null;
  /** e.g. status_changed for task events; null for replies. */
  eventType: string | null;
}

/** Contract BoardTask: the summary fields of RaftTask plus the board view. */
export interface BoardTask extends RaftTask {
  completedAt: string | null;
  threadChannelId: string | null;
  lastActivityAt: string;
  latestActivity: TaskActivity | null;
  replyCount: number;
  unreadCount: number;
  mentionsMe: boolean;
}

export interface BoardRow {
  task: BoardTask;
  stale: boolean;
}

export interface BoardViewer {
  type: "user" | "agent";
  id: string;
}

export interface TaskBoard {
  /** in_review, or a thread mention not yet answered by me. */
  needsMe: BoardRow[];
  /** Remaining in_progress, newest activity first; stale rows pinned to top. */
  inProgress: BoardRow[];
  /** done with completedAt in the viewer's local today. */
  doneToday: BoardRow[];
  /** todo, collapsed by default in the UI. */
  todo: BoardRow[];
}

/** The four board sections; BOARD_SECTIONS is the screen's display order. */
export type BoardSection = keyof TaskBoard;

export const BOARD_SECTIONS: readonly BoardSection[] = ["needsMe", "inProgress", "doneToday", "todo"];

/**
 * True when a section header should use the action highlight: needsMe with at
 * least one task in it. An empty needsMe must not glow — there is nothing to do.
 */
export function sectionHighlighted(section: BoardSection, count: number): boolean {
  return section === "needsMe" && count > 0;
}

/**
 * True when the viewer may move this task to done — the approve button's
 * visibility rule. Delegates to taskStatusOptions so the board can never offer
 * a transition the detail sheet would reject (guests see nothing; members get
 * legal transitions only — notably todo → done is NOT legal for them).
 */
export function canApproveFrom(status: TaskStatus, role: string | null | undefined): boolean {
  if (status === "done") return false;
  return taskStatusOptions(status, role).some((option) => option.id === "done");
}

/**
 * Adapt plain tasks (old API rows or fixtures) into BoardTasks with neutral
 * board defaults — the transition path while the board endpoint lands.
 */
export function boardFromTasks(tasks: readonly RaftTask[]): BoardTask[] {
  return tasks.map((task) => ({
    ...task,
    completedAt: null,
    threadChannelId: null,
    lastActivityAt: task.updatedAt ?? task.createdAt ?? "1970-01-01T00:00:00.000Z",
    latestActivity: null,
    replyCount: 0,
    unreadCount: 0,
    mentionsMe: false,
  }));
}

function row(task: BoardTask, stale: boolean): BoardRow {
  return { task, stale };
}

/** True when completedAt falls on the same LOCAL calendar day as `now`. */
export function isDoneToday(completedAt: string | null, now: Date): boolean {
  if (!completedAt) return false;
  const completed = new Date(completedAt);
  if (Number.isNaN(completed.getTime())) return false;
  return (
    completed.getFullYear() === now.getFullYear() &&
    completed.getMonth() === now.getMonth() &&
    completed.getDate() === now.getDate()
  );
}

function isStale(task: BoardTask, now: Date): boolean {
  const last = new Date(task.lastActivityAt).getTime();
  if (Number.isNaN(last)) return false;
  return now.getTime() - last > STALE_MS;
}

/**
 * Group board tasks. A task appears in exactly one section — needsMe wins
 * over everything (but a mention only LIFTS an unfinished task: done stays
 * in doneToday, closed never shows), stale flags apply to in_progress only,
 * closed tasks are dropped entirely, and done tasks outside today are
 * dropped (the server already filters via completedAfter; this is the
 * client-side guarantee).
 */
export function buildBoard(tasks: readonly BoardTask[], now: Date, _me?: BoardViewer): TaskBoard {
  const board: TaskBoard = { needsMe: [], inProgress: [], doneToday: [], todo: [] };
  const seen = new Set<string>();
  for (const task of tasks) {
    if (seen.has(task.id)) continue; // pagination overlap dedup (contract §3)
    seen.add(task.id);
    const mentionLifts = task.mentionsMe && (task.status === "todo" || task.status === "in_progress");
    if (task.status === "in_review" || mentionLifts) {
      board.needsMe.push(row(task, false));
      continue;
    }
    switch (task.status) {
      case "in_progress":
        board.inProgress.push(row(task, isStale(task, now)));
        break;
      case "done":
        if (isDoneToday(task.completedAt, now)) board.doneToday.push(row(task, false));
        break;
      case "todo":
        board.todo.push(row(task, false));
        break;
      case "closed":
        break; // in_review never reaches the switch — handled above
    }
  }
  const byActivityDesc = (left: BoardRow, right: BoardRow) =>
    compareDesc(left.task.lastActivityAt, right.task.lastActivityAt) || right.task.taskNumber - left.task.taskNumber;
  board.inProgress.sort((left, right) => {
    // Stale rows pin to the top; among them, the LONGEST-stuck comes first.
    if (left.stale !== right.stale) return Number(right.stale) - Number(left.stale);
    if (left.stale) return compareAsc(left.task.lastActivityAt, right.task.lastActivityAt);
    return byActivityDesc(left, right);
  });
  board.needsMe.sort(byActivityDesc);
  // Done-today order follows completion time — thread replies arriving after
  // completion must not reshuffle the section.
  board.doneToday.sort(
    (left, right) => compareDesc(left.task.completedAt ?? "", right.task.completedAt ?? "") || right.task.taskNumber - left.task.taskNumber,
  );
  board.todo.sort(byActivityDesc);
  return board;
}

function compareAsc(leftIso: string, rightIso: string): number {
  const left = new Date(leftIso).getTime();
  const right = new Date(rightIso).getTime();
  if (Number.isNaN(left) || Number.isNaN(right)) return 0;
  return left - right;
}

function compareDesc(leftIso: string, rightIso: string): number {
  const left = new Date(leftIso).getTime();
  const right = new Date(rightIso).getTime();
  if (Number.isNaN(left) || Number.isNaN(right)) return 0;
  return right - left;
}

/** Parse one contract BoardTask row; null when the payload is not usable. */
export function parseBoardTask(value: unknown): BoardTask | null {
  if (!isRecord(value) || typeof value.lastActivityAt !== "string") return null;
  const base = parseTask(value);
  if (!base) return null;
  return {
    ...base,
    completedAt: typeof value.completedAt === "string" ? value.completedAt : null,
    threadChannelId: typeof value.threadChannelId === "string" ? value.threadChannelId : null,
    lastActivityAt: value.lastActivityAt,
    latestActivity: parseActivity(value.latestActivity),
    replyCount: nonNegativeInt(value.replyCount),
    unreadCount: nonNegativeInt(value.unreadCount),
    mentionsMe: value.mentionsMe === true,
  };
}

function parseActivity(value: unknown): TaskActivity | null {
  if (!isRecord(value)) return null;
  if (value.kind !== "reply" && value.kind !== "task_event") return null;
  if (typeof value.at !== "string") return null;
  const actorType = value.actorType === "user" || value.actorType === "agent" || value.actorType === "system" ? value.actorType : "system";
  return {
    kind: value.kind,
    at: value.at,
    actorType,
    actorId: typeof value.actorId === "string" ? value.actorId : null,
    actorName: typeof value.actorName === "string" ? value.actorName : null,
    snippet: typeof value.snippet === "string" ? value.snippet : null,
    eventType: typeof value.eventType === "string" ? value.eventType : null,
  };
}

function nonNegativeInt(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? Math.floor(value) : 0;
}

/** Statuses the board asks the server for (todo..done; closed never shows). */
export const BOARD_QUERY_STATUSES: readonly TaskStatus[] = ["todo", "in_progress", "in_review", "done"];

export function boardStatusParam(): string {
  return BOARD_QUERY_STATUSES.join(",");
}

/**
 * Realtime recalibration (contract §ids): replace/insert the freshly fetched
 * rows, and REMOVE every requested id the server did not return — with the
 * board's status filter still applied server-side, a missing id means the
 * task left the board (e.g. it was closed) and its row must not linger.
 */
export function reconcileByIds(
  current: readonly BoardTask[],
  fetched: readonly BoardTask[],
  requestedIds: readonly string[],
): BoardTask[] {
  const fetchedById = new Map(fetched.map((task) => [task.id, task]));
  const next = new Map<string, BoardTask>();
  for (const task of current) {
    if (requestedIds.includes(task.id)) continue; // its fate is decided below
    next.set(task.id, task);
  }
  for (const id of requestedIds) {
    const fresh = fetchedById.get(id);
    if (fresh) next.set(id, fresh); // returned → updated row
    // not returned → dropped from the board entirely
  }
  return [...next.values()];
}
