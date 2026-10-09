export interface BubbleMessage {
  senderId?: string;
  senderType?: string;
  pending?: "sending" | "failed";
}

/**
 * A one-to-one row sits on the right when the signed-in user sent it.
 * A local send can be pending before the server assigns senderId; that row
 * still belongs on the right so it does not jump after the ack.
 */
export function isOwnBubble(message: BubbleMessage, currentUserId: string | undefined): boolean {
  if (message.senderType === "agent") return false;
  const pending = message.pending === "sending" || message.pending === "failed";
  if (pending && (!message.senderId || !currentUserId || message.senderId === currentUserId)) return true;
  return Boolean(currentUserId && message.senderId === currentUserId && message.senderType === "user");
}
