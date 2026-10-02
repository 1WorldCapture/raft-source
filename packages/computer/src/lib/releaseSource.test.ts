import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, test } from "vitest";
import { isComputerError } from "./errors.js";
import {
  initializeReleaseSource,
  parseReleaseSource,
  readReleaseSource,
  releaseSourcePath,
  releaseSourcesEquivalent,
  resolveRuntimeReleaseSource,
  writeReleaseSource,
} from "./releaseSource.js";

let home: string;

beforeEach(async () => {
  home = await mkdtemp(path.join(tmpdir(), "release-source-"));
  // Raw-corruption tests write the file directly; the production writers
  // create this directory themselves, but the test harness should not depend
  // on a previous test having created it.
  await mkdir(path.dirname(releaseSourcePath(home)), { recursive: true });
});

afterEach(async () => {
  await rm(home, { recursive: true, force: true });
});

function manifestSource(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schemaVersion: 1,
    backend: "manifest",
    releaseBase: "https://raft.example.com/computer",
    ...overrides,
  };
}

// --- parse ---

test("parse accepts a valid manifest source and normalizes trailing slashes", () => {
  const parsed = parseReleaseSource(JSON.stringify(manifestSource({ releaseBase: "https://raft.example.com/computer///" })));
  assert.ok(parsed);
  assert.equal(parsed.backend, "manifest");
  assert.equal(parsed.releaseBase, "https://raft.example.com/computer");
  assert.equal(parsed.handsOrigin, undefined);
});

test("parse requires handsOrigin for the hands backend", () => {
  assert.equal(parseReleaseSource(JSON.stringify(manifestSource({ backend: "hands" }))), null);
  const parsed = parseReleaseSource(JSON.stringify(manifestSource({
    backend: "hands",
    handsOrigin: "https://hands.internal",
  })));
  assert.ok(parsed);
  assert.equal(parsed.handsOrigin, "https://hands.internal");
});

test("parse rejects unknown schema, bad backends, malformed URLs, credentials, queries, and non-loopback HTTP", () => {
  for (const bad of [
    manifestSource({ schemaVersion: 2 }),
    manifestSource({ backend: "legacy-cdn" }),
    manifestSource({ releaseBase: "not a url" }),
    manifestSource({ releaseBase: "https://user:pass@raft.example.com/computer" }),
    manifestSource({ releaseBase: "https://raft.example.com/computer?x=1" }),
    manifestSource({ releaseBase: "http://raft.example.com/computer" }),
    manifestSource({ releaseBase: "https://raft.example.com/computer#frag" }),
    manifestSource({ backend: "manifest", handsOrigin: "https://hands.internal" }), // manifest never carries handsOrigin
    "not json",
  ]) {
    assert.equal(parseReleaseSource(typeof bad === "string" ? bad : JSON.stringify(bad)), null, `expected null for ${JSON.stringify(bad)}`);
  }
  // Loopback HTTP stays legal for local development.
  assert.ok(parseReleaseSource(JSON.stringify(manifestSource({ releaseBase: "http://localhost:9765/computer" }))));
});

// --- read / write / initialize ---

test("read: missing file is absent; a corrupt present file is a hard error, never a fallback", async () => {
  assert.equal((await readReleaseSource(home)).status, "absent");

  await writeFile(releaseSourcePath(home), "{ not json", "utf8");
  await assert.rejects(
    () => readReleaseSource(home),
    (error: unknown) => isComputerError(error) && error.code === "RELEASE_SOURCE_CORRUPT",
  );

  await writeFile(releaseSourcePath(home), JSON.stringify(manifestSource({ schemaVersion: 99 })), "utf8");
  await assert.rejects(
    () => readReleaseSource(home),
    (error: unknown) => isComputerError(error) && error.code === "RELEASE_SOURCE_CORRUPT",
  );
});

test("write persists a durable, strictly-valid document with audit fields", async () => {
  await writeReleaseSource(home, {
    schemaVersion: 1,
    backend: "manifest",
    releaseBase: "https://raft.example.com/computer",
  }, "installer");
  const raw = await readFile(releaseSourcePath(home), "utf8");
  const parsed = parseReleaseSource(raw);
  assert.ok(parsed);
  assert.equal(parsed.writtenBy, "installer");
  assert.ok(parsed.writtenAt);
});

