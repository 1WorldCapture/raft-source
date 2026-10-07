import { useCallback, useEffect, useRef, useState } from "react";
import { LayoutAnimation, Platform, Pressable, StyleSheet, UIManager, View, type LayoutChangeEvent, type NativeScrollEvent, type NativeSyntheticEvent } from "react-native";
import { Gesture, GestureDetector, ScrollView } from "react-native-gesture-handler";
import * as Haptics from "expo-haptics";
import type { RaftServer } from "../model/messages";
import { HardShadow } from "../ui/shadow";
import { AppText } from "../ui/text";
import { border, color, shadowOffset } from "../ui/tokens";
import { railOverflow, railScrollTargetY } from "./railScroll";
import { serverInitial } from "./serverInitial";

export const SERVER_RAIL_WIDTH = 64;
const TILE = 44;
/** Short screens keep more width for the list: narrower rail, smaller tiles. */
const COMPACT_RAIL_WIDTH = 52;
const COMPACT_TILE = 36;
/** Hold time before a tile starts following the finger (task #4). */
const DRAG_ACTIVATE_MS = 350;
/** Neighbours slide into their new slots instead of jumping (task #5). */
const REFLOW = LayoutAnimation.create(140, LayoutAnimation.Types.easeInEaseOut, LayoutAnimation.Properties.opacity);

if (Platform.OS === "android") UIManager.setLayoutAnimationEnabledExperimental?.(true);

