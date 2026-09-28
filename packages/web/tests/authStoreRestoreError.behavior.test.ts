import assert from "node:assert/strict";
import test from "node:test";
import axios from "axios";
import "./helpers/domSetup";
import api from "../src/api/client";
import { useAuthStore } from "../src/store/authStore";
import type { User } from "../src/store/authStore";

// #desktop-session-restore task #1 — the bootstrap restore loop must record WHY
// the last restore attempt failed (lastRestoreError) so the degraded UI can
// show "HTTP 502" vs "network error", keep credentials on transient failures,
// clear the record once a restore succeeds, and still reach signed_out when
// both /auth/me and /auth/refresh return 401.

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
  });
}

test.afterEach(async () => {
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
  localStorage.clear();
  useAuthStore.setState(initialAuthState, true);
});

test("502 on /auth/me keeps credentials in restoring and records the HTTP error", async (t) => {
  seedStoredSession();
  t.mock.method(api, "get", async () => {
    throw httpError(502);
  });

  await useAuthStore.getState().loadUser();

  const state = useAuthStore.getState();
  assert.equal(state.accessToken, "stale_access", "a 502 must not clear credentials");
  assert.equal(state.refreshToken, "stale_refresh");
  assert.equal(state.restoreState, "restoring_auth");
  assert.equal(state.lastRestoreError?.kind, "http");
  assert.equal(state.lastRestoreError?.status, 502);
  assert.equal(typeof state.lastRestoreError?.at, "number");
});

test("a network-shaped failure records kind=network without inventing a status", async (t) => {
  seedStoredSession();
  t.mock.method(api, "get", async () => {
    throw networkError();
  });

  await useAuthStore.getState().loadUser();

  const state = useAuthStore.getState();
  assert.equal(state.restoreState, "restoring_auth");
  assert.equal(state.lastRestoreError?.kind, "network");
  assert.equal(state.lastRestoreError?.status, undefined);
});

test("a successful retry clears lastRestoreError and authenticates", async (t) => {
  seedStoredSession();
  let attempts = 0;
  t.mock.method(api, "get", async () => {
    attempts += 1;
    if (attempts === 1) throw httpError(502);
    return { data: user() };
  });

  await useAuthStore.getState().loadUser();
  assert.equal(useAuthStore.getState().lastRestoreError?.status, 502, "precondition: failure recorded");

  await useAuthStore.getState().loadUser();

  const state = useAuthStore.getState();
  assert.equal(state.restoreState, "authenticated");
  assert.equal(state.user?.id, "restore-user");
  assert.equal(state.lastRestoreError, null, "a successful restore must clear the recorded error");
});

test("401 on /auth/me followed by 401 on /auth/refresh reaches signed_out", async (t) => {
  seedStoredSession();
  t.mock.method(api, "get", async () => {
    throw httpError(401);
  });
  t.mock.method(api, "post", async () => ({}));
  // The refresh coordinator posts with the bare axios module, not the `api`
  // instance — intercept it at the adapter level like authRefreshAttemptWiring.
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
  assert.equal(state.restoreState, "signed_out", "a rejected credential must leave the restore loop");
  assert.equal(state.accessToken, null);
  assert.equal(state.refreshToken, null);
  assert.equal(localStorage.getItem("slock_refresh_token"), null);
});
