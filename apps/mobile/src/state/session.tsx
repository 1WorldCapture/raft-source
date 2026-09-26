import { createContext, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { AppState } from "react-native";
import * as SecureStore from "expo-secure-store";
import { ApiError, createApiClient, type ApiClient, type TokenPair } from "../api/client";
import { createInstallationId } from "../api/ids";
import { syncSince } from "../api/sync";
import { parseUser, type RaftUser } from "../model/messages";
import { createRealtime, type Realtime } from "../realtime/socket";
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
  resendVerification: () => Promise<void>;
  markRead: (channelId: string, seq: number) => Promise<void>;
  joinThread: (threadChannelId: string) => void;
  leaveThread: (threadChannelId: string) => void;
  setFocusedChannelId: (channelId: string | null) => void;
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
      })) : Promise.resolve(),
    ]);
  }

  function clearAuth() {
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
    setTokens: (tokens) => {
      apply({ accessToken: tokens.accessToken, refreshToken: tokens.refreshToken });
      void persistTokens(tokens);
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
      if (message.channelId !== focusedRef.current) useRaftStore.getState().bumpLiveUnread(message.channelId);
    },
    onCatchUp: (messages, hasMore) => {
      useRaftStore.getState().upsertMessages(messages);
      if (!hasMore) return;
      const channelId = focusedRef.current;
      const since = useRaftStore.getState().lastSeq;
      if (!channelId || since <= 0) return;
      void syncSince(client, since, channelId).then((page) => {
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
    },
    onReadState: (channelId) => {
      useRaftStore.getState().clearChannelUnread(channelId);
      useRaftStore.getState().clearLiveUnread(channelId);
    },
    onDirectoryChanged: () => {
      useRaftStore.getState().bumpDirectory();
    },
    onRoomsJoined: () => {
      useRaftStore.getState().bumpDirectory();
    },
    onGap: (channelId, sinceSeq) => {
      void syncSince(client, sinceSeq, channelId).then((page) => {
        useRaftStore.getState().upsertMessages(page);
      }).catch(() => {});
    },
  }), [client]);
  realtimeRef.current = realtime;

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const [origin, accessToken, refreshToken, userJson, serverId, storedInstallation] = await Promise.all([
          SecureStore.getItemAsync(ORIGIN),
          SecureStore.getItemAsync(ACCESS),
          SecureStore.getItemAsync(REFRESH),
          SecureStore.getItemAsync(USER),
          SecureStore.getItemAsync(SERVER),
          SecureStore.getItemAsync(INSTALLATION),
        ]);
        let installationId = storedInstallation && /^ari_[0-9a-f]{32}$/.test(storedInstallation)
          ? storedInstallation
          : createInstallationId();
        if (installationId !== storedInstallation) await SecureStore.setItemAsync(INSTALLATION, installationId);
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
            } catch {
              clearAuth();
            }
          }
        }
      } catch {
        if (!cancelled) apply({ ready: true, installationId: snapshotRef.current.installationId ?? createInstallationId() });
      }
    })();
    return () => {
      cancelled = true;
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
    selectServer: async (serverId: string) => {
      if (snapshotRef.current.serverId !== serverId) useRaftStore.getState().clearServerData();
      apply({ serverId });
      await SecureStore.setItemAsync(SERVER, serverId);
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
  }), [client, realtime, snapshot]);

  return <SessionContext.Provider value={api}>{children}</SessionContext.Provider>;
}

export function useSession(): SessionApi {
  const value = useContext(SessionContext);
  if (!value) throw new Error("useSession must be used inside SessionProvider");
  return value;
}
