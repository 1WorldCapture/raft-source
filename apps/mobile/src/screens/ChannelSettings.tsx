import { Pressable, StyleSheet, View } from "react-native";
import { AppText } from "../ui/text";
import { color } from "../ui/tokens";
import type { ChannelMeta } from "./channelMeta";

export function ChannelSettings({
  meta,
  collapse,
  visibilityLabel,
  members,
  memberLabel,
  muteLabel,
  collapseLabel,
  leaveLabel,
  onMute,
  onCollapse,
  onLeave,
}: {
  meta: ChannelMeta;
  collapse: boolean;
  visibilityLabel: string;
  members: string[];
  memberLabel: string;
  muteLabel: string;
  collapseLabel: string;
  leaveLabel: string;
  onMute: (muted: boolean) => void;
  onCollapse: (collapse: boolean) => void;
  onLeave: () => void;
}) {
  const visibility = meta.visibility === "private" ? "private" : meta.visibility === "joint" ? "joint" : "public";
  return (
    <View style={styles.block}>
      <AppText style={styles.tag}>{visibilityLabel || visibility}</AppText>
      {meta.description ? <AppText style={styles.body}>{meta.description}</AppText> : null}
      <AppText style={styles.section}>{memberLabel}</AppText>
      {members.map((name, index) => <AppText key={`${name}-${index}`} style={styles.body}>{name}</AppText>)}
      {meta.activityMuteSupported ? <Toggle label={muteLabel} on={meta.activityMuted} onPress={() => onMute(!meta.activityMuted)} /> : null}
      <Toggle label={collapseLabel} on={collapse} onPress={() => onCollapse(!collapse)} />
      {meta.type === "dm" ? null : (
        <Pressable onPress={onLeave} style={styles.leave}>
          <AppText style={styles.leaveText}>{leaveLabel}</AppText>
        </Pressable>
      )}
    </View>
  );
}

function Toggle({ label, on, onPress }: { label: string; on: boolean; onPress: () => void }) {
  return (
    <Pressable onPress={onPress} style={styles.toggle}>
      <AppText style={styles.body}>{label}</AppText>
      <View style={[styles.box, on ? styles.on : null]} />
    </Pressable>
  );
}

const styles = StyleSheet.create({
  block: { gap: 12 },
  tag: { alignSelf: "flex-start", backgroundColor: color.yellow, borderColor: color.border, borderWidth: 2, color: color.ink, fontSize: 12, fontWeight: "700", paddingHorizontal: 8, paddingVertical: 4, textTransform: "uppercase" },
  body: { color: color.ink, fontSize: 14 },
  section: { color: color.ink, fontSize: 12, fontWeight: "700", letterSpacing: 0.8, textTransform: "uppercase" },
  toggle: { alignItems: "center", flexDirection: "row", justifyContent: "space-between" },
  box: { borderColor: color.border, borderWidth: 2, height: 18, width: 18 },
  on: { backgroundColor: color.yellow },
  leave: { alignSelf: "flex-start", borderColor: color.border, borderWidth: 2, marginTop: 8, paddingHorizontal: 12, paddingVertical: 8 },
  leaveText: { color: color.red, fontSize: 14, fontWeight: "700" },
});
