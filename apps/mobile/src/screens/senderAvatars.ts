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
