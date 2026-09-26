import { Image, Pressable, StyleSheet, View } from "react-native";
import type { RaftMessage } from "../model/messages";
import { senderLabel } from "../model/messages";
import { Avatar } from "../ui/Avatar";
import { AppText } from "../ui/text";
import { RichText } from "../ui/richText";
import { color, fontSize } from "../ui/tokens";
import type { MessageGroupState } from "./messageGrouping";

/** Shared message row. Task #14 adds press and long-press on top of this layout. */
export function MessageRow({
  message,
  group,
  timeLabel,
  dayLabel,
  mentioned,
  threadLabel,
  sendingLabel,
  resendLabel,
  deleteLabel,
  onOpenThread,
  onResend,
  onDelete,
}: {
  message: RaftMessage;
  group: MessageGroupState;
  timeLabel: string;
  dayLabel: string;
  mentioned: boolean;
  threadLabel?: string;
  sendingLabel: string;
  resendLabel: string;
  deleteLabel: string;
  onOpenThread?: () => void;
  onResend?: () => void;
  onDelete?: () => void;
}) {
  const system = message.messageType === "system";
  return (
    <View>
      {group.showDayDivider && dayLabel ? (
        <View style={styles.divider}>
          <AppText style={styles.dividerLabel}>{dayLabel}</AppText>
        </View>
      ) : null}
      {system ? (
        <AppText style={styles.system}>{timeLabel ? `${timeLabel} ${message.content}` : message.content}</AppText>
      ) : (
        <View style={[styles.row, mentioned ? styles.mentioned : null, message.pending === "failed" ? styles.failed : null]}>
          <View style={styles.avatar}>
            {group.showAvatar ? (
              <Avatar
                name={senderLabel(message)}
                kind={message.senderType === "agent" ? "agent" : "human"}
                avatarUrl={message.senderAvatarUrl}
              />
            ) : null}
          </View>
          <View style={styles.body}>
            {group.showAvatar ? (
              <View style={styles.head}>
                <AppText style={styles.name}>{senderLabel(message)}</AppText>
                {timeLabel ? <AppText style={styles.time}>{timeLabel}</AppText> : null}
              </View>
            ) : null}
            <RichText content={message.content} mentions={message.mentions} />
            {message.attachments?.map((attachment) => (
              <View key={attachment.id ?? attachment.filename} style={styles.attachment}>
                {attachment.thumbnailUrl ? <Image source={{ uri: attachment.thumbnailUrl }} style={styles.thumb} /> : null}
                <AppText style={styles.file}>{attachment.filename}</AppText>
              </View>
            ))}
            {message.reactions && message.reactions.length > 0 ? (
              <AppText style={styles.reactions}>{message.reactions.map((reaction) => `${reaction.emoji} ${reaction.count}`).join("  ")}</AppText>
            ) : null}
            {message.pending === "sending" ? <AppText style={styles.pending}>{sendingLabel}</AppText> : null}
            {message.pending === "failed" ? (
              <View style={styles.retryRow}>
                <Pressable onPress={onResend}><AppText style={styles.retry}>{resendLabel}</AppText></Pressable>
                <Pressable onPress={onDelete}><AppText style={styles.retry}>{deleteLabel}</AppText></Pressable>
              </View>
            ) : null}
            {onOpenThread && threadLabel ? (
              <Pressable onPress={onOpenThread}><AppText style={styles.thread}>{threadLabel}</AppText></Pressable>
            ) : null}
          </View>
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  divider: { borderBottomColor: color.stone, borderBottomWidth: 2, marginBottom: 8, marginTop: 12 },
  dividerLabel: { ...fontSize.date, color: color.mutedStrong, fontWeight: "700", letterSpacing: 0.8, textAlign: "center", textTransform: "uppercase" },
  system: { ...fontSize.time, color: color.muted, fontFamily: "mono", paddingVertical: 6, textAlign: "center" },
  row: { flexDirection: "row", gap: 12, paddingHorizontal: 8, paddingVertical: 4 },
  mentioned: { backgroundColor: color.yellow },
  failed: { borderColor: color.red, borderWidth: 2 },
  avatar: { width: 36 },
  body: { flex: 1 },
  head: { alignItems: "baseline", flexDirection: "row", gap: 8 },
  name: { ...fontSize.sender, color: color.ink, fontWeight: "700" },
  time: { ...fontSize.time, color: color.muted, fontFamily: "mono" },
  attachment: { marginTop: 6 },
  thumb: { height: 120, width: 160 },
  file: { color: color.ink, fontSize: 13, marginTop: 2 },
  reactions: { color: color.ink, fontSize: 13, marginTop: 4 },
  pending: { color: color.muted, fontSize: 12, marginTop: 4 },
  retryRow: { flexDirection: "row", gap: 12, marginTop: 4 },
  retry: { color: color.red, fontWeight: "700" },
  thread: { color: color.cyan, fontSize: 13, fontWeight: "700", marginTop: 4 },
});
