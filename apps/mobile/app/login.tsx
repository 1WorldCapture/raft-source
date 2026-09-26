import { useState } from "react";
import { useRouter } from "expo-router";
import { StyleSheet, Text, View } from "react-native";
import { ApiError } from "../src/api/client";
import { useSession } from "../src/state/session";
import { ErrorText, Field, PrimaryButton } from "../src/ui/screen";
import { colors, space } from "../src/ui/theme";

export default function LoginScreen() {
  const session = useSession();
  const router = useRouter();
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
      if (caught instanceof ApiError && caught.status === 0) setError("网络不通，请检查连接后再试");
      else if (caught instanceof ApiError && caught.status === 429) setError("尝试太频繁，请稍后再试");
      else if (caught instanceof ApiError && (caught.code === "AUTH_INVALID_CREDENTIALS" || caught.status === 401)) setError("邮箱或密码错误");
      else setError(caught instanceof ApiError ? caught.error : "登录失败");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <View style={styles.page}>
      <Text style={styles.origin}>{session.origin}</Text>
      <Field
        autoCapitalize="none"
        autoCorrect={false}
        keyboardType="email-address"
        onChangeText={setEmail}
        placeholder="Email"
        value={email}
      />
      <Field
        onChangeText={setPassword}
        placeholder="Password"
        secureTextEntry
        value={password}
      />
      {error ? <ErrorText>{error}</ErrorText> : null}
      <PrimaryButton
        disabled={submitting || email.trim().length === 0 || password.length === 0}
        label={submitting ? "Signing in…" : "Sign in"}
        onPress={() => void submit()}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  page: { flex: 1, gap: space.md, padding: space.lg, backgroundColor: colors.bg },
  origin: { color: colors.muted, fontSize: 13 },
});
