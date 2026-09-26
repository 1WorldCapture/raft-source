import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useFocusEffect, useNavigation, useRouter } from "expo-router";
import {
  ActivityIndicator,
  FlatList,
  Image,
  Keyboard,
  KeyboardAvoidingView,
  Linking,
  Modal,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
  type NativeScrollEvent,
  type NativeSyntheticEvent,
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
  type MessageAttachment,
  type RaftMessage,
} from "../model/messages";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useSession } from "../state/session";
import { useRaftStore } from "../state/store";
import { colors, space } from "../ui/theme";
import { bodyFont, color } from "../ui/tokens";
import { useT } from "../i18n/provider";
import { MessageRow, type LinkedTaskChip } from "./MessageRow";
import { computeMessageGrouping, hiddenSystemIds, systemRunHeads } from "./messageGrouping";
import { formatDayLabel, formatMessageStamp } from "./messageTime";
import { dmReadByPeer, parsePeerReads, type PeerRead } from "./readReceipt";

const PAGE = 50;
const EMPTY_MESSAGES: RaftMessage[] = [];
const scrollOffsets = new Map<string, number>();

interface MentionCandidate {
  id: string;
  name: string;
  type: "user" | "agent";
  label: string;
}

function sendError(error: unknown, t: (id: "mobile.network.later" | "mobile.messages.forbidden" | "mobile.messages.archived" | "mobile.messages.conflict" | "mobile.messages.sendFailed") => string): string {
  if (!(error instanceof ApiError)) return t("mobile.network.later");
  if (error.status === 0) return t("mobile.network.later");
  if (error.status === 403) return t("mobile.messages.forbidden");
  if (error.status === 409 && error.code === "channel_archived") return t("mobile.messages.archived");
  if (error.status === 409 && error.code === "random_id_conflict") return t("mobile.messages.conflict");
  return error.error || t("mobile.messages.sendFailed");
}

