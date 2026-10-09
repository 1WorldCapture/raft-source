import { StyleSheet, View, useWindowDimensions } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useSkinStyles, type SkinRoles } from "../ui/skin";
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
  const skinStyle = useSkinStyles(headerSkin);
  return (
    <View style={[styles.header, skinStyle.header, { height: headerHeight, paddingTop: insets.top }]}>
      <ServerTitle menuTop={headerHeight} />
      <TopMenu />
    </View>
  );
}

const styles = StyleSheet.create({
  header: {
    alignItems: "center",
    borderBottomColor: color.border,
    borderBottomWidth: 2,
    flexDirection: "row",
    height: size.header,
    justifyContent: "space-between",
    paddingHorizontal: 12,
  },
});

function headerSkin(skin: SkinRoles) {
  return StyleSheet.create({
    header: { backgroundColor: skin.chrome },
  });
}
