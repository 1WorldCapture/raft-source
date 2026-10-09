import { useCallback, useEffect, useRef, useState } from "react";
import { ActivityIndicator, FlatList, Pressable, StyleSheet, View } from "react-native";
import { ApiError, StaleRequestError } from "../../src/api/client";
import { useT } from "../../src/i18n/provider";
import { isRecord } from "../../src/model/messages";
import { MessagePane } from "../../src/screens/MessagePane";
import { useSession } from "../../src/state/session";
import { AppText } from "../../src/ui/text";
import { LoadingScreen, PrimaryButton, ScreenMessage } from "../../src/ui/screen";
import { color, fontSize } from "../../src/ui/tokens";
import { TabHeader } from "../../src/home/TabHeader";
import { useDirectory } from "../../src/home/useDirectory";
import { useServerRail } from "../../src/home/useServerRail";
import { useServerRole, useServerRoleKnown } from "../../src/home/serverRole";
import { useServerPm } from "../../src/home/useServerPm";
import { parsePmAgentChoices, selectPmBody, type PmAgentChoice } from "../../src/home/pmState";
import { closeChoosePm, useChoosePm } from "../../src/home/choosePm";

/**
 * PM tab (Rethink UI stage D). Reads GET /api/servers/:slug/pm on focus.
 * A set PM opens that DM (creating it first when dmChannelId is empty).
 * An unset server asks an owner or admin to pick an agent, or to skip.
 */
export default function PmScreen() {
  const t = useT();
  const { current } = useServerRail();
  useDirectory();
  const roleFromStore = useServerRole();
  const roleKnown = useServerRoleKnown() || current?.role != null;
  const role = current?.role ?? roleFromStore;
  const { state, loading, error, reload } = useServerPm(current?.slug ?? null);
  const choosing = useChoosePm();
  const kind = selectPmBody({ role, roleKnown, loading, error, state, choosing });

  useEffect(() => {
    if (state?.pm) closeChoosePm();
  }, [state?.pm]);

  let body;
  if (kind === "loading") {
    body = <View style={styles.centered}><ActivityIndicator color={color.ink} /></View>;
  } else if (kind === "error") {
    const failed = t("mobile.pm.loadFailed");
    body = (
      <View style={styles.centered}>
        <AppText style={styles.guideTitle}>{failed}</AppText>
        {error && error !== failed ? <AppText style={styles.guideBody}>{error}</AppText> : null}
        <PrimaryButton label={t("mobile.preview.retry")} onPress={() => void reload()} />
      </View>
    );
  } else if (kind === "conversation" && state?.pm) {
    body = (
      <PmConversation
        agentId={state.pm.agentId}
        dmChannelId={state.dmChannelId}
        title={state.pm.displayName || state.pm.name}
      />
    );
  } else if (kind === "setup") {
    body = <PmSetupGuide onChanged={() => { closeChoosePm(); void reload(); }} />;
  } else if (kind === "enable") {
    body = <ScreenMessage title={t("mobile.pm.enableTitle")} body={t("mobile.pm.enableBody")} />;
  } else if (kind === "pickLater") {
    body = <ScreenMessage title={t("mobile.pm.pickLaterTitle")} body={t("mobile.pm.pickLaterBody")} />;
  } else if (kind === "wait") {
    body = <ScreenMessage title={t("mobile.pm.waitTitle")} body={t("mobile.pm.waitBody")} />;
  } else {
    body = <ScreenMessage title={t("mobile.pm.waitPickTitle")} body={t("mobile.pm.waitPickBody")} />;
  }

  return (
    <View style={styles.page}>
      <TabHeader />
      <View style={styles.body}>{body}</View>
    </View>
  );
}

