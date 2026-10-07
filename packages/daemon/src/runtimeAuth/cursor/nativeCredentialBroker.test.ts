import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readFile, rm, symlink, chmod } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { test } from "vitest";
import {
  resolveCursorCredentialLease, connectExistingCursorSdkOwner, loginCursorSdkOwner,
  logoutCursorSdkOwner, getCursorSdkAuthStatus, detectCursorSdkModels,
  type NativeBrokerDeps,
} from "./nativeCredentialBroker.js";
import { CursorAuthorizationError } from "./nativeAuthClient.js";

async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), "raft-cursor-broker-"));
  const homeDir = path.join(root, "user"); const slockHome = path.join(root, "raft");
  const file = path.join(homeDir, ".cursor", "sdk", "auth.json");
  await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  const save = async (key: string, expiry = Date.now() + 60_000) => writeFile(file, JSON.stringify({ version: 1, backendUrl: "https://api2.cursor.sh", apiKey: key, apiKeyExpiresAtMs: expiry }), { mode: 0o600 });
  await save("opaque-fixture-original");
  const seen: string[] = [];
  const deps: NativeBrokerDeps = {
    homeDir, env: {},
    auth: async (call) => {
      seen.push(call.apiKey ?? "login");
      if (call.apiKey === "invalid-explicit") throw new CursorAuthorizationError("CURSOR_SDK_LOGIN_INVALID", "fixture rejection");
      return {
        tag: "raft-cursor-auth-ipc", v: 1, requestId: "fixture", kind: call.kind === "models" ? "models_result" : "verified",
        principalId: call.apiKey === "other-account" ? "22" : "11", backendUrl: "https://api2.cursor.sh",
        ...(call.kind === "models" ? { models: [{ id: "live-model", label: "Live" }] } : {}),
        ...(call.kind === "login" ? { apiKey: "opaque-fixture-owned", apiKeyExpiresAtMs: Date.now() + 60_000 } : {}),
      };
    },
  };
  return { root, file, slockHome, deps, seen, save, cleanup: () => rm(root, { recursive: true, force: true }) };
}

test("borrow exact saved SDK key, verify it, and never change the source file", async () => {
  const f = await fixture();
  try {
    const before = await readFile(f.file, "utf8");
    const lease = await resolveCursorCredentialLease({ slockHome: f.slockHome }, f.deps);
    assert.equal(lease.apiKey, "opaque-fixture-original");
    assert.deepEqual(f.seen, [lease.apiKey]);
    assert.equal(await readFile(f.file, "utf8"), before);
    assert.equal((await getCursorSdkAuthStatus({ slockHome: f.slockHome }, f.deps)).status, "bound");
  } finally { await f.cleanup(); }
});

test("explicit invalid owner environment key cannot fall back to a valid saved SDK key", async () => {
  const f = await fixture();
  try {
    f.deps.env = { CURSOR_API_KEY: "invalid-explicit" };
    await assert.rejects(resolveCursorCredentialLease({ slockHome: f.slockHome }, f.deps), /fixture rejection/);
    assert.deepEqual(f.seen, ["invalid-explicit"]);
  } finally { await f.cleanup(); }
});

test("binding refuses a changed principal and model lookup uses the bound exact key", async () => {
  const f = await fixture();
  try {
    await resolveCursorCredentialLease({ slockHome: f.slockHome }, f.deps);
    const models = await detectCursorSdkModels({ slockHome: f.slockHome }, f.deps);
    assert.equal(models.kind, "live");
    assert.ok(f.seen.every((key) => key === "opaque-fixture-original"));
    await f.save("other-account");
    await assert.rejects(resolveCursorCredentialLease({ slockHome: f.slockHome }, f.deps), /another account/);
  } finally { await f.cleanup(); }
});

test("disconnect leaves shared login intact and persists no-auto-reconnect intent", async () => {
  const f = await fixture();
  try {
    await resolveCursorCredentialLease({ slockHome: f.slockHome }, f.deps);
    const before = await readFile(f.file, "utf8");
    await logoutCursorSdkOwner({ slockHome: f.slockHome });
    assert.equal(await readFile(f.file, "utf8"), before);
    await assert.rejects(resolveCursorCredentialLease({ slockHome: f.slockHome }, f.deps), /explicitly disconnected/);
    assert.equal((await getCursorSdkAuthStatus({ slockHome: f.slockHome }, f.deps)).status, "disconnected");
    const connected = await connectExistingCursorSdkOwner({ slockHome: f.slockHome }, f.deps);
    assert.equal(connected.principalId, "11");
    assert.equal("apiKey" in connected, false);
  } finally { await f.cleanup(); }
});

test("browser login stores Raft-owned key without replacing or copying over shared SDK login", async () => {
  const f = await fixture();
  try {
    const before = await readFile(f.file, "utf8");
    const result = await loginCursorSdkOwner({ slockHome: f.slockHome }, {}, f.deps);
    assert.equal("apiKey" in result, false);
    assert.equal(await readFile(f.file, "utf8"), before);
    const lease = await resolveCursorCredentialLease({ slockHome: f.slockHome }, f.deps);
    assert.equal(lease.apiKey, "opaque-fixture-owned");
    assert.equal((await getCursorSdkAuthStatus({ slockHome: f.slockHome }, f.deps)).borrowed, false);
  } finally { await f.cleanup(); }
});

test("expired, loose-permission and symlink stores fail without an online request", async () => {
  const f = await fixture();
  try {
    await f.save("opaque", Date.now() - 1);
    await assert.rejects(resolveCursorCredentialLease({ slockHome: f.slockHome }, f.deps), /expired/);
    await f.save("opaque"); await chmod(f.file, 0o644);
    await assert.rejects(resolveCursorCredentialLease({ slockHome: f.slockHome }, f.deps), /owner-only/);
    await chmod(f.file, 0o600);
    const original = await readFile(f.file, "utf8");
    await rm(f.file); await writeFile(`${f.file}.target`, original, { mode: 0o600 }); await symlink(`${f.file}.target`, f.file);
    await assert.rejects(resolveCursorCredentialLease({ slockHome: f.slockHome }, f.deps), /safely/);
    assert.deepEqual(f.seen, []);
  } finally { await f.cleanup(); }
});

test("authorization changes refuse a live SDK host", async () => {
  const f = await fixture();
  try {
    const root = path.join(f.slockHome, "cursor-sdk-host", "agent-test");
    await mkdir(root, { recursive: true }); await writeFile(path.join(root, "host.lock"), JSON.stringify({ pid: process.pid }));
    await assert.rejects(logoutCursorSdkOwner({ slockHome: f.slockHome }), /Stop active/);
    await assert.rejects(loginCursorSdkOwner({ slockHome: f.slockHome }, {}, f.deps), /Stop active/);
    assert.deepEqual(f.seen, []);
  } finally { await f.cleanup(); }
});
