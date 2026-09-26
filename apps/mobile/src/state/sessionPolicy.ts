/** A refresh that started before logout or a server switch must not write tokens back. */
export function shouldCommitSession(startedEpoch: number, currentEpoch: number): boolean {
  return startedEpoch === currentEpoch;
}

/** A blurred screen may clear focus only while it still owns it. */
export function releaseFocus(current: string | null, owner: string): string | null {
  return current === owner ? null : current;
}

/** Messages on the screen the user is looking at are read, not unread. */
export function shouldMarkVisibleRead(focusedChannelId: string | null, channelId: string): boolean {
  return focusedChannelId === channelId;
}

export function catchUpPlan(hasMore: boolean): { refreshDirectory: boolean; refreshUnread: boolean } {
  return { refreshDirectory: hasMore, refreshUnread: hasMore };
}
