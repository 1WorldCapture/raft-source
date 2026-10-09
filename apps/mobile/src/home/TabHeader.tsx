import { StyleSheet, View, useWindowDimensions } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { color, size } from "../ui/tokens";
import { ServerTitle } from "./ServerTitle";
import { TopMenu } from "./TopMenu";

/**
 * Shared header for the three tab roots (Rethink UI): "server name ▾" on the
 * left (the server switcher), the top-right menu on the right. The PM tab
 * shows the PM's name on a second line via `subtitle`.
 */
export function TabHeader({ subtitle }: { subtitle?: string }) {
  const insets = useSafeAreaInsets();
  const { height } = useWindowDimensions();
  const compact = height <= 600;
  const headerHeight = (compact ? size.headerCompact : size.header) + insets.top;
  return (
    <View style={[styles.header, { height: headerHeight, paddingTop: insets.top }]}>
      <ServerTitle menuTop={headerHeight} subtitle={subtitle} />
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
});
