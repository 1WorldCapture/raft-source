import { isRecord } from "../model/messages";

/** Message payloads carry no avatar; web resolves it from `/agents` and server members by sender id. */
export function collectSenderAvatars(agents: unknown, members: unknown): Record<string, string> {
  const map: Record<string, string> = {};
  const add = (list: unknown, idKey: "id" | "userId") => {
    if (!Array.isArray(list)) return;
    for (const item of list) {
      if (!isRecord(item) || item.deletedAt) continue;
      const id = item[idKey];
      const url = item.avatarUrl;
      if (typeof id === "string" && typeof url === "string" && url) map[id] = url;
    }
  };
  add(isRecord(agents) && Array.isArray(agents.agents) ? agents.agents : agents, "id");
  add(isRecord(members) && Array.isArray(members.members) ? members.members : members, "userId");
  return map;
}

/** Prefer a directory name over the raw sender name carried on an inbox row. */
export function collectSenderNames(agents: unknown, members: unknown): Record<string, string> {
  const map: Record<string, string> = {};
  const add = (list: unknown, idKey: "id" | "userId") => {
    if (!Array.isArray(list)) return;
    for (const item of list) {
      if (!isRecord(item) || item.deletedAt) continue;
      const id = item[idKey];
      const displayName = typeof item.displayName === "string" ? item.displayName.trim() : "";
      const name = typeof item.name === "string" ? item.name.trim() : "";
      const label = displayName || name;
      if (typeof id === "string" && label) map[id] = label;
    }
  };
  add(isRecord(agents) && Array.isArray(agents.agents) ? agents.agents : agents, "id");
  add(isRecord(members) && Array.isArray(members.members) ? members.members : members, "userId");
  return map;
}

/**
 * Both maps in one pass over the same two responses — the cacheable sender
 * directory (#desktop-data-cache task #3): avatars make offline message rows
 * render real avatars, names ride along for future name lookups.
 */
export function collectSenderDirectory(agents: unknown, members: unknown): { avatars: Record<string, string>; names: Record<string, string> } {
  return {
    avatars: collectSenderAvatars(agents, members),
    names: collectSenderNames(agents, members),
  };
}
