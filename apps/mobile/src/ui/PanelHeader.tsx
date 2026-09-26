import type { ReactNode } from "react";
import { Pressable, StyleSheet, View, useWindowDimensions } from "react-native";
import { ArrowLeft } from "lucide-react-native";
import { AppText } from "./text";
import { color, size } from "./tokens";

export function PanelHeader({
  title,
  subtitle,
  onBack,
  onTitlePress,
  actions,
}: {
  title: string;
  subtitle?: string;
  onBack?: () => void;
  onTitlePress?: () => void;
  actions?: ReactNode;
}) {
  const { height } = useWindowDimensions();
  return (
    <View style={[styles.bar, { height: height <= 600 ? size.headerCompact : size.header }]}>
      {onBack ? (
        <Pressable accessibilityRole="button" onPress={onBack} style={styles.icon}>
          <ArrowLeft color={color.ink} size={18} />
        </Pressable>
      ) : null}
      <Pressable disabled={!onTitlePress} onPress={onTitlePress} style={styles.titles}>
        <AppText numberOfLines={1} style={styles.title}>{title}</AppText>
        {subtitle ? <AppText numberOfLines={1} style={styles.subtitle}>{subtitle}</AppText> : null}
      </Pressable>
      <View style={styles.actions}>{actions}</View>
    </View>
  );
}

const styles = StyleSheet.create({
  bar: {
    alignItems: "center",
    backgroundColor: color.yellow,
    borderBottomColor: color.border,
    borderBottomWidth: 2,
    flexDirection: "row",
    gap: 8,
    paddingHorizontal: 12,
  },
  icon: { alignItems: "center", height: size.iconButton, justifyContent: "center", width: size.iconButton },
  titles: { flex: 1 },
  title: { color: color.ink, fontSize: 16, fontWeight: "700" },
  subtitle: { color: color.mutedStrong, fontFamily: "mono", fontSize: 12 },
  actions: { flexDirection: "row", gap: 8 },
});
