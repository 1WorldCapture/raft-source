import { StyleSheet } from "react-native";
import { useT } from "../i18n/provider";
import { AppText } from "../ui/text";
import { border, color } from "../ui/tokens";

/** Pinned notice shown above preview sheets when the server reports a
 *  truncated preview; shared by the text and markdown panes. */
export function TruncationBanner() {
  const t = useT();
  return <AppText style={styles.banner}>{t("mobile.preview.truncated")}</AppText>;
}

const styles = StyleSheet.create({
  banner: {
    backgroundColor: color.white,
    borderColor: color.border,
    borderWidth: border.strong,
    color: color.ink,
    fontSize: 14,
    fontWeight: "700",
    marginBottom: 12,
    paddingHorizontal: 12,
    paddingVertical: 8,
  },
});
