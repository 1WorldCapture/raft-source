import { Modal, Pressable, StyleSheet, useWindowDimensions, View } from "react-native";
import { AppText } from "../ui/text";
import { color } from "../ui/tokens";
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
  const left = Math.max(8, Math.min(x, width - 208));
  const top = Math.max(8, Math.min(y, height - (reactionsOnly ? 56 : 320)));
  function press(action: () => void) {
    if (Date.now() - openedAt < GUARD_MS) return;
    action();
  }
  return (
    <Modal animationType="fade" onRequestClose={onClose} transparent visible>
      <Pressable onPress={onClose} style={styles.scrim}>
        <Pressable onPress={() => undefined} style={[styles.menu, { left, top }]}>
          <View style={styles.reactions}>
            {QUICK_REACTIONS.map((emoji) => (
              <Pressable key={emoji} onPress={() => press(() => onReact(emoji))} style={styles.emoji}>
                <AppText style={styles.emojiText}>{emoji}</AppText>
              </Pressable>
            ))}
          </View>
          {reactionsOnly ? null : (
            <View>
              <Item label={labels.link} onPress={() => press(onCopyLink)} />
              <Item label={labels.copy} onPress={() => press(onCopy)} />
              {onThread ? <Item label={labels.thread} onPress={() => press(onThread)} /> : null}
              <Item label={saved ? labels.unsave : labels.save} onPress={() => press(onSave)} />
              {onFollow ? <Item label={following ? labels.unfollow : labels.follow} onPress={() => press(onFollow)} /> : null}
              {taskLabel ? <Item label={taskLabel} onPress={() => press(onTask)} /> : null}
            </View>
          )}
        </Pressable>
      </Pressable>
    </Modal>
  );
}

function Item({ label, onPress }: { label: string; onPress: () => void }) {
  return (
    <Pressable onPress={onPress} style={styles.item}>
      <AppText style={styles.itemText}>{label}</AppText>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  scrim: { flex: 1 },
  menu: { backgroundColor: color.white, borderColor: color.border, borderWidth: 2, position: "absolute", width: 200 },
  reactions: { flexDirection: "row", flexWrap: "wrap", gap: 4, padding: 8 },
  emoji: { alignItems: "center", height: 32, justifyContent: "center", width: 32 },
  emojiText: { fontSize: 18 },
  item: { paddingHorizontal: 12, paddingVertical: 10 },
  itemText: { color: color.ink, fontSize: 14, fontWeight: "700" },
});
