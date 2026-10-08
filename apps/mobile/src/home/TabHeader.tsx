import { StyleSheet, View, useWindowDimensions } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import type { ReactNode } from "react";
import { AppText } from "../ui/text";
import { color, size } from "../ui/tokens";
import { TopMenu } from "./TopMenu";

/**
 * Shared header for the three tab roots (Rethink UI): server title on the
 * left, the top-right menu on the right. The PM tab can additionally render
 * the server switcher inline via `center`.
 */
export function TabHeader({ title, center }: { title: string; center?: ReactNode }) {
  const insets = useSafeAreaInsets();
  const { height } = useWindowDimensions();
  const compact = height <= 600;
  const headerHeight = (compact ? size.headerCompact : size.header) + insets.top;
  return (
    <View style={[styles.header, { height: headerHeight, paddingTop: insets.top }]}>
      <AppText numberOfLines={1} style={styles.title}>{title}</AppText>
      {center}
      <TopMenu />
    </View>
  );
}

const styles = StyleSheet.create({
  header: {
    alignItems: "center",
    backgroundColor: color.yellow,
    borderBottomColor: color.border,
    borderBottomWidth: 2,
    flexDirection: "row",
    height: size.header,
    justifyContent: "space-between",
    paddingHorizontal: 12,
  },
  title: { color: color.ink, flexShrink: 1, fontSize: 20, fontWeight: "700", lineHeight: 24, marginRight: 8 },
});
