import { create } from "zustand";
import { useActivityStore } from "../activity/store";
import { useTaskStore } from "../tasks/store";
import { useBoardStore } from "../tasks/boardStore";
import { maxSeq } from "../model/messages";
import { reconcileIncoming } from "../model/reconcile";
import { applyLiveMessage, replaceConversations, shouldRefreshForUnknownChannel, type ConversationEntry } from "../home/conversations";
import type { ChannelUnreadEntry, RaftChannel, RaftMessage, ThreadSummary } from "../model/messages";

interface RaftDataState {
  messagesByChannel: Record<string, RaftMessage[]>;
  threadSummaries: Record<string, ThreadSummary>;
  channelUnread: Record<string, ChannelUnreadEntry>;
  liveUnread: Record<string, number>;
  lastSeq: number;
  directoryVersion: number;
  /**
   * Sender-directory gate (#desktop-data-cache task #3, review fix): which
   * server the cached seed has painted this process, and which server has a
   * FRESH network load. Store state (not module vars) so clearServerData —
   * logout and server switches — resets them; otherwise a re-login on the
   * same server would skip both the seed and the fetch until app restart.
   */
  senderDirectorySeededServer: string | null;
  senderDirectoryFreshServer: string | null;
  /** Record a seed/fresh milestone for the sender-directory gate. */
  markSenderDirectory: (kind: "seeded" | "fresh", serverId: string) => void;
  notice: "verify-email" | "profile-setup" | null;
  /** Sender id → avatar URL from `/agents` and server members; messages do not carry avatars. */
  senderAvatars: Record<string, string>;
  /** Message-list home: merged channels+DMs sorted by latest activity (task #2). */
  conversations: ConversationEntry[];
  /** Every channel id the last full load listed (threads are never listed); unknown-channel detection. */
  conversationChannelIds: ReadonlySet<string>;
  setSenderAvatars: (avatars: Record<string, string>) => void;
  setConversations: (freshChannels: RaftChannel[]) => void;
  applyLiveToConversations: (message: RaftMessage) => void;
  upsertMessages: (incoming: RaftMessage[]) => void;
  setChannelMessages: (channelId: string, messages: RaftMessage[]) => void;
  setThreadSummaries: (summaries: Record<string, ThreadSummary>) => void;
  setChannelUnread: (unread: Record<string, ChannelUnreadEntry>) => void;
  bumpLiveUnread: (channelId: string) => void;
  clearLiveUnread: (channelId: string) => void;
  clearChannelUnread: (channelId: string) => void;
  dropMessage: (channelId: string, messageId: string) => void;
  noteSeq: (seq: number) => void;
  bumpDirectory: () => void;
  setNotice: (notice: RaftDataState["notice"]) => void;
  clearServerData: () => void;
}

export const useRaftStore = create<RaftDataState>((set) => ({
  messagesByChannel: {},
  threadSummaries: {},
  channelUnread: {},
  liveUnread: {},
  lastSeq: 0,
  directoryVersion: 0,
  notice: null,
  senderAvatars: {},
  senderDirectorySeededServer: null,
  senderDirectoryFreshServer: null,
  markSenderDirectory: (kind, serverId) => set(kind === "seeded"
    ? { senderDirectorySeededServer: serverId }
    : { senderDirectoryFreshServer: serverId }),
  conversations: [],
  conversationChannelIds: new Set<string>(),
  setSenderAvatars: (avatars) => set({ senderAvatars: avatars }),
  setConversations: (freshChannels) => set((state) => ({
    conversations: replaceConversations(state.conversations, freshChannels),
    conversationChannelIds: new Set(freshChannels.map((channel) => channel.id)),
  })),
  applyLiveToConversations: (message) => set((state) => {
    const result = applyLiveMessage(state.conversations, message);
    if (result.changed) return { conversations: result.entries };
    // A message for a never-listed, non-thread channel means the directory
    // changed (new DM peer, newly joined channel): bump so the home screen's
    // debounced reload picks the conversation up.
    if (!shouldRefreshForUnknownChannel(message, state.conversationChannelIds)) return state;
    return { directoryVersion: state.directoryVersion + 1 };
  }),
  upsertMessages: (incoming) => set((state) => {
    const messagesByChannel = { ...state.messagesByChannel };
    let lastSeq = state.lastSeq;
    for (const message of incoming) {
      const bucket = messagesByChannel[message.channelId] ?? [];
      messagesByChannel[message.channelId] = reconcileIncoming(bucket, message);
      if (typeof message.seq === "number") lastSeq = Math.max(lastSeq, message.seq);
    }
    return { messagesByChannel, lastSeq };
  }),
  setChannelMessages: (channelId, messages) => set((state) => ({
    messagesByChannel: { ...state.messagesByChannel, [channelId]: messages },
    lastSeq: Math.max(state.lastSeq, maxSeq(messages)),
  })),
  setThreadSummaries: (summaries) => set((state) => ({
    threadSummaries: { ...state.threadSummaries, ...summaries },
  })),
  setChannelUnread: (unread) => set({ channelUnread: unread }),
  bumpLiveUnread: (channelId) => set((state) => ({
    liveUnread: { ...state.liveUnread, [channelId]: (state.liveUnread[channelId] ?? 0) + 1 },
  })),
  clearLiveUnread: (channelId) => set((state) => {
    if (!state.liveUnread[channelId]) return state;
    const liveUnread = { ...state.liveUnread };
    delete liveUnread[channelId];
    return { liveUnread };
  }),
  clearChannelUnread: (channelId) => set((state) => {
    const current = state.channelUnread[channelId];
    if (!current || (current.unreadCount === 0 && !current.hasMention)) return state;
    return {
      channelUnread: {
        ...state.channelUnread,
        [channelId]: { unreadCount: 0, hasMention: false },
      },
    };
  }),
  dropMessage: (channelId, messageId) => set((state) => {
    const bucket = state.messagesByChannel[channelId];
    if (!bucket?.some((message) => message.id === messageId)) return state;
    return {
      messagesByChannel: {
        ...state.messagesByChannel,
        [channelId]: bucket.filter((message) => message.id !== messageId),
      },
    };
  }),
  noteSeq: (seq) => set((state) => ({ lastSeq: Math.max(state.lastSeq, seq) })),
  bumpDirectory: () => set((state) => ({ directoryVersion: state.directoryVersion + 1 })),
  setNotice: (notice) => set({ notice }),
  clearServerData: () => {
    useActivityStore.getState().reset();
    useTaskStore.getState().reset();
    // The tasks board would otherwise stay loaded from the previous server
    // (its load() early-returns while loaded) after a rail switch.
    useBoardStore.getState().reset();
    set({
      messagesByChannel: {},
      threadSummaries: {},
      channelUnread: {},
      liveUnread: {},
      lastSeq: 0,
      senderAvatars: {},
      senderDirectorySeededServer: null,
      senderDirectoryFreshServer: null,
      conversations: [],
      conversationChannelIds: new Set<string>(),
    });
  },
}));
