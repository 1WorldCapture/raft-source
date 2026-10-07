import { useState } from "react";
import { Pressable, StyleSheet, View } from "react-native";
import { AtSign, BellOff, Check, Hash, MessageSquare, Pencil, RotateCcw } from "lucide-react-native";
import { useT } from "../i18n/provider";
import { StatusIcon } from "../tasks/TasksView";
import { HardShadow } from "../ui/shadow";
import { InlineRichText } from "../ui/richText";
import { AppText } from "../ui/text";
import { border, color, shadowOffset } from "../ui/tokens";
import {
  activityBadges,
  activityBodyPreview,
  activityIconKind,
  activityPrimaryText,
  activitySender,
  activityThreadTag,
  taskStatusFill,
  type ActivityBadge,
} from "./card";
import type { ActivityFilter, ActivityItem } from "./model";

export function ActivityCard({
  item,
  filter,
  names,
  hasDraft,
  onOpen,
  onDone,
  onLongPress,
  focused,
}: {
  item: ActivityItem;
  filter: ActivityFilter;
  names: Readonly<Record<string, string>>;
  hasDraft: boolean;
  onOpen: () => void;
  onDone: () => void;
  onLongPress?: (x: number, y: number) => void;
  focused?: boolean;
}) {
  const t = useT();
  const [pressed, setPressed] = useState(false);
  const unread = item.unreadCount > 0;
  const sender = activitySender(item, names);
  const senderLabel = sender.system ? t("thread.row.systemSender") : sender.name;
  const preview = activityBodyPreview(item);
  const tag = activityThreadTag(item);
  const iconKind = activityIconKind(item);
  const badges = activityBadges(item, filter, hasDraft);
  const restoring = filter === "done";
  const doneLabel = t(restoring ? "activity.current.restore" : "thread.row.markAsDone");

  const face = (
    <View style={[styles.card, pressed ? styles.cardPressed : null, focused ? styles.cardFocused : null]}>
      <Pressable
        accessibilityRole="button"
        delayLongPress={400}
        onLongPress={(event) => onLongPress?.(event.nativeEvent.pageX, event.nativeEvent.pageY)}
        onPress={onOpen}
        onPressIn={() => setPressed(true)}
        onPressOut={() => setPressed(false)}
      >
      {tag ? <AppText numberOfLines={1} style={styles.tag}>{tag}</AppText> : null}
      <View style={styles.titleRow}>
        <View style={styles.icon}>
          {iconKind === "thread" ? <MessageSquare color={color.muted} size={13} strokeWidth={2.5} /> : null}
          {iconKind === "dm" ? <AtSign color={color.muted} size={13} strokeWidth={2.5} /> : null}
          {iconKind === "channel" ? <Hash color={color.muted} size={13} strokeWidth={2.5} /> : null}
        </View>
        <InlineRichText
          content={activityPrimaryText(item)}
          fontSize={14}
          numberOfLines={2}
          style={[styles.primary, unread ? styles.primaryUnread : styles.primaryRead]}
        />
      </View>
      {senderLabel || preview ? (
        <AppText numberOfLines={2} style={[styles.body, unread ? styles.bodyUnread : styles.bodyRead]}>
          {senderLabel ? <AppText style={styles.sender}>{`${senderLabel}: `}</AppText> : null}
          {preview ? (
            <InlineRichText
              content={preview}
              fontSize={12}
              style={[styles.body, unread ? styles.bodyUnread : styles.bodyRead]}
            />
          ) : null}
        </AppText>
      ) : null}
      {badges.length > 0 ? (
        <View style={styles.badges}>
          {badges.map((badge) => <ActivityBadgeView badge={badge} key={badgeKey(badge)} />)}
        </View>
      ) : null}
      </Pressable>
      <View style={styles.doneSlot}>
        <Pressable
          accessibilityLabel={doneLabel}
          accessibilityRole="button"
          hitSlop={6}
          onPress={onDone}
        >
          <HardShadow offset={shadowOffset.sm}>
            <View style={styles.done}>
              {restoring
                ? <RotateCcw color={color.ink} size={14} strokeWidth={2.5} />
                : <Check color={color.ink} size={14} strokeWidth={2.5} />}
            </View>
          </HardShadow>
        </Pressable>
      </View>
    </View>
  );

  if (!pressed && !focused) return face;
  return <HardShadow offset={focused ? shadowOffset.md : shadowOffset.sm}>{face}</HardShadow>;
}

