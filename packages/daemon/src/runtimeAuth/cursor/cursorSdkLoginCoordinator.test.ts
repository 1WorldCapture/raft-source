// Cursor SDK 修复-1: web-triggered sign-in coordination — single flight with
// URL reuse, session cleanup on failure/timeout, and the sanitized status
// mapping. The native auth host is a fixture; no real Cursor traffic.

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { test } from "vitest";
import {
  CursorSdkLoginCoordinator,
  cursorSdkStatusSummary,
  CURSOR_SDK_LOGIN_TIMEOUT_MS,
} from "./cursorSdkLoginCoordinator.js";
import type { NativeBrokerDeps } from "./nativeCredentialBroker.js";

function loginDeps(input: {
  failLogin?: boolean;
  failAfterUrl?: boolean;
} = {}): NativeBrokerDeps {
  return {
    homeDir: "/nonexistent", env: {},
    auth: async (call) => {
      if (call.kind === "login") {
        if (input.failLogin) throw new Error("fixture login refused");
        // Same contract as the native host: URL first, result later.
        call.onLoginUrl?.("https://cursor.com/loginDeepControl?state=fixture");
        if (input.failAfterUrl) {
          // Browser step in progress... then the host dies.
          await new Promise((resolve) => setTimeout(resolve, 20));
          throw new Error("fixture authorization host exited");
        }
        return {
          tag: "raft-cursor-auth-ipc", v: 1, requestId: "fixture", kind: "verified",
          principalId: "11", backendUrl: "https://api2.cursor.sh",
          apiKey: "opaque-fixture-owned", apiKeyExpiresAtMs: Date.now() + 60_000,
        };
      }
      return {
        tag: "raft-cursor-auth-ipc", v: 1, requestId: "fixture", kind: "verified",
        principalId: "11", backendUrl: "https://api2.cursor.sh",
      };
    },
  };
}

async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), "raft-cursor-login-"));
  const homeDir = path.join(root, "user");
  const slockHome = path.join(root, "raft");
  return { homeDir, slockHome, cleanup: () => rm(root, { recursive: true, force: true }) };
}

test("begin returns the validated login URL and a completed login clears the session", async () => {
  const f = await fixture();
  try {
    let releaseLogin: (() => void) | null = null;
    const gate = new Promise<void>((resolve) => { releaseLogin = resolve; });
    const deps = loginDeps();
    const originalAuth = deps.auth!;
    deps.auth = async (call) => {
      const reply = await originalAuth(call);
      if (call.kind === "login") await gate;
      return reply;
    };
    const coordinator = new CursorSdkLoginCoordinator();
    const started = await coordinator.begin({ slockHome: f.slockHome }, deps);
    assert.equal(started.ok, true);
    if (started.ok) {
      assert.equal(started.reused, false);
      assert.equal(new URL(started.loginUrl).hostname, "cursor.com");
    }
    assert.ok(coordinator.hasActiveSession(), "authorization still pending");
    releaseLogin!();
    await Promise.race([new Promise((r) => setTimeout(r, 100))]);
    // Poll-style: once the broker persisted the binding, session is cleared.
    for (let i = 0; i < 50 && coordinator.hasActiveSession(); i += 1) {
      await new Promise((r) => setTimeout(r, 20));
    }
    assert.equal(coordinator.hasActiveSession(), false);
  } finally { await f.cleanup(); }
});

test("a second begin while pending reuses the SAME url instead of a second host", async () => {
  const f = await fixture();
  try {
    let releaseLogin: (() => void) | null = null;
    const gate = new Promise<void>((resolve) => { releaseLogin = resolve; });
    const deps = loginDeps();
    const originalAuth = deps.auth!;
    let loginCalls = 0;
    deps.auth = async (call) => {
      if (call.kind === "login") loginCalls += 1;
      const reply = await originalAuth(call);
      if (call.kind === "login") await gate;
      return reply;
    };
    const coordinator = new CursorSdkLoginCoordinator();
    const first = await coordinator.begin({ slockHome: f.slockHome }, deps);
    assert.ok(first.ok && !first.reused);
    const second = await coordinator.begin({ slockHome: f.slockHome }, deps);
    assert.ok(second.ok, "repeat click must get the pending URL");
    if (first.ok && second.ok) {
      assert.equal(second.loginUrl, first.loginUrl, "same authorization link");
      assert.equal(second.reused, true);
    }
    assert.equal(loginCalls, 1, "no second native authorization host");
    releaseLogin!();
  } finally { await f.cleanup(); }
});

