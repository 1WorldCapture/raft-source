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
  parseChannels,
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
import { computeMessageGrouping, hiddenSystemIds, retainGroupStates, systemRunHeads } from "./messageGrouping";
import { formatDayLabel, formatMessageStamp, resolveHour12, resolveTimeZone } from "./messageTime";
import { newerMessageCount } from "./newerMessages";
import { Camera, Image as ImageIcon, ListChecks, Paperclip } from "lucide-react-native";
import { rankComposerSuggestions } from "../../../../packages/web/src/utils/composerSuggestionSearch";
import { channelQuery, parseUploadedAttachmentId } from "./attachmentUpload";
import { loadDraft, persistDraft, DraftScheduler } from "./composerDraft";
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

interface PendingUpload {
  localId: string;
  name: string;
  uri: string;
  mimeType: string;
  progress: number;
  status: "uploading" | "ready" | "error";
  attachmentId?: string;
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
  const [asTask, setAsTask] = useState(false);
  const [androidKeyboard, setAndroidKeyboard] = useState(0);
  const [mentions, setMentions] = useState<MentionCandidate[]>([]);
  const [candidates, setCandidates] = useState<MentionCandidate[]>([]);
  const [channelHits, setChannelHits] = useState<Array<{ id: string; name: string; description: string | null; archived: boolean }>>([]);
  const [uploads, setUploads] = useState<PendingUpload[]>([]);
  const channelCache = useRef<Array<{ id: string; name: string; description: string | null; archived: boolean }> | null>(null);
  const inputRef = useRef<TextInput>(null);
  const suggestGen = useRef(0);
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
    setUploads([]);
    setChannelHits([]);
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

  const draftChannel = useRef(channelId);
  draftChannel.current = channelId;
  const draftScheduler = useRef(new DraftScheduler((value) => {
    void persistDraft(draftChannel.current, value);
  }));
  const draftReady = useRef(false);
  const draftDirty = useRef(false);
  useEffect(() => {
    draftReady.current = false;
    draftDirty.current = false;
    let cancelled = false;
    void loadDraft(channelId).then((value) => {
      if (cancelled || draftDirty.current) {
        draftReady.current = true;
        return;
      }
      setDraft(value);
      draftReady.current = true;
    });
    return () => {
      cancelled = true;
      draftScheduler.current.dispose();
    };
  }, [channelId]);
  useEffect(() => {
    if (!draftReady.current) return;
    draftScheduler.current.update(draft);
  }, [draft]);

