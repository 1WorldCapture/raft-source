import { useEffect, useState } from "react";
import { Modal, Pressable, ScrollView, StyleSheet, View } from "react-native";
import { Check, ChevronDown } from "lucide-react-native";
import { useT } from "../i18n/provider";
import { useSession } from "../state/session";
import { AppText } from "../ui/text";
import { border, color } from "../ui/tokens";
import { buildServerMenu } from "./serverMenu";
import { useServerRail } from "./useServerRail";

/**
 * Header title for the three tab roots (replaces the left server rail): the
 * current server's name with a ▾ that opens a list from the top. Tapping a
 * server switches to it through the same `switchServer` the rail used
 * (closes the PM picker, clears the old PM state). With a single server there
 * is no ▾ and the title is not tappable. A small dot next to ▾ says another
 * server has unread.
 */
export function ServerTitle({ subtitle, menuTop }: { subtitle?: string; menuTop: number }) {
  const t = useT();
  const session = useSession();
  const { servers, serverUnread, current, switchServer, loadServers } = useServerRail();
  const [open, setOpen] = useState(false);
  const menu = buildServerMenu(servers, session.serverId, serverUnread);

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
        <Pressable accessibilityLabel={t("search.back")} onPress={() => setOpen(false)} style={styles.scrim} />
        <View pointerEvents="box-none" style={[styles.sheetWrap, { top: menuTop }]}>
          <View style={styles.panel}>
            <ScrollView bounces={false} style={styles.list}>
              {menu.items.map((item) => (
                <Pressable
                  key={item.id}
                  accessibilityRole="button"
                  accessibilityState={{ selected: item.current }}
                  onPress={() => {
                    setOpen(false);
                    const server = servers.find((candidate) => candidate.id === item.id);
                    if (server) void switchServer(server);
                  }}
                  style={styles.item}
                >
                  <View style={[styles.tile, item.current ? styles.tileCurrent : null]}>
                    <AppText style={styles.initial}>{item.initial}</AppText>
                  </View>
                  <AppText numberOfLines={1} style={styles.itemName}>{item.name}</AppText>
                  {item.unread > 0 ? <View style={styles.dot} /> : null}
                  {item.current ? <Check color={color.ink} size={18} /> : null}
                </Pressable>
              ))}
            </ScrollView>
          </View>
        </View>
      </Modal>
    </View>
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
  item: { alignItems: "center", flexDirection: "row", gap: 12, minHeight: 52, paddingHorizontal: 16, paddingVertical: 8 },
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
