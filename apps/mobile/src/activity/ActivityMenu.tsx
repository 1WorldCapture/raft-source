import type { ReactNode } from "react";
import { Modal, Pressable, StyleSheet, useWindowDimensions, View } from "react-native";
import { Bell, BellOff, Check, MessageSquare } from "lucide-react-native";
import { HardShadow } from "../ui/shadow";
import { AppText } from "../ui/text";
import { border, color, shadowOffset } from "../ui/tokens";
import type { ActivityMenuAction } from "./card";

const GUARD_MS = 600;
const MENU_WIDTH = 200;

export function ActivityMenu({
  x,
  y,
  openedAt,
  actions,
  labels,
  onClose,
  onAction,
}: {
  x: number;
  y: number;
  openedAt: number;
  actions: readonly ActivityMenuAction[];
  labels: Record<ActivityMenuAction, string>;
  onClose: () => void;
  onAction: (action: ActivityMenuAction) => void;
}) {
  const { width, height } = useWindowDimensions();
  const left = Math.max(8, Math.min(x, width - MENU_WIDTH - 12));
  const top = Math.max(8, Math.min(y, height - 48 - actions.length * 40));
  function press(action: ActivityMenuAction) {
    if (Date.now() - openedAt < GUARD_MS) return;
    onAction(action);
  }
  return (
    <Modal animationType="fade" onRequestClose={onClose} transparent visible>
      <Pressable onPress={onClose} style={styles.scrim}>
        <Pressable onPress={() => undefined} style={[styles.anchor, { left, top }]}>
          <HardShadow offset={shadowOffset.md}>
            <View style={styles.menu}>
              {actions.map((action) => (
                <Item key={action} icon={iconFor(action)} label={labels[action]} onPress={() => press(action)} />
              ))}
            </View>
          </HardShadow>
        </Pressable>
      </Pressable>
    </Modal>
  );
}

function iconFor(action: ActivityMenuAction): ReactNode {
  if (action === "done") return <Check color={color.ink} size={16} strokeWidth={2.5} />;
  if (action === "follow") return <Bell color={color.ink} size={16} strokeWidth={2.5} />;
  if (action === "unfollow") return <BellOff color={color.ink} size={16} strokeWidth={2.5} />;
  return <MessageSquare color={color.ink} size={16} strokeWidth={2.5} />;
}

function Item({ icon, label, onPress }: { icon: ReactNode; label: string; onPress: () => void }) {
  return (
    <Pressable onPress={onPress} style={({ pressed }) => [styles.item, pressed ? styles.itemPressed : null]}>
      {icon}
      <AppText numberOfLines={1} style={styles.itemText}>{label}</AppText>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  scrim: { flex: 1 },
  anchor: { position: "absolute", width: MENU_WIDTH + shadowOffset.md },
  menu: { backgroundColor: color.white, borderColor: color.border, borderWidth: border.strong, width: MENU_WIDTH },
  item: { alignItems: "center", flexDirection: "row", gap: 10, paddingHorizontal: 12, paddingVertical: 9 },
  itemPressed: { backgroundColor: color.mutedFill },
  itemText: { color: color.ink, flex: 1, fontSize: 14, fontWeight: "500", lineHeight: 20 },
});
