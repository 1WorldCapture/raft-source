import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { useFocusEffect, useNavigation, useRouter } from "expo-router";
import {
  ActivityIndicator,
  FlatList,
  Image,
  Keyboard,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import { ApiError, StaleRequestError } from "../api/client";
import { createRandomId } from "../api/ids";
import {
  historyLimited,
  isRecord,
  maxSeq,
  minSeq,
  parseMessage,
  parseMessagePage,
  parseThreadSummaries,
  senderLabel,
  type RaftMessage,
} from "../model/messages";
import { mentionsCurrentUser } from "../model/mentions";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useSession } from "../state/session";
import { useRaftStore } from "../state/store";
import { RichText } from "../ui/richText";
import { colors, space } from "../ui/theme";

const PAGE = 50;
const EMPTY_MESSAGES: RaftMessage[] = [];

interface MentionCandidate {
  id: string;
  name: string;
  type: "user" | "agent";
  label: string;
}

function sendError(error: unknown): string {
  if (!(error instanceof ApiError)) return "网络不通，请稍后再试";
  if (error.status === 0) return "网络不通，请稍后再试";
  if (error.status === 403) return "没有权限，或这个频道是只读的";
  if (error.status === 409 && error.code === "channel_archived") return "频道已归档";
  if (error.status === 409 && error.code === "random_id_conflict") return "这条消息的内容和上次不一致，请改一下再发";
  return error.error || "发送失败";
}

function mentionQuery(draft: string): string | null {
  const match = /(?:^|\s)@([\p{L}\p{N}_-]*)$/u.exec(draft);
  return match ? match[1] ?? "" : null;
}

