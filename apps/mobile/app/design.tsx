import { useState } from "react";
import { ScrollView, StyleSheet, View } from "react-native";
import { useT } from "../src/i18n/provider";
import { Avatar } from "../src/ui/Avatar";
import { Badge, MentionMark } from "../src/ui/Badge";
import { BrutalButton } from "../src/ui/BrutalButton";
import { Chip } from "../src/ui/Chip";
import { PanelHeader } from "../src/ui/PanelHeader";
import { Sheet } from "../src/ui/Sheet";
import { AppText } from "../src/ui/text";
import { color, fontSize } from "../src/ui/tokens";

export default function DesignScreen() {
  const t = useT();
  const [open, setOpen] = useState(false);
  return (
    <View style={styles.page}>
      <ScrollView contentContainerStyle={styles.content}>
        <PanelHeader safeArea={false} subtitle="Space Grotesk" title={t("mobile.design.title")} />
        <AppText style={styles.body}>Raft 粗野主义 / Brutal type 0123</AppText>
        <AppText style={styles.mono}>Space Mono 14:32</AppText>
        <View style={styles.row}>
          <BrutalButton label={t("pages.publicServer.signIn")} onPress={() => setOpen(true)} />
          <BrutalButton label={t("pages.serverSelector.logOut")} onPress={() => undefined} tone="plain" />
          <BrutalButton label={t("mobile.messages.send")} onPress={() => undefined} tone="yellow" />
        </View>
        <View style={styles.row}>
          <Badge count={3} />
          <Badge count={120} />
          <Badge count={4} quiet />
          <MentionMark />
        </View>
        <View style={styles.row}>
          <Avatar kind="agent" name="Dev" avatarUrl="pixel:robot" status="online" />
          <Avatar kind="agent" name="Seed" avatarUrl="pixel:random:localdev" status="busy" />
          <Avatar kind="human" name="Lyon" status="offline" />
          <Avatar kind="server" name="Raft" />
        </View>
        <View style={styles.row}>
          <Chip kind="mention" label="@Dev" />
          <Chip kind="channel" label="#all" />
          <Chip kind="thread" label={t("message.threadPanel.thread")} />
        </View>
      </ScrollView>
      <Sheet open={open} title={t("mobile.design.title")} onClose={() => setOpen(false)}>
        <AppText style={styles.body}>{t("mobile.account.profile")}</AppText>
      </Sheet>
    </View>
  );
}

const styles = StyleSheet.create({
  page: { backgroundColor: color.page, flex: 1 },
  content: { gap: 16, paddingBottom: 32 },
  body: { ...fontSize.bodyMd, color: color.ink, paddingHorizontal: 16 },
  mono: { color: color.ink, fontFamily: "mono", fontSize: 12, paddingHorizontal: 16 },
  row: { alignItems: "center", flexDirection: "row", flexWrap: "wrap", gap: 12, paddingHorizontal: 16 },
});
