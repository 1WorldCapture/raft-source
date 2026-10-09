import { Modal, Pressable, StyleSheet } from "react-native";
import { Avatar } from "../ui/Avatar";
import { AppText } from "../ui/text";
import { useSkinStyles, type SkinRoles } from "../ui/skin";
import { color } from "../ui/tokens";

export function ProfileCard({
  name,
  description,
  kind,
  avatarUrl,
  dmLabel,
  onClose,
  onMessage,
}: {
  name: string;
  description?: string | null;
  kind: "agent" | "human";
  avatarUrl?: string | null;
  dmLabel: string;
  onClose: () => void;
  onMessage: () => void;
}) {
  const skinStyle = useSkinStyles(profileSkin);
  return (
    <Modal animationType="fade" onRequestClose={onClose} transparent visible>
      <Pressable onPress={onClose} style={styles.scrim}>
        <Pressable onPress={() => undefined} style={styles.card}>
          <Avatar avatarUrl={avatarUrl} kind={kind} name={name} size={64} />
          <AppText style={styles.name}>{name}</AppText>
          {description ? <AppText style={styles.body}>{description}</AppText> : null}
          <Pressable onPress={onMessage} style={[styles.button, skinStyle.button]}>
            <AppText style={styles.buttonText}>{dmLabel}</AppText>
          </Pressable>
        </Pressable>
      </Pressable>
    </Modal>
  );
}

const styles = StyleSheet.create({
  scrim: { alignItems: "center", backgroundColor: color.scrim, flex: 1, justifyContent: "center", padding: 24 },
  card: { alignItems: "center", backgroundColor: color.page, borderColor: color.border, borderWidth: 2, gap: 12, padding: 24, width: "100%" },
  name: { color: color.ink, fontSize: 18, fontWeight: "700" },
  body: { color: color.mutedStrong, fontSize: 14, textAlign: "center" },
  button: { borderColor: color.border, borderWidth: 2, paddingHorizontal: 16, paddingVertical: 10 },
  buttonText: { color: color.ink, fontSize: 14, fontWeight: "700" },
});

function profileSkin(skin: SkinRoles) {
  return StyleSheet.create({
    button: { backgroundColor: skin.signal },
  });
}