function linkedTasks(data: unknown): Map<string, LinkedTaskChip> {
  const list = Array.isArray(data) ? data : isRecord(data) && Array.isArray(data.tasks) ? data.tasks : [];
  const tasks = new Map<string, LinkedTaskChip>();
  for (const item of list) {
    if (!isRecord(item) || typeof item.messageId !== "string" || typeof item.taskNumber !== "number") continue;
    tasks.set(item.messageId, {
      taskNumber: item.taskNumber,
      claimedByName: typeof item.claimedByName === "string" ? item.claimedByName : null,
      status: typeof item.status === "string" ? item.status : undefined,
    });
  }
  return tasks;
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
  const t = useT();
  const grouping = useMemo(() => {
    const standalone = new Set<string>();
    for (const message of messages) {
      if (message.threadId || summaries[message.id]) standalone.add(message.id);
    }
    return computeMessageGrouping(messages, { standaloneIds: standalone });
  }, [messages, summaries]);
  const systemHeads = useMemo(() => systemRunHeads(messages), [messages]);
  const body = bodyFont(session.user?.preferredMessageBodyFontSize);
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
  const [unseen, setUnseen] = useState(0);
  const [stickyAt, setStickyAt] = useState<string | null>(null);
  const [collapseLong, setCollapseLong] = useState(true);
  const [dm, setDm] = useState(false);
  const [peers, setPeers] = useState<PeerRead[]>([]);
  const [savedIds, setSavedIds] = useState<Set<string>>(new Set());
  const [tasksByMessage, setTasksByMessage] = useState<Map<string, LinkedTaskChip>>(new Map());
  const [openSystems, setOpenSystems] = useState<Set<string>>(new Set());
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const listRef = useRef<FlatList<RaftMessage>>(null);
  const nearBottom = useRef(true);
  const lastOffset = useRef(0);
  const loadingOlderRef = useRef(false);
  const checkedSaved = useRef(new Set<string>());
  const previousCount = useRef(messages.length);
  const hiddenSystems = useMemo(() => hiddenSystemIds(messages, openSystems), [messages, openSystems]);

  useLayoutEffect(() => {
    // setOptions replaces the navigation object. Depending on it retriggers this
    // effect and overflows the update depth as soon as a channel opens.
    navigation.setOptions({ title: title || (thread ? t("message.threadPanel.thread") : t("mobile.messages.title")) });
  }, [thread, title, t]);

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
    checkedSaved.current = new Set();
    setSavedIds(new Set());
    setPeers([]);
    setDm(false);
    setCollapseLong(true);
    setOpenSystems(new Set());
    setUnseen(0);
    setStickyAt(null);
    previousCount.current = useRaftStore.getState().messagesByChannel[channelId]?.length ?? 0;
    const savedOffset = scrollOffsets.get(channelId) ?? 0;
    lastOffset.current = savedOffset;
    nearBottom.current = savedOffset < 100;
    const frame = requestAnimationFrame(() => listRef.current?.scrollToOffset({ offset: savedOffset, animated: false }));
    return () => {
      cancelAnimationFrame(frame);
      scrollOffsets.set(channelId, lastOffset.current);
    };
  }, [channelId]);

  useEffect(() => {
    const grew = messages.length - previousCount.current;
    previousCount.current = messages.length;
    if (grew <= 0 || loadingOlderRef.current) return;
    if (nearBottom.current) setUnseen(0);
    else setUnseen((count) => count + grew);
  }, [messages.length]);

  useEffect(() => {
    if (channelId === "pending-thread") return;
    let cancelled = false;
    void sessionRef.current.client.get<unknown>(`/channels/${channelId}`).then((data) => {
      if (cancelled || !isRecord(data)) return;
      setDm(data.type === "dm");
      if (typeof data.collapseLongMessages === "boolean") setCollapseLong(data.collapseLongMessages);
      const nextPeers = parsePeerReads(data);
      if (nextPeers) setPeers(nextPeers);
    }).catch(() => undefined);
    void sessionRef.current.client.get<unknown>("/tasks/server?detail=summary").then((data) => {
      if (!cancelled) setTasksByMessage(linkedTasks(data));
    }).catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [channelId]);

  useEffect(() => {
    const ids = messages.map((message) => message.id).filter((id) => !id.startsWith("optimistic-") && !checkedSaved.current.has(id));
    if (ids.length === 0 || channelId === "pending-thread") return;
    for (const id of ids) checkedSaved.current.add(id);
    void sessionRef.current.client.post<unknown>("/channels/saved/check", { messageIds: ids }).then((data) => {
      const saved = isRecord(data) && Array.isArray(data.savedIds) ? data.savedIds.filter((id): id is string => typeof id === "string") : null;
      if (!saved) return;
      setSavedIds((current) => {
        const next = new Set(current);
        for (const id of saved) next.add(id);
        return next;
      });
    }).catch(() => undefined);
  }, [channelId, messages]);

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
        setError(sendError(caught, t));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [channelId]);

  async function loadOlder() {
    if (!hasMore || loadingOlder || loadingOlderRef.current) return;
    const before = minSeq(messages);
    if (before === null) return;
    loadingOlderRef.current = true;
    setLoadingOlder(true);
    try {
      const data = await sessionRef.current.client.get<unknown>(`/messages/channel/${channelId}?limit=${PAGE}&before=${before}`);
      const page = parseMessagePage(data);
      useRaftStore.getState().upsertMessages(page);
      setHasMore(page.length >= PAGE);
      setLimited((current) => current || historyLimited(data));
    } catch (caught) {
      if (caught instanceof StaleRequestError) return;
      setError(sendError(caught, t));
    } finally {
      loadingOlderRef.current = false;
      setLoadingOlder(false);
    }
  }

  async function openAttachment(attachment: MessageAttachment, disposition: "inline" | "attachment") {
    if (!attachment.id) return;
    try {
      const data = await sessionRef.current.client.get<unknown>(`/attachments/${attachment.id}/url?disposition=${disposition}`);
      const url = isRecord(data) && typeof data.url === "string" ? data.url : null;
      if (!url) return;
      if (disposition === "inline") setPreviewUrl(url);
      else await Linking.openURL(url);
    } catch (caught) {
      if (caught instanceof StaleRequestError) return;
      setError(sendError(caught, t));
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
        if (!created.threadChannelId) throw new Error(t("mobile.thread.missing"));
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
      setError(sendError(caught, t));
    }
  }

  async function send(existing?: RaftMessage) {
    const content = (existing?.content ?? draft).trim();
    if (!content) return;
    if (content.length > 32000) {
      setError(t("mobile.messages.tooLong"));
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

  const viewabilityConfig = useRef({ itemVisiblePercentThreshold: 20 }).current;
  const onViewableItemsChanged = useRef((info: { viewableItems: Array<{ index: number | null; item: RaftMessage }> }) => {
    let createdAt: string | undefined;
    let best = -1;
    for (const entry of info.viewableItems) {
      if (entry.index !== null && entry.index >= best && entry.item.createdAt) {
        best = entry.index;
        createdAt = entry.item.createdAt;
      }
    }
    if (createdAt) setStickyAt(createdAt);
  }).current;
  const query = mentionQuery(draft);
  const timeOptions = { now: new Date(), yesterdayLabel: t("message.dateDivider.yesterday"), todayLabel: t("message.dateDivider.today") };

  if (loading && messages.length === 0) {
    return <View style={styles.center}><ActivityIndicator color={colors.accent} /></View>;
  }

  return (
    <KeyboardAvoidingView
      behavior={Platform.OS === "ios" ? "padding" : undefined}
      keyboardVerticalOffset={88}
      style={[styles.page, androidKeyboard > 0 ? { paddingBottom: androidKeyboard } : null]}
    >
      <View style={styles.timeline}>
        <FlatList
          ref={listRef}
          data={[...messages].reverse()}
          inverted
          keyExtractor={(item) => item.id}
          maintainVisibleContentPosition={{ minIndexForVisible: 0, autoscrollToTopThreshold: 100 }}
          onEndReached={() => void loadOlder()}
          onEndReachedThreshold={0.3}
          onScroll={(event: NativeSyntheticEvent<NativeScrollEvent>) => {
            const offset = event.nativeEvent.contentOffset.y;
            lastOffset.current = offset;
            nearBottom.current = offset < 100;
            if (offset < 100) setUnseen((count) => (count === 0 ? count : 0));
          }}
          onViewableItemsChanged={onViewableItemsChanged}
          scrollEventThrottle={32}
          viewabilityConfig={viewabilityConfig}
          contentContainerStyle={styles.list}
          ListFooterComponent={loadingOlder
            ? <ActivityIndicator color={colors.accent} />
            : limited
              ? <Text style={styles.note}>{t("mobile.messages.historyLimited")}</Text>
              : !hasMore && messages.length > 0
                ? <Text style={styles.note}>{t(thread ? "message.historyTop.beginningOfReplies" : "message.historyTop.beginningOfMessages")}</Text>
                : null}
          ListEmptyComponent={<Text style={styles.note}>{t("mobile.messages.empty")}</Text>}
          renderItem={({ item }) => {
            if (hiddenSystems.has(item.id)) return null;
            const summary = summaries[item.id];
            const group = grouping.get(item.id) ?? { isFirstInGroup: true, showAvatar: item.messageType !== "system", showDayDivider: false, dayKey: "" };
            const threadCountLabel = !thread && (summary || item.threadId)
              ? `${summary ? t("message.inlineThreadReplies.replyCount", { count: summary.replyCount }) : t("mobile.messages.viewThread")}${summary?.unreadCount ? ` · ${t("message.inlineThreadReplies.newReplyCount", { count: summary.unreadCount })}` : ""} ›`
              : undefined;
            const systemCount = systemHeads.get(item.id);
            return (
              <MessageRow
                bodyFontSize={body.fontSize}
                bodyLineHeight={body.lineHeight}
                collapseLabel={t("message.content.collapse")}
                collapseLong={collapseLong}
                currentUserId={userId}
                dayLabel={item.createdAt && group.showDayDivider ? formatDayLabel(item.createdAt, timeOptions) : ""}
                deleteLabel={t("mobile.messages.delete")}
                group={group}
                linkedTask={tasksByMessage.get(item.id)}
                message={item}
                onDelete={() => removeFailed(item)}
                onOpenAttachment={(attachment, disposition) => void openAttachment(attachment, disposition)}
                onOpenThread={threadCountLabel ? () => router.push({
                  pathname: "/thread/[threadId]",
                  params: {
                    threadId: summary?.threadChannelId ?? item.threadId ?? "pending-thread",
                    parentChannelId: channelId,
                    parentMessageId: item.id,
                    title: t("message.threadPanel.thread"),
                  },
                }) : undefined}
                onResend={() => void send(item)}
                onToggleSystem={() => setOpenSystems((current) => {
                  const next = new Set(current);
                  if (next.has(item.id)) next.delete(item.id);
                  else next.add(item.id);
                  return next;
                })}
                peers={peers}
                readLabel={t("message.messageItem.read")}
                replyTime={(createdAt) => formatMessageStamp(createdAt, timeOptions)}
                resendLabel={t("mobile.messages.resend")}
                saved={savedIds.has(item.id)}
                savedLabel={t("message.messageItem.saved")}
                sendingLabel={t("mobile.messages.sending")}
                showDmRead={dm && item.senderType === "user" && item.senderId === userId && dmReadByPeer(peers, item.seq, item.senderId)}
                showMoreLabel={t("message.content.showMore")}
                subtitle={item.senderDescription}
                systemCount={systemCount}
                systemOpen={openSystems.has(item.id)}
                systemSummary={systemCount ? t("mobile.messages.systemRun", { count: systemCount }) : undefined}
                threadCountLabel={threadCountLabel}
                threadReplies={summary?.latestReplies}
                timeLabel={item.createdAt ? formatMessageStamp(item.createdAt, timeOptions) : ""}
              />
            );
          }}
        />
        {stickyAt ? (
          <View pointerEvents="none" style={styles.sticky}>
            <Text style={styles.stickyText}>{formatDayLabel(stickyAt, timeOptions)}</Text>
          </View>
        ) : null}
        {unseen > 0 ? (
          <Pressable
            onPress={() => {
              nearBottom.current = true;
              setUnseen(0);
              listRef.current?.scrollToOffset({ offset: 0, animated: true });
            }}
            style={styles.jump}
          >
            <Text style={styles.jumpText}>{`↓ ${t("message.chatPanel.newMessagesCount", { count: unseen })}`}</Text>
          </Pressable>
        ) : null}
      </View>
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
          placeholder={thread ? t("mobile.messages.replyPlaceholder") : t("mobile.messages.placeholder")}
          placeholderTextColor={colors.muted}
          style={styles.input}
          value={draft}
        />
        <Pressable disabled={draft.trim().length === 0} onPress={() => void send()} style={styles.send}>
          <Text style={styles.sendText}>{t("mobile.messages.send")}</Text>
        </Pressable>
      </View>
      <Modal animationType="fade" onRequestClose={() => setPreviewUrl(null)} transparent visible={previewUrl !== null}>
        <Pressable onPress={() => setPreviewUrl(null)} style={styles.scrim}>
          {previewUrl ? <Image resizeMode="contain" source={{ uri: previewUrl }} style={styles.preview} /> : null}
        </Pressable>
      </Modal>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  page: { flex: 1, backgroundColor: colors.bg },
  center: { flex: 1, alignItems: "center", justifyContent: "center", backgroundColor: colors.bg },
  list: { padding: space.md },
  timeline: { flex: 1 },
  sticky: { alignSelf: "center", backgroundColor: color.white, borderColor: color.border, borderWidth: 2, paddingHorizontal: 8, paddingVertical: 2, position: "absolute", top: 8 },
  stickyText: { color: color.ink, fontSize: 10, fontWeight: "700", letterSpacing: 0.8, textTransform: "uppercase" },
  jump: { backgroundColor: color.yellow, borderColor: color.border, borderWidth: 2, bottom: 12, paddingHorizontal: 10, paddingVertical: 6, position: "absolute", right: 12 },
  jumpText: { color: color.ink, fontSize: 13, fontWeight: "700" },
  scrim: { alignItems: "center", backgroundColor: color.scrim, flex: 1, justifyContent: "center" },
  preview: { height: "80%", width: "100%" },
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
