import { StyleSheet, View, useWindowDimensions } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { color, size, tabHeaderBlockHeight } from "../ui/tokens";
import { ServerTitle } from "./ServerTitle";
import { TopMenu } from "./TopMenu";

/**
 * Shared header for the three tab roots (Rethink UI): "server name ▾" on the
 * left (the server switcher), the top-right menu on the right.
 */
export function TabHeader() {
  const insets = useSafeAreaInsets();
  const { height } = useWindowDimensions();
  const headerHeight = tabHeaderBlockHeight(height, insets.top);
  return (
    <View style={[styles.header, { height: headerHeight, paddingTop: insets.top }]}>
      <ServerTitle menuTop={headerHeight} />
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
