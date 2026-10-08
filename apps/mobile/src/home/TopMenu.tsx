import { useState } from "react";
import { Pressable, StyleSheet, View } from "react-native";
import { useRouter } from "expo-router";
import { Bookmark, MoreHorizontal, Search, Settings, UserRound, Users } from "lucide-react-native";
import { useT } from "../i18n/provider";
import { AppText } from "../ui/text";
import { color } from "../ui/tokens";
import { requestChoosePm } from "./choosePm";
import { canSetPm } from "./pmState";
import { useServerRole } from "./serverRole";
import { useServerPm } from "./useServerPm";
import { useServerRail } from "./useServerRail";

type MenuItem = {
  key: string;
  label: string;
  icon: typeof Search;
  onPress: () => void;
};

/**
 * Top-right header menu (Rethink UI §2): search, saved, settings, members.
 * Opens a lightweight absolute-positioned dropdown anchored under the
 * trigger; tapping the scrim or an item dismisses it.
 */
export function TopMenu() {
  const router = useRouter();
  const t = useT();
  const [open, setOpen] = useState(false);
  const { current } = useServerRail();
  const roleFromStore = useServerRole();
  const role = current?.role ?? roleFromStore;
  const { state } = useServerPm(current?.slug ?? null);
  const showChoosePm = canSetPm(role) && state != null && state.pm == null;

  const go = (route: string) => {
    setOpen(false);
    router.push(route as never);
  };

  const items: MenuItem[] = [
    ...(showChoosePm ? [{
      key: "choosePm",
      label: t("mobile.menu.choosePm"),
      icon: UserRound,
      onPress: () => {
        setOpen(false);
        requestChoosePm();
        router.push("/pm" as never);
      },
    }] : []),
    { key: "search", label: t("mobile.menu.search"), icon: Search, onPress: () => go("/search") },
    { key: "saved", label: t("mobile.menu.saved"), icon: Bookmark, onPress: () => go("/saved") },
    { key: "settings", label: t("mobile.menu.settings"), icon: Settings, onPress: () => go("/settings") },
    { key: "members", label: t("mobile.menu.members"), icon: Users, onPress: () => go("/members") },
  ];

  return (
    <View style={styles.container}>
      <Pressable accessibilityRole="button" onPress={() => setOpen((value) => !value)} style={styles.trigger}>
        <MoreHorizontal color={color.ink} size={20} />
      </Pressable>
      {open ? (
        <>
          <Pressable accessibilityRole="button" onPress={() => setOpen(false)} style={styles.scrim} />
          <View style={styles.panel}>
            {items.map((item) => {
              const Icon = item.icon;
              return (
                <Pressable
                  key={item.key}
                  accessibilityRole="button"
                  onPress={item.onPress}
                  style={styles.item}
                >
                  <Icon color={color.ink} size={16} />
                  <AppText style={styles.itemLabel}>{item.label}</AppText>
                </Pressable>
              );
            })}
          </View>
        </>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  container: { alignItems: "center", justifyContent: "center" },
  trigger: { alignItems: "center", height: 40, justifyContent: "center", width: 40 },
  scrim: { height: 10000, left: -5000, position: "absolute", top: 32, width: 10000 },
  panel: {
    backgroundColor: color.page,
    borderColor: color.border,
    borderRadius: 8,
    borderWidth: 2,
    minWidth: 180,
    position: "absolute",
    right: 4,
    shadowColor: color.ink,
    shadowOffset: { height: 4, width: 0 },
    shadowOpacity: 0.2,
    shadowRadius: 8,
    top: 36,
    zIndex: 100,
  },
  item: { alignItems: "center", flexDirection: "row", gap: 10, paddingHorizontal: 14, paddingVertical: 12 },
  itemLabel: { color: color.ink, fontSize: 14, fontWeight: "700" },
});
