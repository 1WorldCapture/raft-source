import api from "../api/client";

export interface PendingJointChannelInvite {
  id: string;
  jointChannelId: string;
  fromServerName: string;
  fromServerSlug: string;
  channelName: string;
  channelDescription: string | null;
  invitedByUserId: string;
  expiresAt: string;
  createdAt: string;
}

function inviteFromRow(row: unknown): PendingJointChannelInvite | null {
  if (!row || typeof row !== "object") return null;
  const item = row as Record<string, unknown>;
  if (typeof item.id !== "string" || typeof item.fromServerName !== "string" || typeof item.channelName !== "string") {
    return null;
  }
  return {
    id: item.id,
    jointChannelId: typeof item.jointChannelId === "string" ? item.jointChannelId : "",
    fromServerName: item.fromServerName,
    fromServerSlug: typeof item.fromServerSlug === "string" ? item.fromServerSlug : "",
    channelName: item.channelName,
    channelDescription: typeof item.channelDescription === "string" ? item.channelDescription : null,
    invitedByUserId: typeof item.invitedByUserId === "string" ? item.invitedByUserId : "",
    expiresAt: typeof item.expiresAt === "string" ? item.expiresAt : "",
    createdAt: typeof item.createdAt === "string" ? item.createdAt : "",
  };
}

export function parsePendingJointChannelInvites(data: unknown): PendingJointChannelInvite[] {
  if (!data || typeof data !== "object") return [];
  const invites = (data as { invites?: unknown }).invites;
  if (!Array.isArray(invites)) return [];
  return invites.flatMap((row) => {
    const invite = inviteFromRow(row);
    return invite ? [invite] : [];
  });
}

export function jointInviteErrorText(err: unknown, fallback: string): string {
  const response = (err as { response?: { data?: { error?: unknown } } } | null)?.response;
  const error = response?.data?.error;
  return typeof error === "string" && error.trim() ? error : fallback;
}

export async function fetchPendingJointChannelInvites(): Promise<PendingJointChannelInvite[]> {
  const { data } = await api.get("/channels/joint-invites");
  return parsePendingJointChannelInvites(data);
}

export async function acceptJointChannelInvite(inviteId: string): Promise<string | null> {
  const { data } = await api.post(`/channels/joint-invites/${encodeURIComponent(inviteId)}/accept`);
  return data && typeof data === "object" && typeof (data as { id?: unknown }).id === "string"
    ? (data as { id: string }).id
    : null;
}
