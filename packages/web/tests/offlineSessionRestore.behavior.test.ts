import assert from "node:assert/strict";
import test from "node:test";
import axios from "axios";
import "./helpers/domSetup";
import api from "../src/api/client";
import { WEB_CACHE_LAST_SCOPE_KEY } from "../src/cache/webCacheLifecycle";
import { useAuthStore } from "../src/store/authStore";
import type { User } from "../src/store/authStore";
import { useChannelStore } from "../src/store/channelStore";
import { useServerStore } from "../src/store/serverStore";
import { LAST_SERVER_SLUG_STORAGE_KEY } from "../src/store/serverPersistenceRegistry";
import {
  decideOfflineAdmission,
  isOfflineReadonlyActive,
  OFFLINE_USER_SNAPSHOT_KEY,
  parseOfflineUser,
} from "../src/utils/offlineSession";

const initialAuthState = useAuthStore.getInitialState();
const initialServerState = useServerStore.getInitialState();
const initialChannelState = useChannelStore.getInitialState();

function user(overrides: Partial<User> = {}): User {
  return {
    id: "restore-user",
    email: "restore@example.com",
    gravatarHash: "hash",
    name: "restore-user",
    displayName: "Restore User",
    description: null,
    avatarUrl: null,
    emailVerified: true,
    preferredLanguage: null,
    displayLanguage: null,
    preferredTimezone: null,
    firstObservedTimezone: null,
    firstObservedTimezoneAt: null,
    lastObservedTimezone: null,
    lastObservedTimezoneAt: null,
    autoTranslationEnabled: false,
    preferredTranslationMode: "off",
    preferredTranslationDisplay: "translated",
    preferredTimeFormat: null,
    preferredMessageBodyFontSize: null,
    referralSource: null,
    referralSourceOther: null,
    referralSourceSkippedAt: null,
    signupSurveyCompletedAt: null,
    signupRole: null,
    profileSetupSuggestedHandle: null,
    profileSetupProvider: null,
    ...overrides,
  };
}

const httpError = (status: number) => Object.assign(new Error(`HTTP ${status}`), { response: { status } });
const networkError = () => new Error("Network Error");

function seedStoredSession() {
  localStorage.setItem("slock_access_token", "stale_access");
  localStorage.setItem("slock_refresh_token", "stale_refresh");
  useAuthStore.setState({
    user: null,
    accessToken: "stale_access",
    refreshToken: "stale_refresh",
    initialized: false,
    restoreState: "restoring_auth",
    lastRestoreError: null,
    offlineReadonly: false,
  });
}

function seedLastIdentity(snapshot: User = user(), serverId = "srv-1") {
  localStorage.setItem(OFFLINE_USER_SNAPSHOT_KEY, JSON.stringify(snapshot));
  localStorage.setItem(WEB_CACHE_LAST_SCOPE_KEY, JSON.stringify({ userId: snapshot.id, serverId }));
  localStorage.setItem(LAST_SERVER_SLUG_STORAGE_KEY, "lab");
}

test("network failure with a matching saved identity is the only admission", () => {
  const saved = user();
  assert.deepEqual(
    decideOfflineAdmission({
      status: undefined,
      hasAccessToken: true,
      scope: { userId: saved.id, serverId: "srv-1" },
      user: saved,
    })?.serverId,
    "srv-1",
  );
  assert.equal(decideOfflineAdmission({
    status: 401,
    hasAccessToken: true,
    scope: { userId: saved.id, serverId: "srv-1" },
    user: saved,
  }), null);
  assert.equal(decideOfflineAdmission({
    status: 502,
    hasAccessToken: true,
    scope: { userId: saved.id, serverId: "srv-1" },
    user: saved,
  }), null);
  assert.equal(decideOfflineAdmission({
    status: undefined,
    hasAccessToken: false,
    scope: { userId: saved.id, serverId: "srv-1" },
    user: saved,
  }), null);
  assert.equal(decideOfflineAdmission({
    status: undefined,
    hasAccessToken: true,
    scope: { userId: "someone-else", serverId: "srv-1" },
    user: saved,
  }), null);
  assert.equal(parseOfflineUser(JSON.stringify(user({ emailVerified: false }))), null);
  assert.equal(parseOfflineUser(JSON.stringify(user({ name: "pending_abc" }))), null);
});

