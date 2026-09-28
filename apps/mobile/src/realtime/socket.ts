import { io, type Socket } from "socket.io-client";
import { shouldLogoutAfterRefresh } from "../api/client";
import { isRecord, parseMessage, type RaftMessage, type ThreadSummary } from "../model/messages";
import { authFailureAction, authRetryDelayMs } from "./authRetry";
import { parseAccessTokenExp, planReconnectAuthRefresh } from "./reconnectAuth";

export interface RealtimeOptions {
  getOrigin: () => string | null;
  getAccessToken: () => string | null;
  getServerId: () => string | null;
  getLastSeq: () => number;
  refreshTokens: () => Promise<unknown>;
  onSessionExpired: () => void;
  onMessage: (message: RaftMessage) => void;
  onCatchUp: (messages: RaftMessage[], hasMore: boolean) => void;
  onMessageUpdated: (message: RaftMessage) => void;
  onThreadUpdated: (summary: ThreadSummary & { parentMessageId: string }) => void;
  onReadState: (state: { channelId: string; maxReadSeq: number; readStateVersion: number; serverId: string | null }) => void;
  onReadStateBulk: (states: Array<{ channelId: string; maxReadSeq: number; readStateVersion: number; serverId: string | null }>) => void;
  onDirectoryChanged: (joinChannelId?: string) => void;
  onRoomsJoined: () => void;
  onServerOrderUpdated: (serverIds: unknown) => void;
  /** Server push that the Activity unread totals moved; refetch the summary. */
  onUnreadSummaryChanged: () => void;
  onConnect: () => void;
  onDisconnect: () => void;
  /** A handshake failed (network down or server unreachable); auth failures are handled here. */
  onConnectError?: () => void;
  onTaskCreated: (payload: unknown) => void;
  onTaskUpdated: (payload: unknown) => void;
  onTaskDeleted: (payload: unknown) => void;
}

const HEARTBEAT_STALE_MS = 90_000;

function looksLikeAuthFailure(message: string): boolean {
  const text = message.toLowerCase();
  return text.includes("expired") || text.includes("invalid") || text.includes("authentication");
}

function channelIdFrom(payload: unknown): string | null {
  if (!isRecord(payload)) return null;
  if (typeof payload.channelId === "string") return payload.channelId;
  if (typeof payload.id === "string") return payload.id;
  if (isRecord(payload.channel) && typeof payload.channel.id === "string") return payload.channel.id;
  return null;
}