  useEffect(() => {
    const { newest, added } = newerMessageCount(messages, newestSeq.current);
    newestSeq.current = newest;
    if (added <= 0) return;
    if (nearBottom.current) setUnseen((count) => (count === 0 ? count : 0));
    else setUnseen((count) => count + added);
  }, [messages]);

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
    draftDirty.current = true;
    setDraft(value);
    const generation = ++suggestGen.current;
    const query = mentionQuery(value);
    const hash = channelQuery(value);
    if (query === null && hash === null) {
      setCandidates([]);
      setChannelHits([]);
      return;
    }
    if (query !== null) {
      setChannelHits([]);
      const members = await loadMembers().catch(() => [] as MentionCandidate[]);
      if (generation !== suggestGen.current) return;
      const needle = query.toLowerCase();
      setCandidates(members.filter((member) => member.name.toLowerCase().includes(needle) || member.label.toLowerCase().includes(needle)).slice(0, 6));
      return;
    }
    setCandidates([]);
    const channels = await loadChannels().catch(() => []);
    if (generation !== suggestGen.current) return;
    const ranked = rankComposerSuggestions(hash ?? "", channels.map((channel, index) => ({
      index,
      suggestion: channel,
      fields: [
        { raw: channel.name, priority: 0 },
        { raw: channel.description ?? "", priority: 3 },
      ],
    })));
    setChannelHits(ranked.slice(0, 6));
  }

  async function loadChannels() {
    if (channelCache.current) return channelCache.current;
    const data = await sessionRef.current.client.get<unknown>("/channels?archived=include");
    const next = parseChannels(data)
      .filter((channel) => channel.type === "channel" || channel.type === "private" || channel.type === "joint")
      .map((channel) => ({
        id: channel.id,
        name: channel.name,
        description: channel.description ?? null,
        archived: Boolean(channel.archivedAt),
      }));
    channelCache.current = next;
    return next;
  }

  function chooseChannel(channel: { name: string }) {
    const next = draft.replace(/(?:^|\s)#[\p{L}\p{N}_-]*$/u, (prefix) => `${prefix.startsWith(" ") || prefix.startsWith("\n") ? prefix[0] : ""}#${channel.name} `);
    setDraft(next.endsWith(" ") ? next : `${next} `);
    setChannelHits([]);
    inputRef.current?.focus();
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
        attachmentIds: uploads.flatMap((file) => file.status === "ready" && file.attachmentId ? [file.attachmentId] : []),
        asTask: asTask || undefined,
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
    const ready = uploads.filter((file) => file.status === "ready" && file.attachmentId);
    if (uploads.some((file) => file.status !== "ready")) return;
    if (!content && ready.length === 0) return;
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
      setAsTask(false);
      setUploads([]);
      setMentions([]);
      setCandidates([]);
      setChannelHits([]);
      void persistDraft(channelId, "");
    }
    await deliver(content, randomId, optimisticId);
  }

  function focusComposer() {
    requestAnimationFrame(() => inputRef.current?.focus());
  }

  function queueUpload(uri: string, name: string, mimeType: string) {
    const file: PendingUpload = { localId: createRandomId(), name, uri, mimeType, progress: 0, status: "uploading" };
    setUploads((current) => [...current, file]);
    void uploadLocal(file);
    focusComposer();
  }

  async function uploadLocal(file: PendingUpload) {
    const target = thread && channelId === "pending-thread" && parentChannelId ? parentChannelId : channelId;
    if (!target || target === "pending-thread") {
      setUploads((current) => current.map((item) => item.localId === file.localId ? { ...item, status: "error" } : item));
      setError(t("mobile.messages.uploadFailed"));
      return;
    }
    setUploads((current) => current.map((item) => item.localId === file.localId ? { ...item, status: "uploading", progress: 0, attachmentId: undefined } : item));
    const form = new FormData();
    form.append("channelId", target);
    form.append("files", { uri: file.uri, name: file.name, type: file.mimeType } as unknown as Blob);
    try {
      const data = await sessionRef.current.client.upload<unknown>("/attachments/upload", form, (progress) => {
        setUploads((current) => current.map((item) => item.localId === file.localId && item.status === "uploading" ? { ...item, progress } : item));
      });
      const attachmentId = parseUploadedAttachmentId(data);
      if (!attachmentId) throw new Error("missing");
      setUploads((current) => current.map((item) => item.localId === file.localId ? { ...item, status: "ready", progress: 100, attachmentId } : item));
    } catch (caught) {
      if (!(caught instanceof StaleRequestError)) setError(caught instanceof ApiError ? caught.error : t("mobile.messages.uploadFailed"));
      setUploads((current) => current.map((item) => item.localId === file.localId ? { ...item, status: "error" } : item));
    }
  }

  async function pickImage(camera: boolean) {
    try {
      const ImagePicker = await import("expo-image-picker");
      if (camera) {
        const permission = await ImagePicker.requestCameraPermissionsAsync();
        if (!permission.granted) {
          setError(t("mobile.messages.uploadFailed"));
          return;
        }
      }
      const result = camera
        ? await ImagePicker.launchCameraAsync({ mediaTypes: ["images"], quality: 0.85 })
        : await ImagePicker.launchImageLibraryAsync({ mediaTypes: ["images"], quality: 0.85 });
      const asset = result.canceled ? null : result.assets[0];
      if (!asset) return;
      queueUpload(asset.uri, asset.fileName || "image.jpg", asset.mimeType || "image/jpeg");
    } catch {
      setError(t("mobile.messages.uploadFailed"));
    }
    focusComposer();
  }

  async function pickFile() {
    try {
      const DocumentPicker = await import("expo-document-picker");
      const result = await DocumentPicker.getDocumentAsync({ copyToCacheDirectory: true });
      const asset = result.canceled ? null : result.assets[0];
      if (!asset) return;
      queueUpload(asset.uri, asset.name, asset.mimeType || "application/octet-stream");
    } catch {
      setError(t("mobile.messages.uploadFailed"));
    }
    focusComposer();
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
                onDelete={deleteMessage}
                onOpenAttachment={openAttachmentStable}
                onOpenThread={threadCountLabel ? openThread : undefined}
                onResend={resendMessage}
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
      {channelHits.length > 0 ? (
        <View style={styles.candidates}>
          {channelHits.map((channel) => (
            <Pressable key={channel.id} onPress={() => chooseChannel(channel)} style={styles.candidate}>
              <Text style={styles.candidateName}>#{channel.name}</Text>
              <Text style={styles.candidateLabel}>{channel.archived ? t("message.composer.archivedBadge") : channel.description ?? ""}</Text>
            </Pressable>
          ))}
        </View>
      ) : null}
      {uploads.length > 0 ? (
        <View style={styles.uploads}>
          {uploads.map((file) => (
            <View key={file.localId} style={styles.uploadRow}>
              <Text numberOfLines={1} style={styles.uploadName}>{file.status === "uploading" ? `${file.name} ${file.progress}%` : file.name}</Text>
              {file.status === "error" ? (
                <Pressable onPress={() => void uploadLocal(file)}><Text style={styles.uploadAction}>{t("mobile.messages.resend")}</Text></Pressable>
              ) : null}
              <Pressable onPress={() => setUploads((current) => current.filter((item) => item.localId !== file.localId))}><Text style={styles.uploadAction}>{t("mobile.messages.delete")}</Text></Pressable>
            </View>
          ))}
        </View>
      ) : null}
      {error ? <Text style={styles.error}>{error}</Text> : null}
      <View style={[styles.composer, { paddingBottom: androidKeyboard > 0 ? 8 : Math.max(insets.bottom, 12) }]}>
        <TextInput
          ref={inputRef}
          blurOnSubmit={false}
          multiline
          onChangeText={(value) => void onChangeDraft(value)}
          placeholder={t("message.composer.messagePlaceholder", { channel: title || (thread ? t("message.threadPanel.thread") : "") })}
          placeholderTextColor={colors.muted}
          style={styles.input}
          submitBehavior="newline"
          value={draft}
        />
        <View style={styles.toolbar}>
          <View style={styles.tools}>
            <Pressable accessibilityRole="button" onPress={() => void pickImage(false)} style={styles.tool}><ImageIcon color={color.ink} size={18} /></Pressable>
            <Pressable accessibilityRole="button" onPress={() => void pickImage(true)} style={styles.tool}><Camera color={color.ink} size={18} /></Pressable>
            <Pressable accessibilityRole="button" onPress={() => void pickFile()} style={styles.tool}><Paperclip color={color.ink} size={18} /></Pressable>
            <Pressable accessibilityRole="checkbox" accessibilityState={{ checked: asTask }} onPress={() => { setAsTask((current) => !current); focusComposer(); }} style={styles.taskToggle}>
              <ListChecks color={color.ink} size={16} />
              <Text style={styles.taskLabel}>{t("message.composer.asTask")}</Text>
              <View style={[styles.box, asTask ? styles.boxOn : null]} />
            </Pressable>
          </View>
          <Pressable disabled={uploads.some((file) => file.status !== "ready") || (draft.trim().length === 0 && !uploads.some((file) => file.status === "ready"))} onPress={() => void send()} style={styles.send}>
            <Text style={styles.sendText}>{t("mobile.messages.send")}</Text>
          </Pressable>
        </View>
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
    backgroundColor: color.page,
    borderColor: color.border,
    borderWidth: 2,
    gap: 8,
    marginBottom: 8,
    marginHorizontal: 12,
    padding: 8,
  },
  input: { color: color.ink, fontSize: 16, maxHeight: 128, minHeight: 24, paddingHorizontal: 4, paddingVertical: 4 },
  toolbar: { alignItems: "center", flexDirection: "row", justifyContent: "space-between" },
  tools: { alignItems: "center", flexDirection: "row", gap: 4 },
  tool: { alignItems: "center", height: 32, justifyContent: "center", width: 32 },
  taskToggle: { alignItems: "center", flexDirection: "row", gap: 6 },
  taskLabel: { color: color.ink, fontSize: 12, fontWeight: "700" },
  box: { borderColor: color.border, borderWidth: 2, height: 16, width: 16 },
  boxOn: { backgroundColor: color.yellow },
  send: { backgroundColor: color.pink, borderColor: color.border, borderWidth: 2, paddingHorizontal: 12, paddingVertical: 8 },
  sendText: { color: color.ink, fontSize: 14, fontWeight: "700" },
  uploads: { gap: 4, paddingHorizontal: 12 },
  uploadRow: { alignItems: "center", flexDirection: "row", gap: 8 },
  uploadName: { color: color.ink, flex: 1, fontSize: 13 },
  uploadAction: { color: color.ink, fontSize: 13, fontWeight: "700" },
});
