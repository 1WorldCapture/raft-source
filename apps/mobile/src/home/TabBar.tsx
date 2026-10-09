import { Pressable, StyleSheet, View, useWindowDimensions } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Hash, MessageSquare, Sparkles } from "lucide-react-native";
import { useT } from "../i18n/provider";
import { useSkinStyles, type SkinRoles } from "../ui/skin";
import { AppText } from "../ui/text";
import { color } from "../ui/tokens";

const ICONS = {
  pm: Sparkles,
  dms: MessageSquare,
  channels: Hash,
} as const;

const LABELS = {
  pm: "mobile.tabs.pm",
  dms: "mobile.tabs.dms",
  channels: "mobile.tabs.channels",
} as const;

export function HomeTabBar({
  state,
  navigation,
}: {
  state: { index: number; routes: { key: string; name: string }[] };
  navigation: { navigate: (name: string) => void };
}) {
  const t = useT();
  const { height } = useWindowDimensions();
  const insets = useSafeAreaInsets();
  const compact = height <= 600;
  const skinStyle = useSkinStyles(tabSkin);
  return (
    <View style={[styles.bar, { paddingBottom: Math.min(insets.bottom, 34) }]}>
      {state.routes.map((route, index) => {
        const name = route.name as keyof typeof ICONS;
        const Icon = ICONS[name];
        const active = state.routes[state.index]?.key === route.key;
        return (
          <Pressable
            key={route.key}
            accessibilityRole="button"
            onPress={() => navigation.navigate(route.name)}
            style={[styles.tab, active ? skinStyle.active : null, index < state.routes.length - 1 ? styles.divider : null]}
          >
            {compact || !Icon ? null : <Icon color={color.ink} size={18} />}
            <AppText style={styles.label}>{t(LABELS[name])}</AppText>
          </Pressable>
        );
      })}
    </View>
  );
}

const styles = StyleSheet.create({
  bar: {
    backgroundColor: color.page,
    borderTopColor: color.border,
    borderTopWidth: 2,
    flexDirection: "row",
  },
  tab: { alignItems: "center", flex: 1, gap: 2, justifyContent: "center", paddingVertical: 8 },
  divider: { borderRightColor: color.border, borderRightWidth: 2 },
  label: { color: color.ink, fontSize: 10, fontWeight: "700", letterSpacing: 0.6 },
});

function tabSkin(skin: SkinRoles) {
  return StyleSheet.create({
    active: { backgroundColor: skin.signal },
  });
}
