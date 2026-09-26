import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useFocusEffect, useNavigation, useRouter } from "expo-router";
import {
  ActivityIndicator,
  Alert,
  BackHandler,
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
import { Search, Settings } from "lucide-react-native";
import { ApiError, StaleRequestError } from "../api/client";
import { createRandomId } from "../api/ids";
import {
  historyLimited,
  isRecord,
  maxSeq,
  minSeq,
  parseMessage,
  parseMessagePage,
  parseServers,
  parseThreadSummaries,
  senderLabel,
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
import { computeMessageGrouping, hiddenSystemIds, retainGroupStates, systemRunHeads } from "./messageGrouping";
import { formatDayLabel, formatMessageStamp, resolveHour12, resolveTimeZone } from "./messageTime";
import { newerMessageCount } from "./newerMessages";
import { PanelHeader } from "../ui/PanelHeader";
import { Sheet } from "../ui/Sheet";
import { ChannelSettings } from "./ChannelSettings";
import { parseChannelMeta, type ChannelMeta } from "./channelMeta";
import { MessageMenu } from "./MessageMenu";
import { ProfileCard } from "./ProfileCard";
import { messagePermalink } from "./messageLink";
import { convertMessageToTask, leaveChannel, openDirectMessage, setActivityMuted, setCollapseLongMessages, setMessageReaction, setMessageSaved, setTaskStatus, setThreadFollow } from "./messageCommands";
import { applyReaction, actorNames } from "./reactions";
import { copyText, tapFeedback } from "./messageFeedback";
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
      taskId: typeof item.id === "string" ? item.id : undefined,
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
  const timeZone = resolveTimeZone(session.user?.preferredTimezone);
  const hour12 = resolveHour12(session.user?.preferredTimeFormat);
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
  const [meta, setMeta] = useState<ChannelMeta | null>(null);
  const [followedIds, setFollowedIds] = useState<Set<string>>(new Set());
  const [threadByParent, setThreadByParent] = useState<Record<string, string>>({});
  const [menu, setMenu] = useState<{ messageId: string; x: number; y: number; openedAt: number; reactionsOnly?: boolean } | null>(null);
  const [profile, setProfile] = useState<RaftMessage | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [memberNames, setMemberNames] = useState<string[]>([]);
  const slugRef = useRef<string | null>(null);
  const reactionFlight = useRef(new Set<string>());
  const settingsChannelId = thread && parentChannelId ? parentChannelId : thread ? null : channelId;
  const groupCache = useRef<Map<string, import("./messageGrouping").MessageGroupState> | null>(null);
  const grouping = useMemo(() => {
    const standalone = new Set<string>();
    for (const message of messages) {
      if (message.threadId || summaries[message.id] || tasksByMessage.has(message.id)) standalone.add(message.id);
    }
    const next = retainGroupStates(groupCache.current, computeMessageGrouping(messages, { standaloneIds: standalone, timeZone }));
    groupCache.current = next;
    return next;
  }, [messages, summaries, tasksByMessage, timeZone]);
  const listRef = useRef<FlatList<RaftMessage>>(null);
  const nearBottom = useRef(true);
  const lastOffset = useRef(0);
  const newestSeq = useRef(0);
  const checkedSaved = useRef(new Set<string>());
  const hiddenSystems = useMemo(() => hiddenSystemIds(messages, openSystems), [messages, openSystems]);

  useLayoutEffect(() => {
    // setOptions replaces the navigation object. Depending on it retriggers this
    // effect and overflows the update depth as soon as a channel opens.
    navigation.setOptions({ headerShown: false });
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
    setMeta(null);
    setMenu(null);
    setProfile(null);
    setSettingsOpen(false);
    setMemberNames([]);
    setCollapseLong(true);
    setOpenSystems(new Set());
    setUnseen(0);
    setStickyAt(null);
    newestSeq.current = 0;
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
    const { newest, added } = newerMessageCount(messages, newestSeq.current, userId);
    newestSeq.current = newest;
    if (added <= 0) return;
    if (nearBottom.current) setUnseen((count) => (count === 0 ? count : 0));
    else setUnseen((count) => count + added);
  }, [messages, userId]);

  useEffect(() => {
    if (!settingsChannelId || settingsChannelId === "pending-thread") return;
    let cancelled = false;
    void sessionRef.current.client.get<unknown>(`/channels/${settingsChannelId}`).then((data) => {
      if (cancelled || !isRecord(data)) return;
      setDm(!thread && data.type === "dm");
      setMeta(parseChannelMeta(data));
      if (typeof data.collapseLongMessages === "boolean") setCollapseLong(data.collapseLongMessages);
      const nextPeers = !thread ? parsePeerReads(data) : null;
      if (nextPeers) setPeers(nextPeers);
    }).catch(() => undefined);
    void sessionRef.current.client.get<unknown>("/channels/threads/followed").then((data) => {
      if (cancelled || !isRecord(data) || !Array.isArray(data.threads)) return;
      const ids = new Set<string>();
      const map: Record<string, string> = {};
      for (const threadRow of data.threads) {
        if (!isRecord(threadRow) || typeof threadRow.parentMessageId !== "string" || typeof threadRow.threadChannelId !== "string") continue;
        ids.add(threadRow.parentMessageId);
        map[threadRow.parentMessageId] = threadRow.threadChannelId;
      }
      setFollowedIds(ids);
      setThreadByParent((current) => ({ ...current, ...map }));
    }).catch(() => undefined);
    void sessionRef.current.client.get<unknown>("/tasks/server?detail=summary").then((data) => {
      if (!cancelled) setTasksByMessage(linkedTasks(data));
    }).catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [settingsChannelId, thread]);

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
      setError(sendError(caught, t));
    } finally {
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
    nearBottom.current = true;
    setUnseen(0);
    requestAnimationFrame(() => listRef.current?.scrollToOffset({ offset: 0, animated: true }));
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
  const [clock, setClock] = useState(() => new Date());
  useEffect(() => {
    const timer = setInterval(() => setClock(new Date()), 60_000);
    return () => clearInterval(timer);
  }, []);
  const timeOptions = useMemo(() => ({
    now: clock,
    hour12,
    timeZone,
    yesterdayLabel: t("message.dateDivider.yesterday"),
    todayLabel: t("message.dateDivider.today"),
  }), [clock, hour12, t, timeZone]);
  const reversed = useMemo(() => [...messages].reverse(), [messages]);
  const sendRef = useRef(send);
  sendRef.current = send;
  const openThread = useCallback((messageId: string) => {
    const summary = useRaftStore.getState().threadSummaries[messageId];
    const message = (useRaftStore.getState().messagesByChannel[channelId] ?? []).find((item) => item.id === messageId);
    router.push({
      pathname: "/thread/[threadId]",
      params: {
        threadId: summary?.threadChannelId ?? message?.threadId ?? "pending-thread",
        parentChannelId: channelId,
        parentMessageId: messageId,
        title: t("message.threadPanel.thread"),
      },
    });
  }, [channelId, router, t]);
  const resendMessage = useCallback((messageId: string) => {
    const message = (useRaftStore.getState().messagesByChannel[channelId] ?? []).find((item) => item.id === messageId);
    if (message) void sendRef.current(message);
  }, [channelId]);
  const deleteMessage = useCallback((messageId: string) => {
    const message = (useRaftStore.getState().messagesByChannel[channelId] ?? []).find((item) => item.id === messageId);
    if (message) removeFailed(message);
  }, [channelId]);
  const toggleSystem = useCallback((messageId: string) => {
    setOpenSystems((current) => {
      const next = new Set(current);
      if (next.has(messageId)) next.delete(messageId);
      else next.add(messageId);
      return next;
    });
  }, []);
  const openAttachmentRef = useRef(openAttachment);
  openAttachmentRef.current = openAttachment;
  const openAttachmentStable = useCallback((attachment: MessageAttachment, disposition: "inline" | "attachment") => {
    void openAttachmentRef.current(attachment, disposition);
  }, []);
  const replyTime = useCallback((createdAt: string) => formatMessageStamp(createdAt, timeOptions), [timeOptions]);

  useEffect(() => {
    const serverId = session.serverId;
    if (!serverId) return;
    let cancelled = false;
    void sessionRef.current.client.get<unknown>("/servers", { server: false }).then((data) => {
      if (cancelled) return;
      slugRef.current = parseServers(data).find((server) => server.id === serverId)?.slug ?? null;
    }).catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [session.serverId]);

  useEffect(() => {
    if (!settingsOpen || !settingsChannelId || settingsChannelId === "pending-thread") return;
    let cancelled = false;
    void sessionRef.current.client.get<unknown>(`/channels/${settingsChannelId}/members`).then((data) => {
      if (cancelled || !isRecord(data)) return;
      const names: string[] = [];
      for (const key of ["humans", "agents", "externalMembers"] as const) {
        const list = data[key];
        if (!Array.isArray(list)) continue;
        for (const item of list) {
          if (!isRecord(item)) continue;
          const name = typeof item.displayName === "string" && item.displayName
            ? item.displayName
            : typeof item.name === "string" ? item.name : "";
          if (name) names.push(name);
        }
      }
      setMemberNames(names);
    }).catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [settingsChannelId, settingsOpen]);

  useEffect(() => {
    if (!menu && !profile && !settingsOpen) return;
    const subscription = BackHandler.addEventListener("hardwareBackPress", () => {
      if (menu) setMenu(null);
      else if (profile) setProfile(null);
      else setSettingsOpen(false);
      return true;
    });
    return () => subscription.remove();
  }, [menu, profile, settingsOpen]);

  const storedMessage = useCallback((messageId: string) => (
    (useRaftStore.getState().messagesByChannel[channelId] ?? []).find((item) => item.id === messageId)
  ), [channelId]);

  const reactTo = useCallback((messageId: string, emoji: string) => {
    const key = `${messageId}:${emoji}`;
    if (reactionFlight.current.has(key)) return;
    const message = storedMessage(messageId);
    if (!message || message.id.startsWith("optimistic-") || message.messageType === "system") return;
    const mine = message.reactions?.some((reaction) => reaction.emoji === emoji && (reaction.reactedByMe || Boolean(userId && reaction.userIds?.includes(userId)))) ?? false;
    reactionFlight.current.add(key);
    useRaftStore.getState().upsertMessages([applyReaction(message, emoji, !mine, userId)]);
    void setMessageReaction(sessionRef.current.client, messageId, emoji, !mine).then(() => {
      reactionFlight.current.delete(key);
    }).catch((caught: unknown) => {
      reactionFlight.current.delete(key);
      const latest = storedMessage(messageId);
      if (latest) useRaftStore.getState().upsertMessages([applyReaction(latest, emoji, mine, userId)]);
      if (!(caught instanceof StaleRequestError)) setError(t("mobile.messages.actionFailed"));
    });
  }, [storedMessage, t, userId]);

  const showReactors = useCallback((messageId: string, emoji: string) => {
    void sessionRef.current.client.get<unknown>(`/messages/${messageId}/reactions/actors?emoji=${encodeURIComponent(emoji)}`).then((data) => {
      const names = actorNames(data);
      Alert.alert(emoji, names.length > 0 ? names.join("\n") : "—");
    }).catch((caught: unknown) => {
      if (!(caught instanceof StaleRequestError)) setError(t("mobile.messages.actionFailed"));
    });
  }, [t]);

  const longPressMessage = useCallback((messageId: string, x: number, y: number, reactionsOnly?: boolean) => {
    void tapFeedback();
    setMenu({ messageId, x, y, openedAt: Date.now(), reactionsOnly });
  }, []);

  const pressSender = useCallback((messageId: string) => {
    const message = storedMessage(messageId);
    if (message) setProfile(message);
  }, [storedMessage]);

  const mentionSender = useCallback((messageId: string) => {
    const message = storedMessage(messageId);
    if (!message?.senderId) return;
    void loadMembers().then((members) => {
      const candidate = members.find((member) => member.id === message.senderId);
      if (!candidate?.name) return;
      setDraft((current) => `${current}${current.length > 0 && !current.endsWith(" ") ? " " : ""}@${candidate.name} `);
      setMentions((current) => current.some((item) => item.id === candidate.id) ? current : [...current, candidate]);
    }).catch(() => setError(t("mobile.messages.actionFailed")));
  }, [storedMessage, t]);

  async function toggleSaved(messageId: string) {
    const saved = savedIds.has(messageId);
    setSavedIds((current) => {
      const next = new Set(current);
      if (saved) next.delete(messageId);
      else next.add(messageId);
      return next;
    });
    try {
      await setMessageSaved(sessionRef.current.client, messageId, !saved);
    } catch (caught) {
      setSavedIds((current) => {
        const next = new Set(current);
        if (saved) next.add(messageId);
        else next.delete(messageId);
        return next;
      });
      if (!(caught instanceof StaleRequestError)) setError(t("mobile.messages.actionFailed"));
    }
  }

  async function toggleFollow(parentId: string, threadChannelId: string | undefined, follow: boolean) {
    if (!follow && !threadChannelId) return;
    setFollowedIds((current) => {
      const next = new Set(current);
      if (follow) next.add(parentId);
      else next.delete(parentId);
      return next;
    });
    try {
      const data = await setThreadFollow(sessionRef.current.client, parentId, threadChannelId, follow);
      if (follow && isRecord(data) && typeof data.threadChannelId === "string") {
        setThreadByParent((current) => ({ ...current, [parentId]: data.threadChannelId as string }));
      }
    } catch (caught) {
      setFollowedIds((current) => {
        const next = new Set(current);
        if (follow) next.delete(parentId);
        else next.add(parentId);
        return next;
      });
      if (!(caught instanceof StaleRequestError)) setError(t("mobile.messages.actionFailed"));
    }
  }

  async function toggleTask(messageId: string) {
    const task = tasksByMessage.get(messageId);
    try {
      if (!task?.taskId) {
        await convertMessageToTask(sessionRef.current.client, messageId);
        const data = await sessionRef.current.client.get<unknown>("/tasks/server?detail=summary");
        setTasksByMessage(linkedTasks(data));
        return;
      }
      const status = task.status === "done" ? "todo" : "done";
      await setTaskStatus(sessionRef.current.client, task.taskId, status);
      setTasksByMessage((current) => {
        const next = new Map(current);
        const existing = next.get(messageId);
        if (existing) next.set(messageId, { ...existing, status });
        return next;
      });
    } catch (caught) {
      if (!(caught instanceof StaleRequestError)) setError(t("mobile.messages.actionFailed"));
    }
  }

  async function copyMessage(messageId: string) {
    const message = storedMessage(messageId);
    if (!message) return;
    try {
      await copyText(message.content);
    } catch {
      setError(t("mobile.messages.actionFailed"));
    }
  }

  async function copyLink(messageId: string) {
    const origin = sessionRef.current.origin;
    const slug = slugRef.current;
    const linkChannelId = thread ? parentChannelId : channelId;
    if (!origin || !slug || !linkChannelId) {
      setError(t("mobile.messages.actionFailed"));
      return;
    }
    try {
      await copyText(messagePermalink(origin, slug, linkChannelId, messageId, {
        dm: meta?.type === "dm",
        threadParentMessageId: thread ? parentMessageId : null,
      }));
    } catch {
      setError(t("mobile.messages.actionFailed"));
    }
  }

  async function changeMuted(muted: boolean) {
    if (!settingsChannelId) return;
    setMeta((current) => current ? { ...current, activityMuted: muted } : current);
    try {
      await setActivityMuted(sessionRef.current.client, settingsChannelId, muted);
    } catch (caught) {
      setMeta((current) => current ? { ...current, activityMuted: !muted } : current);
      if (!(caught instanceof StaleRequestError)) setError(t("mobile.messages.actionFailed"));
    }
  }

  async function changeCollapse(collapse: boolean) {
    if (!settingsChannelId) return;
    setCollapseLong(collapse);
    try {
      await setCollapseLongMessages(sessionRef.current.client, settingsChannelId, collapse);
    } catch (caught) {
      setCollapseLong(!collapse);
      if (!(caught instanceof StaleRequestError)) setError(t("mobile.messages.actionFailed"));
    }
  }

  async function leave() {
    try {
      if (!settingsChannelId) return;
      await leaveChannel(sessionRef.current.client, settingsChannelId);
      setSettingsOpen(false);
      router.back();
    } catch (caught) {
      if (!(caught instanceof StaleRequestError)) setError(t("mobile.messages.actionFailed"));
    }
  }

  async function messageProfile() {
    if (!profile?.senderId) return;
    try {
      const data = await openDirectMessage(sessionRef.current.client, { id: profile.senderId, type: profile.senderType });
      const id = isRecord(data) && typeof data.id === "string" ? data.id : null;
      if (!id) throw new Error("missing");
      setProfile(null);
      router.push({ pathname: "/messages/[channelId]", params: { channelId: id, name: senderLabel(profile) } });
    } catch (caught) {
      if (!(caught instanceof StaleRequestError)) setError(t("mobile.messages.actionFailed"));
    }
  }

  const headerTitle = thread
    ? `${t("message.threadPanel.thread")} — #${meta?.name || title}`
    : meta?.type === "dm" ? (meta.peerName || title) : (meta?.name || title);
  const headerSubtitle = [
    meta?.archived ? t("mobile.messages.archived") : "",
    meta?.activityMuted ? t("message.chatPanel.mutedBadge") : "",
    meta?.type === "dm" ? "" : (meta?.description ?? ""),
  ].filter(Boolean).join(" · ") || undefined;
  const menuMessage = menu ? storedMessage(menu.messageId) : undefined;
  const menuTask = menuMessage ? tasksByMessage.get(menuMessage.id) : undefined;
  const visibilityLabel = meta?.visibility === "private"
    ? t("mobile.messages.private")
    : meta?.visibility === "joint" ? t("mobile.messages.joint") : t("mobile.messages.public");

  return (
    <KeyboardAvoidingView
      behavior={Platform.OS === "ios" ? "padding" : undefined}
      keyboardVerticalOffset={insets.top + 56}
      style={[styles.page, { paddingTop: insets.top }, androidKeyboard > 0 ? { paddingBottom: androidKeyboard } : null]}
    >
      <PanelHeader
        actions={(
          <>
            {thread && parentMessageId ? (
              <Pressable
                onPress={() => {
                  const threadChannelId = channelId === "pending-thread" ? threadByParent[parentMessageId] : channelId;
                  if (followedIds.has(parentMessageId) && !threadChannelId) return;
                  void toggleFollow(parentMessageId, threadChannelId, !followedIds.has(parentMessageId));
                }}
                style={styles.headerAction}
              >
                <Text style={styles.headerActionText}>
                  {followedIds.has(parentMessageId) ? t("message.messageItem.unfollowThread") : t("message.messageItem.followThread")}
                </Text>
              </Pressable>
            ) : null}
            <View accessibilityLabel={t("message.chatPanel.searchChannel")} style={styles.headerAction}>
              <Search color={color.ink} size={18} />
            </View>
            {settingsChannelId ? (
              <Pressable accessibilityRole="button" onPress={() => setSettingsOpen(true)} style={styles.headerAction}>
                <Settings color={color.ink} size={18} />
              </Pressable>
            ) : null}
          </>
        )}
        onBack={() => router.back()}
        onTitlePress={thread ? () => listRef.current?.scrollToEnd({ animated: true }) : undefined}
        subtitle={headerSubtitle}
        title={headerTitle}
      />
      {loading && messages.length === 0 ? (
        <View style={styles.center}><ActivityIndicator color={colors.accent} /></View>
      ) : (
      <View style={styles.timeline}>
        <FlatList
          ref={listRef}
          data={reversed}
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
                onAddReaction={(messageId, x, y) => longPressMessage(messageId, x, y, true)}
                onDelete={deleteMessage}
                onLongPressMessage={longPressMessage}
                onLongPressSender={mentionSender}
                onOpenAttachment={openAttachmentStable}
                onOpenThread={threadCountLabel ? openThread : undefined}
                onPressMessage={thread ? undefined : openThread}
                onPressSender={pressSender}
                onResend={resendMessage}
                onShowReactors={showReactors}
                onToggleReaction={reactTo}
                onToggleSystem={toggleSystem}
                peers={peers}
                readLabel={t("message.messageItem.read")}
                replyTime={replyTime}
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
      )}
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
      {menu && menuMessage ? (
        <MessageMenu
          following={followedIds.has(menuMessage.id)}
          labels={{
            copy: t("message.messageItem.copyMarkdown"),
            link: t("message.messageItem.copyLink"),
            thread: t("message.messageItem.openThread"),
            save: t("message.messageItem.saveMessage"),
            unsave: t("mobile.messages.unsave"),
            follow: t("message.messageItem.followThread"),
            unfollow: t("message.messageItem.unfollowThread"),
          }}
          onClose={() => setMenu(null)}
          onCopy={() => {
            setMenu(null);
            void copyMessage(menuMessage.id);
          }}
          onCopyLink={() => {
            setMenu(null);
            void copyLink(menuMessage.id);
          }}
          onFollow={thread ? undefined : (() => {
            const threadChannelId = threadByParent[menuMessage.id] ?? useRaftStore.getState().threadSummaries[menuMessage.id]?.threadChannelId ?? menuMessage.threadId ?? undefined;
            if (!threadChannelId) return undefined;
            return () => {
              setMenu(null);
              void toggleFollow(menuMessage.id, threadChannelId, !followedIds.has(menuMessage.id));
            };
          })()}
          onReact={(emoji) => {
            setMenu(null);
            reactTo(menuMessage.id, emoji);
          }}
          onSave={() => {
            setMenu(null);
            void toggleSaved(menuMessage.id);
          }}
          onTask={() => {
            setMenu(null);
            void toggleTask(menuMessage.id);
          }}
          onThread={thread ? undefined : () => {
            setMenu(null);
            openThread(menuMessage.id);
          }}
          openedAt={menu.openedAt}
          reactionsOnly={menu.reactionsOnly}
          saved={savedIds.has(menuMessage.id)}
          taskLabel={thread ? null : (menuTask?.taskId
            ? (menuTask.status === "done" ? t("message.messageItem.reopenTask") : t("message.messageItem.markAsDone"))
            : t("message.messageItem.convertToTask"))}
          x={menu.x}
          y={menu.y}
        />
      ) : null}
      {profile ? (
        <ProfileCard
          avatarUrl={profile.senderAvatarUrl}
          description={profile.senderDescription}
          dmLabel={t("mobile.messages.dm")}
          kind={profile.senderType === "agent" ? "agent" : "human"}
          name={senderLabel(profile)}
          onClose={() => setProfile(null)}
          onMessage={() => void messageProfile()}
        />
      ) : null}
      {meta && settingsChannelId ? (
        <Sheet onClose={() => setSettingsOpen(false)} open={settingsOpen} title={t("message.channelSettings.title")}>
          <ChannelSettings
            collapse={collapseLong}
            collapseLabel={t("message.channelSettings.collapseLongMessagesTitle")}
            leaveLabel={t("mobile.messages.leave")}
            memberLabel={t("mobile.messages.members")}
            members={memberNames}
            meta={meta}
            muteLabel={t("message.channelSettings.muteActivityTitle")}
            onCollapse={(collapse) => void changeCollapse(collapse)}
            onLeave={() => void leave()}
            onMute={(muted) => void changeMuted(muted)}
            visibilityLabel={visibilityLabel}
          />
        </Sheet>
      ) : null}
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
  headerAction: { alignItems: "center", justifyContent: "center", minHeight: 32, paddingHorizontal: 4 },
  headerActionText: { color: color.ink, fontSize: 12, fontWeight: "700" },
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
