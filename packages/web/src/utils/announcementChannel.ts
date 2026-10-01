import type { Channel } from "../store/channelStore";

/** GET /messages/channel/:id/by-sender. Not the cached channel window. */
export const ANNOUNCEMENT_SENDER_QUERY_PARAM = "senderId";

export type AnnouncementChannelLike = {
  systemKind?: "all" | "announcement" | null;
  activityMuted?: boolean;
} | null | undefined;

/** The system announcement channel. Identified only by `systemKind`, never by name. */
export function isAnnouncementChannel(channel: AnnouncementChannelLike): boolean {
  return channel?.systemKind === "announcement";
}

/**
 * Default-muted announcement channels stay out of loud unread totals.
 * An explicit unmute (`activityMuted === false`) opts back in.
 * Other channels keep the existing activity-mute rule.
 */
export function channelExcludedFromUnmutedUnread(channel: AnnouncementChannelLike): boolean {
  if (!channel) return false;
  if (isAnnouncementChannel(channel) && channel.activityMuted !== false) return true;
  return channel.activityMuted === true;
}

export function announcementShowsMuted(channel: Pick<Channel, "activityMuted" | "systemKind">): boolean {
  return (isAnnouncementChannel(channel) && channel.activityMuted !== false)
    || channel.activityMuted === true;
}

export function isSystemPostedAnnouncement(message: {
  actionMetadata?: { kind?: string } | null;
}): boolean {
  return message.actionMetadata?.kind === "announcement-proxy";
}