test.afterEach(async () => {
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
  localStorage.clear();
  useAuthStore.setState(initialAuthState, true);
  useServerStore.setState(initialServerState, true);
  useChannelStore.setState(initialChannelState, true);
});

test("loadUser enters offline read-only when /auth/me is unreachable and the last identity matches", async (t) => {
  seedStoredSession();
  seedLastIdentity();
  t.mock.method(api, "get", async () => {
    throw networkError();
  });

  await useAuthStore.getState().loadUser();

  const state = useAuthStore.getState();
  assert.equal(state.offlineReadonly, true);
  assert.equal(isOfflineReadonlyActive(), true);
  assert.equal(state.user?.id, "restore-user");
  assert.equal(state.restoreState, "restoring_auth", "retry loop must keep running");
  assert.equal(state.accessToken, "stale_access");
  assert.equal(state.refreshToken, "stale_refresh");
  assert.equal(state.lastRestoreError?.kind, "network");
  assert.equal(useServerStore.getState().servers[0]?.id, "srv-1");
  assert.equal(useServerStore.getState().servers[0]?.slug, "lab");
});

test("502 keeps the restoring screen even when a saved identity exists", async (t) => {
  seedStoredSession();
  seedLastIdentity();
  t.mock.method(api, "get", async () => {
    throw httpError(502);
  });

  await useAuthStore.getState().loadUser();

  const state = useAuthStore.getState();
  assert.equal(state.offlineReadonly, false);
  assert.equal(isOfflineReadonlyActive(), false);
  assert.equal(state.user, null);
  assert.equal(state.restoreState, "restoring_auth");
  assert.equal(state.accessToken, "stale_access");
});

test("401 still signs out and does not enter offline read-only", async (t) => {
  seedStoredSession();
  seedLastIdentity();
  t.mock.method(api, "get", async () => {
    throw httpError(401);
  });
  t.mock.method(api, "post", async () => ({}));
  const originalAdapter = axios.defaults.adapter;
  axios.defaults.adapter = (async () => {
    throw httpError(401);
  }) as typeof axios.defaults.adapter;
  try {
    await useAuthStore.getState().loadUser();
  } finally {
    axios.defaults.adapter = originalAdapter;
  }

  const state = useAuthStore.getState();
  assert.equal(state.restoreState, "signed_out");
  assert.equal(state.offlineReadonly, false);
  assert.equal(state.user, null);
  assert.equal(state.accessToken, null);
  assert.equal(localStorage.getItem("slock_refresh_token"), null);
});

test("a later successful /auth/me leaves offline read-only", async (t) => {
  seedStoredSession();
  seedLastIdentity();
  let attempts = 0;
  t.mock.method(api, "get", async () => {
    attempts += 1;
    if (attempts === 1) throw networkError();
    return { data: user({ displayName: "Back online" }) };
  });

  await useAuthStore.getState().loadUser();
  assert.equal(useAuthStore.getState().offlineReadonly, true, "precondition: entered offline");

  await useAuthStore.getState().loadUser();

  const state = useAuthStore.getState();
  assert.equal(state.offlineReadonly, false);
  assert.equal(state.restoreState, "authenticated");
  assert.equal(state.user?.displayName, "Back online");
  assert.equal(state.lastRestoreError, null);
});

test("ensureChannel stubs a channel only when offline and the server never answered", async (t) => {
  useServerStore.setState({
    current: { id: "srv-1" } as typeof initialServerState.current,
    serverEpoch: 1,
  });
  useAuthStore.setState({ offlineReadonly: true });
  t.mock.method(api, "get", async (url: string) => {
    if (url.endsWith("/chan-missing")) throw httpError(404);
    throw networkError();
  });

  const stubbed = await useChannelStore.getState().ensureChannel("chan-cached");
  assert.equal(stubbed?.id, "chan-cached");
  assert.equal(useChannelStore.getState().channels.some((channel) => channel.id === "chan-cached"), true);

  const missing = await useChannelStore.getState().ensureChannel("chan-missing");
  assert.equal(missing, null);
  assert.equal(useChannelStore.getState().channels.some((channel) => channel.id === "chan-missing"), false);
});