export function createRealtime(options: RealtimeOptions) {
  let socket: Socket | null = null;
  let refreshInFlight: Promise<boolean> | null = null;
  let lastHeartbeat = 0;
  let watchdog: ReturnType<typeof setInterval> | null = null;
  let refreshedAfterAuthRejection = false;
  let authRetryAttempt = 0;
  let authRetryTimer: ReturnType<typeof setTimeout> | null = null;
  const joinedThreads = new Set<string>();

  function freshAuth(): Record<string, unknown> {
    return {
      token: options.getAccessToken(),
      serverId: options.getServerId(),
      clientKind: "mobile",
    };
  }

  function syncAuth() {
    if (!socket) return;
    socket.auth = freshAuth();
  }

  async function refreshAuthBeforeHandshake(current: Socket, force = false): Promise<boolean> {
    if (refreshInFlight) {
      return refreshInFlight.then((ok) => {
        if (ok) current.auth = freshAuth();
        return ok;
      });
    }
    const action = planReconnectAuthRefresh({
      latestAccessToken: options.getAccessToken(),
      freshAuth: freshAuth(),
      parseTokenExp: parseAccessTokenExp,
      now: Date.now(),
    });
    if (action.type === "skip") return false;
    if (action.type === "update-auth-only" && !force) {
      current.auth = action.auth;
      return true;
    }
    refreshInFlight = (async () => {
      try {
        await options.refreshTokens();
      } catch (error) {
        if (shouldLogoutAfterRefresh(error)) options.onSessionExpired();
        return false;
      }
      current.auth = freshAuth();
      return true;
    })().finally(() => {
      refreshInFlight = null;
    });
    return refreshInFlight;
  }

  function clearAuthRetry() {
    if (!authRetryTimer) return;
    clearTimeout(authRetryTimer);
    authRetryTimer = null;
  }

  function scheduleAuthRetry(current: Socket) {
    if (authRetryTimer) return;
    const delay = authRetryDelayMs(authRetryAttempt);
    authRetryAttempt += 1;
    current.io.reconnection(false);
    authRetryTimer = setTimeout(() => {
      authRetryTimer = null;
      if (socket !== current) return;
      void refreshAuthBeforeHandshake(current, true).then((ok) => {
        if (socket !== current) return;
        const action = authFailureAction({
          refreshOk: ok,
          hasAccessToken: Boolean(options.getAccessToken()),
          alreadyRefreshed: false,
        });
        if (action === "stop") {
          current.io.reconnection(false);
          current.disconnect();
          return;
        }
        if (action === "retry-later") {
          scheduleAuthRetry(current);
          return;
        }
        current.io.reconnection(true);
        current.auth = freshAuth();
        current.connect();
      });
    }, delay);
  }
  function rejoinThreads() {
    if (!socket) return;
    for (const channelId of joinedThreads) socket.emit("join:channel", channelId);
  }

  function ensure(): Socket | null {
    const origin = options.getOrigin();
    if (!origin) return null;
    if (socket) return socket;

    const created = io(origin, {
      autoConnect: false,
      forceNew: true,
      transports: ["websocket"],
      auth: freshAuth(),
    });
    created.on("message:new", (payload: unknown) => {
      const message = parseMessage(payload);
      if (!message) return;
      options.onMessage(message);
    });
    created.on("message:updated", (payload: unknown) => {
      const message = parseMessage(payload);
      if (message) options.onMessageUpdated(message);
    });
    created.on("thread:updated", (payload: unknown) => {
      if (!isRecord(payload) || typeof payload.parentMessageId !== "string" || typeof payload.threadChannelId !== "string") return;
      const replyCount = Number(payload.replyCount);
      // Keep latestReply: the task board (task #2) uses it to update a row's
      // latestActivity and unread count instantly; dropping it (as before)
      // forces every thread event into a full refetch for content the socket
      // already delivered.
      const latestReply = parseMessage(payload.latestReply);
      options.onThreadUpdated({
        parentMessageId: payload.parentMessageId,
        threadChannelId: payload.threadChannelId,
        replyCount: Number.isFinite(replyCount) ? replyCount : 0,
        lastReplyAt: typeof payload.lastReplyAt === "string" ? payload.lastReplyAt : null,
        ...(latestReply ? { latestReply } : {}),
      });
    });
    created.on("read_state:updated", (payload: unknown) => {
      if (!isRecord(payload)) return;
      const channelId = typeof payload.scopeId === "string"
        ? payload.scopeId
        : typeof payload.channelId === "string" ? payload.channelId : null;
      if (!channelId) return;
      options.onReadState({
        channelId,
        maxReadSeq: typeof payload.maxReadSeq === "number" && Number.isFinite(payload.maxReadSeq) ? payload.maxReadSeq : 0,
        readStateVersion: typeof payload.readStateVersion === "number" && Number.isFinite(payload.readStateVersion) ? payload.readStateVersion : 0,
        serverId: typeof payload.serverId === "string" ? payload.serverId : null,
      });
    });
    created.on("read_state:updated_bulk", (payload: unknown) => {
      if (!isRecord(payload) || !Array.isArray(payload.scopes)) return;
      const serverId = typeof payload.serverId === "string" ? payload.serverId : null;
      const states = payload.scopes.flatMap((scope) => (
        isRecord(scope) && typeof scope.scopeId === "string"
          ? [{
              channelId: scope.scopeId,
              maxReadSeq: typeof scope.maxReadSeq === "number" && Number.isFinite(scope.maxReadSeq) ? scope.maxReadSeq : 0,
              readStateVersion: typeof scope.readStateVersion === "number" && Number.isFinite(scope.readStateVersion) ? scope.readStateVersion : 0,
              serverId,
            }]
          : []
      ));
      if (states.length > 0) options.onReadStateBulk(states);
    });
    created.on("channel:updated", () => options.onDirectoryChanged());
    created.on("server_order:updated", (payload: unknown) => {
      if (!isRecord(payload) || !Array.isArray(payload.serverIds)) return;
      options.onServerOrderUpdated(payload.serverIds);
    });
    // Contract (#unread-badges task #4): payload is { serverId }; the client
    // refetches /servers/unread-summary. Malformed payloads are ignored — the
    // focus/poll refreshes stay as the fallback.
    created.on("unread_summary:changed", (payload: unknown) => {
      if (!isRecord(payload) || typeof payload.serverId !== "string" || !payload.serverId) return;
      options.onUnreadSummaryChanged();
    });
    created.on("dm:new", (payload: unknown) => {
      const channelId = channelIdFrom(payload);
      if (channelId) created.emit("join:channel", channelId);
      options.onDirectoryChanged(channelId ?? undefined);
    });
    created.on("heartbeat", () => {
      lastHeartbeat = Date.now();
    });
    created.on("rooms:joined", () => {
      rejoinThreads();
      const lastSeq = options.getLastSeq();
      if (lastSeq > 0) created.emit("sync:resume", { lastSeq });
      options.onRoomsJoined();
    });
    created.on("sync:resume:response", (payload: unknown) => {
      if (!isRecord(payload) || !Array.isArray(payload.messages)) return;
      const messages = payload.messages
        .map((item) => parseMessage(item))
        .filter((message): message is RaftMessage => message !== null);
      options.onCatchUp(messages, payload.hasMore === true);
    });
    created.on("connect_error", (error: Error) => {
      if (!looksLikeAuthFailure(error.message)) {
        options.onConnectError?.();
        return;
      }
      if (refreshInFlight) return;
      void refreshAuthBeforeHandshake(created, true).then((ok) => {
        if (socket !== created) return;
        const action = authFailureAction({
          refreshOk: ok,
          hasAccessToken: Boolean(options.getAccessToken()),
          alreadyRefreshed: refreshedAfterAuthRejection,
        });
        if (ok) refreshedAfterAuthRejection = true;
        if (action === "stop") {
          clearAuthRetry();
          created.io.reconnection(false);
          created.disconnect();
          return;
        }
        if (action === "retry-later") {
          scheduleAuthRetry(created);
          return;
        }
        if (created.connected) return;
        created.auth = freshAuth();
        created.connect();
      });
    });
    created.io.on("reconnect_attempt", () => {
      void refreshAuthBeforeHandshake(created);
    });
    created.on("connect", () => {
      lastHeartbeat = Date.now();
      refreshedAfterAuthRejection = false;
      authRetryAttempt = 0;
      clearAuthRetry();
      options.onConnect();
    });
    created.on("disconnect", () => {
      options.onDisconnect();
    });
    created.on("task:created", (payload: unknown) => {
      options.onTaskCreated(payload);
    });
    created.on("task:updated", (payload: unknown) => {
      options.onTaskUpdated(payload);
    });
    created.on("task:deleted", (payload: unknown) => {
      options.onTaskDeleted(payload);
    });
    socket = created;
    return created;
  }

  function startWatchdog() {
    if (watchdog) return;
    watchdog = setInterval(() => {
      if (!socket?.connected) return;
      if (lastHeartbeat > 0 && Date.now() - lastHeartbeat > HEARTBEAT_STALE_MS) {
        socket.disconnect();
        socket.auth = freshAuth();
        socket.connect();
      }
    }, 15_000);
  }

  return {
    connect() {
      if (!options.getAccessToken() || !options.getServerId()) return;
      const current = ensure();
      if (!current) return;
      refreshedAfterAuthRejection = false;
      authRetryAttempt = 0;
      clearAuthRetry();
      current.io.reconnection(true);
      current.auth = freshAuth();
      startWatchdog();
      if (!current.connected) current.connect();
    },
    syncAuth,
    joinChannel(channelId: string) {
      joinedThreads.add(channelId);
      socket?.emit("join:channel", channelId);
    },
    leaveChannel(channelId: string) {
      joinedThreads.delete(channelId);
      socket?.emit("leave:channel", channelId);
    },
    reset() {
      if (watchdog) clearInterval(watchdog);
      watchdog = null;
      clearAuthRetry();
      authRetryAttempt = 0;
      refreshedAfterAuthRejection = false;
      joinedThreads.clear();
      if (!socket) return;
      socket.removeAllListeners();
      socket.io.removeAllListeners();
      socket.disconnect();
      socket = null;
    },
  };
}

export type Realtime = ReturnType<typeof createRealtime>;
