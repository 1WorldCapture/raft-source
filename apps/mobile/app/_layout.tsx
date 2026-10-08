import "react-native-gesture-handler";
import { useEffect, useState } from "react";
import { Stack, useRouter, useSegments } from "expo-router";
import { StatusBar } from "expo-status-bar";
import { useFonts } from "expo-font";
import * as SplashScreen from "expo-splash-screen";
import { Pressable, View } from "react-native";
import { GestureHandlerRootView } from "react-native-gesture-handler";
import { LocaleProvider, useT } from "../src/i18n/provider";
import { fontAssets } from "../src/ui/fonts";
import { SessionProvider, useSession } from "../src/state/session";
import { useRaftStore } from "../src/state/store";
import { AppText } from "../src/ui/text";
import { ConnectionBanner } from "../src/ui/ConnectionBanner";
import { colors } from "../src/ui/theme";
import { color } from "../src/ui/tokens";

SplashScreen.preventAutoHideAsync().catch(() => {});

function SessionRedirect() {
  const session = useSession();
  const segments = useSegments();
  const router = useRouter();

  useEffect(() => {
    if (!session.ready) return;
    const top = segments[0];
    if (top === "design") return;
    if (!session.origin) {
      if (top) router.replace("/");
      return;
    }
    if (!session.signedIn && top !== "login") {
      router.replace("/login");
    }
  }, [router, segments, session.origin, session.ready, session.signedIn]);

  return null;
}

function AccountNotice() {
  const notice = useRaftStore((state) => state.notice);
  const session = useSession();
  const t = useT();
  const [sending, setSending] = useState(false);
  if (!notice) return null;
  const profile = notice === "profile-setup";
  return (
    <View style={{ backgroundColor: color.yellow, paddingHorizontal: 16, paddingVertical: 10 }}>
      <AppText style={{ color: color.ink }}>
        {profile ? t("mobile.account.profile") : t("mobile.account.verify")}
      </AppText>
      {profile ? null : (
        <Pressable disabled={sending} onPress={() => {
          setSending(true);
          void session.resendVerification().finally(() => setSending(false));
        }}>
          <AppText style={{ color: colors.accent, fontWeight: "700", marginTop: 6 }}>
            {sending ? t("mobile.account.sending") : t("mobile.account.resend")}
          </AppText>
        </Pressable>
      )}
    </View>
  );
}

function AppStack() {
  const t = useT();
  return (
    <Stack
      screenOptions={{
        headerShadowVisible: false,
        headerTintColor: colors.accent,
        headerStyle: { backgroundColor: color.yellow },
        headerTitleStyle: { fontFamily: "SpaceGrotesk-700" },
        contentStyle: { backgroundColor: colors.bg },
      }}
    >
      <Stack.Screen name="index" options={{ headerShown: false }} />
      <Stack.Screen name="login" options={{ title: t("pages.publicServer.signIn") }} />
      <Stack.Screen name="(tabs)" options={{ headerShown: false }} />
      <Stack.Screen name="servers" options={{ headerShown: false }} />
      <Stack.Screen name="members" options={{ headerShown: false }} />
      <Stack.Screen name="settings" options={{ headerShown: false }} />
      <Stack.Screen name="saved" options={{ headerShown: false }} />
      <Stack.Screen name="search" options={{ headerShown: false }} />
      <Stack.Screen name="channels/[serverId]" options={{ title: t("mobile.channels.title") }} />
      <Stack.Screen name="messages/[channelId]" options={{ title: t("mobile.messages.title") }} />
      <Stack.Screen name="thread/[threadId]" options={{ title: t("message.threadPanel.thread") }} />
      <Stack.Screen name="task/[taskId]" options={{ headerShown: false }} />
      <Stack.Screen name="design" options={{ title: t("mobile.design.title") }} />
    </Stack>
  );
}

export default function RootLayout() {
  const [loaded] = useFonts(fontAssets);
  useEffect(() => {
    if (loaded) void SplashScreen.hideAsync();
  }, [loaded]);
  if (!loaded) return null;
  return (
    // RNGH gestures (rail drag, image viewer zoom) only activate inside a
    // GestureHandlerRootView on Android — this is the app-wide one.
    <GestureHandlerRootView style={{ flex: 1 }}>
      <SessionProvider>
        <LocaleProvider>
          <StatusBar style="dark" />
          <SessionRedirect />
          <AccountNotice />
          <ConnectionBanner>
            <AppStack />
          </ConnectionBanner>
        </LocaleProvider>
      </SessionProvider>
    </GestureHandlerRootView>
  );
}
