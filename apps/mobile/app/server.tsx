import { useState } from "react";
import { useRouter } from "expo-router";
import { StyleSheet, Text, View } from "react-native";
import { useSession } from "../src/state/session";
import { checkRaftHealth } from "../src/api/health";
import { ApiError } from "../src/api/client";
import { normalizeServerOrigin } from "../src/session/origin";
import { ErrorText, Field, PrimaryButton } from "../src/ui/screen";
import { colors, space } from "../src/ui/theme";

export default function ServerScreen() {
  const session = useSession();
  const router = useRouter();
  const [value, setValue] = useState(session.origin ?? "");
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  async function save() {
    setError(null);
    let origin: string;
    try {
      origin = normalizeServerOrigin(value);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Check the server address");
      return;
    }
    setSaving(true);
    try {
      await checkRaftHealth(origin);
      await session.setOrigin(origin);
      router.replace("/login");
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.error : caught instanceof Error ? caught.message : "Couldn't reach that server");
    } finally {
      setSaving(false);
    }
  }

  return (
    <View style={styles.page}>
      <Text style={styles.lead}>填入私有化部署的地址。保存前会请求 /health，确认这是 Raft 服务。</Text>
      <Field
        autoCapitalize="none"
        autoCorrect={false}
        keyboardType="url"
        onChangeText={setValue}
        placeholder="https://raft.example.com"
        value={value}
      />
      {error ? <ErrorText>{error}</ErrorText> : null}
      <PrimaryButton disabled={saving || value.trim().length === 0} label={saving ? "Saving…" : "Continue"} onPress={() => void save()} />
    </View>
  );
}

const styles = StyleSheet.create({
  page: { flex: 1, gap: space.md, padding: space.lg, backgroundColor: colors.bg },
  lead: { color: colors.muted, fontSize: 15, lineHeight: 21 },
});
