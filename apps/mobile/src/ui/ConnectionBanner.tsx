import { useEffect, useState, type ReactNode } from "react";
import { StyleSheet, View } from "react-native";
import { SafeAreaInsetsContext, useSafeAreaInsets } from "react-native-safe-area-context";
import { RefreshCw, WifiOff } from "lucide-react-native";
import { useOfflineStore } from "../cache/cacheCleanup";
import { useCacheSyncStatus } from "../cache/cacheSyncRuntime";
import { useT } from "../i18n/provider";
import { AppText } from "./text";
import { border, color, fontSize } from "./tokens";

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
// It takes the status-bar inset itself and hands the screens below a zero top
// inset, so headers don't double-pad under it.
export function ConnectionBanner({ children }: { children: ReactNode }) {
  const t = useT();
  const insets = useSafeAreaInsets();
  const offline = useHeld(useOfflineStore((state) => state.offline), OFFLINE_DELAY_MS);
  const updating = useHeld(useCacheSyncStatus((state) => state.syncing), UPDATING_DELAY_MS) && !offline;
  if (!offline && !updating) return <>{children}</>;
  return (
    <>
      <View
        accessibilityLiveRegion="polite"
        style={[styles.bar, offline ? styles.offline : styles.updating, { paddingTop: insets.top + 6 }]}
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
      <SafeAreaInsetsContext.Provider value={{ ...insets, top: 0 }}>
        <View style={styles.body}>{children}</View>
      </SafeAreaInsetsContext.Provider>
    </>
  );
}

const styles = StyleSheet.create({
  bar: {
    alignItems: "center",
    borderBottomWidth: border.strong,
    borderColor: color.border,
    flexDirection: "row",
    gap: 8,
    paddingBottom: 6,
    paddingHorizontal: 16,
  },
  offline: { backgroundColor: color.ink },
  updating: { backgroundColor: color.cyan },
  text: { ...fontSize.bodySm, color: color.ink, flexShrink: 1, fontWeight: "700" },
  textOffline: { color: color.white },
  body: { flex: 1 },
});
