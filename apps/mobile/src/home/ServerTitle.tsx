import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Modal, Pressable, ScrollView, StyleSheet, View, type LayoutChangeEvent } from "react-native";
import { Gesture, GestureDetector, GestureHandlerRootView } from "react-native-gesture-handler";
import { Check, ChevronDown } from "lucide-react-native";
import * as Haptics from "expo-haptics";
import { useT } from "../i18n/provider";
import type { RaftServer } from "../model/messages";
import { useSession } from "../state/session";
import { AppText } from "../ui/text";
import { border, color } from "../ui/tokens";
import { clampDragDelta, DRAG_ACTIVATE_MS, moveServerIds, nearestSlotIndex } from "./serverDrag";
import { buildServerMenu, type ServerMenuItem } from "./serverMenu";
import { useServerRailStore } from "./serverRailStore";
import { useServerRail } from "./useServerRail";

/**
 * Header title for the three tab roots (replaces the left server rail): the
 * current server's name with a ▾ that opens a list from the top. Tapping a
 * server switches to it through the same `switchServer` the rail used
 * (closes the PM picker, clears the old PM state). A long press drags a row
 * to a new place; releasing saves that order through the same store the rail
 * used, and the drag does not switch servers. With a single server there
 * is no ▾ and the title is not tappable. A small dot next to ▾ says another
 * server has unread.
 */
export function ServerTitle({ subtitle, menuTop }: { subtitle?: string; menuTop: number }) {
  const t = useT();
  const session = useSession();
  const { servers, serverUnread, current, switchServer, loadServers } = useServerRail();
  const [open, setOpen] = useState(false);
  const [drag, setDrag] = useState<Drag | null>(null);
  const dragRef = useRef<Drag | null>(null);
  const slotLayouts = useRef<Record<string, { y: number; height: number }>>({});
  const skipPress = useRef(false);
  const displayServers = drag ? drag.order : servers;
  const menu = buildServerMenu(displayServers, session.serverId, serverUnread);

  // A tab opened before home has loaded (deep link, restored tab) still needs
  // the server list.
  useEffect(() => {
    if (!session.ready || !session.origin || servers.length > 0) return;
    void loadServers(session.client, session.serverId).catch(() => {});
  }, [loadServers, servers.length, session.client, session.origin, session.ready, session.serverId]);

  // The list can shrink to one server while open.
  useEffect(() => {
    if (!menu.switchable) setOpen(false);
  }, [menu.switchable]);

  const beginDrag = useCallback((id: string) => {
    skipPress.current = true;
    const next = { id, order: servers, dy: 0, startY: slotLayouts.current[id]?.y ?? 0 };
    dragRef.current = next;
    setDrag(next);
    void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium).catch(() => {});
  }, [servers]);

  const moveDrag = useCallback((id: string, rawDy: number) => {
    setDrag((currentDrag) => {
      if (!currentDrag || currentDrag.id !== id) return currentDrag;
      const tops = currentDrag.order
        .map((server) => slotLayouts.current[server.id]?.y)
        .filter((y): y is number => y !== undefined);
      const dy = clampDragDelta(currentDrag.startY, rawDy, tops);
      const from = currentDrag.order.findIndex((server) => server.id === id);
      const layout = slotLayouts.current[id];
      const measured = currentDrag.order.flatMap((server, index) => {
        const slot = slotLayouts.current[server.id];
        return slot ? [{ index, y: slot.y, height: slot.height }] : [];
      });
      const picked = layout ? nearestSlotIndex(measured, currentDrag.startY + layout.height / 2 + dy) : -1;
      const to = picked < 0 ? from : measured[picked]?.index ?? from;
      if (to < 0 || to === from) {
        const next = { ...currentDrag, dy };
        dragRef.current = next;
        return next;
      }
      const orderIds = moveServerIds(currentDrag.order.map((server) => server.id), from, to);
      const byId = new Map(currentDrag.order.map((server) => [server.id, server]));
      const order = orderIds.flatMap((serverId) => {
        const server = byId.get(serverId);
        return server ? [server] : [];
      });
      void Haptics.selectionAsync().catch(() => {});
      const next = { ...currentDrag, dy, order };
      dragRef.current = next;
      return next;
    });
  }, []);

  const endDrag = useCallback(() => {
    const currentDrag = dragRef.current;
    dragRef.current = null;
    setDrag(null);
    if (currentDrag) {
      const originalIds = servers.map((server) => server.id);
      const finalIds = currentDrag.order.map((server) => server.id);
      if (finalIds.join("\n") !== originalIds.join("\n")) {
        void useServerRailStore.getState().reorderServers(session.client, finalIds);
      }
    }
    // A long-press release can still emit the row's press. Ignore that press,
    // then allow the next short tap to switch servers.
    setTimeout(() => {
      skipPress.current = false;
    }, 300);
  }, [servers, session.client]);

  const selectServer = useCallback((id: string) => {
    if (skipPress.current) return;
    setOpen(false);
    const server = servers.find((candidate) => candidate.id === id);
    if (server) void switchServer(server);
  }, [servers, switchServer]);

  const name = current?.name || t("mobile.servers.title");
  const title = (
    <View style={styles.titleRow}>
      <AppText numberOfLines={1} style={styles.title}>{name}</AppText>
      {menu.switchable ? <ChevronDown color={color.ink} size={18} /> : null}
      {menu.switchable && menu.otherUnread ? <View style={styles.dot} /> : null}
    </View>
  );

  return (
    <View style={styles.container}>
      {menu.switchable ? (
        <Pressable accessibilityLabel={t("mobile.servers.switch")} accessibilityRole="button" onPress={() => setOpen(true)} style={styles.press}>
          {title}
        </Pressable>
      ) : title}
      {subtitle ? <AppText numberOfLines={1} style={styles.subtitle}>{subtitle}</AppText> : null}
      <Modal animationType="fade" onRequestClose={() => setOpen(false)} statusBarTranslucent transparent visible={open}>
        <GestureHandlerRootView style={styles.modalRoot}>
        <Pressable accessibilityLabel={t("search.back")} onPress={() => setOpen(false)} style={styles.scrim} />
        <View pointerEvents="box-none" style={[styles.sheetWrap, { top: menuTop }]}>
          <View style={styles.panel}>
            <ScrollView bounces={false} scrollEnabled={drag === null} style={styles.list}>
              {menu.items.map((item) => (
                <ServerRow
                  key={item.id}
                  dragDy={drag?.id === item.id
                    ? drag.startY + drag.dy - (slotLayouts.current[item.id]?.y ?? drag.startY)
                    : 0}
                  dragging={drag?.id === item.id}
                  item={item}
                  onBeginDrag={beginDrag}
                  onDragEnd={endDrag}
                  onDragMove={moveDrag}
                  onLayout={(event: LayoutChangeEvent) => {
                    const { y, height } = event.nativeEvent.layout;
                    slotLayouts.current[item.id] = { y, height };
                  }}
                  onPress={selectServer}
                />
              ))}
            </ScrollView>
          </View>
        </View>
        </GestureHandlerRootView>
      </Modal>
    </View>
  );
}