test("an early login failure cleans the session and is surfaced to the caller", async () => {
  const f = await fixture();
  try {
    const coordinator = new CursorSdkLoginCoordinator();
    const started = await coordinator.begin({ slockHome: f.slockHome }, loginDeps({ failLogin: true }));
    assert.equal(started.ok, false);
    if (!started.ok) assert.match(started.message, /fixture login refused/);
    assert.equal(coordinator.hasActiveSession(), false, "failed attempt must not stay in flight");
    // A follow-up begin starts fresh (not "in progress").
    const retry = await coordinator.begin({ slockHome: f.slockHome }, loginDeps());
    assert.ok(retry.ok);
  } finally { await f.cleanup(); }
});

test("an authorization that never finishes expires out of the session window", async () => {
  const f = await fixture();
  try {
    const coordinator = new CursorSdkLoginCoordinator({ timeoutMs: 30 });
    const started = await coordinator.begin({ slockHome: f.slockHome }, loginDeps({ failAfterUrl: true }));
    // The URL was handed out, so begin returns ok; the host dies shortly after.
    assert.ok(started.ok);
    for (let i = 0; i < 100 && coordinator.hasActiveSession(); i += 1) {
      await new Promise((r) => setTimeout(r, 20));
    }
    assert.equal(coordinator.hasActiveSession(), false, "failed session must clear");
  } finally { await f.cleanup(); }
});

test("default timeout stays the 10-minute product contract", () => {
  assert.equal(CURSOR_SDK_LOGIN_TIMEOUT_MS, 10 * 60_000);
});

test("status is minimized: closed status values, source, no credential metadata", async () => {
  const f = await fixture();
  try {
    // No binding anywhere → unbound.
    const missing = await cursorSdkStatusSummary({ slockHome: f.slockHome }, { homeDir: f.homeDir, env: {} });
    assert.deepEqual(missing, { status: "unbound", source: "cursor_sdk_store" });
    assert.equal(Object.keys(missing).length, 2, "only status and source cross the boundary");
    // A stored binding reads back as bound.
    const ownedKey = "opaque-fixture-owned";
    const root = path.join(f.slockHome, "auth", "providers", "cursor");
    await mkdir(root, { recursive: true, mode: 0o700 });
    await writeFile(path.join(root, "binding.json"), JSON.stringify({
      version: 2, disabled: false, source: "raft_owned", principalId: "11",
      backendUrl: "https://api2.cursor.sh", connectionId: "cursor-fixture",
      generation: 1,
      fingerprint: createHash("sha256").update(ownedKey).digest("hex"),
      verifiedAt: Date.now(),
    }), { mode: 0o600 });
    await writeFile(path.join(root, "credential-cursor-fixture.json"), JSON.stringify({
      version: 1, backendUrl: "https://api2.cursor.sh",
      apiKey: "opaque-fixture-owned", apiKeyExpiresAtMs: Date.now() + 60_000,
      createdAtMs: Date.now(),
    }), { mode: 0o600 });
    const deps: NativeBrokerDeps = {
      homeDir: f.homeDir, env: {},
      auth: async (call) => ({
        tag: "raft-cursor-auth-ipc", v: 1, requestId: "fixture", kind: "verified",
        principalId: "11", backendUrl: "https://api2.cursor.sh",
        apiKey: "opaque-fixture-owned", apiKeyExpiresAtMs: Date.now() + 60_000,
        ...(call.kind === "models" ? { models: [] } : {}),
      }),
    };
    const bound = await cursorSdkStatusSummary({ slockHome: f.slockHome }, deps);
    assert.equal(bound.status, "bound");
    assert.equal(bound.source, "raft_owned");
  } finally { await f.cleanup(); }
});
