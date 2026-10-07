import type { ReactNode } from "react";
import { Modal, Pressable, StyleSheet, useWindowDimensions, View } from "react-native";
import { Bookmark, BookmarkMinus, CirclePlus, CircleMinus, ClipboardCheck, Copy, Link, MessageSquare } from "lucide-react-native";
import { HardShadow } from "../ui/shadow";
import { AppText } from "../ui/text";
import { border, color, shadowOffset } from "../ui/tokens";
import { QUICK_REACTIONS } from "./reactions";

const GUARD_MS = 600;

export function MessageMenu({
  x,
  y,
  openedAt,
  reactionsOnly,
  saved,
  following,
  taskLabel,
  labels,
  onClose,
  onReact,
  onCopy,
  onCopyLink,
  onThread,
  onSave,
  onFollow,
  onTask,
}: {
  x: number;
  y: number;
  openedAt: number;
  reactionsOnly?: boolean;
  saved: boolean;
  following: boolean;
  taskLabel: string | null;
  labels: {
    copy: string;
    link: string;
    thread: string;
    save: string;
    unsave: string;
    follow: string;
    unfollow: string;
  };
  onClose: () => void;
  onReact: (emoji: string) => void;
  onCopy: () => void;
  onCopyLink: () => void;
  onThread?: () => void;
  onSave: () => void;
  onFollow?: () => void;
  onTask: () => void;
}) {
  const { width, height } = useWindowDimensions();
  const left = Math.max(8, Math.min(x, width - MENU_WIDTH - 12));
  const top = Math.max(8, Math.min(y, height - (reactionsOnly ? 64 : 360)));
  function press(action: () => void) {
    if (Date.now() - openedAt < GUARD_MS) return;
    action();
  }
  return (
    <Modal animationType="fade" onRequestClose={onClose} transparent visible>
      <Pressable onPress={onClose} style={styles.scrim}>
        <Pressable onPress={() => undefined} style={[styles.anchor, { left, top }]}>
          <HardShadow offset={shadowOffset.md}>
          <View style={styles.menu}>
          <View style={styles.reactions}>
            {QUICK_REACTIONS.map((emoji) => (
              <Pressable key={emoji} onPress={() => press(() => onReact(emoji))} style={styles.emoji}>
                <AppText style={styles.emojiText}>{emoji}</AppText>
              </Pressable>
            ))}
          </View>
          {reactionsOnly ? null : (
            <View>
              <View style={styles.group}>
                <Item icon={<Link color={color.ink} size={16} />} label={labels.link} onPress={() => press(onCopyLink)} />
                <Item icon={<Copy color={color.ink} size={16} />} label={labels.copy} onPress={() => press(onCopy)} />
              </View>
              <View style={styles.group}>
                {onThread ? <Item icon={<MessageSquare color={color.ink} size={16} />} label={labels.thread} onPress={() => press(onThread)} /> : null}
                <Item icon={saved ? <BookmarkMinus color={color.ink} size={16} /> : <Bookmark color={color.ink} size={16} />} label={saved ? labels.unsave : labels.save} onPress={() => press(onSave)} />
                {onFollow ? <Item icon={following ? <CircleMinus color={color.ink} size={16} /> : <CirclePlus color={color.ink} size={16} />} label={following ? labels.unfollow : labels.follow} onPress={() => press(onFollow)} /> : null}
              </View>
              {taskLabel ? (
                <View style={styles.group}>
                  <Item icon={<ClipboardCheck color={color.ink} size={16} />} label={taskLabel} onPress={() => press(onTask)} />
                </View>
              ) : null}
            </View>
          )}
          </View>
          </HardShadow>
        </Pressable>
      </Pressable>
    </Modal>
  );
}

function Item({ icon, label, onPress }: { icon: ReactNode; label: string; onPress: () => void }) {
  return (
    <Pressable onPress={onPress} style={({ pressed }) => [styles.item, pressed ? styles.itemPressed : null]}>
      {icon}
      <AppText numberOfLines={1} style={styles.itemText}>{label}</AppText>
    </Pressable>
  );
}

/** Web context menu: 2px black border, 4px hard shadow, groups split by 2px rules. */
const MENU_WIDTH = 236;

const styles = StyleSheet.create({
  scrim: { flex: 1 },
  anchor: { position: "absolute", width: MENU_WIDTH + shadowOffset.md },
  menu: { backgroundColor: color.white, borderColor: color.border, borderWidth: border.strong, width: MENU_WIDTH },
  reactions: { flexDirection: "row", justifyContent: "space-between", paddingHorizontal: 6, paddingVertical: 6 },
  emoji: { alignItems: "center", height: 30, justifyContent: "center", width: 30 },
  emojiText: { fontSize: 18, lineHeight: 24 },
  group: { borderTopColor: color.border, borderTopWidth: border.strong, paddingVertical: 2 },
  item: { alignItems: "center", flexDirection: "row", gap: 10, paddingHorizontal: 12, paddingVertical: 9 },
  itemPressed: { backgroundColor: color.mutedFill },
  itemText: { color: color.ink, flex: 1, fontSize: 14, fontWeight: "500", lineHeight: 20 },
});
