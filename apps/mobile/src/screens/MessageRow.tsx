import { memo, useState } from "react";
import { Image, Pressable, StyleSheet, View } from "react-native";
import type { MessageAttachment, RaftMessage, ThreadReplyPreview } from "../model/messages";
import { senderLabel } from "../model/messages";
import { Avatar } from "../ui/Avatar";
import { AppText } from "../ui/text";
import { RichText } from "../ui/richText";
import { color, fontSize, radius } from "../ui/tokens";
import type { MessageGroupState } from "./messageGrouping";
import { agentHasRead, type PeerRead } from "./readReceipt";

export interface LinkedTaskChip {
  taskNumber: number;
  claimedByName?: string | null;
  status?: string;
}

const COLLAPSE_AT = 320;

/** Shared message row. Task #14 adds press and long-press on top of this layout. */
export const MessageRow = memo(function MessageRow({
  message,
  group,
  timeLabel,
  dayLabel,
  bodyFontSize,
  bodyLineHeight,
  currentUserId,
  peers,
  collapseLong,
  systemCount,
  systemOpen,
  systemSummary,
  saved,
  linkedTask,
  threadCountLabel,
  threadReplies,
  showDmRead,
  subtitle,
  sendingLabel,
  resendLabel,
  deleteLabel,
  showMoreLabel,
  collapseLabel,
  savedLabel,
  readLabel,
  onOpenThread,
  onResend,
  onDelete,
  onToggleSystem,
  onOpenAttachment,
  replyTime,
}: {
  message: RaftMessage;
  group: MessageGroupState;
  timeLabel: string;
  dayLabel: string;
  bodyFontSize: number;
  bodyLineHeight: number;
  currentUserId?: string;
  peers: readonly PeerRead[];
  collapseLong: boolean;
  systemCount?: number;
  systemOpen?: boolean;
  systemSummary?: string;
  saved?: boolean;
  linkedTask?: LinkedTaskChip | null;
  threadCountLabel?: string;
  threadReplies?: ThreadReplyPreview[];
  showDmRead?: boolean;
  subtitle?: string | null;
  sendingLabel: string;
  resendLabel: string;
  deleteLabel: string;
  showMoreLabel: string;
  collapseLabel: string;
  savedLabel: string;
  readLabel: string;
  onOpenThread?: (messageId: string) => void;
  onResend?: (messageId: string) => void;
  onDelete?: (messageId: string) => void;
  onToggleSystem?: (messageId: string) => void;
  onOpenAttachment?: (attachment: MessageAttachment, disposition: "inline" | "attachment") => void;
  replyTime?: (createdAt: string) => string;
}) {
  const [tall, setTall] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const system = message.messageType === "system";
  const images = (message.attachments ?? []).filter(isImage);
  const files = (message.attachments ?? []).filter((attachment) => !isImage(attachment));
  const collapsed = collapseLong && tall && !expanded;
  const ownMessage = Boolean(currentUserId && message.senderId === currentUserId && message.senderType === "user");
  return (
    <View>
      {group.showDayDivider && dayLabel ? (
        <View style={styles.divider}>
          <AppText style={styles.dividerLabel}>{dayLabel}</AppText>
        </View>
      ) : null}
      {system ? (
        systemCount && systemCount > 1 && !systemOpen ? (
          <Pressable onPress={() => onToggleSystem?.(message.id)}>
            <AppText style={styles.system}>{systemSummary ?? `${systemCount}`}</AppText>
          </Pressable>
        ) : (
          <AppText style={styles.system}>{timeLabel ? `${timeLabel} ${message.content}` : message.content}</AppText>
        )
      ) : (
        <View style={[styles.row, message.pending === "failed" ? styles.failed : null]}>
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
              <View>
                <View style={styles.head}>
                  <AppText style={styles.name}>{senderLabel(message)}</AppText>
                  {timeLabel ? <AppText style={styles.time}>{timeLabel}</AppText> : null}
                </View>
                {subtitle ? <AppText style={styles.subtitle}>{subtitle}</AppText> : null}
              </View>
            ) : null}
            <View
              onLayout={(event) => {
                if (event.nativeEvent.layout.height > COLLAPSE_AT) setTall(true);
              }}
              style={collapsed ? styles.clipped : undefined}
            >
              <RichText
                agentRead={(agentId) => ownMessage ? agentHasRead(peers, agentId, message.seq) : null}
                content={message.content}
                currentUserId={currentUserId}
                fontSize={bodyFontSize}
                lineHeight={bodyLineHeight}
                mentions={message.mentions}
              />
            </View>
            {tall && collapseLong ? (
              <Pressable onPress={() => setExpanded((open) => !open)}>
                <AppText style={styles.more}>{expanded ? collapseLabel : showMoreLabel}</AppText>
              </Pressable>
            ) : null}
            {images.length > 0 ? (
              <View style={styles.grid}>
                {images.map((attachment) => (
                  <Pressable key={attachment.id ?? attachment.filename} onPress={() => onOpenAttachment?.(attachment, "inline")}>
                    {attachment.thumbnailUrl ? (
                      <Image source={{ uri: attachment.thumbnailUrl }} style={styles.thumb} />
                    ) : (
                      <View style={[styles.thumb, styles.fileCard]}><AppText numberOfLines={2} style={styles.file}>{attachment.filename}</AppText></View>
                    )}
                  </Pressable>
                ))}
              </View>
            ) : null}
            {files.map((attachment) => (
              <Pressable key={attachment.id ?? attachment.filename} onPress={() => onOpenAttachment?.(attachment, "attachment")} style={styles.fileCard}>
                <AppText style={styles.file}>{attachment.filename}</AppText>
                {attachment.sizeBytes ? <AppText style={styles.fileMeta}>{formatFileSize(attachment.sizeBytes)}</AppText> : null}
              </Pressable>
            ))}
            <View style={styles.footer}>
              {linkedTask ? (
                <View style={[styles.capsule, styles.taskChip]}>
                  <AppText style={styles.capsuleText}>{linkedTask.claimedByName ? `task #${linkedTask.taskNumber} @${linkedTask.claimedByName}` : `task #${linkedTask.taskNumber}`}</AppText>
                </View>
              ) : null}
              {saved ? (
                <View style={[styles.capsule, styles.saved]}>
                  <AppText style={styles.capsuleText}>{savedLabel}</AppText>
                </View>
              ) : null}
              {message.reactions?.map((reaction) => {
                const mine = reaction.reactedByMe || Boolean(currentUserId && reaction.userIds?.includes(currentUserId));
                return (
                  <View key={reaction.emoji} style={[styles.capsule, mine ? styles.mine : styles.reaction]}>
                    <AppText style={styles.capsuleText}>{`${reaction.emoji} ${reaction.count}`}</AppText>
                  </View>
                );
              })}
              {showDmRead ? <AppText style={styles.read}>{readLabel}</AppText> : null}
            </View>
            {onOpenThread && threadCountLabel ? (
              <Pressable onPress={() => onOpenThread?.(message.id)} style={styles.preview}>
                <AppText style={styles.previewCount}>{threadCountLabel}</AppText>
                {threadReplies?.map((reply) => (
                  <View key={reply.messageId} style={styles.previewRow}>
                    <Avatar
                      avatarUrl={reply.senderAvatarUrl}
                      kind={reply.senderType === "agent" ? "agent" : "human"}
                      name={reply.senderDisplayName || reply.senderName}
                      size={16}
                    />
                    <AppText numberOfLines={1} style={styles.previewName}>{reply.senderDisplayName || reply.senderName}</AppText>
                    <AppText numberOfLines={1} style={styles.previewBody}>{reply.preview}</AppText>
                    {reply.createdAt && replyTime ? <AppText style={styles.previewTime}>{replyTime(reply.createdAt)}</AppText> : null}
                  </View>
                ))}
              </Pressable>
            ) : null}
            {message.pending === "sending" ? <AppText style={styles.pending}>{sendingLabel}</AppText> : null}
            {message.pending === "failed" ? (
              <View style={styles.retryRow}>
                <Pressable onPress={() => onResend?.(message.id)}><AppText style={styles.retry}>{resendLabel}</AppText></Pressable>
                <Pressable onPress={() => onDelete?.(message.id)}><AppText style={styles.retry}>{deleteLabel}</AppText></Pressable>
              </View>
            ) : null}
          </View>
        </View>
      )}
    </View>
  );
});

