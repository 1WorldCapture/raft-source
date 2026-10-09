import { Pressable, StyleSheet, View } from "react-native";
import { SKINS } from "@botiverse/raft-shared/src/skins.ts";
import { AppText } from "./text";
import { setSkin, useSkin } from "./skin";
import { border, color } from "./tokens";

/** Swatch, name, and a check on the current skin. Same rows in the menu and in Settings. */
export function SkinChoices({ onPick }: { onPick?: () => void }) {
  const current = useSkin();
  return (
    <View>
      {SKINS.map((skin) => {
        const selected = skin.id === current.id;
        return (
          <Pressable
            key={skin.id}
            accessibilityRole="button"
            accessibilityState={{ selected }}
            onPress={() => {
              setSkin(skin.id);
              onPick?.();
            }}
            style={[styles.row, selected ? [styles.selected, { backgroundColor: current.chrome }] : null]}
          >
            <View style={[styles.swatch, { backgroundColor: skin.chrome }]} />
            <AppText style={styles.name}>{skin.name}</AppText>
            {selected ? <AppText style={styles.check}>✓</AppText> : null}
          </Pressable>
        );
      })}
    </View>
  );
}

const styles = StyleSheet.create({
  row: {
    alignItems: "center",
    borderColor: "transparent",
    borderWidth: border.strong,
    flexDirection: "row",
    gap: 8,
    paddingHorizontal: 8,
    paddingVertical: 6,
  },
  selected: { borderColor: color.border },
  swatch: { borderColor: color.border, borderWidth: border.strong, height: 16, width: 16 },
  name: { color: color.ink, flex: 1, fontSize: 14, fontWeight: "700" },
  check: { color: color.ink, fontSize: 14, fontWeight: "700" },
});
