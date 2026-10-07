// Cursor SDK 修复-1: model detection must distinguish "needs sign-in" (a
// recoverable missing_config with the cursor_login recovery) from plain
// environmental errors, so the web can show a sign-in button instead of the
// generic "could not load models" message.

import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { test } from "vitest";
import { detectCursorSdkModels, type NativeBrokerDeps } from "./nativeCredentialBroker.js";
import { CursorAuthorizationError } from "./nativeAuthClient.js";

async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), "raft-cursor-detect-"));
  const homeDir = path.join(root, "user");
  const slockHome = path.join(root, "raft");
  return { homeDir, slockHome, cleanup: () => rm(root, { recursive: true, force: true }) };
}

function authDeps(overrides: Partial<NativeBrokerDeps> = {}, auth?: NativeBrokerDeps["auth"]): NativeBrokerDeps {
  return { homeDir: "/nonexistent", env: {}, ...overrides, ...(auth ? { auth } : {}) };
}

test("no Cursor login at all reports missing_config with the cursor_login recovery", async () => {
  const f = await fixture();
  try {
    // No ~/.cursor/sdk/auth.json and no binding: the unauthenticated state
    // owner production is in.
    const outcome = await detectCursorSdkModels({ slockHome: f.slockHome }, authDeps({ homeDir: f.homeDir }));
    assert.deepEqual(outcome, { kind: "missing_config", recovery: "cursor_login" });
  } finally { await f.cleanup(); }
});

test("expired Cursor login reports the same sign-in recovery", async () => {
  const f = await fixture();
  try {
    const file = path.join(f.homeDir, ".cursor", "sdk", "auth.json");
    await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
    await writeFile(file, JSON.stringify({
      version: 1, backendUrl: "https://api2.cursor.sh",
      apiKey: "opaque-fixture-expired", apiKeyExpiresAtMs: Date.now() - 1_000,
    }), { mode: 0o600 });
    const outcome = await detectCursorSdkModels({ slockHome: f.slockHome }, authDeps({ homeDir: f.homeDir }));
    assert.deepEqual(outcome, { kind: "missing_config", recovery: "cursor_login" });
  } finally { await f.cleanup(); }
});

test("credentials rejected by Cursor (invalid key) still route to the sign-in recovery", async () => {
  const f = await fixture();
  try {
    const file = path.join(f.homeDir, ".cursor", "sdk", "auth.json");
    await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
    await writeFile(file, JSON.stringify({
      version: 1, backendUrl: "https://api2.cursor.sh",
      apiKey: "opaque-fixture-revoked", apiKeyExpiresAtMs: Date.now() + 60_000,
    }), { mode: 0o600 });
    const auth: NativeBrokerDeps["auth"] = async () => {
      throw new CursorAuthorizationError("CURSOR_SDK_LOGIN_INVALID", "Cursor rejected this connection's credential.");
    };
    const outcome = await detectCursorSdkModels({ slockHome: f.slockHome }, authDeps({ homeDir: f.homeDir }, auth));
    assert.deepEqual(outcome, { kind: "missing_config", recovery: "cursor_login" });
  } finally { await f.cleanup(); }
});

test("network and native-host failures stay a plain retriable error, not a sign-in prompt", async () => {
  const f = await fixture();
  try {
    // A usable-looking stored key so detection gets past credential loading
    // and actually reaches the online model lookup.
    const file = path.join(f.homeDir, ".cursor", "sdk", "auth.json");
    await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
    await writeFile(file, JSON.stringify({
      version: 1, backendUrl: "https://api2.cursor.sh",
      apiKey: "opaque-fixture-hostfail", apiKeyExpiresAtMs: Date.now() + 60_000,
    }), { mode: 0o600 });
    const auth: NativeBrokerDeps["auth"] = async (call) => {
      if (call.kind === "verify") {
        return {
          tag: "raft-cursor-auth-ipc", v: 1, requestId: "fixture", kind: "verified",
          principalId: "11", backendUrl: "https://api2.cursor.sh",
        };
      }
      throw new CursorAuthorizationError("CURSOR_SDK_AUTH_HOST_FAILED", "The Cursor authorization host could not start.");
    };
    const outcome = await detectCursorSdkModels({ slockHome: f.slockHome }, authDeps({ homeDir: f.homeDir }, auth));
    // Host failures are environmental: not a sign-in prompt, still retriable.
    assert.deepEqual(outcome, { kind: "error", retryable: true });
  } finally { await f.cleanup(); }
});

test("a live, bound login still returns the model list unchanged", async () => {
  const f = await fixture();
  try {
    const file = path.join(f.homeDir, ".cursor", "sdk", "auth.json");
    await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
    await writeFile(file, JSON.stringify({
      version: 1, backendUrl: "https://api2.cursor.sh",
      apiKey: "opaque-fixture-live", apiKeyExpiresAtMs: Date.now() + 60_000,
    }), { mode: 0o600 });
    const auth: NativeBrokerDeps["auth"] = async (call) => (
      call.kind === "verify"
        ? {
          tag: "raft-cursor-auth-ipc", v: 1, requestId: "fixture", kind: "verified",
          principalId: "11", backendUrl: "https://api2.cursor.sh",
        }
        : {
          tag: "raft-cursor-auth-ipc", v: 1, requestId: "fixture", kind: "models_result",
          principalId: "11", backendUrl: "https://api2.cursor.sh",
          models: [{ id: "composer-1", label: "Composer" }, { id: "default", label: "Default" }],
        });
    const outcome = await detectCursorSdkModels({ slockHome: f.slockHome }, authDeps({ homeDir: f.homeDir }, auth));
    assert.equal(outcome.kind, "live");
    if (outcome.kind === "live") {
      assert.deepEqual(outcome.value.models.map((m) => m.id), ["composer-1", "default"]);
      assert.equal(outcome.value.default, "default");
    }
  } finally { await f.cleanup(); }
});
