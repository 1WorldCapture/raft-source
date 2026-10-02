import assert from "node:assert/strict";
import { test } from "vitest";
import {
  computerReleaseIdentity,
  readComputerDeploymentConfig,
  RAFT_COMPUTER_HANDS_ORIGIN_ENV,
  RAFT_COMPUTER_INSTALL_CHANNEL_ENV,
  RAFT_COMPUTER_PINNED_VERSION_ENV,
  RAFT_COMPUTER_RELEASE_BACKEND_ENV,
  RAFT_COMPUTER_RELEASE_BASE_ENV,
  RAFT_PUBLIC_ORIGIN_ENV,
} from "./computerDeploymentConfig.js";

function env(overrides: Record<string, string> = {}): NodeJS.ProcessEnv {
  return {
    [RAFT_PUBLIC_ORIGIN_ENV]: "https://raft.example.com",
    [RAFT_COMPUTER_RELEASE_BASE_ENV]: "https://raft.example.com/computer",
    [RAFT_COMPUTER_RELEASE_BACKEND_ENV]: "manifest",
    ...overrides,
  };
}

test("ready: manifest backend parses origins, path-bearing base, and derived channel", () => {
  const result = readComputerDeploymentConfig(env());
  assert.equal(result.status, "ready");
  if (result.status !== "ready") return;
  assert.equal(result.config.serverUrl, "https://raft.example.com");
  assert.equal(result.config.backend, "manifest");
  assert.equal(result.config.releaseBase, "https://raft.example.com/computer");
  assert.equal(result.config.handsOrigin, null);
  assert.equal(result.config.pinnedVersion, null);
  assert.equal(result.config.installChannel, "latest");
});

test("ready: hands backend requires and carries handsOrigin", () => {
  const result = readComputerDeploymentConfig(env({
    [RAFT_COMPUTER_RELEASE_BACKEND_ENV]: "hands",
    [RAFT_COMPUTER_HANDS_ORIGIN_ENV]: "https://hands.internal",
  }));
  assert.equal(result.status, "ready");
  if (result.status !== "ready") return;
  assert.equal(result.config.backend, "hands");
  assert.equal(result.config.handsOrigin, "https://hands.internal");
});

test("backend defaults to hands when unset", () => {
  const result = readComputerDeploymentConfig(env({
    [RAFT_COMPUTER_RELEASE_BACKEND_ENV]: "",
    [RAFT_COMPUTER_HANDS_ORIGIN_ENV]: "https://hands.internal",
  }));
  assert.equal(result.status, "ready");
  if (result.status !== "ready") return;
  assert.equal(result.config.backend, "hands");
});

test("hands backend without handsOrigin reports it as missing", () => {
  const result = readComputerDeploymentConfig(env({
    [RAFT_COMPUTER_RELEASE_BACKEND_ENV]: "hands",
  }));
  assert.deepEqual(result, { status: "missing", fields: [RAFT_COMPUTER_HANDS_ORIGIN_ENV] });
});

test("empty environment reports required fields as missing", () => {
  const result = readComputerDeploymentConfig({});
  assert.equal(result.status, "missing");
  assert.deepEqual(result.fields, [
    RAFT_PUBLIC_ORIGIN_ENV,
    RAFT_COMPUTER_RELEASE_BASE_ENV,
    RAFT_COMPUTER_HANDS_ORIGIN_ENV,
  ]);
});

test("invalid values win over missing and only field names travel", () => {
  const result = readComputerDeploymentConfig({
    [RAFT_PUBLIC_ORIGIN_ENV]: "https://user:pass@raft.example.com",
  });
  assert.equal(result.status, "invalid");
  if (result.status !== "invalid" && result.status !== "missing") return;
  assert.ok((result as { fields: string[] }).fields.includes(RAFT_PUBLIC_ORIGIN_ENV));
  const serialized = JSON.stringify(result);
  assert.ok(!serialized.includes("user:pass"), "raw values must never be echoed");
});

test("origins reject paths, credentials, queries, fragments, and non-HTTP schemes", () => {
  for (const bad of [
    "https://raft.example.com/app", // path on an origin-only value
    "https://raft.example.com/?x=1",
    "https://raft.example.com/#frag",
    "ftp://raft.example.com",
    "not a url",
    "http://raft.example.com", // non-loopback HTTP
  ]) {
    const result = readComputerDeploymentConfig(env({ [RAFT_PUBLIC_ORIGIN_ENV]: bad }));
    assert.equal(result.status, "invalid", `expected invalid for ${bad}`);
    if ((result as { status: string }).status === "invalid") {
      assert.deepEqual((result as { fields: string[] }).fields, [RAFT_PUBLIC_ORIGIN_ENV]);
    }
  }
});

