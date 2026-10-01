import type { Channel } from "../store/channelStore";

/** GET /messages/channel/:id/by-sender. Not the cached channel window. */
export const ANNOUNCEMENT_SENDER_QUERY_PARAM = "senderId";

export type AnnouncementChannelLike = {
  name?: string | null;
  type?: string | null;
  systemKind?: "all" | "announcement" | null;
  activityMuted?: boolean;
} | null | undefined;

/**
 * The system announcement channel. `systemKind` wins once the server sends it.
 * Until that field is on the wire, the reserved name `#announcement` is the
 * same channel (the migration deletes a user channel that already used it).
 */
export function isAnnouncementChannel(channel: AnnouncementChannelLike): boolean {
  if (!channel) return false;
  if (channel.systemKind === "announcement") return true;
  if (channel.systemKind != null) return false;
  return channel.type === "channel" && channel.name === "announcement";
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

export function announcementShowsMuted(channel: Pick<Channel, "activityMuted" | "name" | "type" | "systemKind">): boolean {
  return isAnnouncementChannel(channel) && channel.activityMuted !== false
    || channel.activityMuted === true;
}

export function isSystemPostedAnnouncement(message: { postedBySystem?: boolean | null }): boolean {
  return message.postedBySystem === true;
}
