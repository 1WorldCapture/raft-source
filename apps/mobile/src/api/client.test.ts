import assert from "node:assert/strict";
import test from "node:test";
import { ApiError, StaleRequestError, createApiClient, shouldLogoutAfterRefresh, type TokenPair } from "./client.ts";

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function createHarness(initial?: Partial<TokenPair & { serverId: string | null }>) {
  const state = {
    accessToken: initial?.accessToken ?? "access-1",
    refreshToken: initial?.refreshToken ?? "refresh-1",
    serverId: initial?.serverId === undefined ? "server-1" : initial.serverId,
  };
  const calls: Array<{ url: string; init: RequestInit | undefined }> = [];
  let expired = 0;
  const client = createApiClient({
    getOrigin: () => "https://raft.example.com",
    getAccessToken: () => state.accessToken,
    getRefreshToken: () => state.refreshToken,
    getServerId: () => state.serverId,
    setTokens: (tokens) => {
      state.accessToken = tokens.accessToken;
      state.refreshToken = tokens.refreshToken;
    },
    onSessionExpired: () => {
      expired += 1;
      state.accessToken = null;
      state.refreshToken = null;
    },
    fetchImpl: async (url, init) => {
      calls.push({ url: String(url), init });
      const path = new URL(String(url)).pathname;
      const headers = new Headers(init?.headers);
      if (path === "/api/auth/refresh") {
        const sent = JSON.parse(String(init?.body)) as { refreshToken?: string };
        if (sent.refreshToken !== "refresh-1") return jsonResponse(401, { error: "Invalid or expired refresh token" });
        return jsonResponse(200, { accessToken: "access-2", refreshToken: "refresh-2" });
      }
      if (headers.get("Authorization") === "Bearer access-1" && path === "/api/servers") {
        return jsonResponse(401, { error: "expired" });
      }
      if (path === "/api/auth/login") return jsonResponse(401, { error: "Invalid email or password" });
      return jsonResponse(200, { ok: true, authorization: headers.get("Authorization"), serverId: headers.get("X-Server-Id") });
    },
  });
  return { client, calls, state, expired: () => expired };
}

test("request sends the bearer token and X-Server-Id", async () => {
  const { client, calls } = createHarness();
  const body = await client.get<{ ok: boolean; authorization: string; serverId: string }>("/channels");
  assert.equal(body.ok, true);
  assert.equal(body.authorization, "Bearer access-1");
  assert.equal(body.serverId, "server-1");
  assert.equal(calls[0]?.url, "https://raft.example.com/api/channels");
});

test("401 refresh still runs when crypto.getRandomValues is missing", async () => {
  const cryptoObj = globalThis.crypto;
  const previous = cryptoObj.getRandomValues.bind(cryptoObj);
  Object.defineProperty(cryptoObj, "getRandomValues", { value: undefined, configurable: true });
  const host = globalThis as { expo?: { uuidv4?: () => string } };
  const previousExpo = host.expo;
  host.expo = { uuidv4: () => "01234567-89ab-cdef-0123-456789abcdef" };
  try {
    const { client, calls } = createHarness();
    await client.get("/servers");
    assert.equal(calls.filter((call) => call.url.endsWith("/api/auth/refresh")).length, 1);
  } finally {
    Object.defineProperty(cryptoObj, "getRandomValues", { value: previous, configurable: true });
    host.expo = previousExpo;
  }
});

test("401 refreshes once and retries with the new access token", async () => {
  const { client, calls, state } = createHarness();
  const body = await client.get<{ authorization: string }>("/servers");
  assert.equal(body.authorization, "Bearer access-2");
  assert.equal(state.refreshToken, "refresh-2");
  assert.deepEqual(calls.map((call) => new URL(call.url).pathname), [
    "/api/servers",
    "/api/auth/refresh",
    "/api/servers",
  ]);
});

test("five concurrent 401s share a single refresh", async () => {
  const { client, calls } = createHarness();
  await Promise.all(Array.from({ length: 5 }, () => client.get("/servers")));
  const refreshes = calls.filter((call) => call.url.endsWith("/api/auth/refresh"));
  assert.equal(refreshes.length, 1);
});

