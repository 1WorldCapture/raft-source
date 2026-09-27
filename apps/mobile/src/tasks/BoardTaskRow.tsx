import { useRef } from "react";
import { StyleSheet, View } from "react-native";
import { useIntl } from "react-intl";
import { useT } from "../i18n/provider";
import { Avatar } from "../ui/Avatar";
import { Badge } from "../ui/Badge";
import { HardShadow } from "../ui/shadow";
import { AppText } from "../ui/text";
import { border, color, shadowOffset } from "../ui/tokens";
import type { BoardRow } from "./board";
import { boardSummaryLine } from "./boardSummary";
import { channelLabel } from "./list";

/** Live presence for the claimed agent, resolved from /agents by the screen. */
export interface BoardAssigneeInfo {
  avatarUrl: string | null;
  status: "online" | "busy" | "error" | "offline";
}

// A progress-board row (task #2). Named BoardTaskRow, not BoardRow, to avoid
// clashing with the BoardRow data type from board.ts when both are imported
// into the tasks screen.
export function BoardTaskRow({
  row,
  assignee,
  onPress,
}: {
  row: BoardRow;
  assignee?: BoardAssigneeInfo | null;
  onPress?: () => void;
}) {
  const t = useT();
  const { locale } = useIntl();
  const { task, stale } = row;
  const touch = useRef({ x: 0, y: 0 });
  const summary = boardSummaryLine(task.latestActivity, task.createdAt, locale, {
    updatedTask: t("mobile.board.row.updatedTask"),
    createdAgo: (time) => t("mobile.board.row.createdAgo", { time }),
    systemActor: t("mobile.board.row.system"),
  });
  const claimedKind = task.claimedByType === "agent" ? "agent" : task.claimedByType === "user" ? "human" : null;
  const claimerName = task.claimedByName ?? t("mobile.board.row.unclaimed");
  return (
    <HardShadow offset={shadowOffset.sm}>
      <View style={styles.card}>
        <View
          onTouchEnd={(event) => {
            // Same tap-vs-drag guard as TaskCardView so a future inline action
            // (the approve button) can sit inside the row without hijacking taps.
            const dx = Math.abs(event.nativeEvent.pageX - touch.current.x);
            const dy = Math.abs(event.nativeEvent.pageY - touch.current.y);
            if (dx < 8 && dy < 8) onPress?.();
          }}
          onTouchStart={(event) => {
            touch.current = { x: event.nativeEvent.pageX, y: event.nativeEvent.pageY };
          }}
        >
          <View style={styles.metaRow}>
            {claimedKind ? (
              <Avatar
                avatarUrl={claimedKind === "agent" ? assignee?.avatarUrl : null}
                kind={claimedKind}
                name={claimerName}
                size={24}
                status={claimedKind === "agent" ? assignee?.status : undefined}
              />
            ) : null}
            <AppText numberOfLines={1} style={styles.claimer}>{claimerName}</AppText>
            <View style={styles.spacer} />
            {task.unreadCount > 0 ? <Badge count={task.unreadCount} /> : null}
            <AppText numberOfLines={1} style={styles.channel}>{channelLabel(task.channelName)}</AppText>
            <AppText style={styles.number}>{`#${task.taskNumber}`}</AppText>
          </View>
          <AppText numberOfLines={2} style={styles.title}>{task.title}</AppText>
          {summary ? <AppText numberOfLines={1} style={styles.summary}>{summary}</AppText> : null}
          {stale ? (
            <View style={styles.staleTag}>
              <AppText style={styles.staleTagText}>{t("mobile.board.row.mayBeStuck")}</AppText>
            </View>
          ) : null}
        </View>
      </View>
    </HardShadow>
  );
}

const styles = StyleSheet.create({
  card: { backgroundColor: color.page, borderColor: color.border, borderWidth: border.strong, paddingHorizontal: 12, paddingVertical: 10 },
  metaRow: { alignItems: "center", flexDirection: "row", gap: 8 },
  claimer: { color: color.ink, flexShrink: 1, fontSize: 12, fontWeight: "700", lineHeight: 16 },
  spacer: { flexShrink: 0, flexGrow: 1 },
  channel: { color: color.inkMid, fontSize: 12, fontWeight: "700", lineHeight: 16 },
  number: { color: color.inkFaint, fontFamily: "mono", fontSize: 11, lineHeight: 14 },
  title: { color: color.ink, fontSize: 14, fontWeight: "700", lineHeight: 20, marginTop: 6, paddingRight: 8 },
  summary: { color: color.inkLabel, fontSize: 12, lineHeight: 16, marginTop: 2 },
  staleTag: {
    alignSelf: "flex-start",
    backgroundColor: color.orangeSoft,
    borderColor: color.orange,
    borderWidth: border.hairline,
    marginTop: 6,
    paddingHorizontal: 6,
    paddingVertical: 2,
  },
  staleTagText: { color: color.ink, fontSize: 10, fontWeight: "700", lineHeight: 12, textTransform: "uppercase" },
});
