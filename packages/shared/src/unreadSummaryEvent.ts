/**
 * Server → client socket event: "this server's unread summary may have
 * changed — re-fetch GET /api/servers/unread-summary". It carries no counts;
 * clients re-fetch, so it is safe to receive more than once.
 *
 * Sent to the `user:<userId>` room (every device/tab of that user) after
 * reads, Done/undone, mute changes, membership/archive changes, completed
 * read mutations, and new Activity rows. User actions are debounced (~500 ms);
 * new-activity notifications are rate-limited per user and server.
 */
export const UNREAD_SUMMARY_CHANGED_EVENT = "unread_summary:changed" as const;

export interface UnreadSummaryChangedPayload {
  serverId: string;
}