test("refresh sends the installation and attempt headers and persists tokens before retry", async () => {
  const installationId = `ari_${"ab".repeat(16)}`;
  const attemptId = `arf_${"cd".repeat(8)}`;
  let persisted: TokenPair | null = null;
  const calls: Array<{ url: string; init: RequestInit | undefined }> = [];
  const client = createApiClient({
    getOrigin: () => "https://raft.example.com",
    getAccessToken: () => persisted?.accessToken ?? "access-1",
    getRefreshToken: () => persisted?.refreshToken ?? "refresh-1",
    getServerId: () => null,
    getInstallationId: () => installationId,
    createAttemptId: () => attemptId,
    setTokens: (tokens) => {
      persisted = tokens;
    },
    onSessionExpired: () => {},
    fetchImpl: async (url, init) => {
      calls.push({ url: String(url), init });
      const path = new URL(String(url)).pathname;
      if (path === "/api/auth/refresh") {
        assert.equal(persisted, null);
        return jsonResponse(200, { accessToken: "access-2", refreshToken: "refresh-2" });
      }
      const headers = new Headers(init?.headers);
      if (headers.get("Authorization") === "Bearer access-1") return jsonResponse(401, { error: "expired" });
      assert.equal(persisted?.accessToken, "access-2");
      return jsonResponse(200, { ok: true });
    },
  });
  await client.get("/servers");
  const refresh = calls.find((call) => call.url.endsWith("/api/auth/refresh"));
  const headers = new Headers(refresh?.init?.headers);
  assert.equal(headers.get("X-Slock-Auth-Installation-Id"), installationId);
  assert.equal(headers.get("X-Slock-Auth-Refresh-Attempt-Id"), attemptId);
});

test("auth endpoint 401 does not refresh", async () => {
  const { client, calls } = createHarness();
  await assert.rejects(
    () => client.post("/auth/login", { email: "a@b.c", password: "nope" }, { auth: false }),
    (error: unknown) => error instanceof ApiError && error.status === 401,
  );
  assert.equal(calls.length, 1);
});

test("refresh 401 clears the session", async () => {
  const { client, expired } = createHarness({ refreshToken: "dead" });
  await assert.rejects(() => client.get("/servers"), (error: unknown) => error instanceof ApiError && error.status === 401);
  assert.equal(expired(), 1);
});

test("shouldLogoutAfterRefresh is only a refresh 401", () => {
  assert.equal(shouldLogoutAfterRefresh(new ApiError("no", 401, null)), true);
  assert.equal(shouldLogoutAfterRefresh(new ApiError("down", 503, null)), false);
  assert.equal(shouldLogoutAfterRefresh(new ApiError("offline", 0, null)), false);
  assert.equal(shouldLogoutAfterRefresh(new Error("network")), false);
});

test("retry waits until setTokens finishes", async () => {
  let persisted: TokenPair | null = null;
  let release: () => void = () => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let retryStarted = false;
  const client = createApiClient({
    getOrigin: () => "https://raft.example.com",
    getAccessToken: () => persisted?.accessToken ?? "access-1",
    getRefreshToken: () => "refresh-1",
    getServerId: () => null,
    setTokens: async (tokens) => {
      await gate;
      persisted = tokens;
    },
    onSessionExpired: () => {},
    fetchImpl: async (url, init) => {
      const path = new URL(String(url)).pathname;
      if (path === "/api/auth/refresh") return jsonResponse(200, { accessToken: "access-2", refreshToken: "refresh-2" });
      const headers = new Headers(init?.headers);
      if (headers.get("Authorization") === "Bearer access-1") return jsonResponse(401, { error: "expired" });
      retryStarted = true;
      return jsonResponse(200, { ok: true });
    },
  });
  const pending = client.get("/servers");
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(retryStarted, false);
  release();
  await pending;
  assert.equal(retryStarted, true);
  assert.equal(persisted?.accessToken, "access-2");
});

test("logout during refresh does not write the new tokens", async () => {
  let authEpoch = 1;
  let stored: TokenPair | null = { accessToken: "access-1", refreshToken: "refresh-1" };
  const client = createApiClient({
    getOrigin: () => "https://raft.example.com",
    getAccessToken: () => (authEpoch === 1 ? "access-1" : null),
    getRefreshToken: () => stored?.refreshToken ?? "refresh-1",
    getServerId: () => "server-1",
    getAuthEpoch: () => authEpoch,
    setTokens: async (tokens, startedAuthEpoch) => {
      if (startedAuthEpoch !== authEpoch) return;
      stored = tokens;
    },
    onSessionExpired: () => {},
    fetchImpl: async (url, init) => {
      const path = new URL(String(url)).pathname;
      if (path === "/api/auth/refresh") {
        authEpoch += 1;
        stored = null;
        return jsonResponse(200, { accessToken: "access-2", refreshToken: "refresh-2" });
      }
      const headers = new Headers(init?.headers);
      if (headers.get("Authorization") === "Bearer access-1") return jsonResponse(401, { error: "expired" });
      return jsonResponse(200, { ok: true });
    },
  });
  await assert.rejects(() => client.get("/servers"), (error: unknown) => error instanceof StaleRequestError);
  assert.equal(stored, null);
});

