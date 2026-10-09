import { useEffect, useState, type ReactNode } from "react";
import { StyleSheet, useWindowDimensions, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { RefreshCw, WifiOff } from "lucide-react-native";
import { useOfflineStore } from "../cache/cacheCleanup";
import { useCacheSyncStatus } from "../cache/cacheSyncRuntime";
import { useT } from "../i18n/provider";
import { connectionBannerFrame } from "./connectionBannerFrame";
import { AppText } from "./text";
import { border, color, fontSize, tabHeaderBlockHeight } from "./tokens";

// Brief blips (background return, a reconnect that lands within a second)
// should not flash a banner, so each state must hold for a moment first.
const OFFLINE_DELAY_MS = 1200;
const UPDATING_DELAY_MS = 700;

function useHeld(active: boolean, delayMs: number): boolean {
  const [held, setHeld] = useState(false);
  useEffect(() => {
    if (!active) {
      setHeld(false);
      return;
    }
    const timer = setTimeout(() => setHeld(true), delayMs);
    return () => clearTimeout(timer);
  }, [active, delayMs]);
  return held;
}

// App-wide connection strip (client-data-cache task #5): offline read-only
// notice, or an "updating" hint while the cache catches up after reconnect.
// The strip is an overlay sibling. Children stay in the same host whether it
// is visible or not, so a sync blip does not remount the app stack or push
// the page down.
export function ConnectionBanner({ children }: { children: ReactNode }) {
  const t = useT();
  const insets = useSafeAreaInsets();
  const { height } = useWindowDimensions();
  const offline = useHeld(useOfflineStore((state) => state.offline), OFFLINE_DELAY_MS);
  const updating = useHeld(useCacheSyncStatus((state) => state.syncing), UPDATING_DELAY_MS) && !offline;
  const visible = offline || updating;
  // Sit on the content, just under the yellow header, so the server name and
  // the status bar keep the header color. The strip stays absolute: it covers
  // the top of the page instead of pushing it down.
  const strip = visible ? (
    <View
      accessibilityLiveRegion="polite"
      pointerEvents="none"
      style={[styles.bar, offline ? styles.offline : styles.updating, { top: tabHeaderBlockHeight(height, insets.top) }]}
    >
      {offline ? (
        <WifiOff color={color.white} size={14} strokeWidth={2.5} />
      ) : (
        <RefreshCw color={color.ink} size={14} strokeWidth={2.5} />
      )}
      <AppText numberOfLines={1} style={[styles.text, offline ? styles.textOffline : null]}>
        {offline ? t("mobile.connection.offline") : t("mobile.connection.updating")}
      </AppText>
    </View>
  ) : null;
  return connectionBannerFrame({
    Host: View as unknown as (props: { children?: ReactNode; style?: typeof styles.root }) => ReactNode,
    rootStyle: styles.root,
    bodyStyle: styles.body,
    children,
    strip,
    status: null,
  });
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  bar: {
    alignItems: "center",
    borderBottomWidth: border.strong,
    borderColor: color.border,
    flexDirection: "row",
    gap: 8,
    left: 0,
    paddingBottom: 6,
    paddingHorizontal: 16,
    paddingTop: 6,
    position: "absolute",
    right: 0,
    zIndex: 2,
  },
  offline: { backgroundColor: color.ink },
  updating: { backgroundColor: color.cyan },
  text: { ...fontSize.bodySm, color: color.ink, flexShrink: 1, fontWeight: "700" },
  textOffline: { color: color.white },
  body: { flex: 1 },
});