function ActivityBadgeView({ badge }: { badge: ActivityBadge }) {
  const t = useT();
  if (badge.kind === "task") {
    return (
      <View style={[styles.badge, { backgroundColor: taskStatusFill(badge.status) }]}>
        <StatusIcon size={10} status={badge.status} />
        <AppText style={styles.badgeText}>{badge.text}</AppText>
      </View>
    );
  }
  if (badge.kind === "replies") {
    return (
      <View style={[styles.badge, styles.badgeOutline]}>
        <AppText style={styles.badgeText}>{t("thread.row.replies", { count: badge.count })}</AppText>
      </View>
    );
  }
  if (badge.kind === "unfollowed") {
    return (
      <View style={[styles.badge, styles.badgeOutline]}>
        <BellOff color={color.ink} size={10} strokeWidth={2.5} />
        <AppText style={styles.badgeText}>{t("thread.row.unfollowed")}</AppText>
      </View>
    );
  }
  if (badge.kind === "mention") {
    return (
      <View style={[styles.badge, styles.badgeMention]}>
        <AtSign color={color.ink} size={10} strokeWidth={2.5} />
        <AppText style={styles.badgeText}>{t("thread.row.mentionBadgeLabel")}</AppText>
      </View>
    );
  }
  if (badge.kind === "unread") {
    return (
      <View style={[styles.badge, styles.badgeUnread]}>
        <AppText style={styles.badgeText}>{t("thread.row.unreadCount", { count: badge.count })}</AppText>
      </View>
    );
  }
  return (
    <View accessibilityLabel={t("thread.row.draftTitle")} style={[styles.badge, styles.badgeOutline]}>
      <Pencil color={color.ink} size={12} strokeWidth={2.5} />
    </View>
  );
}

function badgeKey(badge: ActivityBadge): string {
  if (badge.kind === "task") return `task:${badge.text}`;
  if (badge.kind === "replies" || badge.kind === "unread") return `${badge.kind}:${badge.count}`;
  return badge.kind;
}

export function ActivitySkeleton() {
  return (
    <View style={styles.skeleton}>
      <View style={[styles.bone, styles.boneShort]} />
      <View style={[styles.bone, styles.boneLong]} />
      <View style={[styles.bone, styles.boneMid]} />
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    backgroundColor: color.page,
    borderColor: color.borderSoft,
    borderWidth: border.strong,
    padding: 12,
  },
  cardPressed: { borderColor: color.border },
  cardFocused: { backgroundColor: color.cyanHighlight, borderColor: color.border },
  tag: { color: color.muted, fontSize: 11, fontWeight: "700", lineHeight: 14, marginBottom: 2, marginRight: 40 },
  titleRow: { alignItems: "flex-start", flexDirection: "row", marginBottom: 2, marginRight: 40 },
  icon: { marginRight: 6, marginTop: 3 },
  primary: { flex: 1, fontSize: 14, lineHeight: 20 },
  primaryUnread: { color: color.ink, fontWeight: "700" },
  primaryRead: { color: color.inkSoft, fontWeight: "600" },
  body: { fontSize: 12, lineHeight: 16 },
  bodyUnread: { color: color.ink },
  bodyRead: { color: color.inkSoft },
  sender: { color: color.inkLabel, fontWeight: "700" },
  badges: { flexDirection: "row", flexWrap: "wrap", gap: 6, marginTop: 4, minHeight: 20 },
  badge: {
    alignItems: "center",
    borderColor: color.border,
    borderWidth: border.hairline,
    flexDirection: "row",
    gap: 2,
    height: 20,
    paddingHorizontal: 6,
  },
  badgeOutline: { backgroundColor: color.page },
  badgeMention: { backgroundColor: color.yellow },
  badgeUnread: { backgroundColor: color.pink },
  badgeText: { color: color.ink, fontSize: 10, fontWeight: "700", lineHeight: 12 },
  doneSlot: { position: "absolute", right: 12, top: 12 },
  done: {
    alignItems: "center",
    backgroundColor: color.page,
    borderColor: color.border,
    borderWidth: border.strong,
    height: 30,
    justifyContent: "center",
    width: 30,
  },
  skeleton: {
    backgroundColor: color.page,
    borderColor: color.borderSoft,
    borderWidth: border.strong,
    gap: 8,
    padding: 12,
  },
  bone: { backgroundColor: color.mutedFill, height: 12 },
  boneShort: { width: "36%" },
  boneLong: { height: 14, width: "78%" },
  boneMid: { width: "62%" },
});
