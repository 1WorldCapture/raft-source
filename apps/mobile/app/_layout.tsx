import "react-native-gesture-handler";
import { useEffect, useState } from "react";
import { Stack, useRouter, useSegments } from "expo-router";
import { StatusBar } from "expo-status-bar";
import { Pressable, Text, View } from "react-native";
import { SessionProvider, useSession } from "../src/state/session";
import { useRaftStore } from "../src/state/store";
import { colors } from "../src/ui/theme";

function SessionRedirect() {
  const session = useSession();
  const segments = useSegments();
  const router = useRouter();

  useEffect(() => {
    if (!session.ready) return;
    const top = segments[0];
    if (!session.origin) {
      if (top !== "server") router.replace("/server");
      return;
    }
    if (!session.signedIn && top !== "login" && top !== "server") {
      router.replace("/login");
    }
  }, [router, segments, session.origin, session.ready, session.signedIn]);

  return null;
}

function AccountNotice() {
  const notice = useRaftStore((state) => state.notice);
  const session = useSession();
  const [sending, setSending] = useState(false);
  if (!notice) return null;
  const profile = notice === "profile-setup";
  return (
    <View style={{ backgroundColor: "#fff7ed", paddingHorizontal: 16, paddingVertical: 10 }}>
      <Text style={{ color: "#9a3412" }}>
        {profile ? "请先在 Web 端完成资料设置，然后再回到 App。" : "请先在 Web 端完成邮箱验证。"}
      </Text>
      {profile ? null : (
        <Pressable disabled={sending} onPress={() => {
          setSending(true);
          void session.resendVerification().finally(() => setSending(false));
        }}>
          <Text style={{ color: colors.accent, fontWeight: "700", marginTop: 6 }}>{sending ? "发送中…" : "重新发送验证邮件"}</Text>
        </Pressable>
      )}
    </View>
  );
}

export default function RootLayout() {
  return (
    <SessionProvider>
      <StatusBar style="dark" />
      <SessionRedirect />
      <AccountNotice />
      <Stack
        screenOptions={{
          headerShadowVisible: false,
          headerTintColor: colors.accent,
          headerStyle: { backgroundColor: colors.bg },
          contentStyle: { backgroundColor: colors.bg },
        }}
      >
        <Stack.Screen name="index" options={{ headerShown: false }} />
        <Stack.Screen name="server" options={{ title: "Server" }} />
        <Stack.Screen name="login" options={{ title: "Sign in" }} />
        <Stack.Screen name="servers" options={{ title: "Servers", headerBackVisible: false }} />
        <Stack.Screen name="channels/[serverId]" options={{ title: "Channels" }} />
        <Stack.Screen name="messages/[channelId]" options={{ title: "Messages" }} />
        <Stack.Screen name="thread/[threadId]" options={{ title: "Thread" }} />
      </Stack>
    </SessionProvider>
  );
}
