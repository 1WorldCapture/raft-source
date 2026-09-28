import { Pressable, StyleSheet, View } from "react-native";
import { Hash, Link2, Lock, Pencil } from "lucide-react-native";
import type { MessagePreview } from "@botiverse/raft-shared/src/messageSnippet.ts";
import { useT } from "../i18n/provider";
import { channelLabel, type RaftChannel } from "../model/messages";
import { Avatar } from "../ui/Avatar";
import { Badge, MentionMark } from "../ui/Badge";
import { HardShadow } from "../ui/shadow";
import { AppText } from "../ui/text";
import { border, color, fontSize, pressShift, shadowOffset } from "../ui/tokens";
import { conversationSummaryStrings, formatConversationSummary } from "./conversationPreview";

/** Live presence for the DM peer, resolved from /agents by the screen. */
export interface ConversationPresence {
  avatarUrl: string | null;
  status: "online" | "busy" | "error" | "offline";
}

const ICON_BOX = 36;
const ICON_BOX_COMPACT = 30;

// One card of the message-list home (task #5, card styling task #9): avatar or
// boxed channel icon, name, latest-message summary, relative time, unread
// badge, @ mark and draft mark. Deliberately presentational — data, sorting
// and presence resolution live in the data layer that assembles the screen.
export function ConversationRow({
  channel,
  preview,
  timeText,
  unreadCount,
  hasMention,
  hasDraft,
  presence,
  compact,
  onPress,
  onLongPress,
}: {
  channel: RaftChannel;
  preview: MessagePreview | null | undefined;
  /** Preformatted relative time (formatRelativeTime); null hides the column. */
  timeText: string | null;
  unreadCount: number;
  hasMention: boolean;
  hasDraft: boolean;
  presence?: ConversationPresence | null;
  compact?: boolean;
  onPress: () => void;
  onLongPress?: () => void;
}) {
  const t = useT();
  const dm = channel.type === "dm";
  const agentPeer = dm && channel.peerType === "agent";
  const summary = formatConversationSummary(preview, conversationSummaryStrings(t))
    ?? t("mobile.conversations.noMessages");
  const unread = unreadCount > 0 || hasMention;
  // System notices never outrank people: no bold, secondary colour even when unread.
  const systemPreview = preview?.kind === "system";
  return (
    <Pressable delayLongPress={500} onLongPress={onLongPress} onPress={onPress} style={[styles.outer, compact ? styles.outerCompact : null]}>
      {({ pressed }) => (
        <HardShadow offset={pressed ? shadowOffset.pressed : shadowOffset.sm} style={pressed ? styles.pressedShift : null}>
          <View style={[styles.card, compact ? styles.cardCompact : null, unread ? styles.cardUnread : null]}>
            {dm ? (
              <Avatar
                avatarUrl={agentPeer ? (presence?.avatarUrl ?? channel.peerAvatarUrl) : channel.peerAvatarUrl}
                kind={agentPeer ? "agent" : "human"}
                name={channelLabel(channel)}
                size={compact ? ICON_BOX_COMPACT : ICON_BOX}
                status={agentPeer && presence ? presence.status : undefined}
              />
            ) : (
              <View style={[styles.iconBox, compact ? styles.iconBoxCompact : null]}>
                {channel.type === "private" ? <Lock color={color.ink} size={18} /> : <Hash color={color.ink} size={18} />}
              </View>
            )}
            <View style={styles.main}>
              <View style={styles.titleLine}>
                {channel.type === "joint" ? <Link2 color={color.inkMid} size={12} strokeWidth={2.5} style={styles.jointMark} /> : null}
                <AppText numberOfLines={1} style={[styles.name, unread ? styles.nameUnread : null]}>{channelLabel(channel)}</AppText>
                {timeText ? <AppText numberOfLines={1} style={styles.time}>{timeText}</AppText> : null}
              </View>
              <View style={styles.summaryLine}>
                <AppText
                  numberOfLines={1}
                  style={[
                    styles.summary,
                    systemPreview ? styles.summarySystem : unread ? styles.summaryUnread : null,
                  ]}
                >
                  {summary}
                </AppText>
                <View style={styles.marks}>
                  {hasDraft ? <Pencil color={color.inkMid} size={13} /> : null}
                  {hasMention ? <MentionMark /> : null}
                  <Badge count={unreadCount} quiet={channel.activityMuted} />
                </View>
              </View>
            </View>
          </View>
        </HardShadow>
      )}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  outer: { marginBottom: 8, marginHorizontal: 12 },
  outerCompact: { marginBottom: 6, marginHorizontal: 8 },
  pressedShift: { transform: [{ translateX: pressShift / 2 }, { translateY: pressShift / 2 }] },
  card: {
    alignItems: "center",
    backgroundColor: color.page,
    borderColor: color.border,
    borderWidth: border.strong,
    flexDirection: "row",
    gap: 12,
    minHeight: 64,
    paddingHorizontal: 12,
    paddingVertical: 10,
  },
  cardCompact: { gap: 8, minHeight: 56, paddingHorizontal: 8, paddingVertical: 6 },
  cardUnread: { backgroundColor: color.yellowPale },
  iconBox: {
    alignItems: "center",
    backgroundColor: color.mutedFill,
    borderColor: color.border,
    borderWidth: border.strong,
    height: ICON_BOX,
    justifyContent: "center",
    width: ICON_BOX,
  },
  iconBoxCompact: { height: ICON_BOX_COMPACT, width: ICON_BOX_COMPACT },
  main: { flex: 1, gap: 2, minWidth: 0 },
  titleLine: { alignItems: "center", flexDirection: "row", gap: 4 },
  jointMark: { flexShrink: 0 },
  name: { ...fontSize.list, color: color.ink, flexShrink: 1, fontWeight: "600" },
  nameUnread: { fontWeight: "700" },
  time: { ...fontSize.time, color: color.inkFaint, flexShrink: 0, fontFamily: "mono", marginLeft: "auto", paddingLeft: 8 },
  summaryLine: { alignItems: "center", flexDirection: "row", gap: 6 },
  summary: { ...fontSize.bodySm, color: color.inkLabel, flex: 1 },
  summaryUnread: { color: color.ink, fontWeight: "700" },
  summarySystem: { color: color.inkSoft, fontWeight: "400" },
  marks: { alignItems: "center", flexDirection: "row", flexShrink: 0, gap: 4 },
});
