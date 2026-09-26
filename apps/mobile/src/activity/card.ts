import type { AppMessageId } from "../i18n/catalog";
import { color } from "../ui/tokens";
import { activityKey, type ActivityFilter, type ActivityItem } from "./model";

export type ActivityIconKind = "thread" | "dm" | "channel";

export type ActivityBadge =
  | { kind: "task"; text: string; status: string }
  | { kind: "replies"; count: number }
  | { kind: "unfollowed" }
  | { kind: "mention" }
  | { kind: "unread"; count: number }
  | { kind: "draft" };

export function stripActivityTitlePrefix(value: string): string {
  return value.replace(/^[@#]+/, "");
}

/** Parent-channel tag on a thread card. Channel and DM cards have no tag row. */
export function activityThreadTag(item: ActivityItem): string | null {
  if (item.kind !== "thread") return null;
  const name = stripActivityTitlePrefix(item.parentChannelName);
  return item.parentChannelType === "dm" ? `@${name}` : `#${name}`;
}

export function activityIconKind(item: ActivityItem): ActivityIconKind {
  if (item.kind === "thread") return "thread";
  if (item.kind === "dm" || item.channelType === "dm") return "dm";
  return "channel";
}

/** Thread parent preview, channel name, or the other person's name. */
export function activityPrimaryText(item: ActivityItem): string {
  if (item.kind === "thread") return item.parentMessagePreview;
  return stripActivityTitlePrefix(item.channelName);
}

export function activityBodyPreview(item: ActivityItem): string {
  return item.kind === "thread" ? item.latestActivityPreview : item.lastMessagePreview;
}

export function activitySender(item: ActivityItem, names: Readonly<Record<string, string>>): { system: boolean; name: string | null } {
  const senderType = item.kind === "thread" ? item.latestActivitySenderType : item.lastMessageSenderType;
  const senderId = item.kind === "thread" ? item.latestActivitySenderId : item.lastMessageSenderId;
  const fallback = item.kind === "thread" ? item.latestActivitySenderName : item.lastMessageSenderName;
  if (senderType === "system" || senderId === "system") return { system: true, name: null };
  return { system: false, name: names[senderId] || fallback || null };
}

export function activityBadges(item: ActivityItem, filter: ActivityFilter, hasDraft: boolean): ActivityBadge[] {
  const badges: ActivityBadge[] = [];
  if (item.kind === "thread" && item.taskNumber != null && item.taskStatus) {
    const claim = item.taskClaimedByName ? ` @${item.taskClaimedByName}` : "";
    badges.push({ kind: "task", text: `#${item.taskNumber}${claim}`, status: item.taskStatus });
  }
  if (item.kind === "thread") badges.push({ kind: "replies", count: item.replyCount });
  if (item.kind === "thread" && item.isFollowing === false) badges.push({ kind: "unfollowed" });
  if (filter !== "mentions" && item.hasMention && item.unreadCount > 0) badges.push({ kind: "mention" });
  if (item.unreadCount > 0) badges.push({ kind: "unread", count: item.unreadCount });
  if (hasDraft) badges.push({ kind: "draft" });
  return badges;
}

export function taskStatusFill(status: string): string {
  if (status === "in_progress") return color.cyan;
  if (status === "in_review") return color.lavender;
  if (status === "done") return color.lime;
  if (status === "closed") return color.stone;
  return color.orange;
}

export function showMarkAllRead(filter: ActivityFilter, totalUnreadCount: number): boolean {
  return totalUnreadCount > 0 && filter !== "done";
}

/** Thread opens on the first unread reply; a channel prefers the mention, then the first unread. */
export function activityTargetMessageId(item: ActivityItem): string | null {
  if (item.kind === "thread") {
    return item.unreadCount > 0
      ? present(item.firstUnreadMessageId) ?? present(item.latestActivityMessageId)
      : present(item.latestActivityMessageId);
  }
  const mention = present(item.firstMentionMessageId);
  if (mention) return mention;
  const last = present(item.lastMessageId);
  if (item.unreadCount > 0) return present(item.firstUnreadMessageId) ?? last;
  return last;
}

export type ActivityMenuAction = "read" | "unread" | "done" | "follow" | "unfollow";

/** Unfollowed threads hide read/unread. Follow and unfollow are thread-only. */
export function activityMenuActions(item: ActivityItem): ActivityMenuAction[] {
  const actions: ActivityMenuAction[] = [];
  if (!(item.kind === "thread" && item.isFollowing === false)) {
    actions.push(item.unreadCount > 0 ? "read" : "unread");
  }
  actions.push("done");
  if (item.kind === "thread") actions.push(item.isFollowing === false ? "follow" : "unfollow");
  return actions;
}

/** Title double-tap walks unread rows and wraps to the first. */
export function nextUnreadKey(items: readonly ActivityItem[], currentKey: string | null): string | null {
  const unread = items.filter((item) => item.unreadCount > 0);
  if (unread.length === 0) return null;
  const current = currentKey ? unread.findIndex((item) => activityKey(item) === currentKey) : -1;
  const next = unread[(current + 1) % unread.length];
  return next ? activityKey(next) : null;
}

/** A changed top row counts as one update only after the list has left the top. */
export function nextNewUpdateCount(previousTop: string | null, nextTop: string | null, nearTop: boolean, count: number): number {
  if (nearTop) return 0;
  if (previousTop && nextTop && previousTop !== nextTop) return count + 1;
  return count;
}

function present(value: string | null | undefined): string | null {
  return value && value.length > 0 ? value : null;
}

export function activityEmptyCopy(filter: ActivityFilter): { title: AppMessageId; description: AppMessageId } {
  if (filter === "mentions") return { title: "thread.empty.mentionsTitle", description: "thread.empty.mentionsDescription" };
  if (filter === "unread") return { title: "thread.empty.unreadTitle", description: "thread.empty.defaultDescription" };
  if (filter === "done") return { title: "activity.current.emptyDone", description: "activity.current.emptyDoneDescription" };
  return { title: "thread.empty.defaultTitle", description: "thread.empty.defaultDescription" };
}
