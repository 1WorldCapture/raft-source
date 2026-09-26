import { isRecord } from "../model/messages";

export interface ChannelMeta {
  name: string;
  description: string | null;
  type: string;
  visibility: "public" | "private" | "joint";
  archived: boolean;
  activityMuted: boolean;
  peerName: string | null;
  peerAvatarUrl: string | null;
  peerId: string | null;
  peerKind: "agent" | "human" | null;
  peerDescription: string | null;
}

export function parseChannelMeta(data: unknown): ChannelMeta | null {
  if (!isRecord(data) || typeof data.name !== "string") return null;
  const visibility = data.visibility === "private"
    ? "private"
    : data.visibility === "joint" || data.joint === true
      ? "joint"
      : "public";
  const peer = isRecord(data.peer) ? data.peer : null;
  const peerId = text(data.peerId) || text(peer?.id);
  return {
    name: data.name,
    description: typeof data.description === "string" ? data.description : null,
    type: typeof data.type === "string" ? data.type : "channel",
    visibility,
    archived: data.archived === true || typeof data.archivedAt === "string",
    activityMuted: data.activityMuted === true,
    peerName: text(data.peerDisplayName) || text(data.peerName) || text(peer?.displayName) || text(peer?.name),
    peerAvatarUrl: text(data.peerAvatarUrl) || text(peer?.avatarUrl),
    peerId,
    peerKind: data.peerType === "agent" || peer?.type === "agent" ? "agent" : peerId ? "human" : null,
    peerDescription: text(data.peerDescription) || text(peer?.description),
  };
}

function text(value: unknown): string | null {
  return typeof value === "string" && value ? value : null;
}
