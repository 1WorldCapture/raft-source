import { Pressable, StyleSheet, View } from "react-native";
import { Hash, Link2, Lock, Pencil } from "lucide-react-native";
import type { MessagePreview } from "@botiverse/raft-shared/src/messageSnippet.ts";
import { useT } from "../i18n/provider";
import { channelLabel, type RaftChannel } from "../model/messages";
import { Avatar } from "../ui/Avatar";
import { Badge, MentionMark } from "../ui/Badge";
import { AppText } from "../ui/text";
import { color, fontSize } from "../ui/tokens";
import { conversationSummaryStrings, formatConversationSummary } from "./conversationPreview";

/** Live presence for the DM peer, resolved from /agents by the screen. */
export interface ConversationPresence {
  avatarUrl: string | null;
  status: "online" | "busy" | "error" | "offline";
}

// One row of the message-list home (task #5): avatar or channel icon, name,
// latest-message summary, relative time, unread badge, @ mark and draft mark.
// Deliberately presentational — data, sorting and presence resolution live in
// the data layer that assembles the screen (task #6).
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
  const bold = unreadCount > 0 || hasMention;
  return (
    <Pressable delayLongPress={500} onLongPress={onLongPress} onPress={onPress} style={[styles.row, compact ? styles.rowCompact : null]}>
      <View style={styles.iconCol}>
        {dm ? (
          <Avatar
            avatarUrl={agentPeer ? (presence?.avatarUrl ?? channel.peerAvatarUrl) : channel.peerAvatarUrl}
            kind={agentPeer ? "agent" : "human"}
            name={channelLabel(channel)}
            size={32}
            status={agentPeer && presence ? presence.status : undefined}
          />
        ) : channel.type === "private" ? (
          <Lock color={color.ink} size={18} />
        ) : (
          <Hash color={color.ink} size={18} />
        )}
      </View>
      <View style={styles.main}>
        <View style={styles.titleLine}>
          {channel.type === "joint" ? <Link2 color={color.inkMid} size={12} strokeWidth={2.5} style={styles.jointMark} /> : null}
          <AppText numberOfLines={1} style={[styles.name, bold ? styles.unread : null]}>{channelLabel(channel)}</AppText>
          {timeText ? <AppText numberOfLines={1} style={styles.time}>{timeText}</AppText> : null}
        </View>
        <View style={styles.summaryLine}>
          <AppText numberOfLines={1} style={[styles.summary, bold ? styles.summaryUnread : null]}>{summary}</AppText>
          <View style={styles.marks}>
            {hasDraft ? <Pencil color={color.inkMid} size={13} /> : null}
            {hasMention ? <MentionMark /> : null}
            <Badge count={unreadCount} quiet={channel.activityMuted} />
          </View>
        </View>
      </View>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  row: { alignItems: "center", borderColor: "transparent", borderWidth: 2, flexDirection: "row", gap: 10, paddingHorizontal: 16, paddingVertical: 8 },
  rowCompact: { paddingVertical: 4 },
  iconCol: { alignItems: "center", height: 32, justifyContent: "center", width: 32 },
  main: { flex: 1, gap: 2 },
  titleLine: { alignItems: "center", flexDirection: "row", gap: 4 },
  jointMark: { flexShrink: 0 },
  name: { ...fontSize.list, color: color.ink, flexShrink: 1, fontWeight: "500" },
  unread: { fontWeight: "700" },
  time: { ...fontSize.time, color: color.inkFaint, flexShrink: 0, fontFamily: "mono", marginLeft: "auto", paddingLeft: 8 },
  summaryLine: { alignItems: "center", flexDirection: "row", gap: 6 },
  summary: { ...fontSize.bodySm, color: color.inkLabel, flex: 1, flexShrink: 1 },
  summaryUnread: { color: color.ink, fontWeight: "700" },
  marks: { alignItems: "center", flexDirection: "row", gap: 4, flexShrink: 0 },
});
