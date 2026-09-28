import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useFocusEffect, useNavigation, useRouter } from "expo-router";
import {
  ActivityIndicator,
  Alert,
  BackHandler,
  FlatList,
  Keyboard,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  StyleSheet,
  TextInput,
  View,
  type NativeScrollEvent,
  type NativeSyntheticEvent,
} from "react-native";
import { Camera, Hash, ImagePlus, ListChecks, Lock, MessageSquare, Paperclip, Search, SendHorizontal, Settings, Users } from "lucide-react-native";
import { attachmentPreviewGate } from "../attachments/previewSession";
import { canRenderSvgNatively, isSvgAttachment } from "../attachments/svgRender";
import { viewKind } from "../attachments/viewKind";
import { attachmentDownloadUrl, rewriteAttachmentUrl } from "../api/attachmentUrl";
import { ApiError, StaleRequestError } from "../api/client";
import { AttachmentViewer } from "./AttachmentViewer";
import { downloadAndShareAttachment } from "./attachmentFile";
import { ImageViewer } from "./ImageViewer";
import { createRandomId } from "../api/ids";
import {
  advanceContextWindow,
  applyContextWindow,
  appendNewerPage,
  forgetContextWindow,
  JUMP_VIEW_POSITION,
  parseMessageContext,
  recallContextWindow,
  rememberContextWindow,
  shouldRequestContext,
  visibleInWindow,
} from "../model/messageWindow";
import {
  historyLimited,
  isRecord,
  maxSeq,
  minSeq,
  parseChannels,
  parseMessage,
  parseMessagePage,
  parseServers,
  parseThreadSummaries,
  senderLabel,
  type MessageAttachment,
  type RaftMessage,
} from "../model/messages";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { drainAfterPages, hydrateCachedMessages, messageFetchPlan, rawPageForCache } from "../cache/boot";
import { getAppCacheSync } from "../cache/appSync";
import { getCacheRuntime } from "../cache/runtime";
import { useSession } from "../state/session";
import { useRaftStore } from "../state/store";
import { colors, space } from "../ui/theme";
import { AppText } from "../ui/text";
import { bodyFont, color, shadowOffset } from "../ui/tokens";
import { Avatar } from "../ui/Avatar";
import { collectSenderAvatars } from "./senderAvatars";
import { useT } from "../i18n/provider";
import { MessageRow, type LinkedTaskChip } from "./MessageRow";
import { computeMessageGrouping, hiddenSystemIds, retainGroupStates, systemRunHeads } from "./messageGrouping";
import { formatDayLabel, formatMessageStamp, resolveHour12, resolveTimeZone } from "./messageTime";
import { newerMessageCount } from "./newerMessages";
import { rankComposerSuggestions } from "../../../../packages/web/src/utils/composerSuggestionSearch";
import { HeaderIconButton, HeaderIconSlot, PanelHeader } from "../ui/PanelHeader";
import { HardShadow } from "../ui/shadow";
import { Sheet } from "../ui/Sheet";
import { channelQuery, parseUploadedAttachmentId, attachmentIdsForSend } from "./attachmentUpload";
import { ChannelSettings } from "./ChannelSettings";
import { parseChannelMeta, type ChannelMeta } from "./channelMeta";
import { loadDraft, persistDraft, DraftScheduler } from "./composerDraft";
import { MessageMenu } from "./MessageMenu";
import { ProfileCard } from "./ProfileCard";
import { messagePermalink } from "./messageLink";
import { convertMessageToTask, leaveChannel, openDirectMessage, setActivityMuted, setCollapseLongMessages, setMessageReaction, setMessageSaved, setTaskStatus, setThreadFollow } from "./messageCommands";
import { applyReaction, actorNames } from "./reactions";
import { claimReaction, releaseReaction, threadMenuActions } from "./interactionRules";
import { copyText, tapFeedback } from "./messageFeedback";
import { dmReadByPeer, parsePeerReads, type PeerRead } from "./readReceipt";

const PAGE = 50;