test("a server switch during refresh keeps the new tokens and drops the old request", async () => {
  let serverEpoch = 1;
  const authEpoch = 1;
  let stored: TokenPair | null = { accessToken: "access-1", refreshToken: "refresh-1" };
  let cleared = false;
  let retried = false;
  const client = createApiClient({
    getOrigin: () => "https://raft.example.com",
    getAccessToken: () => stored?.accessToken ?? "access-1",
    getRefreshToken: () => "refresh-1",
    getServerId: () => "server-1",
    getAuthEpoch: () => authEpoch,
    getServerEpoch: () => serverEpoch,
    setTokens: async (tokens, startedAuthEpoch) => {
      if (startedAuthEpoch !== authEpoch) {
        stored = null;
        cleared = true;
        return;
      }
      stored = tokens;
    },
    onSessionExpired: () => {},
    fetchImpl: async (url, init) => {
      const path = new URL(String(url)).pathname;
      if (path === "/api/auth/refresh") {
        serverEpoch += 1;
        return jsonResponse(200, { accessToken: "access-2", refreshToken: "refresh-2" });
      }
      const headers = new Headers(init?.headers);
      if (headers.get("Authorization") === "Bearer access-2") retried = true;
      if (headers.get("Authorization") === "Bearer access-1") return jsonResponse(401, { error: "expired" });
      return jsonResponse(200, { ok: true });
    },
  });
  await assert.rejects(() => client.get("/servers"), (error: unknown) => error instanceof StaleRequestError);
  assert.equal(cleared, false);
  assert.equal(stored?.accessToken, "access-2");
  assert.equal(retried, false);
});

function hangUntilAbort(init: RequestInit | undefined): Promise<Response> {
  return new Promise((_resolve, reject) => {
    const signal = init?.signal;
    if (!signal) {
      reject(new Error("missing timeout signal"));
      return;
    }
    const abort = () => {
      const error = new Error("The operation was aborted");
      error.name = "AbortError";
      reject(error);
    };
    if (signal.aborted) {
      abort();
      return;
    }
    signal.addEventListener("abort", abort, { once: true });
  });
}

test("a hung JSON request rejects when the timeout fires and does not log out", async () => {
  let expired = 0;
  const client = createApiClient({
    getOrigin: () => "https://raft.example.com",
    getAccessToken: () => "access-1",
    getRefreshToken: () => "refresh-1",
    getServerId: () => "server-1",
    setTokens: () => {},
    onSessionExpired: () => {
      expired += 1;
    },
    jsonTimeoutMs: 40,
    fetchImpl: (_url, init) => hangUntilAbort(init),
  });
  const started = Date.now();
  await assert.rejects(
    () => client.get("/channels"),
    (error: unknown) => error instanceof ApiError && error.status === 0 && error.message === "Request timed out",
  );
  assert.ok(Date.now() - started < 2_000);
  assert.equal(expired, 0);
});

test("a hung token refresh rejects when the timeout fires and does not log out", async () => {
  let expired = 0;
  const client = createApiClient({
    getOrigin: () => "https://raft.example.com",
    getAccessToken: () => "access-1",
    getRefreshToken: () => "refresh-1",
    getServerId: () => "server-1",
    setTokens: () => {},
    onSessionExpired: () => {
      expired += 1;
    },
    jsonTimeoutMs: 40,
    fetchImpl: (url, init) => {
      const path = new URL(String(url)).pathname;
      if (path === "/api/auth/refresh") return hangUntilAbort(init);
      return Promise.resolve(jsonResponse(401, { error: "expired" }));
    },
  });
  const started = Date.now();
  await assert.rejects(
    () => client.get("/servers"),
    (error: unknown) => error instanceof ApiError && error.status === 0 && error.message === "Request timed out",
  );
  assert.ok(Date.now() - started < 2_000);
  assert.equal(expired, 0);
});
