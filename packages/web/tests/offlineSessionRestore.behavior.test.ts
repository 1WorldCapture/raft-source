import assert from "node:assert/strict";
import test from "node:test";
import axios from "axios";
import "./helpers/domSetup";
import api from "../src/api/client";
import { WEB_CACHE_LAST_SCOPE_KEY } from "../src/cache/webCacheLifecycle";
import { useAuthStore } from "../src/store/authStore";
import type { User } from "../src/store/authStore";
import {
  decideOfflineAdmission,
  OFFLINE_USER_SNAPSHOT_KEY,
  parseOfflineUser,
} from "../src/utils/offlineSession";

const initialAuthState = useAuthStore.getInitialState();

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

/** Minimal JWT-shaped token whose subject accessTokenSubject() can decode. */
const fakeAccessJwt = (sub: string) => {
  const payload = globalThis.btoa(JSON.stringify({ sub, type: "access" }))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
  return `h.${payload}.s`;
};

function seedStoredSession(accessToken = fakeAccessJwt("restore-user")) {
  localStorage.setItem("slock_access_token", accessToken);
  localStorage.setItem("slock_refresh_token", "stale_refresh");
  useAuthStore.setState({
    user: null,
    accessToken,
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
}

test("network failure with a matching saved identity is the only admission", () => {
  const saved = user();
  const admit = {
    status: undefined,
    hasStoredSession: true,
    tokenSubject: saved.id,
    scope: { userId: saved.id, serverId: "srv-1" },
    user: saved,
  };
  assert.deepEqual(decideOfflineAdmission(admit)?.serverId, "srv-1");
  assert.equal(decideOfflineAdmission({ ...admit, status: 401 }), null);
  assert.equal(decideOfflineAdmission({ ...admit, status: 502 }), null);
  assert.equal(decideOfflineAdmission({ ...admit, hasStoredSession: false }), null,
    "an access token without a refresh token is not a complete stored session");
  assert.equal(decideOfflineAdmission({ ...admit, tokenSubject: "someone-else" }), null,
    "a token issued to another account must not read this snapshot");
  assert.equal(decideOfflineAdmission({ ...admit, tokenSubject: null }), null,
    "a token whose subject cannot be decoded must not admit");
  assert.equal(decideOfflineAdmission({ ...admit, scope: { userId: "someone-else", serverId: "srv-1" } }), null);
  assert.equal(parseOfflineUser(JSON.stringify(user({ emailVerified: false }))), null);
  assert.equal(parseOfflineUser(JSON.stringify(user({ name: "pending_abc" }))), null);
});

test.afterEach(async () => {
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
  localStorage.clear();
  useAuthStore.setState(initialAuthState, true);
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
  assert.equal(state.user?.id, "restore-user");
  assert.equal(state.restoreState, "restoring_auth", "retry loop must keep running");
  assert.equal(state.refreshToken, "stale_refresh");
  assert.equal(state.lastRestoreError?.kind, "network");
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
  assert.equal(state.user, null);
  assert.equal(state.restoreState, "restoring_auth");
  assert.equal(state.accessToken, fakeAccessJwt("restore-user"));
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

test("401 from /auth/me never enters offline read-only even when refresh then fails offline (#17 review fix 1)", async (t) => {
  seedStoredSession();
  seedLastIdentity();
  // /auth/me IS answered — with a rejection. Only the refresh probe dies offline.
  t.mock.method(api, "get", async () => {
    throw httpError(401);
  });
  const originalAdapter = axios.defaults.adapter;
  let refreshAttempts = 0;
  axios.defaults.adapter = (async () => {
    refreshAttempts += 1;
    throw networkError();
  }) as typeof axios.defaults.adapter;
  try {
    await useAuthStore.getState().loadUser();
  } finally {
    axios.defaults.adapter = originalAdapter;
  }

  const state = useAuthStore.getState();
  assert.ok(refreshAttempts > 0, "fixture: the refresh probe actually ran and failed offline");
  assert.equal(state.offlineReadonly, false, "the server rejected the session — no offline read-only");
  assert.equal(state.user, null, "the snapshot identity must not be painted");
  assert.equal(state.restoreState, "restoring_auth", "session kept, the retry loop keeps running");
});

test("a token issued to another account never reads the snapshot offline (#17 review fix 2)", async (t) => {
  // A's snapshot and cache scope; B's access token (B's login completed but
  // /auth/me never answered before the network dropped).
  seedStoredSession(fakeAccessJwt("user-b"));
  seedLastIdentity();
  t.mock.method(api, "get", async () => {
    throw networkError();
  });

  await useAuthStore.getState().loadUser();

  const state = useAuthStore.getState();
  assert.equal(state.offlineReadonly, false, "subject mismatch — no offline read-only");
  assert.equal(state.user, null, "A's identity must not be painted over B's token");
  assert.equal(state.restoreState, "restoring_auth");
});

test("setTokens for a different account drops the previous user's snapshot (#17 review fix 2)", () => {
  seedLastIdentity();

  useAuthStore.getState().setTokens(fakeAccessJwt("user-b"), "refresh-b");
  assert.equal(localStorage.getItem(OFFLINE_USER_SNAPSHOT_KEY), null,
    "an account switch without /auth/me must not keep the old snapshot");

  localStorage.setItem(OFFLINE_USER_SNAPSHOT_KEY, JSON.stringify(user()));
  useAuthStore.getState().setTokens(fakeAccessJwt("restore-user"), "refresh-2");
  assert.ok(localStorage.getItem(OFFLINE_USER_SNAPSHOT_KEY),
    "a same-account token rotation keeps the snapshot");
});

test("an access token without a refresh token does not enter offline read-only (#17 review fix 3)", async (t) => {
  const token = fakeAccessJwt("restore-user");
  localStorage.setItem("slock_access_token", token);
  useAuthStore.setState({
    user: null,
    accessToken: token,
    refreshToken: null,
    initialized: false,
    restoreState: "restoring_auth",
    lastRestoreError: null,
    offlineReadonly: false,
  });
  seedLastIdentity();
  t.mock.method(api, "get", async () => {
    throw networkError();
  });

  await useAuthStore.getState().loadUser();

  const state = useAuthStore.getState();
  assert.equal(state.offlineReadonly, false, "an incomplete stored session must not admit");
  assert.equal(state.user, null);
  assert.equal(state.restoreState, "signed_out",
    "no stored session — the restore machine lands on the login screen instead of a fake signed-in read-only");
});
