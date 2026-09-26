import type { AppMessageId } from "../i18n/catalog";
import { isRecord } from "../model/messages";
import { isTaskStatus, type TaskStatus } from "./model";

export interface TaskHistoryEvent {
  id: string;
  eventType: string;
  actorType: string;
  actorName: string | null;
  createdAt: string;
  payload: Record<string, unknown>;
}

export interface AssigneePerson {
  type: "user" | "agent";
  id: string;
  label: string;
}

const TITLE_ID: Record<string, AppMessageId> = {
  created: "task.history.created",
  amended: "task.history.amended",
  status_changed: "task.history.statusChanged",
  assignee_changed: "task.history.assigneeChanged",
  reopened: "task.history.reopened",
  closed: "task.history.closed",
};

const STATUS_EVENTS = new Set(["status_changed", "closed", "reopened"]);

export function parseTaskHistory(data: unknown): TaskHistoryEvent[] {
  if (!isRecord(data) || !Array.isArray(data.events)) return [];
  return data.events.flatMap((item) => {
    if (!isRecord(item) || typeof item.id !== "string" || typeof item.eventType !== "string") return [];
    return [{
      id: item.id,
      eventType: item.eventType,
      actorType: typeof item.actorType === "string" ? item.actorType : "system",
      actorName: typeof item.actorName === "string" ? item.actorName : null,
      createdAt: typeof item.createdAt === "string" ? item.createdAt : "",
      payload: isRecord(item.payload) ? item.payload : {},
    }];
  });
}

/** Resource receipts stay on the CLI. The person-facing timeline hides them. */
export function visibleTaskHistory(events: readonly TaskHistoryEvent[]): TaskHistoryEvent[] {
  return events.filter((event) => event.eventType !== "resource_receipt_recorded");
}

export function historyTitleId(eventType: string): AppMessageId | null {
  return TITLE_ID[eventType] ?? null;
}

/** Dot color follows the status this event landed on, matching the web timeline. */
export function historyPointStatus(event: TaskHistoryEvent): TaskStatus | null {
  for (const key of ["to", "status", "from"] as const) {
    const value = event.payload[key];
    if (isTaskStatus(value)) return value;
  }
  if (event.eventType === "closed") return "closed";
  if (event.eventType === "reopened") return "in_progress";
  return null;
}

export function historyStatusChange(event: TaskHistoryEvent): { from: TaskStatus; to: TaskStatus } | null {
  if (!STATUS_EVENTS.has(event.eventType)) return null;
  const from = event.payload.from;
  const to = event.payload.to;
  if (!isTaskStatus(from) || !isTaskStatus(to)) return null;
  return { from, to };
}

export function assigneePeople(data: unknown): AssigneePerson[] {
  if (!isRecord(data)) return [];
  const people = [
    ...peopleOf(data.humans, "user"),
    ...peopleOf(data.agents, "agent"),
  ];
  const seen = new Set<string>();
  return people.filter((person) => {
    const key = `${person.type}:${person.id}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export function matchingPeople(people: readonly AssigneePerson[], query: string): AssigneePerson[] {
  const needle = query.trim().toLocaleLowerCase();
  if (!needle) return [...people];
  return people.filter((person) => person.label.toLocaleLowerCase().includes(needle));
}

function peopleOf(value: unknown, type: "user" | "agent"): AssigneePerson[] {
  if (!Array.isArray(value)) return [];
  const people: AssigneePerson[] = [];
  for (const item of value) {
    if (!isRecord(item) || item.deletedAt || typeof item.id !== "string") continue;
    const displayName = typeof item.displayName === "string" ? item.displayName.trim() : "";
    const name = typeof item.name === "string" ? item.name.trim() : "";
    const label = displayName || name;
    if (!label) continue;
    people.push({ type, id: item.id, label });
  }
  return people;
}
