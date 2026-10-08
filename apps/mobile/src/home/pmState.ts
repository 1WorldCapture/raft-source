import { isRecord } from "../model/messages";

/** Wire shape of GET /api/servers/:slug/pm. */
export interface PmAgentSummary {
  agentId: string;
  name: string;
  displayName: string | null;
}

export interface PmTabState {
  pm: PmAgentSummary | null;
  dmChannelId: string | null;
  setup: "unset" | "set" | "dismissed";
}

export interface PmAgentChoice {
  id: string;
  name: string;
}

const SETUPS = new Set(["unset", "set", "dismissed"]);

export function canSetPm(role: string | null | undefined): boolean {
  return role === "owner" || role === "admin";
}

export function parsePmTabState(data: unknown): PmTabState | null {
  if (!isRecord(data) || typeof data.setup !== "string" || !SETUPS.has(data.setup)) return null;
  const setup = data.setup as PmTabState["setup"];
  const dmChannelId = typeof data.dmChannelId === "string" ? data.dmChannelId : null;
  if (data.pm == null) return { pm: null, dmChannelId, setup };
  if (!isRecord(data.pm) || typeof data.pm.agentId !== "string") return null;
  const name = typeof data.pm.name === "string" ? data.pm.name : data.pm.agentId;
  const displayName = typeof data.pm.displayName === "string" ? data.pm.displayName : null;
  return { pm: { agentId: data.pm.agentId, name, displayName }, dmChannelId, setup };
}

export function parsePmAgentChoices(data: unknown): PmAgentChoice[] {
  const list = Array.isArray(data) ? data : isRecord(data) && Array.isArray(data.agents) ? data.agents : [];
  return list.flatMap((item) => {
    if (!isRecord(item) || typeof item.id !== "string" || item.deletedAt) return [];
    const name = typeof item.displayName === "string" && item.displayName
      ? item.displayName
      : typeof item.name === "string" && item.name
        ? item.name
        : item.id;
    return [{ id: item.id, name }];
  });
}

export function isPmDirectMessage(
  channel: { type?: string; peerType?: string | null; peerId?: string | null },
  pmAgentId: string | null,
): boolean {
  return Boolean(pmAgentId && channel.type === "dm" && channel.peerType === "agent" && channel.peerId === pmAgentId);
}