type Drag = { id: string; order: RaftServer[]; dy: number; startY: number };

function ServerRow({
  item,
  dragging,
  dragDy,
  onPress,
  onBeginDrag,
  onDragMove,
  onDragEnd,
  onLayout,
}: {
  item: ServerMenuItem;
  dragging: boolean;
  dragDy: number;
  onPress: (id: string) => void;
  onBeginDrag: (id: string) => void;
  onDragMove: (id: string, dy: number) => void;
  onDragEnd: () => void;
  onLayout: (event: LayoutChangeEvent) => void;
}) {
  const id = item.id;
  const beginRef = useRef(onBeginDrag);
  const moveRef = useRef(onDragMove);
  const endRef = useRef(onDragEnd);
  beginRef.current = onBeginDrag;
  moveRef.current = onDragMove;
  endRef.current = onDragEnd;
  const dragGesture = useMemo(() => Gesture.Pan()
    .activateAfterLongPress(DRAG_ACTIVATE_MS)
    .runOnJS(true)
    .onStart(() => beginRef.current(id))
    .onUpdate((event) => moveRef.current(id, event.translationY))
    .onFinalize(() => endRef.current()), [id]);
  return (
    <GestureDetector gesture={dragGesture}>
      <Pressable
        accessibilityRole="button"
        accessibilityState={{ selected: item.current }}
        onLayout={onLayout}
        onPress={() => onPress(id)}
        style={[styles.item, dragging ? styles.lifted : null, dragging ? { transform: [{ translateY: dragDy }] } : null]}
      >
        <View style={[styles.tile, item.current ? styles.tileCurrent : null]}>
          <AppText style={styles.initial}>{item.initial}</AppText>
        </View>
        <AppText numberOfLines={1} style={styles.itemName}>{item.name}</AppText>
        {item.unread > 0 ? <View style={styles.dot} /> : null}
        {item.current ? <Check color={color.ink} size={18} /> : null}
      </Pressable>
    </GestureDetector>
  );
}

const styles = StyleSheet.create({
  container: { flexShrink: 1, justifyContent: "center", marginRight: 8 },
  press: { minHeight: 40, justifyContent: "center" },
  titleRow: { alignItems: "center", flexDirection: "row", gap: 4 },
  title: { color: color.ink, flexShrink: 1, fontSize: 20, fontWeight: "700", lineHeight: 24 },
  subtitle: { color: color.mutedStrong, fontSize: 13, lineHeight: 16 },
  dot: {
    backgroundColor: color.pink,
    borderColor: color.border,
    borderRadius: 5,
    borderWidth: 1,
    height: 10,
    width: 10,
  },
  modalRoot: { flex: 1 },
  scrim: { backgroundColor: "rgba(0,0,0,0.25)", bottom: 0, left: 0, position: "absolute", right: 0, top: 0 },
  sheetWrap: { left: 0, position: "absolute", right: 0 },
  panel: {
    backgroundColor: color.page,
    borderBottomColor: color.border,
    borderBottomWidth: border.strong,
    borderTopColor: color.border,
    borderTopWidth: border.strong,
  },
  list: { maxHeight: 360 },
  item: { alignItems: "center", backgroundColor: color.page, flexDirection: "row", gap: 12, minHeight: 52, paddingHorizontal: 16, paddingVertical: 8 },
  lifted: { elevation: 4, zIndex: 2 },
  tile: {
    alignItems: "center",
    backgroundColor: color.page,
    borderColor: color.border,
    borderWidth: border.strong,
    height: 36,
    justifyContent: "center",
    width: 36,
  },
  tileCurrent: { backgroundColor: color.yellow },
  initial: { color: color.ink, fontSize: 16, fontWeight: "700", lineHeight: 20 },
  itemName: { color: color.ink, flex: 1, fontSize: 16, fontWeight: "700" },
});
