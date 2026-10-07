import { isRecord, type MessageReaction, type RaftMessage } from "../model/messages";

export const QUICK_REACTIONS = ["👍", "❤️", "🎉", "👀", "🔥", "😂", "✅"] as const;

/** Optimistic reaction toggle. The server call uses the same emoji and the resulting active flag. */
export function applyReaction(message: RaftMessage, emoji: string, active: boolean, userId: string | undefined): RaftMessage {
  const current = message.reactions ?? [];
  const existing = current.find((reaction) => reaction.emoji === emoji);
  let next: MessageReaction[];
  if (active) {
    if (existing) {
      const userIds = userId && !existing.userIds?.includes(userId) ? [...(existing.userIds ?? []), userId] : existing.userIds;
      next = current.map((reaction) => reaction.emoji === emoji
        ? { ...reaction, count: reaction.reactedByMe ? reaction.count : reaction.count + 1, reactedByMe: true, userIds }
        : reaction);
    } else {
      next = [...current, { emoji, count: 1, reactedByMe: true, userIds: userId ? [userId] : [] }];
    }
  } else if (!existing) {
    next = current;
  } else {
    const count = Math.max(0, existing.count - 1);
    next = count === 0
      ? current.filter((reaction) => reaction.emoji !== emoji)
      : current.map((reaction) => reaction.emoji === emoji
        ? { ...reaction, count, reactedByMe: false, userIds: reaction.userIds?.filter((id) => id !== userId) }
        : reaction);
  }
  return { ...message, reactions: next };
}

export function actorNames(data: unknown): string[] {
  if (!isRecord(data) || !Array.isArray(data.actors)) return [];
  return data.actors.flatMap((actor) => {
    if (!isRecord(actor)) return [];
    const name = typeof actor.displayName === "string" ? actor.displayName : typeof actor.name === "string" ? actor.name : "";
    return name ? [name] : [];
  });
}

export function reactionIsMine(reaction: MessageReaction, userId: string | undefined): boolean {
  return Boolean(reaction.reactedByMe || (userId && reaction.userIds?.includes(userId)));
}