// Discord-style server rail (home task #10; scrolling task #3, drag reorder
// task #4 in #mobile-server-rail): one square tile per server, the current one
// highlighted, a pink dot when another server has unread. Edge bars show more
// above/below and the current server stays visible. The drag is minimal on
// purpose — lifted tile follows the finger, others reflow in place; the
// full visual treatment (raise/shift animations) is task #5.
export function ServerRail({
  servers,
  currentId,
  compact,
  unreadByServer,
  onSelect,
  onReorder,
}: {
  servers: RaftServer[];
  currentId: string | null;
  compact?: boolean;
  unreadByServer: Record<string, number>;
  onSelect: (server: RaftServer) => void;
  /** Called with the final id order after a completed drag. */
  onReorder: (orderedIds: string[]) => void;
}) {
  const scrollRef = useRef<ScrollView>(null);
  const slotLayouts = useRef<Record<string, { y: number; height: number }>>({});
  const offsetRef = useRef(0);
  const [viewport, setViewport] = useState(0);
  const [contentHeight, setContentHeight] = useState(0);
  const [offset, setOffset] = useState(0);
  // Local drag shadow: while dragging, `order` is the working order and `dy`
  // the finger travel. Dropped or cancelled → null, prop order takes over
  // again (the caller applies it optimistically to the store).
  // `startY` is the tile's slot top when the drag began: the finger position
  // is startY + dy regardless of how many times the working order reflowed.
  const [drag, setDrag] = useState<{ id: string; order: RaftServer[]; dy: number; startY: number } | null>(null);
  const overflow = railOverflow({ offset, viewport, contentHeight });
  const displayServers = drag ? drag.order : servers;

  // Keep the current server visible after mount, a server switch, or a
  // reorder that moved it off-screen. The scroll offset is read from a ref so
  // the user's own scrolling never triggers a snap back.
  useEffect(() => {
    if (!currentId || viewport === 0) return;
    const slot = slotLayouts.current[currentId];
    if (!slot) return;
    const target = railScrollTargetY({ slot, offset: offsetRef.current, viewport, contentHeight });
    if (target !== null) scrollRef.current?.scrollTo({ y: target, animated: true });
  }, [currentId, viewport, contentHeight, displayServers]);

  const onScroll = (event: NativeSyntheticEvent<NativeScrollEvent>) => {
    offsetRef.current = event.nativeEvent.contentOffset.y;
    setOffset(offsetRef.current);
  };

  // Which slot the dragged tile's center is closest to, from the measured
  // layouts of the CURRENT working order. Scroll is disabled for the whole
  // gesture, so screen-space travel maps 1:1 onto content space.
  const targetIndexFor = useCallback((order: RaftServer[], id: string, startY: number, dy: number): number => {
    const center = (entry: { y: number; height: number }) => entry.y + entry.height / 2;
    const draggedLayout = slotLayouts.current[id];
    if (!draggedLayout) return order.findIndex((server) => server.id === id);
    // Anchor on where the drag started, not the slot's current (reflowed) y.
    const draggedCenter = startY + draggedLayout.height / 2 + dy;
    let best = 0;
    let bestDistance = Number.POSITIVE_INFINITY;
    order.forEach((server, index) => {
      const layout = slotLayouts.current[server.id];
      if (!layout) return;
      const distance = Math.abs(center(layout) - draggedCenter);
      if (distance < bestDistance) {
        bestDistance = distance;
        best = index;
      }
    });
    return best;
  }, []);

  const beginDrag = useCallback((id: string) => {
    setDrag({ id, order: servers, dy: 0, startY: slotLayouts.current[id]?.y ?? 0 });
    void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium).catch(() => {});
  }, [servers]);

  const moveDrag = useCallback((id: string, rawDy: number) => {
    setDrag((current) => {
      if (!current || current.id !== id) return current;
      // Keep the lifted tile inside the rail: between the first and last slot.
      const ys = current.order.map((server) => slotLayouts.current[server.id]?.y).filter((y): y is number => y !== undefined);
      const dy = ys.length > 0
        ? Math.min(Math.max(...ys) - current.startY, Math.max(Math.min(...ys) - current.startY, rawDy))
        : rawDy;
      const from = current.order.findIndex((server) => server.id === id);
      const to = targetIndexFor(current.order, id, current.startY, dy);
      if (to < 0 || to === from) return { ...current, dy };
      LayoutAnimation.configureNext(REFLOW);
      void Haptics.selectionAsync().catch(() => {});
      const order = current.order.slice();
      const [moved] = order.splice(from, 1);
      order.splice(to, 0, moved);
      return { ...current, dy, order };
    });
  }, [targetIndexFor]);

  const endDrag = useCallback(() => {
    setDrag((current) => {
      if (!current) return null;
      const originalIds = servers.map((server) => server.id);
      const finalIds = current.order.map((server) => server.id);
      if (finalIds.join("\n") !== originalIds.join("\n")) onReorder(finalIds);
      // Settle the lifted tile into its slot rather than snapping.
      LayoutAnimation.configureNext(REFLOW);
      return null;
    });
  }, [onReorder, servers]);

  return (
    <View
      onLayout={(event: LayoutChangeEvent) => setViewport(event.nativeEvent.layout.height)}
      style={[styles.rail, compact ? styles.railCompact : null]}
    >
      <ScrollView
        contentContainerStyle={styles.content}
        onContentSizeChange={(_width, height) => setContentHeight(height)}
        onScroll={onScroll}
        ref={scrollRef}
        scrollEnabled={drag === null}
        scrollEventThrottle={32}
        showsVerticalScrollIndicator={false}
      >
        {displayServers.map((server) => (
          <RailSlot
            key={server.id}
            compact={compact}
            currentId={currentId}
            dragging={drag?.id === server.id}
            // Visual lift = finger position minus the slot's current top.
            dragDy={drag?.id === server.id ? drag.startY + drag.dy - (slotLayouts.current[server.id]?.y ?? drag.startY) : 0}
            onBeginDrag={beginDrag}
            onDragMove={moveDrag}
            onDragEnd={endDrag}
            onLayout={(event: LayoutChangeEvent) => {
              const { y, height } = event.nativeEvent.layout;
              slotLayouts.current[server.id] = { y, height };
            }}
            onSelect={onSelect}
            server={server}
            unread={server.id !== currentId && (unreadByServer[server.id] ?? 0) > 0}
          />
        ))}
      </ScrollView>
      {overflow.above ? <View pointerEvents="none" style={[styles.edge, styles.edgeTop]} /> : null}
      {overflow.below ? <View pointerEvents="none" style={[styles.edge, styles.edgeBottom]} /> : null}
    </View>
  );
}

