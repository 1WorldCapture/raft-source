import { create } from "zustand";
import type { ApiClient } from "../api/client";
import {
  activityScopeId,
  applyFollow,
  applyMarkAllRead,
  applyMarkRead,
  applyMarkUnread,
  applyReadState,
  applyRemove,
  doneRequest,
  mergeActivityItems,
  parseActivityPage,
  type ActivityFilter,
  type ActivityItem,
  type ActivitySnapshot,
} from "./model";

const PAGE_SIZE = 30;
const REFRESH_DEBOUNCE_MS = 150;

interface ActivityState extends ActivitySnapshot {
  loading: boolean;
  loadingMore: boolean;
  loaded: boolean;
  error: string | null;
  load: (client: ApiClient, filter: ActivityFilter) => Promise<void>;
  loadMore: (client: ApiClient) => Promise<void>;
  refresh: (client: ApiClient) => Promise<void>;
  scheduleRefresh: (client: ApiClient) => void;
  markRead: (client: ApiClient, item: ActivityItem) => Promise<void>;
  markUnread: (client: ApiClient, item: ActivityItem) => Promise<void>;
  markAllRead: (client: ApiClient) => Promise<void>;
  markDone: (client: ApiClient, item: ActivityItem) => Promise<void>;
  markUndone: (client: ApiClient, item: ActivityItem) => Promise<void>;
  setFollowing: (client: ApiClient, item: ActivityItem, following: boolean) => Promise<void>;
  applyReadStates: (scopeIds: readonly string[]) => void;
  reset: () => void;
}

const EMPTY: ActivitySnapshot = {
  items: [],
  hasMore: false,
  totalCount: 0,
  totalUnreadCount: 0,
  activeUnreadCount: 0,
  filter: "all",
};

let requestSeq = 0;
let refreshTimer: ReturnType<typeof setTimeout> | null = null;

function snapshotOf(state: ActivitySnapshot): ActivitySnapshot {
  return {
    items: state.items,
    hasMore: state.hasMore,
    totalCount: state.totalCount,
    totalUnreadCount: state.totalUnreadCount,
    activeUnreadCount: state.activeUnreadCount,
    filter: state.filter,
  };
}

function pagePath(filter: ActivityFilter, limit: number, offset: number): string {
  const query = `limit=${limit}&offset=${offset}`;
  if (filter === "done") return `/channels/inbox/done?${query}`;
  return `/channels/inbox?filter=${filter}&${query}`;
}

async function fetchPage(client: ApiClient, filter: ActivityFilter, limit: number, offset: number) {
  return parseActivityPage(await client.get<unknown>(pagePath(filter, limit, offset)));
}

export const useActivityStore = create<ActivityState>((set, get) => ({
  ...EMPTY,
  loading: false,
  loadingMore: false,
  loaded: false,
  error: null,

  async load(client, filter) {
    const seq = ++requestSeq;
    set({ filter, loading: true, loadingMore: false, error: null });
    try {
      const page = await fetchPage(client, filter, PAGE_SIZE, 0);
      if (seq !== requestSeq) return;
      set({ ...page, filter, loading: false, loaded: true, error: null });
    } catch (caught) {
      if (seq !== requestSeq) return;
      set({ loading: false, error: messageOf(caught) });
    }
  },

  async loadMore(client) {
    const state = get();
    if (!state.loaded || state.loading || state.loadingMore || !state.hasMore) return;
    const seq = ++requestSeq;
    const filter = state.filter;
    const offset = state.items.length;
    set({ loadingMore: true });
    try {
      const page = await fetchPage(client, filter, PAGE_SIZE, offset);
      if (seq !== requestSeq || get().filter !== filter) return;
      set({
        items: mergeActivityItems(get().items, page.items),
        hasMore: page.hasMore,
        totalCount: page.totalCount,
        totalUnreadCount: page.totalUnreadCount,
        activeUnreadCount: page.activeUnreadCount,
        loadingMore: false,
      });
    } catch (caught) {
      if (seq !== requestSeq) return;
      set({ loadingMore: false, error: messageOf(caught) });
    }
  },

  async refresh(client) {
    const state = get();
    if (!state.loaded) return;
    const seq = ++requestSeq;
    const filter = state.filter;
    const limit = Math.min(100, Math.max(PAGE_SIZE, state.items.length));
    try {
      const page = await fetchPage(client, filter, limit, 0);
      if (seq !== requestSeq || get().filter !== filter) return;
      set({ ...page, filter, loaded: true, error: null });
    } catch (caught) {
      if (seq !== requestSeq) return;
      set({ error: messageOf(caught) });
    }
  },

  scheduleRefresh(client) {
    if (!get().loaded) return;
    if (refreshTimer) clearTimeout(refreshTimer);
    refreshTimer = setTimeout(() => {
      refreshTimer = null;
      void get().refresh(client);
    }, REFRESH_DEBOUNCE_MS);
  },

  async markRead(client, item) {
    if (item.unreadCount <= 0) return;
    const scopeId = activityScopeId(item);
    await mutate(client, applyMarkRead(snapshotOf(get()), scopeId), () => client.post(`/channels/${scopeId}/read-all`, {}));
  },

  async markUnread(client, item) {
    const scopeId = activityScopeId(item);
    await mutate(client, applyMarkUnread(snapshotOf(get()), scopeId), () => client.post(`/channels/${scopeId}/unread`));
  },

  async markAllRead(client) {
    if (get().totalUnreadCount <= 0) return;
    await mutate(client, applyMarkAllRead(snapshotOf(get())), () => client.post("/channels/inbox/read-all", {}));
  },

  async markDone(client, item) {
    const request = doneRequest(item);
    if (request.action === "refresh") {
      await get().refresh(client);
      return;
    }
    const scopeId = activityScopeId(item);
    await mutate(client, applyRemove(snapshotOf(get()), scopeId), () => client.post(request.path, request.body));
  },

  async markUndone(client, item) {
    const scopeId = activityScopeId(item);
    const path = item.kind === "thread" ? "/channels/threads/undone" : "/channels/inbox/undone";
    const body = item.kind === "thread" ? { threadChannelId: item.threadChannelId } : { channelId: item.channelId };
    await mutate(client, applyRemove(snapshotOf(get()), scopeId), () => client.post(path, body));
  },

  async setFollowing(client, item, following) {
    if (item.kind !== "thread") return;
    await mutate(
      client,
      applyFollow(snapshotOf(get()), item.threadChannelId, following),
      () => (following
        ? client.post("/channels/threads/follow", { parentMessageId: item.parentMessageId })
        : client.post("/channels/threads/unfollow", { threadChannelId: item.threadChannelId })),
    );
  },

  applyReadStates(scopeIds) {
    if (scopeIds.length === 0) return;
    set(applyReadState(snapshotOf(get()), scopeIds));
  },

  reset() {
    requestSeq += 1;
    if (refreshTimer) clearTimeout(refreshTimer);
    refreshTimer = null;
    set({ ...EMPTY, loading: false, loadingMore: false, loaded: false, error: null });
  },
}));

async function mutate(client: ApiClient, next: ActivitySnapshot, send: () => Promise<unknown>) {
  const previous = snapshotOf(useActivityStore.getState());
  useActivityStore.setState(next);
  try {
    await send();
    await useActivityStore.getState().refresh(client);
  } catch (caught) {
    useActivityStore.setState({ ...previous, error: messageOf(caught) });
    await useActivityStore.getState().refresh(client);
  }
}

function messageOf(caught: unknown): string {
  return caught instanceof Error && caught.message ? caught.message : "Request failed";
}
