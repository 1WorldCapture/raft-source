/** One in-flight reaction request per message and emoji. A second tap waits. */
export function claimReaction(inFlight: { has(key: string): boolean; add(key: string): void }, messageId: string, emoji: string): boolean {
  const key = `${messageId}:${emoji}`;
  if (inFlight.has(key)) return false;
  inFlight.add(key);
  return true;
}

export function releaseReaction(inFlight: { delete(key: string): void }, messageId: string, emoji: string) {
  inFlight.delete(`${messageId}:${emoji}`);
}

/** Thread replies cannot open another thread, follow, or become a task. */
export function threadMenuActions(input: { inThread: boolean; threadChannelId?: string | null }): {
  openThread: boolean;
  follow: boolean;
  task: boolean;
} {
  if (input.inThread) return { openThread: false, follow: false, task: false };
  return { openThread: true, follow: Boolean(input.threadChannelId), task: true };
}