/** Raw enriched message → cache row shape (boot.rawPageForCache input). */
function messageToCacheRow(item: unknown) {
  if (!isRecord(item) || typeof item.id !== "string" || typeof item.seq !== "number") return null;
  return { seq: item.seq, id: item.id, raw: item as Record<string, unknown> };
}
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
  targetMessageId,
  embedded,
  listHeader,
}: {
  channelId: string;
  title: string;
  thread?: boolean;
  parentChannelId?: string;
  parentMessageId?: string;
  targetMessageId?: string;
  /** Task detail draws its own bar and keeps this pane as the discussion only. */
  embedded?: boolean;
  /** Task head, rendered above the replies in the same list. */
  listHeader?: ReactNode;
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
  const body = bodyFont(session.user?.preferredMessageBodyFontSize);
  const [loading, setLoading] = useState(true);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [hasMore, setHasMore] = useState(true);
  const [hasNewer, setHasNewer] = useState(() => {
    if (!targetMessageId) return false;
    const cached = useRaftStore.getState().messagesByChannel[channelId] ?? [];
    return recallContextWindow(channelId, targetMessageId, cached) !== null;
  });
  const [loadingNewer, setLoadingNewer] = useState(false);
  const [windowCeiling, setWindowCeiling] = useState<number | null>(() => {
    if (!targetMessageId) return null;
    const cached = useRaftStore.getState().messagesByChannel[channelId] ?? [];
    return recallContextWindow(channelId, targetMessageId, cached)?.ceilingSeq ?? null;
  });
  const [highlightedId, setHighlightedId] = useState<string | null>(null);
  const [resolvedTarget, setResolvedTarget] = useState<string | null>(null);
  const visibleMessages = visibleInWindow(messages, hasNewer, windowCeiling);
  const systemHeads = useMemo(() => systemRunHeads(visibleMessages), [visibleMessages]);
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
  const [showBack, setShowBack] = useState(false);
  const [stickyAt, setStickyAt] = useState<string | null>(null);
  const [collapseLong, setCollapseLong] = useState(true);
  const [dm, setDm] = useState(false);
  const [peers, setPeers] = useState<PeerRead[]>([]);
  const [savedIds, setSavedIds] = useState<Set<string>>(new Set());
  const [tasksByMessage, setTasksByMessage] = useState<Map<string, LinkedTaskChip>>(new Map());
  const [openSystems, setOpenSystems] = useState<Set<string>>(new Set());
  const [imageViewer, setImageViewer] = useState<{ images: MessageAttachment[]; index: number } | null>(null);
  const [fileViewer, setFileViewer] = useState<MessageAttachment | null>(null);
  const [downloadingAttachmentId, setDownloadingAttachmentId] = useState<string | null>(null);
  const downloadingRef = useRef<string | null>(null);
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
  const [memberCount, setMemberCount] = useState<number | null>(null);
  useEffect(() => {
    if (!settingsChannelId || settingsChannelId === "pending-thread") return;
    let cancelled = false;
    void sessionRef.current.client.get<unknown>(`/channels/${settingsChannelId}/members`).then((data) => {
      if (cancelled || !isRecord(data)) return;
      let count = 0;
      for (const key of ["humans", "agents", "externalMembers"] as const) {
        const list = data[key];
        if (Array.isArray(list)) count += list.length;
      }
      setMemberCount(count);
    }).catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [settingsChannelId]);
  const groupCache = useRef<Map<string, import("./messageGrouping").MessageGroupState> | null>(null);
  const grouping = useMemo(() => {
    const standalone = new Set<string>();
    for (const message of visibleMessages) {
      if (message.threadId || summaries[message.id] || tasksByMessage.has(message.id)) standalone.add(message.id);
    }
    const next = retainGroupStates(groupCache.current, computeMessageGrouping(visibleMessages, { standaloneIds: standalone, timeZone }));
    groupCache.current = next;
    return next;
  }, [summaries, tasksByMessage, timeZone, visibleMessages]);
  const listRef = useRef<FlatList<RaftMessage>>(null);
  const nearBottom = useRef(true);
  const lastOffset = useRef(0);
  const newestSeq = useRef(0);
  const checkedSaved = useRef(new Set<string>());
  const hiddenSystems = useMemo(() => hiddenSystemIds(visibleMessages, openSystems), [openSystems, visibleMessages]);

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
    setUploads([]);
    setChannelHits([]);
    setStickyAt(null);
    newestSeq.current = 0;
    if (targetMessageId) {
      nearBottom.current = false;
      return () => {
        scrollOffsets.set(channelId, lastOffset.current);
      };
    }
    const savedOffset = scrollOffsets.get(channelId) ?? 0;
    lastOffset.current = savedOffset;
    nearBottom.current = savedOffset < 100;
    const frame = requestAnimationFrame(() => listRef.current?.scrollToOffset({ offset: savedOffset, animated: false }));
    return () => {
      cancelAnimationFrame(frame);
      scrollOffsets.set(channelId, lastOffset.current);
    };
  }, [channelId, targetMessageId]);

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

  const hasNewerRef = useRef(hasNewer);
  hasNewerRef.current = hasNewer;
  const windowCeilingRef = useRef(windowCeiling);
  windowCeilingRef.current = windowCeiling;
  const loadingNewerRef = useRef(false);
  const jumpedRef = useRef<string | null>(null);

  useEffect(() => {
    const { newest, added } = newerMessageCount(visibleMessages, newestSeq.current, userId);
    newestSeq.current = newest;
    if (added <= 0) return;
    if (nearBottom.current) setUnseen((count) => (count === 0 ? count : 0));
    else setUnseen((count) => count + added);
  }, [visibleMessages, userId]);

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
      let cached = useRaftStore.getState().messagesByChannel[channelId] ?? [];
      setError(null);
      // Cold-start fast path (#client-data-cache task #2): seed the pane from
      // the local cache so it paints before the network answers, then fetch
      // only what the coverage says is missing (after=tail). Context-window
      // opens (targetMessageId) keep their own recall logic untouched.
      let cacheScope: number | null = null;
      if (!targetMessageId) {
        try {
          const runtime = getCacheRuntime();
          cacheScope = runtime.scopeFor(sessionRef.current.serverId ?? "");
          if (cached.length === 0 && cacheScope !== null) {
            const rows = runtime.repo.getLatestMessages(cacheScope, channelId, PAGE);
            if (rows.length > 0) {
              // getLatestMessages is newest-first; the store is chronological.
              const hydrated = hydrateCachedMessages(rows).reverse();
              useRaftStore.getState().setChannelMessages(channelId, hydrated);
              cached = hydrated;
            }
          }
        } catch {
          cacheScope = null;
        }
      }
      if (targetMessageId && !shouldRequestContext(cached, targetMessageId)) {
        const saved = recallContextWindow(channelId, targetMessageId, cached);
        if (saved) {
          setHasNewer(true);
          setWindowCeiling(saved.ceilingSeq);
          setHasMore(saved.hasOlder);
        } else {
          setHasNewer(false);
          setWindowCeiling(null);
        }
        setLoading(false);
        return;
      }
      setLoading(cached.length === 0 || Boolean(targetMessageId));
      let missingTarget = false;
      try {
        if (targetMessageId && shouldRequestContext(cached, targetMessageId)) {
          try {
            const data = await sessionRef.current.client.get<unknown>(
              `/messages/context/${encodeURIComponent(targetMessageId)}?channelId=${encodeURIComponent(channelId)}`,
            );
            if (cancelled) return;
            const page = parseMessageContext(data);
            const focusId = page?.messages.some((message) => message.id === targetMessageId)
              ? targetMessageId
              : page?.targetMessageId;
            if (!page || !focusId || !page.messages.some((message) => message.id === focusId)) {
              throw new ApiError("Message not found", 404, null);
            }
            setResolvedTarget(focusId);
            const window = applyContextWindow(cached, page);
            useRaftStore.getState().setChannelMessages(channelId, window.messages);
            useRaftStore.getState().setThreadSummaries(parseThreadSummaries(data));
            setHasMore(window.hasOlder);
            setHasNewer(window.hasNewer);
            setWindowCeiling(window.hasNewer ? window.ceilingSeq : null);
            if (window.hasNewer) rememberContextWindow(channelId, focusId, { ceilingSeq: window.ceilingSeq, hasOlder: window.hasOlder });
            else forgetContextWindow(channelId);
            setLimited(historyLimited(data));
            if (!window.hasNewer && window.ceilingSeq > 0) void sessionRef.current.markRead(channelId, window.ceilingSeq);
            return;
          } catch (caught) {
            if (cancelled || caught instanceof StaleRequestError) return;
            missingTarget = true;
          }
        }
        // With local coverage, continue from the tail instead of re-pulling
        // the whole page (#client-data-cache task #2).
        const plan = cacheScope !== null
          ? messageFetchPlan(getCacheRuntime().repo.getCoverage(cacheScope, channelId))
          : ({ latest: true } as const);
        if ("after" in plan && !missingTarget) {
          // Review fix #1: a FULL after-page means more newer messages exist
          // beyond it — drain until a short page so a >PAGE offline gap
          // still lands on the newest tail (each page is cached as it
          // arrives; thread summaries merge across the drain).
          const mergedSummaries: Record<string, ReturnType<typeof parseThreadSummaries>[string]> = {};
          const drained = await drainAfterPages(
            plan.after,
            async (after) => {
              const data = await sessionRef.current.client.get<unknown>(`/messages/channel/${channelId}?limit=${PAGE}&after=${after}`);
              const parsed = parseMessagePage(data);
              if (cacheScope !== null) {
                void getCacheRuntime().repo.appendPage(cacheScope, channelId, rawPageForCache(data, messageToCacheRow));
              }
              Object.assign(mergedSummaries, parseThreadSummaries(data));
              return parsed;
            },
            (p) => p.length >= PAGE,
          );
          if (cancelled) return;
          forgetContextWindow(channelId);
          for (const p of drained.pages) useRaftStore.getState().upsertMessages(p);
          if (Object.keys(mergedSummaries).length > 0) useRaftStore.getState().setThreadSummaries(mergedSummaries);
          // A short after-page does not mean history ends: the seeded tail
          // may itself fill a page.
          setHasMore(cached.length >= PAGE || drained.pages.some((p) => p.length >= PAGE));
          setHasNewer(false);
          setWindowCeiling(null);
          const seq = maxSeq(useRaftStore.getState().messagesByChannel[channelId] ?? []);
          if (seq > 0) void sessionRef.current.markRead(channelId, seq);
          // Review fix #4: the pane showed cached (possibly stale) dynamic
          // data — refresh the visible page's overlay once per boot.
          if (cacheScope !== null && cached.length > 0) {
            const visible = useRaftStore.getState().messagesByChannel[channelId] ?? [];
            const from = minSeq(visible);
            const through = maxSeq(visible);
            const sync = getAppCacheSync();
            if (sync && from !== null && through !== null) {
              void sync.refreshOverlayPageOncePerBoot(cacheScope, channelId, from, through);
            }
          }
        } else {
          const data = await sessionRef.current.client.get<unknown>(`/messages/channel/${channelId}?limit=${PAGE}`);
          if (cancelled) return;
          const page = parseMessagePage(data);
          forgetContextWindow(channelId);
          if (missingTarget) useRaftStore.getState().setChannelMessages(channelId, page);
          else useRaftStore.getState().upsertMessages(page);
          useRaftStore.getState().setThreadSummaries(parseThreadSummaries(data));
          setHasMore(page.length >= PAGE);
          setHasNewer(false);
          setWindowCeiling(null);
          setLimited(historyLimited(data));
          if (cacheScope !== null) {
            void getCacheRuntime().repo.appendPage(cacheScope, channelId, rawPageForCache(data, messageToCacheRow));
          }
          const seq = maxSeq(page);
          if (seq > 0) void sessionRef.current.markRead(channelId, seq);
        }
        if (missingTarget) {
          setError(t("message.chatPanel.messageNotFound"));
          nearBottom.current = true;
          setUnseen(0);
          setShowBack(false);
          setTimeout(() => {
            if (cancelled) return;
            if (embedded) listRef.current?.scrollToEnd({ animated: false });
            else listRef.current?.scrollToOffset({ offset: 0, animated: false });
          }, 50);
        }
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
  }, [channelId, targetMessageId]);

  async function loadOlder() {
    if (!hasMore || loadingOlder) return;
    const before = minSeq(visibleMessages);
    if (before === null) return;
    setLoadingOlder(true);
    try {
      const data = await sessionRef.current.client.get<unknown>(`/messages/channel/${channelId}?limit=${PAGE}&before=${before}`);
      const page = parseMessagePage(data);
      useRaftStore.getState().upsertMessages(page);
      setHasMore(page.length >= PAGE);
      setLimited((current) => current || historyLimited(data));
      // History pages extend the cached coverage downwards (#2).
      try {
        const runtime = getCacheRuntime();
        const scope = runtime.scopeFor(sessionRef.current.serverId ?? "");
        if (scope !== null) {
          void runtime.repo.appendPage(scope, channelId, rawPageForCache(data, messageToCacheRow));
        }
      } catch {
        // Cache unavailable.
      }
    } catch (caught) {
      if (caught instanceof StaleRequestError) return;
      setError(sendError(caught, t));
    } finally {
      setLoadingOlder(false);
    }
  }

  async function loadNewer() {
    const ceiling = windowCeilingRef.current;
    if (!hasNewerRef.current || loadingNewerRef.current || ceiling === null) return;
    loadingNewerRef.current = true;
    setLoadingNewer(true);
    try {
      const data = await sessionRef.current.client.get<unknown>(`/messages/channel/${channelId}?limit=${PAGE}&after=${ceiling}`);
      const current = visibleInWindow(useRaftStore.getState().messagesByChannel[channelId] ?? [], true, ceiling);
      const page = parseMessagePage(data);
      const next = appendNewerPage(current, page, PAGE);
      useRaftStore.getState().setChannelMessages(channelId, next.messages);
      setHasNewer(next.hasNewer);
      setWindowCeiling(next.hasNewer ? next.ceilingSeq : null);
      const focusId = focusMessageId;
      if (focusId && next.hasNewer) advanceContextWindow(channelId, focusId, next.ceilingSeq);
      else forgetContextWindow(channelId);
      if (!next.hasNewer && next.ceilingSeq > 0) void sessionRef.current.markRead(channelId, next.ceilingSeq);
    } catch (caught) {
      if (caught instanceof StaleRequestError) return;
      setError(sendError(caught, t));
    } finally {
      loadingNewerRef.current = false;
      setLoadingNewer(false);
    }
  }

  async function returnToLatest() {
    forgetContextWindow(channelId);
    setHasNewer(false);
    setWindowCeiling(null);
    setHighlightedId(null);
    nearBottom.current = true;
    setUnseen(0);
    setShowBack(false);
    try {
      const data = await sessionRef.current.client.get<unknown>(`/messages/channel/${channelId}?limit=${PAGE}`);
      const page = parseMessagePage(data);
      useRaftStore.getState().setChannelMessages(channelId, page);
      useRaftStore.getState().setThreadSummaries(parseThreadSummaries(data));
      setHasMore(page.length >= PAGE);
      setLimited(historyLimited(data));
      const seq = maxSeq(page);
      if (seq > 0) void sessionRef.current.markRead(channelId, seq);
    } catch (caught) {
      if (caught instanceof StaleRequestError) return;
      setError(sendError(caught, t));
    }
    requestAnimationFrame(() => {
      if (embedded) listRef.current?.scrollToEnd({ animated: true });
      else listRef.current?.scrollToOffset({ offset: 0, animated: true });
    });
  }

  async function openAttachment(attachment: MessageAttachment) {
    if (!attachment.id) return;
    if (canRenderSvgNatively(attachment) && !attachment.rasterPreviewUrl) {
      // SVGs that reached the file-card path (e.g. no mime type, only the
      // .svg suffix) render in the same native viewer as the image grid.
      setImageViewer({ images: [attachment], index: 0 });
      return;
    }
    {
      const kind = viewKind(attachment.filename, attachment.mimeType);
      if (kind === "text" || kind === "markdown") {
        try {
          const enabled = await attachmentPreviewGate.load(() => sessionRef.current.client.get<unknown>("/messages/attachment-preview/enabled"));
          if (enabled) {
            setFileViewer(attachment);
            return;
          }
        } catch (caught) {
          if (caught instanceof StaleRequestError) return;
        }
      }
      if (downloadingRef.current) return;
      const sessionNow = sessionRef.current;
      if (!sessionNow.origin) {
        setError(t("mobile.attachments.failed"));
        return;
      }
      downloadingRef.current = attachment.id;
      setDownloadingAttachmentId(attachment.id);
      try {
        await downloadAndShareAttachment({
          url: attachmentDownloadUrl(sessionNow.origin, attachment.id),
          getAccessToken: () => sessionRef.current.client.getAccessToken(),
          getHeaders: () => sessionRef.current.client.authHeaders(),
          refreshTokens: async () => {
            await sessionRef.current.client.refreshTokens();
          },
          filename: attachment.filename,
          mimeType: attachment.mimeType,
        });
      } catch (caught) {
        if (caught instanceof StaleRequestError) return;
        setError(t("mobile.attachments.failed"));
      } finally {
        downloadingRef.current = null;
        setDownloadingAttachmentId(null);
      }
      return;
    }
  }

  /** SVG renders natively in the image viewer (expo-image parses SVG in
   *  image mode: no scripts, no external loads); oversize files fall to the
   *  generic viewer's unsupported state so a huge SVG cannot stall decode. */
  function openImageGroup(images: MessageAttachment[], index: number) {
    const tapped = images[index];
    if (tapped && isSvgAttachment(tapped) && !tapped.rasterPreviewUrl && !canRenderSvgNatively(tapped)) {
      setFileViewer(tapped);
      return;
    }
    setImageViewer({ images, index });
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

  async function deliver(content: string, randomId: string, optimisticId: string, attachmentIds: string[]) {
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
        attachmentIds,
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
    const storedIds = existing?.attachments?.flatMap((file) => file.id ? [file.id] : []) ?? [];
    const ready = uploads.filter((file) => file.status === "ready" && file.attachmentId);
    if (!existing && uploads.some((file) => file.status !== "ready")) return;
    const attachmentIds = attachmentIdsForSend({
      retry: Boolean(existing),
      pendingIds: ready.flatMap((file) => file.attachmentId ? [file.attachmentId] : []),
      messageIds: storedIds,
    });
    const typed = (existing?.content ?? draft).trim();
    const content = typed || (attachmentIds.length > 0 ? t("message.composer.attachmentsOnlyBody", { count: attachmentIds.length }) : "");
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
      attachments: attachmentIds.map((id) => {
        const pending = ready.find((file) => file.attachmentId === id);
        const previous = existing?.attachments?.find((file) => file.id === id);
        return { id, filename: previous?.filename ?? pending?.name ?? id, mimeType: previous?.mimeType ?? pending?.mimeType };
      }),
    };
    if (hasNewerRef.current) await returnToLatest();
    useRaftStore.getState().upsertMessages([optimistic]);
    nearBottom.current = true;
    setUnseen(0);
    requestAnimationFrame(() => {
      if (embedded) listRef.current?.scrollToEnd({ animated: true });
      else listRef.current?.scrollToOffset({ offset: 0, animated: true });
    });
    if (!existing) {
      setDraft("");
      setAsTask(false);
      setUploads([]);
      setMentions([]);
      setCandidates([]);
      setChannelHits([]);
      void persistDraft(channelId, "");
    }
    setError(null);
    await deliver(content, randomId, optimisticId, attachmentIds);
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
  const reversed = useMemo(() => [...visibleMessages].reverse(), [visibleMessages]);
  const focusMessageId = resolvedTarget ?? targetMessageId ?? null;
  useEffect(() => {
    jumpedRef.current = null;
    setResolvedTarget(null);
  }, [channelId, targetMessageId]);
  useEffect(() => {
    if (!focusMessageId || jumpedRef.current === focusMessageId) return;
    const index = reversed.findIndex((message) => message.id === focusMessageId);
    if (index < 0) return;
    jumpedRef.current = focusMessageId;
    setHighlightedId(focusMessageId);
    const frame = requestAnimationFrame(() => {
      listRef.current?.scrollToIndex({ index, animated: false, viewPosition: JUMP_VIEW_POSITION });
    });
    return () => cancelAnimationFrame(frame);
  }, [focusMessageId, reversed]);
  useEffect(() => {
    if (!highlightedId) return;
    const timer = setTimeout(() => setHighlightedId(null), 3400);
    return () => clearTimeout(timer);
  }, [highlightedId]);
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
  const imageUrls = useRef(new Map<string, Promise<string | null>>());
  const resolveImageUrl = useCallback((attachment: MessageAttachment, options?: { refresh?: boolean }): Promise<string | null> => {
    if (!attachment.id) return Promise.resolve(null);
    if (options?.refresh) imageUrls.current.delete(attachment.id);
    const cached = imageUrls.current.get(attachment.id);
    if (cached) return cached;
    const pending = sessionRef.current.client.get<unknown>(`/attachments/${attachment.id}/url?disposition=inline`)
      .then((data) => {
        const raw = isRecord(data) && typeof data.url === "string" ? data.url : null;
        return raw ? rewriteAttachmentUrl(raw, sessionRef.current.origin) : null;
      })
      .catch(() => {
        imageUrls.current.delete(attachment.id as string);
        return null;
      });
    imageUrls.current.set(attachment.id, pending);
    return pending;
  }, []);
  const openAttachmentRef = useRef(openAttachment);
  openAttachmentRef.current = openAttachment;
  const openAttachmentStable = useCallback((attachment: MessageAttachment) => {
    void openAttachmentRef.current(attachment);
  }, []);
  const openImageGroupRef = useRef(openImageGroup);
  openImageGroupRef.current = openImageGroup;
  const openImageGroupStable = useCallback((images: MessageAttachment[], index: number) => {
    openImageGroupRef.current(images, index);
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
    const serverId = session.serverId;
    if (!serverId || Object.keys(useRaftStore.getState().senderAvatars).length > 0) return;
    let cancelled = false;
    void Promise.all([
      sessionRef.current.client.get<unknown>("/agents").catch(() => null),
      sessionRef.current.client.get<unknown>(`/servers/${serverId}/members`).catch(() => null),
    ]).then(([agents, members]) => {
      if (cancelled) return;
      useRaftStore.getState().setSenderAvatars(collectSenderAvatars(agents, members));
    });
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
    if (!claimReaction(reactionFlight.current, messageId, emoji)) return;
    const message = storedMessage(messageId);
    if (!message || message.id.startsWith("optimistic-") || message.messageType === "system") {
      releaseReaction(reactionFlight.current, messageId, emoji);
      return;
    }
    const mine = message.reactions?.some((reaction) => reaction.emoji === emoji && (reaction.reactedByMe || Boolean(userId && reaction.userIds?.includes(userId)))) ?? false;
    useRaftStore.getState().upsertMessages([applyReaction(message, emoji, !mine, userId)]);
    void setMessageReaction(sessionRef.current.client, messageId, emoji, !mine).then(() => {
      releaseReaction(reactionFlight.current, messageId, emoji);
    }).catch((caught: unknown) => {
      releaseReaction(reactionFlight.current, messageId, emoji);
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

  const headerIcon = thread
    ? <HeaderIconSlot fill={color.cyan}><MessageSquare color={color.ink} size={16} strokeWidth={2.5} /></HeaderIconSlot>
    : meta?.type === "dm"
      ? <Avatar avatarUrl={meta.peerAvatarUrl} kind={meta.peerKind === "agent" ? "agent" : "human"} name={meta.peerName || title} size={36} />
      : <HeaderIconSlot>{meta?.visibility === "private" || meta?.type === "private" ? <Lock color={color.ink} size={16} strokeWidth={2.5} /> : <Hash color={color.ink} size={16} strokeWidth={2.5} />}</HeaderIconSlot>;
  const composerTarget = meta?.type === "dm" ? `@${meta.peerName || title}` : `#${meta?.name || title}`;
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

  const frameStyle = [styles.page, androidKeyboard > 0 ? { paddingBottom: androidKeyboard } : null];
  return (
    <KeyboardAvoidingView
      behavior={embedded || Platform.OS !== "ios" ? undefined : "padding"}
      keyboardVerticalOffset={embedded ? 0 : insets.top + 56}
      style={frameStyle}
    >
      {embedded ? null : <PanelHeader
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
                <AppText style={styles.headerActionText}>
                  {followedIds.has(parentMessageId) ? t("message.messageItem.unfollowThread") : t("message.messageItem.followThread")}
                </AppText>
              </Pressable>
            ) : null}
            <HeaderIconButton accessibilityLabel={t("message.chatPanel.searchChannel")} onPress={() => router.push("/search")}>
              <Search color={color.ink} size={16} strokeWidth={2.5} />
            </HeaderIconButton>
            {settingsChannelId ? (
              <HeaderIconButton accessibilityLabel={t("mobile.messages.members")} onPress={() => setSettingsOpen(true)}>
                <Settings color={color.ink} size={16} strokeWidth={2.5} />
              </HeaderIconButton>
            ) : null}
            {settingsChannelId && memberCount !== null && meta?.type !== "dm" ? (
              <HeaderIconButton accessibilityLabel={t("mobile.messages.members")} onPress={() => setSettingsOpen(true)} wide>
                <Users color={color.ink} size={16} strokeWidth={2.5} />
                <AppText style={styles.memberCount}>{String(memberCount)}</AppText>
              </HeaderIconButton>
            ) : null}
          </>
        )}
        icon={headerIcon}
        onBack={() => router.back()}
        onTitlePress={thread ? () => listRef.current?.scrollToEnd({ animated: true }) : undefined}
        subtitle={headerSubtitle}
        title={headerTitle}
      />}
      {loading && messages.length === 0 && !embedded ? (
        <View style={styles.center}><ActivityIndicator color={colors.accent} /></View>
      ) : (
      <View style={styles.timeline}>
        <FlatList
          ref={listRef}
          data={embedded ? visibleMessages : reversed}
          inverted={!embedded}
          keyExtractor={(item) => item.id}
          maintainVisibleContentPosition={embedded ? undefined : hasNewer
            ? { minIndexForVisible: 0 }
            : { minIndexForVisible: 0, autoscrollToTopThreshold: 100 }}
          onEndReached={embedded ? undefined : () => void loadOlder()}
          onEndReachedThreshold={0.3}
          onScrollToIndexFailed={(info) => {
            listRef.current?.scrollToOffset({ offset: Math.max(0, info.averageItemLength * info.index), animated: false });
            setTimeout(() => {
              listRef.current?.scrollToIndex({ index: info.index, animated: false, viewPosition: JUMP_VIEW_POSITION });
            }, 50);
          }}
          onScroll={(event: NativeSyntheticEvent<NativeScrollEvent>) => {
            const offset = event.nativeEvent.contentOffset.y;
            if (embedded) {
              if (offset < 48) void loadOlder();
              return;
            }
            lastOffset.current = offset;
            const atTail = !hasNewerRef.current && offset < 100;
            nearBottom.current = atTail;
            const back = hasNewerRef.current || offset >= 100;
            setShowBack((current) => current === back ? current : back);
            if (atTail) setUnseen((count) => (count === 0 ? count : 0));
            if (hasNewerRef.current && offset < 160 && (!focusMessageId || jumpedRef.current === focusMessageId)) void loadNewer();
          }}
          onViewableItemsChanged={onViewableItemsChanged}
          scrollEventThrottle={32}
          viewabilityConfig={viewabilityConfig}
          contentContainerStyle={embedded ? styles.embeddedList : styles.list}
          ListHeaderComponent={embedded ? (
            <View>
              {listHeader}
              {loadingOlder ? <ActivityIndicator color={colors.accent} /> : null}
              {!hasMore && messages.length > 0 ? (
                <View style={styles.threadStart}>
                  <AppText style={styles.note}>{t(thread ? "message.historyTop.beginningOfReplies" : "message.historyTop.beginningOfMessages")}</AppText>
                  {thread ? <AppText style={styles.note}>{t("message.inlineThreadReplies.replyCount", { count: messages.length })}</AppText> : null}
                </View>
              ) : null}
            </View>
          ) : loadingNewer ? <ActivityIndicator color={colors.accent} /> : null}
          ListFooterComponent={embedded ? (loadingNewer ? <ActivityIndicator color={colors.accent} /> : null) : loadingOlder
            ? <ActivityIndicator color={colors.accent} />
            : limited
              ? <AppText style={styles.note}>{t("mobile.messages.historyLimited")}</AppText>
              : !hasMore && messages.length > 0
                ? <AppText style={styles.note}>{t(thread ? "message.historyTop.beginningOfReplies" : "message.historyTop.beginningOfMessages")}</AppText>
                : null}
          ListEmptyComponent={<AppText style={styles.note}>{t("mobile.messages.empty")}</AppText>}
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
                downloadingAttachmentId={downloadingAttachmentId}
                downloadingLabel={t("mobile.attachments.downloading")}
                group={group}
                linkedTask={tasksByMessage.get(item.id)}
                message={item}
                onAddReaction={(messageId, x, y) => longPressMessage(messageId, x, y, true)}
                onDelete={deleteMessage}
                onLongPressMessage={longPressMessage}
                onLongPressSender={mentionSender}
                onOpenAttachment={openAttachmentStable}
                onOpenImage={openImageGroupStable}
                resolveImageUrl={resolveImageUrl}
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
                highlighted={item.id === highlightedId}
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
        {stickyAt && !embedded ? (
          <View pointerEvents="none" style={styles.sticky}>
            <AppText style={styles.stickyText}>{formatDayLabel(stickyAt, timeOptions)}</AppText>
          </View>
        ) : null}
        {!embedded && (showBack || hasNewer || unseen > 0) ? (
          <Pressable
            onPress={() => {
              if (hasNewerRef.current) {
                void returnToLatest();
                return;
              }
              nearBottom.current = true;
              setUnseen(0);
              listRef.current?.scrollToOffset({ offset: 0, animated: true });
            }}
            style={styles.jump}
          >
            <AppText style={styles.jumpText}>{hasNewer || unseen === 0
              ? t("message.chatPanel.backToBottom")
              : `↓ ${t("message.chatPanel.newMessagesCount", { count: unseen })}`}</AppText>
          </Pressable>
        ) : null}
      </View>
      )}
      {query !== null && candidates.length > 0 ? (
        <View style={styles.candidates}>
          {candidates.map((candidate) => (
            <Pressable key={candidate.id} onPress={() => chooseMention(candidate)} style={styles.candidate}>
              <AppText style={styles.candidateName}>@{candidate.name}</AppText>
              <AppText style={styles.candidateLabel}>{candidate.label}</AppText>
            </Pressable>
          ))}
        </View>
      ) : null}
      {channelHits.length > 0 ? (
        <View style={styles.candidates}>
          {channelHits.map((channel) => (
            <Pressable key={channel.id} onPress={() => chooseChannel(channel)} style={styles.candidate}>
              <AppText style={styles.candidateName}>#{channel.name}</AppText>
              <AppText style={styles.candidateLabel}>{channel.archived ? t("message.composer.archivedBadge") : channel.description ?? ""}</AppText>
            </Pressable>
          ))}
        </View>
      ) : null}
      {uploads.length > 0 ? (
        <View style={styles.uploads}>
          {uploads.map((file) => (
            <View key={file.localId} style={styles.uploadRow}>
              <AppText numberOfLines={1} style={styles.uploadName}>{file.status === "uploading" ? `${file.name} ${file.progress}%` : file.name}</AppText>
              {file.status === "error" ? (
                <Pressable onPress={() => void uploadLocal(file)}><AppText style={styles.uploadAction}>{t("mobile.messages.resend")}</AppText></Pressable>
              ) : null}
              <Pressable onPress={() => setUploads((current) => current.filter((item) => item.localId !== file.localId))}><AppText style={styles.uploadAction}>{t("mobile.messages.delete")}</AppText></Pressable>
            </View>
          ))}
        </View>
      ) : null}
      {error ? <AppText style={styles.error}>{error}</AppText> : null}
      <View style={[styles.composer, { paddingBottom: androidKeyboard > 0 ? 8 : Math.max(insets.bottom, 12) }]}>
        <TextInput
          ref={inputRef}
          blurOnSubmit={false}
          multiline
          onChangeText={(value) => void onChangeDraft(value)}
          placeholder={thread ? t("message.threadPanel.composerPlaceholder") : t("message.composer.messagePlaceholder", { channel: composerTarget })}
          placeholderTextColor={colors.muted}
          style={styles.input}
          submitBehavior="newline"
          value={draft}
        />
        <View style={styles.toolbar}>
          <View style={styles.tools}>
            <ToolButton onPress={() => void pickImage(false)}><ImagePlus color={color.ink} size={16} strokeWidth={2.5} /></ToolButton>
            <ToolButton onPress={() => void pickImage(true)}><Camera color={color.ink} size={16} strokeWidth={2.5} /></ToolButton>
            <ToolButton onPress={() => void pickFile()}><Paperclip color={color.ink} size={16} strokeWidth={2.5} /></ToolButton>
            {thread ? null : (
              <Pressable accessibilityRole="checkbox" accessibilityState={{ checked: asTask }} onPress={() => { setAsTask((current) => !current); focusComposer(); }} style={styles.taskToggle}>
                <ListChecks color={color.ink} size={16} />
                <AppText style={styles.taskLabel}>{t("message.composer.asTask")}</AppText>
                <View style={[styles.box, asTask ? styles.boxOn : null]} />
              </Pressable>
            )}
          </View>
          {(() => {
            const sendDisabled = uploads.some((file) => file.status !== "ready") || (draft.trim().length === 0 && !uploads.some((file) => file.status === "ready"));
            return (
              <Pressable accessibilityLabel={t("mobile.messages.send")} accessibilityRole="button" disabled={sendDisabled} onPress={() => void send()}>
                {sendDisabled ? (
                  <View style={[styles.send, styles.sendDisabled]}>
                    <SendHorizontal color={color.muted} size={16} strokeWidth={2.5} />
                  </View>
                ) : (
                  <HardShadow offset={shadowOffset.sm}>
                    <View style={styles.send}>
                      <SendHorizontal color={color.ink} size={16} strokeWidth={2.5} />
                    </View>
                  </HardShadow>
                )}
              </Pressable>
            );
          })()}
        </View>
      </View>
      {fileViewer ? (
        <AttachmentViewer
          attachment={fileViewer}
          getAccessToken={() => sessionRef.current.client.getAccessToken()}
          getHeaders={() => sessionRef.current.client.authHeaders()}
          loadPreview={(id) => sessionRef.current.client.get<unknown>(`/attachments/${id}/preview`)}
          onClose={() => setFileViewer(null)}
          origin={session.origin}
          refreshTokens={async () => {
            await sessionRef.current.client.refreshTokens();
          }}
        />
      ) : null}
      {imageViewer ? (
        <ImageViewer
          getAccessToken={() => sessionRef.current.client.getAccessToken()}
          getHeaders={() => sessionRef.current.client.authHeaders()}
          images={imageViewer.images}
          index={imageViewer.index}
          onClose={() => setImageViewer(null)}
          origin={session.origin}
          refreshTokens={async () => {
            await sessionRef.current.client.refreshTokens();
          }}
          resolve={resolveImageUrl}
        />
      ) : null}
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
          onFollow={(() => {
            if (!menuMessage) return undefined;
            const threadChannelId = threadByParent[menuMessage.id] ?? useRaftStore.getState().threadSummaries[menuMessage.id]?.threadChannelId ?? menuMessage.threadId ?? undefined;
            if (!threadMenuActions({ inThread: Boolean(thread), threadChannelId }).follow) return undefined;
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
          onThread={threadMenuActions({ inThread: Boolean(thread) }).openThread ? () => {
            setMenu(null);
            openThread(menuMessage.id);
          } : undefined}
          openedAt={menu.openedAt}
          reactionsOnly={menu.reactionsOnly}
          saved={savedIds.has(menuMessage.id)}
          taskLabel={threadMenuActions({ inThread: Boolean(thread) }).task ? (menuTask?.taskId
            ? (menuTask.status === "done" ? t("message.messageItem.reopenTask") : t("message.messageItem.markAsDone"))
            : t("message.messageItem.convertToTask")) : null}
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


function ToolButton({ children, onPress }: { children: ReactNode; onPress: () => void }) {
  return (
    <Pressable accessibilityRole="button" hitSlop={4} onPress={onPress}>
      <HardShadow offset={shadowOffset.sm}>
        <View style={styles.toolFace}>{children}</View>
      </HardShadow>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  page: { flex: 1, backgroundColor: colors.bg },
  center: { flex: 1, alignItems: "center", justifyContent: "center", backgroundColor: colors.bg },
  list: { padding: space.md },
  embeddedList: { paddingBottom: space.md },
  threadStart: { borderBottomColor: colors.line, borderBottomWidth: 1, marginBottom: 8, paddingBottom: 8 },
  timeline: { flex: 1 },
  sticky: { alignSelf: "center", backgroundColor: color.white, borderColor: color.border, borderWidth: 2, paddingHorizontal: 10, paddingVertical: 3, position: "absolute", top: 6, zIndex: 2 },
  stickyText: { color: color.ink, fontSize: 10, fontWeight: "700", letterSpacing: 0.8, textTransform: "uppercase" },
  jump: { alignSelf: "center", backgroundColor: color.yellow, borderColor: color.border, borderWidth: 2, bottom: 12, paddingHorizontal: 12, paddingVertical: 6, position: "absolute" },
  jumpText: { color: color.ink, fontSize: 13, fontWeight: "700" },
  headerAction: { alignItems: "center", justifyContent: "center", minHeight: 32, paddingHorizontal: 4 },
  headerActionText: { color: color.ink, fontSize: 12, fontWeight: "700" },
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
  input: { color: color.ink, fontFamily: "SpaceGrotesk-400", fontSize: 16, maxHeight: 128, minHeight: 24, paddingHorizontal: 4, paddingVertical: 4 },
  toolbar: { alignItems: "center", flexDirection: "row", justifyContent: "space-between" },
  tools: { alignItems: "center", flexDirection: "row", gap: 8 },
  tool: { alignItems: "center", height: 32, justifyContent: "center", width: 32 },
  taskToggle: { alignItems: "center", flexDirection: "row", gap: 6 },
  taskLabel: { color: color.ink, fontSize: 12, fontWeight: "700" },
  box: { borderColor: color.border, borderWidth: 2, height: 16, width: 16 },
  boxOn: { backgroundColor: color.yellow },
  send: { alignItems: "center", backgroundColor: color.pink, borderColor: color.border, borderWidth: 2, height: 32, justifyContent: "center", width: 36 },
  sendDisabled: { backgroundColor: color.pinkPale, borderColor: color.muted, marginBottom: shadowOffset.sm, marginRight: shadowOffset.sm },
  toolFace: { alignItems: "center", backgroundColor: color.page, borderColor: color.border, borderWidth: 2, height: 30, justifyContent: "center", width: 30 },
  memberCount: { color: color.ink, fontSize: 13, fontWeight: "700" },
  sendText: { color: color.ink, fontSize: 14, fontWeight: "700" },
  uploads: { gap: 4, paddingHorizontal: 12 },
  uploadRow: { alignItems: "center", flexDirection: "row", gap: 8 },
  uploadName: { color: color.ink, flex: 1, fontSize: 13 },
  uploadAction: { color: color.ink, fontSize: 13, fontWeight: "700" },
});
