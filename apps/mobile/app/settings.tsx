import { useState } from "react";
import { Pressable, ScrollView, StyleSheet, View } from "react-native";
import Constants from "expo-constants";
import { getLocales } from "expo-localization";
import { useRouter } from "expo-router";
import { resolveLocale } from "../src/i18n/catalog";
import { useT } from "../src/i18n/provider";
import { userLabel } from "../src/model/messages";
import { useSession } from "../src/state/session";
import { PanelHeader } from "../src/ui/PanelHeader";
import { SkinChoices } from "../src/ui/SkinChoices";
import { AppText } from "../src/ui/text";
import { useSkinStyles, type SkinRoles } from "../src/ui/skin";
import { color, fontSize } from "../src/ui/tokens";

const FONT_SIZES = [
  { id: "sm", label: "settings.appearance.fontSizeSmall" },
  { id: "md", label: "settings.appearance.fontSizeMedium" },
  { id: "lg", label: "settings.appearance.fontSizeLarge" },
] as const;

export default function SettingsScreen() {
  const session = useSession();
  const router = useRouter();
  const t = useT();
  const skinStyle = useSkinStyles(choiceSkin);
  const [error, setError] = useState<string | null>(null);
  const font = session.user?.preferredMessageBodyFontSize || "md";
  const language = resolveLocale(session.user?.displayLanguage, getLocales()[0]?.languageTag ?? null);

  async function save(fields: { displayLanguage?: string; preferredMessageBodyFontSize?: "sm" | "md" | "lg" }) {
    setError(null);
    try {
      await session.updateProfile(fields);
    } catch {
      setError(t("settings.language.updateFailed"));
    }
  }

  return (
    <View style={styles.page}>
      <PanelHeader tone="yellow" title={t("layout.mobileTabBar.settings")} />
      <ScrollView contentContainerStyle={styles.scroll}>
      <View style={styles.block}>
        <AppText style={styles.label}>{userLabel(session.user) || t("mobile.account.signedIn")}</AppText>
        <AppText style={styles.hint}>{session.user?.email || ""}</AppText>
      </View>
      <AppText style={styles.section}>{t("mobile.menu.skin")}</AppText>
      <View style={styles.skins}>
        <SkinChoices />
      </View>
      <AppText style={styles.section}>{t("settings.appearance.fontSizeAria")}</AppText>
      <View style={styles.choices}>
        {FONT_SIZES.map((item) => (
          <Pressable key={item.id} onPress={() => void save({ preferredMessageBodyFontSize: item.id })} style={[styles.choice, font === item.id ? skinStyle.current : null]}>
            <AppText style={styles.choiceLabel}>{t(item.label)}</AppText>
          </Pressable>
        ))}
      </View>
      <AppText style={styles.section}>{t("settings.language.sectionLabel")}</AppText>
      <View style={styles.choices}>
        <Pressable onPress={() => void save({ displayLanguage: "en" })} style={[styles.choice, language === "en" ? skinStyle.current : null]}>
          <AppText style={styles.choiceLabel}>{t("mobile.settings.english")}</AppText>
        </Pressable>
        <Pressable onPress={() => void save({ displayLanguage: "zh-cn" })} style={[styles.choice, language === "zh-cn" ? skinStyle.current : null]}>
          <AppText style={styles.choiceLabel}>{t("mobile.settings.chinese")}</AppText>
        </Pressable>
      </View>
      <AppText style={styles.section}>{t("mobile.settings.about")}</AppText>
      <AppText style={styles.hint}>{Constants.expoConfig?.version || "0.1.0"}</AppText>
      {error ? <AppText style={styles.error}>{error}</AppText> : null}
      <Pressable onPress={() => void session.logout().then(() => router.replace("/login"))} style={styles.logout}>
        <AppText style={styles.choiceLabel}>{t("pages.serverSelector.logOut")}</AppText>
      </Pressable>
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  page: { backgroundColor: color.page, flex: 1 },
  scroll: { paddingBottom: 32 },
  block: { paddingHorizontal: 16, paddingTop: 16 },
  skins: { paddingHorizontal: 8, paddingTop: 8 },
  label: { color: color.ink, fontSize: 16, fontWeight: "700" },
  hint: { ...fontSize.time, color: color.muted, fontFamily: "mono", paddingHorizontal: 16, paddingTop: 4 },
  section: { ...fontSize.group, color: color.ink, fontWeight: "700", letterSpacing: 0.8, paddingHorizontal: 16, paddingTop: 20, textTransform: "uppercase" },
  choices: { flexDirection: "row", gap: 8, paddingHorizontal: 16, paddingTop: 8 },
  choice: { borderColor: color.border, borderWidth: 2, paddingHorizontal: 12, paddingVertical: 8 },
  choiceLabel: { ...fontSize.list, color: color.ink, fontWeight: "700" },
  error: { color: color.red, paddingHorizontal: 16, paddingTop: 12 },
  logout: { alignSelf: "flex-start", borderColor: color.border, borderWidth: 2, marginHorizontal: 16, marginTop: 24, paddingHorizontal: 12, paddingVertical: 8 },
});

function choiceSkin(skin: SkinRoles) {
  return StyleSheet.create({
    current: { backgroundColor: skin.signal },
  });
}
