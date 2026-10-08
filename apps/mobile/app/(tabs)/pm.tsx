import { StyleSheet, View } from "react-native";
import { useT } from "../../src/i18n/provider";
import { ScreenMessage } from "../../src/ui/screen";
import { AppText } from "../../src/ui/text";
import { color } from "../../src/ui/tokens";
import { RailLayout } from "../../src/home/RailLayout";
import { TabHeader } from "../../src/home/TabHeader";
import { useDirectory } from "../../src/home/useDirectory";
import { useServerRail } from "../../src/home/useServerRail";

/**
 * PM tab (Rethink UI §2, stage C). Stage C ships the shell: server switcher
 * via the rail plus a static enablement prompt. Stage D replaces the prompt
 * with the real PM conversation once GET /api/servers/:slug/pm lands
 * (stage A) — until then the tab stays a placeholder by design.
 */
export default function PmScreen() {
  const t = useT();
  const { current } = useServerRail();
  useDirectory();

  return (
    <View style={styles.page}>
      <TabHeader title={current?.name || t("mobile.servers.title")} />
      <RailLayout>
        <View style={styles.pane}>
          <ScreenMessage
            title={t("mobile.pm.enableTitle")}
            body={t("mobile.pm.enableBody")}
          />
          <AppText style={styles.hint}>{t("mobile.pm.stageCHint")}</AppText>
        </View>
      </RailLayout>
    </View>
  );
}

const styles = StyleSheet.create({
  page: { backgroundColor: color.page, flex: 1 },
  pane: { alignItems: "center", flex: 1, justifyContent: "center", padding: 24 },
  hint: { color: color.muted, fontSize: 12, marginTop: 16, textAlign: "center" },
});