// One rail tile. A pan that activates after a long press (350ms) implements
// the drag, so plain taps and the rail scroll keep working untouched.
function RailSlot({
  server,
  currentId,
  compact,
  unread,
  dragging,
  dragDy,
  onSelect,
  onBeginDrag,
  onDragMove,
  onDragEnd,
  onLayout,
}: {
  server: RaftServer;
  currentId: string | null;
  compact?: boolean;
  unread: boolean;
  dragging: boolean;
  dragDy: number;
  onSelect: (server: RaftServer) => void;
  onBeginDrag: (id: string) => void;
  onDragMove: (id: string, dy: number) => void;
  onDragEnd: () => void;
  onLayout: (event: LayoutChangeEvent) => void;
}) {
  const id = server.id;
  const dragGesture = Gesture.Pan()
    .activateAfterLongPress(DRAG_ACTIVATE_MS)
    .runOnJS(true)
    .onStart(() => onBeginDrag(id))
    .onUpdate((event) => onDragMove(id, event.translationY))
    .onFinalize(() => onDragEnd());
  return (
    <GestureDetector gesture={dragGesture}>
      <Pressable
        accessibilityLabel={server.name}
        accessibilityRole="button"
        accessibilityState={{ selected: server.id === currentId }}
        onLayout={onLayout}
        onPress={() => onSelect(server)}
        style={[
          styles.slot,
          compact ? styles.slotCompact : null,
          dragging ? { transform: [{ translateY: dragDy }], zIndex: 2, elevation: 4 } : null,
        ]}
      >
        {({ pressed }) => (
          <View style={styles.slotInner}>
            {dragging ? (
              // Placeholder: a dashed outline where the tile will land.
              <View pointerEvents="none" style={[styles.placeholder, compact ? styles.tileCompact : null, { transform: [{ translateY: -dragDy }] }]} />
            ) : null}
            {server.id === currentId ? <View style={[styles.indicator, compact ? styles.indicatorCompact : null]} /> : null}
            <HardShadow
              offset={dragging ? shadowOffset.md : server.id === currentId && !pressed ? shadowOffset.sm : shadowOffset.pressed}
              style={dragging ? styles.lifted : null}
            >
              <View style={[styles.tile, compact ? styles.tileCompact : null, server.id === currentId ? styles.tileSelected : null]}>
                <AppText numberOfLines={1} style={[styles.initial, compact ? styles.initialCompact : null]}>{serverInitial(server.name)}</AppText>
              </View>
            </HardShadow>
            {unread ? <View style={styles.dot} /> : null}
          </View>
        )}
      </Pressable>
    </GestureDetector>
  );
}

const EDGE = 10;

const styles = StyleSheet.create({
  rail: {
    backgroundColor: color.mutedFill,
    borderRightColor: color.border,
    borderRightWidth: border.strong,
    width: SERVER_RAIL_WIDTH,
  },
  railCompact: { width: COMPACT_RAIL_WIDTH },
  slotCompact: { width: COMPACT_RAIL_WIDTH },
  indicatorCompact: { height: 22, left: -(COMPACT_RAIL_WIDTH - COMPACT_TILE) / 2 },
  tileCompact: { height: COMPACT_TILE, width: COMPACT_TILE },
  content: { alignItems: "center", gap: 12, paddingBottom: 24, paddingTop: 12 },
  slot: { alignItems: "center", width: SERVER_RAIL_WIDTH },
  slotInner: { alignItems: "center", justifyContent: "center" },
  indicator: {
    backgroundColor: color.ink,
    height: 28,
    left: -(SERVER_RAIL_WIDTH - TILE) / 2,
    position: "absolute",
    width: 4,
  },
  tile: {
    alignItems: "center",
    backgroundColor: color.page,
    borderColor: color.border,
    borderWidth: border.strong,
    height: TILE,
    justifyContent: "center",
    width: TILE,
  },
  tileSelected: { backgroundColor: color.yellow },
  // Lifted tile: bigger hard shadow, slightly larger and tilted, like a card
  // picked up off the rail.
  lifted: { transform: [{ scale: 1.12 }, { rotate: "-4deg" }] },
  placeholder: {
    borderColor: color.ink,
    borderStyle: "dashed",
    borderWidth: border.strong,
    height: TILE,
    position: "absolute",
    width: TILE,
  },
  initial: { color: color.ink, fontSize: 18, fontWeight: "700", lineHeight: 22 },
  initialCompact: { fontSize: 15, lineHeight: 18 },
  dot: {
    backgroundColor: color.pink,
    borderColor: color.border,
    borderRadius: 5,
    borderWidth: 1,
    height: 10,
    position: "absolute",
    right: -3,
    top: -3,
    width: 10,
  },
  // "More above/below" cue: a hard ink rule plus a faint band, in keeping with
  // the brutalist style (no gradients).
  edge: {
    backgroundColor: color.borderFaint,
    height: EDGE,
    left: 0,
    position: "absolute",
    right: 0,
  },
  edgeTop: { borderTopColor: color.ink, borderTopWidth: border.strong, top: 0 },
  edgeBottom: { borderBottomColor: color.ink, borderBottomWidth: border.strong, bottom: 0 },
});