function isImage(attachment: MessageAttachment): boolean {
  if (attachment.mimeType?.toLowerCase().startsWith("image/")) return true;
  return !attachment.mimeType && Boolean(attachment.thumbnailUrl);
}

function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 102.4) / 10} KB`;
  return `${Math.round(bytes / (1024 * 102.4)) / 10} MB`;
}

const styles = StyleSheet.create({
  divider: { borderBottomColor: color.stone, borderBottomWidth: 2, marginBottom: 8, marginTop: 12 },
  dividerLabel: { ...fontSize.date, color: color.mutedStrong, fontWeight: "700", letterSpacing: 0.8, textAlign: "center", textTransform: "uppercase" },
  system: { ...fontSize.time, color: color.muted, fontFamily: "mono", paddingVertical: 6, textAlign: "center" },
  row: { flexDirection: "row", gap: 12, paddingHorizontal: 8, paddingVertical: 4 },
  failed: { borderColor: color.red, borderWidth: 2 },
  avatar: { width: 36 },
  body: { flex: 1, minWidth: 0 },
  head: { alignItems: "baseline", flexDirection: "row", gap: 8 },
  name: { ...fontSize.sender, color: color.ink, fontWeight: "700" },
  subtitle: { color: color.muted, fontSize: 12, marginBottom: 2 },
  time: { ...fontSize.time, color: color.muted, fontFamily: "mono" },
  clipped: { maxHeight: COLLAPSE_AT, overflow: "hidden" },
  more: { color: color.link, fontSize: 13, fontWeight: "700", marginTop: 4 },
  grid: { flexDirection: "row", flexWrap: "wrap", gap: 4, marginTop: 6 },
  thumb: { height: 120, width: 120 },
  fileCard: { borderColor: color.border, borderWidth: 2, marginTop: 6, paddingHorizontal: 8, paddingVertical: 6 },
  file: { color: color.ink, fontSize: 13, fontWeight: "700" },
  fileMeta: { color: color.muted, fontSize: 12 },
  footer: { alignItems: "center", flexDirection: "row", flexWrap: "wrap", gap: 6, marginTop: 6 },
  capsule: { alignItems: "center", borderRadius: radius.chip, height: 20, justifyContent: "center", paddingHorizontal: 6 },
  capsuleText: { color: color.ink, fontSize: 12, fontWeight: "700" },
  taskChip: { backgroundColor: color.yellowSoft, borderColor: color.border, borderWidth: 1 },
  saved: { backgroundColor: color.orangeSoft, borderColor: color.border, borderWidth: 1 },
  reaction: { backgroundColor: color.previewSurface },
  mine: { backgroundColor: color.pinkSoft },
  read: { ...fontSize.badge, color: color.muted, fontWeight: "700", marginLeft: "auto" },
  preview: { backgroundColor: color.previewSurface, marginTop: 6, paddingHorizontal: 10, paddingVertical: 8 },
  previewCount: { color: color.mutedStrong, fontSize: 12.5, fontWeight: "700" },
  previewRow: { alignItems: "center", flexDirection: "row", gap: 6, marginTop: 4 },
  previewName: { color: color.mutedStrong, flexShrink: 1, fontSize: 12.5, fontWeight: "700", maxWidth: 96 },
  previewBody: { color: color.muted, flex: 1, fontSize: 12.5 },
  previewTime: { color: color.muted, fontSize: 11.5 },
  pending: { color: color.muted, fontSize: 12, marginTop: 4 },
  retryRow: { flexDirection: "row", gap: 12, marginTop: 4 },
  retry: { color: color.red, fontWeight: "700" },
});
