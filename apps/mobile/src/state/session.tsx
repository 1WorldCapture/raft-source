import { createContext, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { AppState } from "react-native";
import * as SecureStore from "expo-secure-store";
import { ApiError, createApiClient, shouldLogoutAfterRefresh, type ApiClient, type TokenPair } from "../api/client";
import { createInstallationId } from "../api/ids";
import { syncSince } from "../api/sync";
import { parseChannelUnread, parseUser, type RaftUser } from "../model/messages";
import { useActivityStore } from "../activity/store";
import { createRealtime, type Realtime } from "../realtime/socket";
import { BUNDLED_SERVER_ORIGIN } from "../session/origin";
import { shouldApplyServerResponse, shouldCommitTokens, shouldMarkVisibleRead, catchUpPlan, releaseFocus } from "./sessionPolicy";
import { useRaftStore } from "./store";

const ORIGIN = "raft_mobile_origin";
const ACCESS = "raft_mobile_access";
const REFRESH = "raft_mobile_refresh";
const USER = "raft_mobile_user";
const SERVER = "raft_mobile_server";
const INSTALLATION = "raft_mobile_installation";
const BACKGROUND_DISCONNECT_MS = 30_000;

interface Snapshot {
  ready: boolean;
  origin: string | null;
  accessToken: string | null;
  refreshToken: string | null;
  installationId: string | null;
  user: RaftUser | null;
  serverId: string | null;
}

interface LoginResult {
  user: RaftUser;
  accessToken: string;
  refreshToken: string;
}

export interface SessionApi {
  ready: boolean;
  origin: string | null;
  user: RaftUser | null;
  serverId: string | null;
  signedIn: boolean;
  client: ApiClient;
  setOrigin: (origin: string) => Promise<void>;
  login: (email: string, password: string) => Promise<void>;
  logout: () => Promise<void>;
  selectServer: (serverId: string) => Promise<void>;
  updateProfile: (fields: { displayLanguage?: string; preferredMessageBodyFontSize?: "sm" | "md" | "lg" }) => Promise<void>;
  resendVerification: () => Promise<void>;
  markRead: (channelId: string, seq: number) => Promise<void>;
  joinThread: (threadChannelId: string) => void;
  leaveThread: (threadChannelId: string) => void;
  setFocusedChannelId: (channelId: string | null) => void;
  clearFocusedChannelId: (channelId: string) => void;
}

const SessionContext = createContext<SessionApi | null>(null);

function classifyNotice(error: ApiError) {
  if (error.status !== 403) return;
  if (error.code === "PROFILE_SETUP_REQUIRED") {
    useRaftStore.getState().setNotice("profile-setup");
    return;
  }
  if (error.error === "Email verification required" || error.code === "EMAIL_VERIFICATION_REQUIRED") {
    useRaftStore.getState().setNotice("verify-email");
  }
}

export function SessionProvider({ children }: { children: ReactNode }) {
  const snapshotRef = useRef<Snapshot>({
    ready: false,
    origin: null,
    accessToken: null,
    refreshToken: null,
    installationId: null,
    user: null,
    serverId: null,
  });
  const [snapshot, setSnapshotState] = useState(snapshotRef.current);
  const focusedRef = useRef<string | null>(null);
  const backgroundAt = useRef<number | null>(null);
  const pendingReads = useRef(new Map<string, number>());
  const realtimeRef = useRef<Realtime | null>(null);
  const authEpoch = useRef(0);
  const serverEpoch = useRef(0);
  const markReadRef = useRef<(channelId: string, seq: number) => Promise<void>>(async () => {});

  function apply(patch: Partial<Snapshot>) {
    snapshotRef.current = { ...snapshotRef.current, ...patch };
    setSnapshotState(snapshotRef.current);
  }

  async function persistTokens(tokens: TokenPair | null, user?: RaftUser | null) {
    if (!tokens) {
      await Promise.all([
        SecureStore.deleteItemAsync(ACCESS),
        SecureStore.deleteItemAsync(REFRESH),
        SecureStore.deleteItemAsync(USER),
      ]);
      return;
    }
    await Promise.all([
      SecureStore.setItemAsync(ACCESS, tokens.accessToken),
      SecureStore.setItemAsync(REFRESH, tokens.refreshToken),
      user ? SecureStore.setItemAsync(USER, JSON.stringify({
        id: user.id,
        email: user.email,
        name: user.name,
        displayName: user.displayName,
        displayLanguage: user.displayLanguage,
        preferredMessageBodyFontSize: user.preferredMessageBodyFontSize,
        preferredTimeFormat: user.preferredTimeFormat,
        preferredTimezone: user.preferredTimezone,
      })) : Promise.resolve(),
    ]);
  }

  function bumpServerEpoch() {
    serverEpoch.current += 1;
    pendingReads.current.clear();
  }

  function clearAuth() {
    authEpoch.current += 1;
    bumpServerEpoch();
    apply({ accessToken: null, refreshToken: null, user: null, serverId: null });
    useRaftStore.getState().clearServerData();
    useRaftStore.getState().setNotice(null);
    void persistTokens(null);
    void SecureStore.deleteItemAsync(SERVER);
    realtimeRef.current?.reset();
  }

  const client = useMemo(() => createApiClient({
    getOrigin: () => snapshotRef.current.origin,
    getAccessToken: () => snapshotRef.current.accessToken,
    getRefreshToken: () => snapshotRef.current.refreshToken,
    getServerId: () => snapshotRef.current.serverId,
    getInstallationId: () => snapshotRef.current.installationId,
    getAuthEpoch: () => authEpoch.current,
    getServerEpoch: () => serverEpoch.current,
    setTokens: async (tokens, startedAuthEpoch) => {
      const started = startedAuthEpoch ?? authEpoch.current;
      if (!shouldCommitTokens(started, authEpoch.current)) return;
      await persistTokens(tokens);
      if (!shouldCommitTokens(started, authEpoch.current)) {
        await persistTokens(null);
        return;
      }
      apply({ accessToken: tokens.accessToken, refreshToken: tokens.refreshToken });
      realtimeRef.current?.syncAuth();
    },
    onSessionExpired: () => {
      clearAuth();
    },
    onApiError: classifyNotice,
  }), []);

  const realtime = useMemo(() => createRealtime({
    getOrigin: () => snapshotRef.current.origin,
    getAccessToken: () => snapshotRef.current.accessToken,
    getServerId: () => snapshotRef.current.serverId,
    getLastSeq: () => useRaftStore.getState().lastSeq,
    refreshTokens: () => client.refreshTokens(),
    onSessionExpired: () => clearAuth(),
    onMessage: (message) => {
      useRaftStore.getState().upsertMessages([message]);
      useActivityStore.getState().scheduleRefresh(client);
      if (shouldMarkVisibleRead(focusedRef.current, message.channelId)) {
        useRaftStore.getState().clearLiveUnread(message.channelId);
        if (typeof message.seq === "number") void markReadRef.current(message.channelId, message.seq);
        return;
      }
      useRaftStore.getState().bumpLiveUnread(message.channelId);
    },
    onCatchUp: (messages, hasMore) => {
      const epoch = serverEpoch.current;
      useRaftStore.getState().upsertMessages(messages);
      const plan = catchUpPlan(hasMore);
      if (plan.refreshDirectory) useRaftStore.getState().bumpDirectory();
      if (plan.refreshUnread) {
        void client.get<unknown>("/channels/unread?summary=1").then((unreadData) => {
          if (!shouldApplyServerResponse(epoch, serverEpoch.current)) return;
          useRaftStore.getState().setChannelUnread(parseChannelUnread(unreadData));
        }).catch(() => {});
      }
      if (!hasMore) return;
      const channelId = focusedRef.current;
      const since = useRaftStore.getState().lastSeq;
      if (!channelId || since <= 0) return;
      void syncSince(client, since, channelId).then((page) => {
        if (!shouldApplyServerResponse(epoch, serverEpoch.current)) return;
        useRaftStore.getState().upsertMessages(page);
      }).catch(() => {});
    },
    onMessageUpdated: (message) => {
      useRaftStore.getState().upsertMessages([message]);
    },
    onThreadUpdated: (summary) => {
      useRaftStore.getState().setThreadSummaries({
        [summary.parentMessageId]: summary,
      });
      useActivityStore.getState().scheduleRefresh(client);
    },
    onReadState: (channelId) => {
      useRaftStore.getState().clearChannelUnread(channelId);
      useRaftStore.getState().clearLiveUnread(channelId);
      useActivityStore.getState().applyReadStates([channelId]);
    },
    onReadStateBulk: (scopeIds) => {
      for (const scopeId of scopeIds) {
        useRaftStore.getState().clearChannelUnread(scopeId);
        useRaftStore.getState().clearLiveUnread(scopeId);
      }
      useActivityStore.getState().applyReadStates(scopeIds);
    },
    onDirectoryChanged: () => {
      useRaftStore.getState().bumpDirectory();
    },
    onRoomsJoined: () => {
      useRaftStore.getState().bumpDirectory();
      void useActivityStore.getState().refresh(client);
    },
  }), [client]);
  realtimeRef.current = realtime;

  useEffect(() => {
    let cancelled = false;
    // SecureStore calls in this effect's first turn never settle on Android
    // release builds. A state update, then a read on the next turn, does.
    apply({ ready: false });
    const timer = setTimeout(() => {
      void (async () => {
        try {
          const storedOrigin = await SecureStore.getItemAsync(ORIGIN);
          const origin = BUNDLED_SERVER_ORIGIN;
          if (!origin) {
            if (!cancelled) apply({ origin: null, ready: true });
            return;
          }
          let accessToken = await SecureStore.getItemAsync(ACCESS);
          let refreshToken = await SecureStore.getItemAsync(REFRESH);
          let userJson = await SecureStore.getItemAsync(USER);
          let serverId = await SecureStore.getItemAsync(SERVER);
          if (storedOrigin !== origin) {
            void SecureStore.setItemAsync(ORIGIN, origin);
            if (storedOrigin) {
              accessToken = null;
              refreshToken = null;
              userJson = null;
              serverId = null;
              void persistTokens(null);
              void SecureStore.deleteItemAsync(SERVER);
            }
          }
          const storedInstallation = await SecureStore.getItemAsync(INSTALLATION);
          let installationId = storedInstallation && /^ari_[0-9a-f]{32}$/.test(storedInstallation)
            ? storedInstallation
            : createInstallationId();
          if (cancelled) return;
          apply({
            origin,
            accessToken,
            refreshToken,
            installationId,
            user: userJson ? parseUser(JSON.parse(userJson) as unknown) : null,
            serverId,
            ready: true,
          });
          if (installationId !== storedInstallation) {
            void SecureStore.setItemAsync(INSTALLATION, installationId);
          }
          if (!accessToken) return;
          try {
            const me = parseUser(await client.get("/auth/me"));
            if (me) apply({ user: me });
          } catch (error) {
            if (error instanceof ApiError && error.status === 401 && snapshotRef.current.refreshToken) {
              try {
                await client.refreshTokens();
                const me = parseUser(await client.get("/auth/me"));
                if (me) apply({ user: me });
              } catch (refreshError) {
                if (shouldLogoutAfterRefresh(refreshError)) clearAuth();
              }
            }
          }
        } catch {
          if (!cancelled) apply({ origin: BUNDLED_SERVER_ORIGIN, ready: true });
        }
      })();
    }, 0);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [client]);

  useEffect(() => {
    if (!snapshot.ready || !snapshot.accessToken || !snapshot.serverId || !snapshot.origin) {
      realtime.reset();
      return;
    }
    realtime.connect();
  }, [realtime, snapshot.accessToken, snapshot.origin, snapshot.ready, snapshot.serverId]);

  useEffect(() => {
    const subscription = AppState.addEventListener("change", (state) => {
      if (state === "background" || state === "inactive") {
        backgroundAt.current = Date.now();
        return;
      }
      if (state !== "active") return;
      const away = backgroundAt.current ? Date.now() - backgroundAt.current : 0;
      backgroundAt.current = null;
      if (away > BACKGROUND_DISCONNECT_MS) realtime.reset();
      realtime.connect();
      void flushReads();
    });
    return () => subscription.remove();
  }, [realtime]);

  async function flushReads() {
    for (const [channelId, seq] of pendingReads.current) {
      try {
        await client.post(`/channels/${channelId}/read`, { seq });
        pendingReads.current.delete(channelId);
      } catch {
        // Keep the cursor queued for the next foreground or channel open.
      }
    }
  }

  const api = useMemo<SessionApi>(() => ({
    ready: snapshot.ready,
    origin: snapshot.origin,
    user: snapshot.user,
    serverId: snapshot.serverId,
    signedIn: Boolean(snapshot.accessToken && snapshot.refreshToken),
    client,
    setOrigin: async (origin: string) => {
      const changed = origin !== snapshotRef.current.origin;
      await SecureStore.setItemAsync(ORIGIN, origin);
      if (changed) clearAuth();
      apply({ origin });
    },
    login: async (email: string, password: string) => {
      const data = await client.post<LoginResult>("/auth/login", { email, password }, { auth: false, server: false });
      const user = parseUser(data.user);
      if (!user || !data.accessToken || !data.refreshToken) throw new Error("Login did not return a session");
      await persistTokens({ accessToken: data.accessToken, refreshToken: data.refreshToken }, user);
      apply({ accessToken: data.accessToken, refreshToken: data.refreshToken, user });
      useRaftStore.getState().setNotice(null);
    },
    logout: async () => {
      const refreshToken = snapshotRef.current.refreshToken;
      clearAuth();
      if (!refreshToken) return;
      try {
        await client.post("/auth/logout", { refreshToken }, { auth: false, server: false });
      } catch {
        // Local sign-out already happened.
      }
    },
    updateProfile: async (fields) => {
      const data = await client.request<unknown>("/auth/me", { method: "PATCH", body: fields });
      const user = parseUser(data);
      if (!user) throw new Error("Profile update did not return a user");
      const tokens = snapshotRef.current.accessToken && snapshotRef.current.refreshToken
        ? { accessToken: snapshotRef.current.accessToken, refreshToken: snapshotRef.current.refreshToken }
        : null;
      if (tokens) await persistTokens(tokens, user);
      apply({ user });
    },
    selectServer: async (serverId: string) => {
      if (snapshotRef.current.serverId !== serverId) {
        bumpServerEpoch();
        useRaftStore.getState().clearServerData();
      }
      apply({ serverId });
      // Android release builds can leave this write pending. The home load
      // must not wait on it; the in-memory server id is already applied.
      void SecureStore.setItemAsync(SERVER, serverId).catch(() => {});
      realtime.reset();
      realtime.connect();
    },
    resendVerification: async () => {
      await client.post("/auth/resend-verification", {});
    },
    markRead: async (channelId: string, seq: number) => {
      if (seq <= 0) return;
      const queued = Math.max(pendingReads.current.get(channelId) ?? 0, seq);
      pendingReads.current.set(channelId, queued);
      try {
        await client.post(`/channels/${channelId}/read`, { seq: queued });
        pendingReads.current.delete(channelId);
        useRaftStore.getState().clearChannelUnread(channelId);
      } catch {
        // Queued for flushReads.
      }
    },
    joinThread: (threadChannelId: string) => realtime.joinChannel(threadChannelId),
    leaveThread: (threadChannelId: string) => realtime.leaveChannel(threadChannelId),
    setFocusedChannelId: (channelId: string | null) => {
      focusedRef.current = channelId;
      if (channelId) useRaftStore.getState().clearLiveUnread(channelId);
    },
    clearFocusedChannelId: (channelId: string) => {
      focusedRef.current = releaseFocus(focusedRef.current, channelId);
    },
  }), [client, realtime, snapshot]);
  markReadRef.current = api.markRead;

  return <SessionContext.Provider value={api}>{children}</SessionContext.Provider>;
}

export function useSession(): SessionApi {
  const value = useContext(SessionContext);
  if (!value) throw new Error("useSession must be used inside SessionProvider");
  return value;
}