export function MessagePane({
  channelId,
  title,
  thread,
  parentChannelId,
  parentMessageId,
}: {
  channelId: string;
  title: string;
  thread?: boolean;
  parentChannelId?: string;
  parentMessageId?: string;
}) {
  const session = useSession();
  const insets = useSafeAreaInsets();
  const sessionRef = useRef(session);
  sessionRef.current = session;
  const navigation = useNavigation();
  const router = useRouter();
  const messages = useRaftStore((state) => state.messagesByChannel[channelId] ?? EMPTY_MESSAGES);
  const summaries = useRaftStore((state) => state.threadSummaries);
  const userId = session.user?.id;
  const [loading, setLoading] = useState(true);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [hasMore, setHasMore] = useState(true);
  const [limited, setLimited] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [androidKeyboard, setAndroidKeyboard] = useState(0);
  const [mentions, setMentions] = useState<MentionCandidate[]>([]);
  const [candidates, setCandidates] = useState<MentionCandidate[]>([]);
  const [memberCache, setMemberCache] = useState<MentionCandidate[] | null>(null);

  useLayoutEffect(() => {
    // setOptions replaces the navigation object. Depending on it retriggers this
    // effect and overflows the update depth as soon as a channel opens.
    navigation.setOptions({ title: title || (thread ? "Thread" : "Messages") });
  }, [thread, title]);

  useEffect(() => {
    if (Platform.OS !== "android") return;
    // Edge-to-edge ignores adjustResize, so the IME covers the composer and
    // the mention list. Pad by the reported keyboard height instead.
    const show = Keyboard.addListener("keyboardDidShow", (event) => {
      setAndroidKeyboard(event.endCoordinates.height);
    });
    const hide = Keyboard.addListener("keyboardDidHide", () => setAndroidKeyboard(0));
    return () => {
      show.remove();
      hide.remove();
    };
  }, []);

  useFocusEffect(useCallback(() => {
    sessionRef.current.setFocusedChannelId(channelId);
    if (thread && channelId !== "pending-thread") sessionRef.current.joinThread(channelId);
    return () => {
      sessionRef.current.clearFocusedChannelId(channelId);
      if (thread && channelId !== "pending-thread") sessionRef.current.leaveThread(channelId);
    };
  }, [channelId, thread]));

  useEffect(() => {
    let cancelled = false;
    if (channelId === "pending-thread") {
      setLoading(false);
      return;
    }
    void (async () => {
      setLoading((useRaftStore.getState().messagesByChannel[channelId] ?? []).length === 0);
      setError(null);
      try {
        const data = await sessionRef.current.client.get<unknown>(`/messages/channel/${channelId}?limit=${PAGE}`);
        if (cancelled) return;
        const page = parseMessagePage(data);
        useRaftStore.getState().upsertMessages(page);
        useRaftStore.getState().setThreadSummaries(parseThreadSummaries(data));
        setHasMore(page.length >= PAGE);
        setLimited(historyLimited(data));
        const seq = maxSeq(page);
        if (seq > 0) void sessionRef.current.markRead(channelId, seq);
      } catch (caught) {
        if (cancelled || caught instanceof StaleRequestError) return;
        setError(sendError(caught));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [channelId]);

  async function loadOlder() {
    if (!hasMore || loadingOlder) return;
    const before = minSeq(messages);
    if (before === null) return;
    setLoadingOlder(true);
    try {
      const data = await sessionRef.current.client.get<unknown>(`/messages/channel/${channelId}?limit=${PAGE}&before=${before}`);
      const page = parseMessagePage(data);
      useRaftStore.getState().upsertMessages(page);
      setHasMore(page.length >= PAGE);
      setLimited((current) => current || historyLimited(data));
    } catch (caught) {
      if (caught instanceof StaleRequestError) return;
      setError(sendError(caught));
    } finally {
      setLoadingOlder(false);
    }
  }

  async function loadMembers() {
    if (memberCache) return memberCache;
    if (thread && !parentChannelId) return [];
    const scope = thread ? parentChannelId : channelId;
    if (!scope) return [];
    const data = await sessionRef.current.client.get<unknown>(`/channels/${scope}/members`);
    const record = isRecord(data) ? data : {};
    const next: MentionCandidate[] = [];
    for (const agent of Array.isArray(record.agents) ? record.agents : []) {
      if (!isRecord(agent) || typeof agent.name !== "string" || typeof agent.id !== "string") continue;
      next.push({
        id: agent.id,
        name: agent.name,
        type: "agent",
        label: typeof agent.displayName === "string" ? agent.displayName : agent.name,
      });
    }
    for (const human of Array.isArray(record.humans) ? record.humans : []) {
      if (!isRecord(human) || typeof human.name !== "string" || typeof human.id !== "string") continue;
      next.push({
        id: human.id,
        name: human.name,
        type: "user",
        label: typeof human.displayName === "string" ? human.displayName : human.name,
      });
    }
    setMemberCache(next);
    return next;
  }

  async function onChangeDraft(value: string) {
    setDraft(value);
    const query = mentionQuery(value);
    if (query === null) {
      setCandidates([]);
      return;
    }
    const members = await loadMembers().catch(() => [] as MentionCandidate[]);
    const needle = query.toLowerCase();
    setCandidates(members.filter((member) => member.name.toLowerCase().includes(needle) || member.label.toLowerCase().includes(needle)).slice(0, 6));
  }

  function chooseMention(candidate: MentionCandidate) {
    const next = draft.replace(/(?:^|\s)@[\p{L}\p{N}_-]*$/u, (prefix) => `${prefix.startsWith(" ") || prefix.startsWith("\n") ? prefix[0] : ""}@${candidate.name} `);
    setDraft(next.endsWith(" ") ? next : `${next} `);
    setMentions((current) => current.some((item) => item.id === candidate.id) ? current : [...current, candidate]);
    setCandidates([]);
  }

  async function deliver(content: string, randomId: string, optimisticId: string) {
    const activeMentions = mentions.filter((mention) => content.includes(`@${mention.name}`));
    try {
      let targetChannelId = channelId;
      if (thread && parentChannelId && parentMessageId && channelId === "pending-thread") {
        const created = await sessionRef.current.client.post<{ threadChannelId?: string }>(`/channels/${parentChannelId}/threads`, { parentMessageId });
        if (!created.threadChannelId) throw new Error("Thread was not created");
        targetChannelId = created.threadChannelId;
        const optimistic = useRaftStore.getState().messagesByChannel["pending-thread"]?.find((item) => item.id === optimisticId);
        useRaftStore.getState().dropMessage("pending-thread", optimisticId);
        if (optimistic) useRaftStore.getState().upsertMessages([{ ...optimistic, channelId: targetChannelId }]);
        sessionRef.current.joinThread(targetChannelId);
        useRaftStore.getState().setThreadSummaries({
          [parentMessageId]: { threadChannelId: targetChannelId, replyCount: 0 },
        });
      }
      const data = await sessionRef.current.client.post<unknown>("/v2/messages", {
        channelId: targetChannelId,
        content,
        randomId,
        mentions: activeMentions.map((mention) => ({ type: mention.type, id: mention.id, name: mention.name })),
      });
      const record = isRecord(data) ? data : null;
      const message = parseMessage(record?.message) ?? parseMessage(data);
      if (message) useRaftStore.getState().upsertMessages([message]);
      else useRaftStore.getState().upsertMessages(useRaftStore.getState().messagesByChannel[targetChannelId]?.filter((item) => item.id !== optimisticId) ?? []);
    } catch (caught) {
      if (caught instanceof StaleRequestError) return;
      const current = useRaftStore.getState().messagesByChannel[channelId] ?? [];
      useRaftStore.getState().upsertMessages(current.map((item) => item.id === optimisticId ? { ...item, pending: "failed" as const } : item));
      setError(sendError(caught));
    }
  }

  async function send(existing?: RaftMessage) {
    const content = (existing?.content ?? draft).trim();
    if (!content) return;
    if (content.length > 32000) {
      setError("消息超过 32000 个字符");
      return;
    }
    const randomId = existing?.randomId ?? createRandomId();
    const optimisticId = existing?.id ?? `optimistic-${randomId}`;
    const optimistic: RaftMessage = {
      id: optimisticId,
      channelId,
      randomId,
      content,
      senderId: userId,
      senderType: "user",
      senderName: session.user?.displayName || session.user?.name || "You",
      createdAt: new Date().toISOString(),
      pending: "sending",
    };
    useRaftStore.getState().upsertMessages([optimistic]);
    if (!existing) {
      setDraft("");
      setMentions([]);
      setCandidates([]);
    }
    await deliver(content, randomId, optimisticId);
  }

  function removeFailed(message: RaftMessage) {
    const bucket = (useRaftStore.getState().messagesByChannel[channelId] ?? []).filter((item) => item.id !== message.id);
    useRaftStore.setState({
      messagesByChannel: { ...useRaftStore.getState().messagesByChannel, [channelId]: bucket },
    });
  }

  const query = mentionQuery(draft);

  if (loading && messages.length === 0) {
    return <View style={styles.center}><ActivityIndicator color={colors.accent} /></View>;
  }

  return (
    <KeyboardAvoidingView
      behavior={Platform.OS === "ios" ? "padding" : undefined}
      keyboardVerticalOffset={88}
      style={[styles.page, androidKeyboard > 0 ? { paddingBottom: androidKeyboard } : null]}
    >
      <FlatList
        data={[...messages].reverse()}
        inverted
        keyExtractor={(item) => item.id}
        onEndReached={() => void loadOlder()}
        onEndReachedThreshold={0.3}
        contentContainerStyle={styles.list}
        ListFooterComponent={loadingOlder ? <ActivityIndicator color={colors.accent} /> : limited ? <Text style={styles.note}>更早的消息受套餐限制不可见</Text> : null}
        ListEmptyComponent={<Text style={styles.note}>还没有消息。</Text>}
        renderItem={({ item }) => {
          const summary = summaries[item.id];
          const mine = item.senderId === userId;
          const mentioned = mentionsCurrentUser(item.mentions, userId);
          return (
            <View style={[styles.item, mentioned && styles.mentioned]}>
              <View style={[styles.bubble, mine ? styles.mine : styles.other, item.messageType === "system" && styles.system, item.pending === "failed" && styles.failed]}>
                {item.messageType === "system" ? null : (
                  <Text style={[styles.sender, mine && styles.senderMine]}>
                    {senderLabel(item)}{item.senderType === "agent" ? " · Agent" : ""}
                    {item.createdAt ? `  ${new Date(item.createdAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}` : ""}
                  </Text>
                )}
                <RichText content={item.content} mentions={item.mentions} mine={mine && item.messageType !== "system"} />
                {item.attachments?.map((attachment) => (
                  <View key={attachment.id ?? attachment.filename} style={styles.attachment}>
                    {attachment.thumbnailUrl ? <Image source={{ uri: attachment.thumbnailUrl }} style={styles.thumb} /> : null}
                    <Text style={[styles.file, mine && styles.senderMine]}>{attachment.filename}</Text>
                  </View>
                ))}
                {item.reactions && item.reactions.length > 0 ? (
                  <Text style={[styles.reactions, mine && styles.senderMine]}>
                    {item.reactions.map((reaction) => `${reaction.emoji} ${reaction.count}`).join("  ")}
                  </Text>
                ) : null}
                {item.pending === "sending" ? <Text style={styles.pending}>发送中</Text> : null}
                {item.pending === "failed" ? (
                  <View style={styles.retryRow}>
                    <Pressable onPress={() => void send(item)}><Text style={styles.retry}>重发</Text></Pressable>
                    <Pressable onPress={() => removeFailed(item)}><Text style={styles.retry}>删除</Text></Pressable>
                  </View>
                ) : null}
              </View>
              {!thread && (summary || item.threadId) ? (
                <Pressable
                  onPress={() => router.push({
                    pathname: "/thread/[threadId]",
                    params: {
                      threadId: summary?.threadChannelId ?? item.threadId ?? "pending-thread",
                      parentChannelId: channelId,
                      parentMessageId: item.id,
                      title: "Thread",
                    },
                  })}
                  style={styles.thread}
                >
                  <Text style={styles.threadText}>{summary ? `${summary.replyCount} 条回复` : "查看线程"}</Text>
                </Pressable>
              ) : null}
            </View>
          );
        }}
      />
      {query !== null && candidates.length > 0 ? (
        <View style={styles.candidates}>
          {candidates.map((candidate) => (
            <Pressable key={candidate.id} onPress={() => chooseMention(candidate)} style={styles.candidate}>
              <Text style={styles.candidateName}>@{candidate.name}</Text>
              <Text style={styles.candidateLabel}>{candidate.label}</Text>
            </Pressable>
          ))}
        </View>
      ) : null}
      {error ? <Text style={styles.error}>{error}</Text> : null}
      <View style={[styles.composer, { paddingBottom: androidKeyboard > 0 ? 8 : Math.max(insets.bottom, 28) }]}>
        <TextInput
          multiline
          onChangeText={(value) => void onChangeDraft(value)}
          placeholder={thread ? "回复" : "消息"}
          placeholderTextColor={colors.muted}
          style={styles.input}
          value={draft}
        />
        <Pressable disabled={draft.trim().length === 0} onPress={() => void send()} style={styles.send}>
          <Text style={styles.sendText}>发送</Text>
        </Pressable>
      </View>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  page: { flex: 1, backgroundColor: colors.bg },
  center: { flex: 1, alignItems: "center", justifyContent: "center", backgroundColor: colors.bg },
  list: { padding: space.md },
  item: { marginBottom: space.sm },
  mentioned: { backgroundColor: "#fff7ed", borderRadius: 12 },
  bubble: { borderRadius: 16, maxWidth: "88%", paddingHorizontal: 12, paddingVertical: 8 },
  mine: { alignSelf: "flex-end", backgroundColor: colors.mine },
  other: { alignSelf: "flex-start", backgroundColor: colors.other, borderColor: colors.line, borderWidth: StyleSheet.hairlineWidth },
  system: { alignSelf: "center", backgroundColor: "transparent" },
  failed: { borderColor: colors.danger, borderWidth: 1 },
  sender: { color: colors.muted, fontSize: 12, fontWeight: "600", marginBottom: 2 },
  senderMine: { color: "#dbe4ff" },
  attachment: { marginTop: 6 },
  thumb: { borderRadius: 8, height: 120, width: 160 },
  file: { color: colors.ink, fontSize: 13, marginTop: 2 },
  reactions: { color: colors.muted, fontSize: 13, marginTop: 4 },
  pending: { color: "#dbe4ff", fontSize: 12, marginTop: 4 },
  retryRow: { flexDirection: "row", gap: space.md, marginTop: 4 },
  retry: { color: colors.danger, fontWeight: "700" },
  thread: { alignSelf: "flex-start", marginLeft: 8, marginTop: 4 },
  threadText: { color: colors.accent, fontSize: 13, fontWeight: "600" },
  note: { color: colors.muted, padding: space.md, textAlign: "center" },
  error: { color: colors.danger, paddingHorizontal: space.md },
  candidates: { backgroundColor: colors.card, borderTopColor: colors.line, borderTopWidth: StyleSheet.hairlineWidth },
  candidate: { paddingHorizontal: space.md, paddingVertical: 8 },
  candidateName: { color: colors.ink, fontWeight: "600" },
  candidateLabel: { color: colors.muted, fontSize: 12 },
  composer: {
    alignItems: "flex-end",
    backgroundColor: colors.card,
    borderTopColor: colors.line,
    borderTopWidth: StyleSheet.hairlineWidth,
    flexDirection: "row",
    gap: space.sm,
    padding: space.sm,
  },
  input: { color: colors.ink, flex: 1, fontSize: 16, maxHeight: 120, paddingHorizontal: space.sm, paddingVertical: 8 },
  send: { paddingHorizontal: space.sm, paddingVertical: 10 },
  sendText: { color: colors.accent, fontSize: 16, fontWeight: "700" },
});