test("initialize is first-writer-wins: idempotent for an equivalent source, conflict otherwise", async () => {
  const source = {
    schemaVersion: 1 as const,
    backend: "manifest" as const,
    releaseBase: "https://raft.example.com/computer",
  };
  assert.equal((await initializeReleaseSource(home, source, "installer")).outcome, "initialized");
  assert.equal((await initializeReleaseSource(home, source, "setup")).outcome, "already-present");

  await assert.rejects(
    () => initializeReleaseSource(home, { ...source, releaseBase: "https://other.example.com/computer" }, "setup"),
    (error: unknown) => isComputerError(error) && error.code === "RELEASE_SOURCE_CONFLICT",
  );
  // The conflicting attempt must not have replaced the existing source.
  const current = await readReleaseSource(home);
  assert.ok(current.status === "present" && current.source.releaseBase === "https://raft.example.com/computer");
});

test("equivalence ignores audit fields", () => {
  const a = { schemaVersion: 1 as const, backend: "manifest" as const, releaseBase: "https://x.example.com/computer" };
  const b = { ...a, writtenAt: "2026-10-02T00:00:00Z", writtenBy: "installer" };
  assert.ok(releaseSourcesEquivalent(a, b));
  assert.ok(!releaseSourcesEquivalent(a, { ...a, releaseBase: "https://y.example.com/computer" }));
});

// --- runtime resolution precedence ---

test("resolution precedence: env override > persisted file > official default", async () => {
  assert.equal((await resolveRuntimeReleaseSource({}, home)).origin, "official-default");

  await writeReleaseSource(home, {
    schemaVersion: 1,
    backend: "manifest",
    releaseBase: "https://raft.example.com/computer",
  }, "installer");
  assert.equal((await resolveRuntimeReleaseSource({}, home)).origin, "persisted");

  const envOverride = await resolveRuntimeReleaseSource({
    RAFT_COMPUTER_RELEASE_BASE: "https://override.example.com/computer",
    RAFT_COMPUTER_RELEASE_BACKEND: "manifest",
  }, home);
  assert.equal(envOverride.origin, "env-override");
  assert.equal(envOverride.source.releaseBase, "https://override.example.com/computer");
});

test("env override must be a complete, valid group", async () => {
  await assert.rejects(
    () => resolveRuntimeReleaseSource({ RAFT_COMPUTER_RELEASE_BACKEND: "manifest" }, home),
    (error: unknown) => isComputerError(error) && error.code === "RELEASE_SOURCE_ENV_INVALID",
  );
  await assert.rejects(
    () => resolveRuntimeReleaseSource({
      RAFT_COMPUTER_RELEASE_BASE: "https://raft.example.com/computer",
      RAFT_COMPUTER_RELEASE_BACKEND: "manifest",
      RAFT_COMPUTER_HANDS_ORIGIN: "https://hands.internal",
    }, home),
    (error: unknown) => isComputerError(error) && error.code === "RELEASE_SOURCE_ENV_INVALID",
  );
  await assert.rejects(
    () => resolveRuntimeReleaseSource({
      RAFT_COMPUTER_RELEASE_BASE: "https://raft.example.com/computer",
      RAFT_COMPUTER_RELEASE_BACKEND: "hands",
    }, home),
    (error: unknown) => isComputerError(error) && error.code === "RELEASE_SOURCE_ENV_INVALID",
  );
});

test("legacy variables normalize into the new group and conflicts are rejected", async () => {
  const legacy = await resolveRuntimeReleaseSource({
    RAFT_COMPUTER_UPGRADE_BASE_URL: "https://raft.example.com/computer",
    RAFT_COMPUTER_RELEASE_BACKEND: "legacy-cdn",
  }, home);
  assert.equal(legacy.origin, "env-override");
  assert.equal(legacy.source.backend, "manifest");
  assert.equal(legacy.source.releaseBase, "https://raft.example.com/computer");

  const sameValue = await resolveRuntimeReleaseSource({
    RAFT_COMPUTER_RELEASE_BASE: "https://raft.example.com/computer",
    RAFT_COMPUTER_UPGRADE_BASE_URL: "https://raft.example.com/computer",
    RAFT_COMPUTER_RELEASE_BACKEND: "manifest",
  }, home);
  assert.equal(sameValue.source.releaseBase, "https://raft.example.com/computer");

  await assert.rejects(
    () => resolveRuntimeReleaseSource({
      RAFT_COMPUTER_RELEASE_BASE: "https://a.example.com/computer",
      RAFT_COMPUTER_UPGRADE_BASE_URL: "https://b.example.com/computer",
    }, home),
    (error: unknown) => isComputerError(error) && error.code === "RELEASE_SOURCE_ENV_CONFLICT",
  );
});

test("a corrupt persisted file fails resolution instead of falling back to official", async () => {
  await writeFile(releaseSourcePath(home), "{ broken", "utf8");
  await assert.rejects(
    () => resolveRuntimeReleaseSource({}, home),
    (error: unknown) => isComputerError(error) && error.code === "RELEASE_SOURCE_CORRUPT",
  );
});
