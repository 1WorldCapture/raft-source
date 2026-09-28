import { useEffect, useRef, useState } from "react";
import { Pressable, ScrollView, StyleSheet, View, type LayoutChangeEvent, type NativeScrollEvent, type NativeSyntheticEvent } from "react-native";
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

// Discord-style server rail (home task #10; scrolling task #3 in
// #mobile-server-rail): one square tile per server, the current one
// highlighted, a pink dot when another server has unread messages. When the
// list is taller than the rail, edge bars show there is more above/below and
// the current server is scrolled into view. Presentational — the screen owns
// switching.
export function ServerRail({
  servers,
  currentId,
  compact,
  unreadByServer,
  onSelect,
}: {
  servers: RaftServer[];
  currentId: string | null;
  compact?: boolean;
  unreadByServer: Record<string, number>;
  onSelect: (server: RaftServer) => void;
}) {
  const scrollRef = useRef<ScrollView>(null);
  const slotLayouts = useRef<Record<string, { y: number; height: number }>>({});
  const offsetRef = useRef(0);
  const [viewport, setViewport] = useState(0);
  const [contentHeight, setContentHeight] = useState(0);
  const [offset, setOffset] = useState(0);
  const overflow = railOverflow({ offset, viewport, contentHeight });

  // Keep the current server visible after mount, a server switch, or a
  // reorder that moved it off-screen. The scroll offset is read from a ref so
  // the user's own scrolling never triggers a snap back.
  useEffect(() => {
    if (!currentId || viewport === 0) return;
    const slot = slotLayouts.current[currentId];
    if (!slot) return;
    const target = railScrollTargetY({ slot, offset: offsetRef.current, viewport, contentHeight });
    if (target !== null) scrollRef.current?.scrollTo({ y: target, animated: true });
  }, [currentId, viewport, contentHeight, servers]);

  const onScroll = (event: NativeSyntheticEvent<NativeScrollEvent>) => {
    offsetRef.current = event.nativeEvent.contentOffset.y;
    setOffset(offsetRef.current);
  };

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
        scrollEventThrottle={32}
        showsVerticalScrollIndicator={false}
      >
        {servers.map((server) => {
          const selected = server.id === currentId;
          const unread = !selected && (unreadByServer[server.id] ?? 0) > 0;
          return (
            <Pressable
              accessibilityLabel={server.name}
              accessibilityRole="button"
              accessibilityState={{ selected }}
              key={server.id}
              onLayout={(event: LayoutChangeEvent) => {
                const { y, height } = event.nativeEvent.layout;
                slotLayouts.current[server.id] = { y, height };
              }}
              onPress={() => onSelect(server)}
              style={[styles.slot, compact ? styles.slotCompact : null]}
            >
              {({ pressed }) => (
                <View style={styles.slotInner}>
                  {selected ? <View style={[styles.indicator, compact ? styles.indicatorCompact : null]} /> : null}
                  <HardShadow offset={selected && !pressed ? shadowOffset.sm : shadowOffset.pressed}>
                    <View style={[styles.tile, compact ? styles.tileCompact : null, selected ? styles.tileSelected : null]}>
                      <AppText numberOfLines={1} style={[styles.initial, compact ? styles.initialCompact : null]}>{serverInitial(server.name)}</AppText>
                    </View>
                  </HardShadow>
                  {unread ? <View style={styles.dot} /> : null}
                </View>
              )}
            </Pressable>
          );
        })}
      </ScrollView>
      {overflow.above ? <View pointerEvents="none" style={[styles.edge, styles.edgeTop]} /> : null}
      {overflow.below ? <View pointerEvents="none" style={[styles.edge, styles.edgeBottom]} /> : null}
    </View>
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
