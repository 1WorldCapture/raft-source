import { useState } from "react";
import { useRouter } from "expo-router";
import { StyleSheet, View } from "react-native";
import { ApiError } from "../src/api/client";
import { useT } from "../src/i18n/provider";
import { useSession } from "../src/state/session";
import { AppText } from "../src/ui/text";
import { ErrorText, Field, PrimaryButton } from "../src/ui/screen";
import { colors, space } from "../src/ui/theme";

export default function LoginScreen() {
  const session = useSession();
  const router = useRouter();
  const t = useT();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  async function submit() {
    setError(null);
    setSubmitting(true);
    try {
      await session.login(email.trim(), password);
      router.replace("/servers");
    } catch (caught) {
      if (caught instanceof ApiError && caught.status === 0) setError(t("mobile.network.offline"));
      else if (caught instanceof ApiError && caught.status === 429) setError(t("mobile.auth.tooMany"));
      else if (caught instanceof ApiError && (caught.code === "AUTH_INVALID_CREDENTIALS" || caught.status === 401)) setError(t("auth.error.incorrectCredentials"));
      else setError(caught instanceof ApiError ? caught.error : t("mobile.auth.failed"));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <View style={styles.page}>
      <AppText style={styles.origin}>{session.origin ?? ""}</AppText>
      <Field
        autoCapitalize="none"
        autoCorrect={false}
        keyboardType="email-address"
        onChangeText={setEmail}
        placeholder={t("pages.login.emailLabel")}
        value={email}
      />
      <Field
        onChangeText={setPassword}
        placeholder={t("pages.login.passwordLabel")}
        secureTextEntry
        value={password}
      />
      {error ? <ErrorText>{error}</ErrorText> : null}
      <PrimaryButton
        disabled={submitting || email.trim().length === 0 || password.length === 0}
        label={submitting ? t("pages.login.signingIn") : t("pages.publicServer.signIn")}
        onPress={() => void submit()}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  page: { flex: 1, gap: space.md, padding: space.lg, backgroundColor: colors.bg },
  origin: { color: colors.muted, fontSize: 13 },
});