test("loopback HTTP stays legal for local development", () => {
  for (const loopback of ["http://localhost:3001", "http://127.0.0.1:3001", "http://[::1]:3001"]) {
    const result = readComputerDeploymentConfig(env({
      [RAFT_PUBLIC_ORIGIN_ENV]: loopback,
      [RAFT_COMPUTER_RELEASE_BASE_ENV]: `${loopback}/computer`,
      [RAFT_COMPUTER_RELEASE_BACKEND_ENV]: "manifest",
    }));
    assert.equal(result.status, "ready", `expected ready for ${loopback}`);
  }
});

test("releaseBase keeps its path and drops trailing slashes", () => {
  const result = readComputerDeploymentConfig(env({
    [RAFT_COMPUTER_RELEASE_BASE_ENV]: "https://cdn.example.com/computer///",
  }));
  assert.equal(result.status, "ready");
  if (result.status !== "ready") return;
  assert.equal(result.config.releaseBase, "https://cdn.example.com/computer");
});

test("unknown backend value is invalid", () => {
  const result = readComputerDeploymentConfig(env({
    [RAFT_COMPUTER_RELEASE_BACKEND_ENV]: "legacy-cdn",
  }));
  assert.deepEqual(result, { status: "invalid", fields: [RAFT_COMPUTER_RELEASE_BACKEND_ENV] });
});

test("pinned version must be valid semver and drives the install channel", () => {
  const ready = readComputerDeploymentConfig(env({
    [RAFT_COMPUTER_PINNED_VERSION_ENV]: "1.2.3",
  }));
  assert.equal(ready.status, "ready");
  if (ready.status !== "ready") return;
  assert.equal(ready.config.pinnedVersion, "1.2.3");
  assert.equal(ready.config.installChannel, "pinned:1.2.3");

  const invalid = readComputerDeploymentConfig(env({
    [RAFT_COMPUTER_PINNED_VERSION_ENV]: "latest",
  }));
  assert.deepEqual(invalid, { status: "invalid", fields: [RAFT_COMPUTER_PINNED_VERSION_ENV] });
});

test("alpha channel is hands-only and the only accepted channel override", () => {
  const handsAlpha = readComputerDeploymentConfig(env({
    [RAFT_COMPUTER_RELEASE_BACKEND_ENV]: "hands",
    [RAFT_COMPUTER_HANDS_ORIGIN_ENV]: "https://hands.internal",
    [RAFT_COMPUTER_INSTALL_CHANNEL_ENV]: "alpha",
  }));
  assert.equal(handsAlpha.status, "ready");
  if (handsAlpha.status !== "ready") return;
  assert.equal(handsAlpha.config.installChannel, "alpha");

  // manifest has no alpha: refuse instead of passing latest off as alpha.
  const manifestAlpha = readComputerDeploymentConfig(env({
    [RAFT_COMPUTER_INSTALL_CHANNEL_ENV]: "alpha",
  }));
  assert.deepEqual(manifestAlpha, { status: "invalid", fields: [RAFT_COMPUTER_INSTALL_CHANNEL_ENV] });

  // Pins come exclusively from RAFT_COMPUTER_PINNED_VERSION — a channel-side
  // pin would create a second pin state.
  const channelPin = readComputerDeploymentConfig(env({
    [RAFT_COMPUTER_INSTALL_CHANNEL_ENV]: "pinned:1.0.0",
  }));
  assert.deepEqual(channelPin, { status: "invalid", fields: [RAFT_COMPUTER_INSTALL_CHANNEL_ENV] });
});

test("manifest mode ignores a stray hands origin instead of rejecting it", () => {
  const result = readComputerDeploymentConfig(env({
    [RAFT_COMPUTER_HANDS_ORIGIN_ENV]: "https://hands.internal",
  }));
  assert.equal(result.status, "ready");
  if (result.status !== "ready") return;
  assert.equal(result.config.handsOrigin, null);
});

test("release identity separates configs the version cache must not share", () => {
  const base = {
    serverUrl: "https://raft.example.com",
    backend: "manifest" as const,
    releaseBase: "https://raft.example.com/computer",
    handsOrigin: null,
    pinnedVersion: null,
    installChannel: "latest" as const,
  };
  assert.notEqual(
    computerReleaseIdentity(base),
    computerReleaseIdentity({ ...base, releaseBase: "https://other.example.com/computer" }),
  );
  assert.notEqual(
    computerReleaseIdentity(base),
    computerReleaseIdentity({ ...base, installChannel: "pinned:1.0.0" as const }),
  );
});
