/** A refresh that started before logout must not write tokens. A server switch does not count. */
export function shouldCommitTokens(startedAuthEpoch: number, currentAuthEpoch: number): boolean {
  return startedAuthEpoch === currentAuthEpoch;
}

/** In-flight reads belong to the server that was selected when the request started. */
export function shouldApplyServerResponse(startedServerEpoch: number, currentServerEpoch: number): boolean {
  return startedServerEpoch === currentServerEpoch;
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