function PmConversation({ agentId, dmChannelId, title }: { agentId: string; dmChannelId: string | null; title: string }) {
  const session = useSession();
  const t = useT();
  const [channelId, setChannelId] = useState(dmChannelId);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setChannelId(dmChannelId);
    setError(null);
  }, [agentId, dmChannelId]);

  useEffect(() => {
    if (channelId || error) return;
    let cancelled = false;
    void session.client.post<unknown>("/channels/dm", { agentId }).then((data) => {
      if (cancelled) return;
      const id = isRecord(data) && typeof data.id === "string" ? data.id : null;
      if (!id) {
        setError(t("mobile.pm.pickFailed"));
        return;
      }
      setChannelId(id);
    }).catch((caught: unknown) => {
      if (cancelled || caught instanceof StaleRequestError) return;
      setError(caught instanceof ApiError ? caught.message : t("mobile.pm.pickFailed"));
    });
    return () => {
      cancelled = true;
    };
  }, [agentId, channelId, error, session.client, t]);

  if (error) return <ScreenMessage title={t("mobile.pm.pickFailed")} body={error} />;
  if (!channelId) return <LoadingScreen />;
  return <MessagePane channelId={channelId} direct embedded title={title} />;
}

function PmSetupGuide({ onChanged }: { onChanged: () => void }) {
  const session = useSession();
  const t = useT();
  const tRef = useRef(t);
  tRef.current = t;
  const { current } = useServerRail();
  const [agents, setAgents] = useState<PmAgentChoice[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      const data = await session.client.get<unknown>("/agents");
      setAgents(parsePmAgentChoices(data));
    } catch (caught) {
      if (caught instanceof StaleRequestError) return;
      setError(caught instanceof ApiError ? caught.message : tRef.current("mobile.pm.loadFailed"));
    } finally {
      setLoading(false);
    }
  }, [session.client]);

  useEffect(() => {
    void load();
  }, [load]);

  const choose = useCallback(async (agent: PmAgentChoice) => {
    if (!current?.slug || busy) return;
    setBusy(true);
    setError(null);
    try {
      await session.client.request(`/servers/${encodeURIComponent(current.slug)}/pm`, { method: "PUT", body: { agentId: agent.id } });
      onChanged();
    } catch (caught) {
      if (caught instanceof StaleRequestError) return;
      setError(caught instanceof ApiError ? caught.message : t("mobile.pm.pickFailed"));
    } finally {
      setBusy(false);
    }
  }, [busy, current?.slug, onChanged, session.client, t]);

  const skip = useCallback(async () => {
    if (!current?.slug || busy) return;
    setBusy(true);
    setError(null);
    try {
      await session.client.post(`/servers/${encodeURIComponent(current.slug)}/pm/dismiss-setup`, {});
      onChanged();
    } catch (caught) {
      if (caught instanceof StaleRequestError) return;
      setError(caught instanceof ApiError ? caught.message : t("mobile.pm.pickFailed"));
    } finally {
      setBusy(false);
    }
  }, [busy, current?.slug, onChanged, session.client, t]);

  if (loading) return <View style={styles.centered}><ActivityIndicator color={color.ink} /></View>;

  return (
    <View style={styles.guide}>
      <AppText style={styles.guideTitle}>{t("mobile.pm.pickTitle")}</AppText>
      <AppText style={styles.guideBody}>{agents.length === 0 ? t("mobile.pm.noAgents") : t("mobile.pm.pickBody")}</AppText>
      {error ? <AppText style={styles.error}>{error}</AppText> : null}
      <PrimaryButton disabled={busy} label={t("mobile.pm.skip")} onPress={() => void skip()} />
      <FlatList
        data={agents}
        keyExtractor={(agent) => agent.id}
        renderItem={({ item }) => (
          <Pressable accessibilityRole="button" disabled={busy} onPress={() => void choose(item)} style={styles.row}>
            <AppText style={styles.rowName}>{item.name}</AppText>
          </Pressable>
        )}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  page: { backgroundColor: color.page, flex: 1 },
  body: { flex: 1 },
  centered: { alignItems: "center", flex: 1, justifyContent: "center" },
  guide: { flex: 1, gap: 12, padding: 16 },
  guideTitle: { color: color.ink, fontSize: 18, fontWeight: "700" },
  guideBody: { color: color.muted, fontSize: fontSize.input.fontSize },
  error: { color: color.red, fontSize: 14 },
  row: { borderBottomColor: color.border, borderBottomWidth: 1, paddingVertical: 14 },
  rowName: { color: color.ink, fontSize: 16, fontWeight: "700" },
});
