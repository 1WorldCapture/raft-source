import { Pressable, ScrollView, StyleSheet, View } from "react-native";
import type { RaftServer } from "../model/messages";
import { HardShadow } from "../ui/shadow";
import { AppText } from "../ui/text";
import { border, color, shadowOffset } from "../ui/tokens";
import { serverInitial } from "./serverInitial";

export const SERVER_RAIL_WIDTH = 64;
const TILE = 44;
/** Short screens keep more width for the list: narrower rail, smaller tiles. */
const COMPACT_RAIL_WIDTH = 52;
const COMPACT_TILE = 36;

// Discord-style server rail for the message-list home (task #10): one square
// tile per server, the current one highlighted, a pink dot when another server
// has unread messages. Presentational — the screen owns switching.
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
  return (
    <View style={[styles.rail, compact ? styles.railCompact : null]}>
      <ScrollView contentContainerStyle={styles.content} showsVerticalScrollIndicator={false}>
        {servers.map((server) => {
          const selected = server.id === currentId;
          const unread = !selected && (unreadByServer[server.id] ?? 0) > 0;
          return (
            <Pressable
              accessibilityLabel={server.name}
              accessibilityRole="button"
              accessibilityState={{ selected }}
              key={server.id}
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
    </View>
  );
}

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
  content: { alignItems: "center", gap: 12, paddingVertical: 12 },
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
});
