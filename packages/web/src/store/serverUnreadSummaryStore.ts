// Single shared owner of the cross-server unread summary
// (GET /servers/unread-summary). Before this store existed, LeftRail and
// Sidebar each held a private copy with different refresh policies (LeftRail:
// mount/prefs/chat-unread-flip only; Sidebar: +30s poll +focus/visibility),
// so the same screen could show different badges, and — the bug that motivated
// this — reading the Activity inbox never refreshed either copy, leaving the
// rail's Activity dot lit over an empty unread filter.
//
// Refresh triggers, all funnelled through the debounced load():
//   - retain() lifecycle (mount) and the 30s poll while any consumer lives
//   - window focus / document visible / notification-prefs event
//   - local chat-unread 0↔nonzero flip (messageStore subscription)
//   - explicit read actions (markRead/markAllRead/markDone) via noteReadActivity()
//   - socket `unread_summary:changed { serverId }` (server may not ship it
//     yet; the poll stays as the fallback) via applyUnreadSummaryChanged()
//
// On failure the snapshot is cleared rather than retained: a stale >0 count
// keeps dots lit forever, while a transient blank only hides them until the
// next poll succeeds.
import { create } from "zustand";
import api from "../api/client";
import { useMessageStore } from "./messageStore";
import { parseServerUnreadSummaryRows, retainServerUnreadSummary } from "../utils/serverUnreadSummary";
import { cachedUnreadSummary, claimDirectorySeed, currentDirectoryCacheScope, directoryCacheBindPending, recordUnreadSummary, whenDirectoryCacheBound } from "../cache/directoryCache";
import { useServerStore } from "./serverStore";
import type { ServerUnreadSummary } from "../utils/serverUnreadSummary";
import { SERVER_NOTIFICATION_PREFS_UPDATED_EVENT } from "./events/notificationPrefsEvents";

const POLL_INTERVAL_MS = 30_000;
/** Merge bursts (a burst of reads, a flipped-unread refetch) into one GET. */
const LOAD_DEBOUNCE_MS = 300;

interface ServerUnreadSummaryState {
  byServer: Record<string, ServerUnreadSummary>;
  load: () => Promise<void>;
  /** Debounced reload after a user read action (markRead/markAllRead/markDone). */
  noteReadActivity: () => void;
  /** Socket `unread_summary:changed` entry point; ignores malformed payloads. */
  applyUnreadSummaryChanged: (payload: unknown) => void;
  /** Start/stop the poll + listeners; refcounted across mounted consumers. */
  retain: () => void;
  release: () => void;
  reset: () => void;
}

// Lifecycle machinery lives outside the zustand state: it is transport, not
// UI state.
let refCount = 0;
let pollTimer: number | null = null;
let debounceTimer: number | null = null;
let messageStoreUnsubscribe: (() => void) | null = null;
let previousHasLocalUnread: boolean | null = null;
let queued = false;
let loadInFlight: Promise<void> | null = null;
// Bumped by reset(): flights captured before it may not touch the state when
// they finally settle, and the in-flight handshake must not survive a reset —
// a loader whose request never settles would otherwise wedge every future
// load() onto it forever.
let loadGeneration = 0;

const hasAnyLocalUnread = (): boolean =>
  Object.values(useMessageStore.getState().unreadCounts).some((count) => count > 0);

const handleWindowFocus = () => void useServerUnreadSummaryStore.getState().load();
const handleVisibility = () => {
  if (document.visibilityState === "visible") void useServerUnreadSummaryStore.getState().load();
};
const handleNotificationPrefsUpdated = () => void useServerUnreadSummaryStore.getState().load();

const handleLocalUnreadCounts = () => {
  // The cross-server badge only cares whether *any* local unread exists, so
  // collapse to a boolean — it flips on 0↔nonzero transitions, not per
  // message. Subscribing to the whole Record would refetch on every inbound
  // message.
  const next = hasAnyLocalUnread();
  if (previousHasLocalUnread === null) {
    previousHasLocalUnread = next;
    return;
  }
  if (next === previousHasLocalUnread) return;
  previousHasLocalUnread = next;
  void useServerUnreadSummaryStore.getState().load();
};

