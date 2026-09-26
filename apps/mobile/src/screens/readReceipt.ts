import { isRecord } from "../model/messages";

export interface PeerRead {
  peerKind: "human" | "agent";
  peerId: string;
  maxReadSeq: number;
}

export function parsePeerReads(data: unknown): PeerRead[] | null {
  if (!isRecord(data) || !Array.isArray(data.peerReadStates)) return null;
  const peers: PeerRead[] = [];
  for (const item of data.peerReadStates) {
    if (!isRecord(item)) return null;
    const maxReadSeq = Number(item.maxReadSeq);
    if ((item.peerKind !== "human" && item.peerKind !== "agent") || typeof item.peerId !== "string" || !Number.isFinite(maxReadSeq)) {
      return null;
    }
    peers.push({ peerKind: item.peerKind, peerId: item.peerId, maxReadSeq });
  }
  return peers;
}

/** A DM is read when some peer other than the sender has passed this seq. */
export function dmReadByPeer(peers: readonly PeerRead[], messageSeq: number | undefined, senderId: string | undefined): boolean {
  if (!messageSeq || messageSeq <= 0 || !senderId) return false;
  return peers.some((peer) => peer.peerId !== senderId && peer.maxReadSeq >= messageSeq);
}

export function agentHasRead(peers: readonly PeerRead[], agentId: string | undefined, messageSeq: number | undefined): boolean | null {
  if (!agentId || !messageSeq || messageSeq <= 0) return null;
  const peer = peers.find((item) => item.peerKind === "agent" && item.peerId === agentId);
  if (!peer) return null;
  return peer.maxReadSeq >= messageSeq;
}
