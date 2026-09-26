import { isRecord } from "../model/messages";
import { color } from "../ui/tokens";
import { groupTasks, type RaftTask, type TaskStatus } from "./model";

export interface TaskFilters {
  channels: string[];
  creators: string[];
  assignees: string[];
}

export interface FilterChoice {
  id: string;
  label: string;
  italic?: boolean;
}

export const EMPTY_TASK_FILTERS: TaskFilters = { channels: [], creators: [], assignees: [] };

export const UNASSIGNED = "unassigned";

export function hasTaskFilter(filters: TaskFilters): boolean {
  return filters.channels.length > 0 || filters.creators.length > 0 || filters.assignees.length > 0;
}

/** Chips combine with AND. Values inside one chip combine with OR. */
export function filterTasks(tasks: readonly RaftTask[], filters: TaskFilters): RaftTask[] {
  let result: RaftTask[] = [...tasks];
  if (filters.channels.length > 0) {
    const selected = new Set(filters.channels);
    result = result.filter((task) => selected.has(task.channelId));
  }
  if (filters.creators.length > 0) {
    const selected = new Set(filters.creators);
    result = result.filter((task) => selected.has(`${task.createdByType}:${task.createdById}`));
  }
  if (filters.assignees.length > 0) {
    const matchUnassigned = filters.assignees.includes(UNASSIGNED);
    const selected = new Set(filters.assignees.filter((id) => id !== UNASSIGNED));
    result = result.filter((task) => {
      if (!task.claimedById || !task.claimedByType) return matchUnassigned;
      return selected.has(`${task.claimedByType}:${task.claimedById}`);
    });
  }
  return result;
}

export function filteredTaskGroups(tasks: readonly RaftTask[], filters: TaskFilters) {
  return groupTasks(filterTasks(tasks, filters));
}

/** Done and closed start collapsed, matching the web list. */
export function defaultCollapsed(): Record<TaskStatus, boolean> {
  return { todo: false, in_progress: false, in_review: false, done: true, closed: true };
}

export function taskStatusFill(status: TaskStatus): string {
  if (status === "in_progress") return color.cyan;
  if (status === "in_review") return color.lavender;
  if (status === "done") return color.lime;
  if (status === "closed") return color.stone;
  return color.orange;
}

export function channelLabel(name: string | null | undefined): string {
  const stripped = (name ?? "").replace(/^[#@]+/, "").trim();
  return stripped ? `#${stripped}` : "#";
}

export function plainDescription(value: string | null | undefined): string {
  return (value ?? "").replace(/\s+/g, " ").trim();
}

interface NamedChannel {
  id: string;
  name: string;
  type?: string | null;
}

/** Public and private channels, plus any channel that still has a visible task. */
export function channelChoices(channels: readonly NamedChannel[], tasks: readonly RaftTask[]): FilterChoice[] {
  const byId = new Map<string, FilterChoice>();
  for (const channel of channels) {
    if (channel.type === "dm" || channel.type === "joint") continue;
    if (channel.type && channel.type !== "channel" && channel.type !== "private") continue;
    byId.set(channel.id, { id: channel.id, label: channelLabel(channel.name) });
  }
  for (const task of tasks) {
    if (byId.has(task.channelId)) continue;
    byId.set(task.channelId, { id: task.channelId, label: channelLabel(task.channelName) });
  }
  return [...byId.values()].sort((left, right) => left.label.localeCompare(right.label, undefined, { sensitivity: "base" }));
}

export function peopleChoices(agents: unknown, members: unknown): FilterChoice[] {
  const choices: FilterChoice[] = [];
  const agentList = isRecord(agents) && Array.isArray(agents.agents) ? agents.agents : agents;
  const memberList = isRecord(members) && Array.isArray(members.members) ? members.members : members;
  if (Array.isArray(agentList)) {
    for (const item of agentList) {
      if (!isRecord(item) || item.deletedAt || typeof item.id !== "string") continue;
      const label = personLabel(item);
      if (label) choices.push({ id: `agent:${item.id}`, label });
    }
  }
  if (Array.isArray(memberList)) {
    for (const item of memberList) {
      if (!isRecord(item) || typeof item.userId !== "string") continue;
      const label = personLabel(item);
      if (label) choices.push({ id: `user:${item.userId}`, label });
    }
  }
  return choices.sort((left, right) => left.label.localeCompare(right.label, undefined, { sensitivity: "base" }));
}

export function matchingChoices(choices: readonly FilterChoice[], query: string): FilterChoice[] {
  const needle = query.trim().toLocaleLowerCase();
  if (!needle) return [...choices];
  return choices.filter((choice) => choice.label.toLocaleLowerCase().includes(needle));
}

export function toggleChoice(selected: readonly string[], id: string): string[] {
  return selected.includes(id) ? selected.filter((item) => item !== id) : [...selected, id];
}

export function parseTaskFilters(raw: string | null): TaskFilters {
  if (!raw) return { ...EMPTY_TASK_FILTERS };
  try {
    const data = JSON.parse(raw) as unknown;
    if (!isRecord(data)) return { ...EMPTY_TASK_FILTERS };
    return {
      channels: stringList(data.channels),
      creators: stringList(data.creators),
      assignees: stringList(data.assignees),
    };
  } catch {
    return { ...EMPTY_TASK_FILTERS };
  }
}

function personLabel(item: Record<string, unknown>): string {
  const displayName = typeof item.displayName === "string" ? item.displayName.trim() : "";
  const name = typeof item.name === "string" ? item.name.trim() : "";
  return displayName || name;
}

function stringList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === "string" && item.length > 0);
}
