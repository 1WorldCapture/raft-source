import { create } from "zustand";
import { useActivityStore } from "../activity/store";
import { useTaskStore } from "../tasks/store";
import { maxSeq } from "../model/messages";
import { reconcileIncoming } from "../model/reconcile";
import type { ChannelUnreadEntry, RaftMessage, ThreadSummary } from "../model/messages";

interface RaftDataState {
  messagesByChannel: Record<string, RaftMessage[]>;
  threadSummaries: Record<string, ThreadSummary>;
  channelUnread: Record<string, ChannelUnreadEntry>;
  liveUnread: Record<string, number>;
  lastSeq: number;
  directoryVersion: number;
  notice: "verify-email" | "profile-setup" | null;
  /** Sender id → avatar URL from `/agents` and server members; messages do not carry avatars. */
  senderAvatars: Record<string, string>;
  setSenderAvatars: (avatars: Record<string, string>) => void;
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
  setSenderAvatars: (avatars) => set({ senderAvatars: avatars }),
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
    set({
      messagesByChannel: {},
      threadSummaries: {},
      channelUnread: {},
      liveUnread: {},
      lastSeq: 0,
      senderAvatars: {},
    });
  },
}));
