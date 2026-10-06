// Server-origin configuration (phase 3-1): priority chain, validation,
// generation monotonicity. Runs unbundled, so CONFIGURED_API_ORIGIN is the
// official production default — exactly the stock-official-build path.
import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  SERVER_ORIGIN_ENV,
  SERVER_ORIGIN_FILE,
  ServerOriginConfig,
  resolveServerOriginSync,
  validateServerOriginInput,
} from "./serverOriginConfig.ts";

const PRIVATE = "https://raft.internal.example:8443";
const OTHER_PRIVATE = "https://raft.other.example";

function tempDir(): string {
  return mkdtempSync(path.join(tmpdir(), "raft-server-origin-"));
}

function writeOriginFile(dir: string, data: unknown): void {
  const file = path.join(dir, SERVER_ORIGIN_FILE);
  rmSync(file, { force: true });
  if (data !== null) {
    writeFileSync(file, typeof data === "string" ? data : JSON.stringify(data), { mode: 0o600 });
  }
}

test("validateServerOriginInput accepts canonical https origins and trims", () => {
  assert.equal(validateServerOriginInput(` ${PRIVATE} `), PRIVATE);
  assert.equal(validateServerOriginInput("https://raft.example"), "https://raft.example");
  // An official origin is a legitimate explicit choice (switching back).
  assert.equal(validateServerOriginInput("https://api.raft.build"), "https://api.raft.build");
});

test("validateServerOriginInput rejects the full invalid set", () => {
  const rejections: unknown[] = [
    "",
    "   ",
    null,
    42,
    // http is refused at runtime — the stock renderer CSP only reaches
    // https/wss targets (localhost makes no difference).
    "http://raft.internal.example:8443",
    "http://localhost:8443",
    "http://127.0.0.1:3001",
    // dangerous schemes
    "javascript:alert(1)",
    "file:///etc/passwd",
    "data:text/html,hi",
    "ftp://raft.example",
    // shape violations
    "https://raft.internal.example:8443/downloads",
    "https://raft.internal.example:8443/?q=1",
    "https://raft.internal.example:8443/#frag",
    "https://user:pw@raft.internal.example:8443",
    "not a url",
    "https://", // URL() throws on bare scheme
    `https://${"a".repeat(2100)}.example`,
  ];
  for (const value of rejections) {
    assert.equal(validateServerOriginInput(value), null, `expected rejection: ${JSON.stringify(value)}`);
  }
});