export const useServerUnreadSummaryStore = create<ServerUnreadSummaryState>((set, get) => {
  const debouncedLoad = () => {
    // Node-side store tests exercise markRead/markAllRead/markDone without a
    // browser; there is nothing to refresh there.
    if (typeof window === "undefined") return;
    if (debounceTimer !== null) window.clearTimeout(debounceTimer);
    debounceTimer = window.setTimeout(() => {
      debounceTimer = null;
      void get().load();
    }, LOAD_DEBOUNCE_MS);
  };

  const startLifecycle = () => {
    if (pollTimer === null) {
      pollTimer = window.setInterval(() => void get().load(), POLL_INTERVAL_MS);
    }
    window.addEventListener("focus", handleWindowFocus);
    document.addEventListener("visibilitychange", handleVisibility);
    window.addEventListener(SERVER_NOTIFICATION_PREFS_UPDATED_EVENT, handleNotificationPrefsUpdated);
    if (messageStoreUnsubscribe === null) {
      previousHasLocalUnread = null;
      messageStoreUnsubscribe = useMessageStore.subscribe(handleLocalUnreadCounts);
    }
  };

  const stopLifecycle = () => {
    if (pollTimer !== null) {
      window.clearInterval(pollTimer);
      pollTimer = null;
    }
    window.removeEventListener("focus", handleWindowFocus);
    document.removeEventListener("visibilitychange", handleVisibility);
    window.removeEventListener(SERVER_NOTIFICATION_PREFS_UPDATED_EVENT, handleNotificationPrefsUpdated);
    messageStoreUnsubscribe?.();
    messageStoreUnsubscribe = null;
    if (debounceTimer !== null) {
      window.clearTimeout(debounceTimer);
      debounceTimer = null;
    }
  };

  return {
    byServer: {},

    async load() {
      // Coalesce concurrent callers onto one flight; queued reloads during a
      // flight re-run after it settles.
      if (loadInFlight) {
        queued = true;
        await loadInFlight;
        return;
      }
      const generation = loadGeneration;
      const flight = (async () => {
        // Directory-cache (task #8): seed an empty store from the cached raw
        // wire payload; the write-back below is guarded by the scope captured
        // after attach so a server switch mid-flight never persists the
        // previous scope's summary into the new one.
        const epoch = useServerStore.getState().serverEpoch;
        const serverId = useServerStore.getState().current?.id ?? null;
        if (serverId && directoryCacheBindPending(serverId)) {
          // The summary is account-scoped. A server switch while this wait
          // is in flight must not drop the request.
          await whenDirectoryCacheBound(serverId);
        }
        const requestScope = currentDirectoryCacheScope();
        // Once per epoch. A later load in the same epoch (poll, focus, a
        // read that cleared the map) must not paint the cached snapshot
        // back over counts the user already cleared. Claiming before the
        // scope is bound still occupies the epoch, so the post-attach
        // reconnect cannot reseed a stale count.
        if (serverId && claimDirectorySeed("unreadSummary", epoch, serverId) && Object.keys(get().byServer).length === 0) {
          try {
            const cached = await cachedUnreadSummary(serverId);
            if (cached !== null && Object.keys(get().byServer).length === 0 && useServerStore.getState().serverEpoch === epoch) {
              set((state) => ({ byServer: retainServerUnreadSummary(state.byServer, parseServerUnreadSummaryRows(cached)) }));
            }
          } catch {
            // Best-effort seed; the network path is authoritative.
          }
        }
        try {
          const { data } = await api.get("/servers/unread-summary");
          if (generation !== loadGeneration) return; // reset() happened mid-flight; drop the stale snapshot.
          set((state) => ({ byServer: retainServerUnreadSummary(state.byServer, parseServerUnreadSummaryRows(data)) }));
          await recordUnreadSummary(data, requestScope, useServerStore.getState().current?.id ?? null);
        } catch {
          if (generation !== loadGeneration) return;
          // A failed refresh must not leave stale >0 counts lighting dots.
          set({ byServer: {} });
        }
      })();
      loadInFlight = flight;
      try {
        await flight;
      } finally {
        // reset() may have already cleared the handshake (or a successor
        // flight may own it); only retire the slot this flight actually holds.
        if (loadInFlight === flight) loadInFlight = null;
        if (queued) {
          queued = false;
          void get().load();
        }
      }
    },

    noteReadActivity() {
      debouncedLoad();
    },

    applyUnreadSummaryChanged(payload) {
      if (typeof payload !== "object" || payload === null) return;
      const serverId = (payload as { serverId?: unknown }).serverId;
      if (typeof serverId !== "string" || !serverId) return;
      debouncedLoad();
    },

    retain() {
      refCount += 1;
      if (refCount === 1) {
        startLifecycle();
        void get().load();
      }
    },

    release() {
      refCount = Math.max(0, refCount - 1);
      if (refCount === 0) stopLifecycle();
    },

    reset() {
      stopLifecycle();
      refCount = 0;
      queued = false;
      // Invalidate any in-flight snapshot and free the coalescing slot so a
      // request that never settles cannot wedge the load pipeline for good.
      loadGeneration += 1;
      loadInFlight = null;
      previousHasLocalUnread = null;
      set({ byServer: {} });
    },
  };
});
