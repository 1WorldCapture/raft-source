import { useCallback, useState } from "react";
import { Alert, FlatList, Pressable, StyleSheet, View } from "react-native";
import { useFocusEffect, useRouter } from "expo-router";
import { ApiError, StaleRequestError } from "../../src/api/client";
import { useT } from "../../src/i18n/provider";
import { isRecord } from "../../src/model/messages";
import { useSession } from "../../src/state/session";
import { RailLayout } from "../../src/home/RailLayout";
import { useServerRail } from "../../src/home/useServerRail";
import { Avatar } from "../../src/ui/Avatar";
import { LoadingScreen, ScreenMessage } from "../../src/ui/screen";
import { PanelHeader } from "../../src/ui/PanelHeader";
import { AppText } from "../../src/ui/text";
import { color, fontSize } from "../../src/ui/tokens";

interface Person {
  id: string;
  name: string;
  kind: "agent" | "human";
  avatarUrl?: string | null;
  status?: "online" | "busy" | "error" | "offline";
  section: "search.scopeAgents" | "search.scopeHumans";
}

export default function MembersScreen() {
  const session = useSession();
  const { current: currentServer } = useServerRail();
  const router = useRouter();
  const t = useT();
  const [people, setPeople] = useState<Person[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!session.serverId) return;
    setError(null);
    try {
      const [agents, members] = await Promise.all([
        session.client.get<unknown>("/agents"),
        session.client.get<unknown>(`/servers/${session.serverId}/members`),
      ]);
      const humans = parseHumans(members).filter((person) => person.id !== session.user?.id);
      setPeople([...parseAgents(agents), ...humans]);
    } catch (caught) {
      if (caught instanceof StaleRequestError) return;
      setError(caught instanceof ApiError ? caught.message : t("mobile.channels.loadFailed"));
    } finally {
      setLoading(false);
    }
  }, [session.client, session.serverId, session.user?.id, t]);

  useFocusEffect(useCallback(() => {
    void load();
  }, [load]));

  const open = useCallback(async (person: Person) => {
    try {
      const data = await session.client.post<unknown>("/channels/dm", person.kind === "agent" ? { agentId: person.id } : { userId: person.id });
      const id = isRecord(data) && typeof data.id === "string" ? data.id : null;
      if (!id) throw new Error("missing");
      router.push({ pathname: "/messages/[channelId]", params: { channelId: id, name: person.name } });
    } catch (caught) {
      if (caught instanceof StaleRequestError) return;
      Alert.alert(t("mobile.members.openFailed"));
    }
  }, [router, session.client, t]);

  if (loading) return <LoadingScreen />;
  if (error) return <ScreenMessage title={t("mobile.channels.loadFailed")} body={error} />;

  return (
    <View style={styles.page}>
      <PanelHeader subtitle={t("layout.mobileTabBar.members")} tone="yellow" title={currentServer?.name || t("layout.mobileTabBar.members")} />
      <RailLayout>
        <FlatList
          data={people}
          keyExtractor={(person) => `${person.kind}:${person.id}`}
          renderItem={({ item, index }) => {
            const showHeader = index === 0 || people[index - 1]?.section !== item.section;
            return (
              <View>
                {showHeader ? <AppText style={styles.section}>{t(item.section)}</AppText> : null}
                <Pressable onPress={() => void open(item)} style={styles.row}>
                  <Avatar name={item.name} kind={item.kind} avatarUrl={item.avatarUrl} status={item.status} size={28} />
                  <AppText style={styles.name}>{item.name}</AppText>
                </Pressable>
              </View>
            );
          }}
        />
      </RailLayout>
    </View>
  );
}

function parseAgents(data: unknown): Person[] {
  const list = Array.isArray(data) ? data : isRecord(data) && Array.isArray(data.agents) ? data.agents : [];
  return list.flatMap((item) => {
    if (!isRecord(item) || typeof item.id !== "string" || item.deletedAt) return [];
    const name = stringField(item.displayName) || stringField(item.name) || item.id;
    return [{ id: item.id, name, kind: "agent", avatarUrl: stringField(item.avatarUrl), status: agentStatus(item), section: "search.scopeAgents" }];
  });
}

function parseHumans(data: unknown): Person[] {
  const list = Array.isArray(data) ? data : isRecord(data) && Array.isArray(data.members) ? data.members : [];
  return list.flatMap((item) => {
    if (!isRecord(item) || typeof item.userId !== "string") return [];
    const name = stringField(item.displayName) || stringField(item.name) || item.userId;
    return [{ id: item.userId, name, kind: "human", avatarUrl: stringField(item.avatarUrl), section: "search.scopeHumans" }];
  });
}

function stringField(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function agentStatus(item: Record<string, unknown>): Person["status"] {
  const value = stringField(item.activity) || stringField(item.status) || "";
  if (value === "error") return "error";
  if (value === "busy" || value === "working" || value === "running") return "busy";
  if (value === "online" || value === "idle") return "online";
  if (!value) return undefined;
  return "offline";
}

const styles = StyleSheet.create({
  page: { backgroundColor: color.page, flex: 1 },
  section: { ...fontSize.group, color: color.ink, fontWeight: "700", letterSpacing: 0.8, paddingHorizontal: 16, paddingTop: 16, textTransform: "uppercase" },
  row: { alignItems: "center", borderColor: "transparent", borderWidth: 2, flexDirection: "row", gap: 10, marginBottom: 4, paddingHorizontal: 16, paddingVertical: 8 },
  name: { ...fontSize.list, color: color.ink, flex: 1, fontWeight: "500" },
});