test("priority: userData file wins over env, env wins over baked default", () => {
  const dir = tempDir();
  try {
    writeOriginFile(dir, { origin: PRIVATE, generation: 3 });
    assert.deepEqual(
      resolveServerOriginSync(dir, { env: { [SERVER_ORIGIN_ENV]: OTHER_PRIVATE } }),
      { override: PRIVATE, source: "file", generation: 3, lastPersistedGeneration: 3 },
    );

    const fromEnv = resolveServerOriginSync(dir, { env: { [SERVER_ORIGIN_ENV]: OTHER_PRIVATE }, readFileSync: () => { throw Object.assign(new Error("ENOENT"), { code: "ENOENT" }); } });
    assert.deepEqual(fromEnv, { override: OTHER_PRIVATE, source: "env", generation: 1, lastPersistedGeneration: 0 });

    const none = resolveServerOriginSync(dir, { env: {}, readFileSync: () => { throw Object.assign(new Error("ENOENT"), { code: "ENOENT" }); } });
    assert.deepEqual(none, { override: null, source: "none", generation: 0, lastPersistedGeneration: 0 });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("invalid file or env values are ignored with a warning, never brick boot", () => {
  const dir = tempDir();
  const warnings: string[] = [];
  const log = (message: string) => warnings.push(message);
  try {
    for (const bad of [
      "{ not json",
      JSON.stringify({ origin: "http://insecure.example", generation: 2 }),
      JSON.stringify({ origin: "javascript:alert(1)", generation: 2 }),
      JSON.stringify({ generation: 2 }),
    ]) {
      writeOriginFile(dir, bad);
      const resolved = resolveServerOriginSync(dir, { env: {}, log });
      assert.equal(resolved.override, null, `file ${bad} must be ignored`);
    }
    // Unreadable (non-ENOENT) file behaves the same.
    const failed = resolveServerOriginSync(dir, { env: {}, log, readFileSync: () => { throw new Error("EISDIR: boom"); } });
    assert.equal(failed.override, null);
    // A corrupt file falls through to a valid env override.
    writeOriginFile(dir, "{ broken");
    const salvaged = resolveServerOriginSync(dir, { env: { [SERVER_ORIGIN_ENV]: OTHER_PRIVATE }, log });
    assert.equal(salvaged.override, OTHER_PRIVATE);
    assert.equal(salvaged.source, "env");
    // The env layer itself runs the same validator.
    const badEnv = resolveServerOriginSync(dir, { env: { [SERVER_ORIGIN_ENV]: "http://nope.example" }, log, readFileSync: () => { throw Object.assign(new Error("ENOENT"), { code: "ENOENT" }); } });
    assert.equal(badEnv.override, null);
    assert.ok(warnings.some((w) => w.includes(SERVER_ORIGIN_FILE)));
    assert.ok(warnings.some((w) => w.includes(SERVER_ORIGIN_ENV)));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a generation-0 file still yields a usable injection generation", () => {
  const dir = tempDir();
  try {
    writeOriginFile(dir, { origin: PRIVATE });
    const resolved = resolveServerOriginSync(dir, { env: {} });
    assert.equal(resolved.override, PRIVATE);
    assert.equal(resolved.generation, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("set validates, persists, and bumps the generation monotonically across resets", async () => {
  const dir = tempDir();
  try {
    const config = new ServerOriginConfig({ userDataDir: dir, env: {} });
    // Stock official build with nothing configured: baked default, official.
    assert.equal(config.current(), "https://api.raft.build");
    assert.equal(config.hasOverride(), false);
    assert.equal(config.injectionGeneration(), 0);

    assert.deepEqual(await config.set("not a url"), { ok: false, error: "invalid_server_origin" });
    assert.deepEqual(await config.set("http://localhost:8443"), { ok: false, error: "invalid_server_origin" });

    // First write starts at 2 — env-only boots reserve generation 1.
    assert.deepEqual(await config.set(PRIVATE), { ok: true, changed: true, generation: 2, origin: PRIVATE });
    // Same-origin re-set is a no-op.
    assert.deepEqual(await config.set(` ${PRIVATE}/ `), { ok: true, changed: false, generation: 2, origin: PRIVATE });

    // A fresh resolve of the same dir sees the persisted override.
    const reRead = new ServerOriginConfig({ userDataDir: dir, env: { [SERVER_ORIGIN_ENV]: OTHER_PRIVATE } });
    assert.equal(reRead.current(), PRIVATE);
    assert.equal(reRead.injectionGeneration(), 2);

    // Reset persists origin=null and bumps again; a subsequent different
    // origin lands on a generation the renderer has NEVER stored — the
    // stale-token-into-new-origin hazard this counter exists to prevent.
    assert.deepEqual(await config.reset(), { ok: true, changed: true, generation: 3, origin: null });
    assert.deepEqual(await config.set(OTHER_PRIVATE), { ok: true, changed: true, generation: 4, origin: OTHER_PRIVATE });

    const persisted = JSON.parse(readFileSync(path.join(dir, SERVER_ORIGIN_FILE), "utf8"));
    assert.deepEqual(persisted, { origin: OTHER_PRIVATE, generation: 4, updatedAt: persisted.updatedAt });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("status reports the split between effective origin, override and baked default", async () => {
  const dir = tempDir();
  try {
    const stock = new ServerOriginConfig({ userDataDir: dir, env: {} });
    assert.deepEqual(stock.status(), {
      origin: "https://api.raft.build",
      override: null,
      bakedOrigin: "https://api.raft.build",
      isOfficial: true,
      generation: 0,
    });

    await stock.set(PRIVATE);
    assert.deepEqual(stock.status(), {
      origin: PRIVATE,
      override: PRIVATE,
      bakedOrigin: "https://api.raft.build",
      isOfficial: false,
      generation: 2,
    });

    // Switching back to the official origin explicitly is allowed (and
    // still bumps the generation — it is a real deployment change).
    assert.deepEqual(await stock.set("https://api.raft.build"), { ok: true, changed: true, generation: 3, origin: "https://api.raft.build" });
    const back = new ServerOriginConfig({ userDataDir: dir, env: {} });
    assert.equal(back.current(), "https://api.raft.build");
    assert.equal(back.hasOverride(), true);
    assert.equal(back.injectionGeneration(), 3);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
