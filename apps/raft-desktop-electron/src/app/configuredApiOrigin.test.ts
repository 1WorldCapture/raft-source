// Runtime consumers of the baked API origin: the CORS-bridge origin set and
// official-build detection. The baked identifier is absent in unbundled tests,
// so the module-level default must behave exactly like a stock official build.
import assert from "node:assert/strict";
import test from "node:test";

import { CONFIGURED_API_ORIGIN, buildApiOrigins, isOfficialApiBuild, readConfiguredApiOrigin } from "./configuredApiOrigin.ts";

const OFFICIAL = new Set(["https://api.raft.build", "https://api-aws-staging.botiverse.dev"]);
const SELF_HOSTED = "http://raft.internal.example:3001";

test("unbundled module state matches a stock official build", () => {
  assert.equal(CONFIGURED_API_ORIGIN, "https://api.raft.build");
  assert.equal(isOfficialApiBuild(), true);
  assert.equal(readConfiguredApiOrigin(undefined), "https://api.raft.build");
});

test("readConfiguredApiOrigin accepts only non-empty baked strings", () => {
  assert.equal(readConfiguredApiOrigin("http://raft.internal.example:3001"), "http://raft.internal.example:3001");
  assert.equal(readConfiguredApiOrigin(0 as unknown), "https://api.raft.build");
  assert.equal(readConfiguredApiOrigin(null), "https://api.raft.build");
  // The empty-string rejection is the meaningful bound:
  assert.equal(readConfiguredApiOrigin(""), "https://api.raft.build");
});

test("buildApiOrigins bridges the official origins for official builds", () => {
  for (const origin of OFFICIAL) {
    const origins = buildApiOrigins(origin);
    assert.equal(origins.size, 2);
    assert.equal(origins.has(origin), true);
  }
});

test("buildApiOrigins adds exactly the configured origin for self-hosted builds", () => {
  const origins = buildApiOrigins(SELF_HOSTED);
  assert.equal(origins.size, 3);
  assert.equal(origins.has(SELF_HOSTED), true);
  // Look-alikes and scheme/port variants are NOT bridged — matching downstream
  // is exact-origin, and the set itself must not contain near-misses.
  for (const lookAlike of [
    "http://raft.internal.example:3002",
    "https://raft.internal.example:3001",
    "http://raft.internal.example:3001.evil.com",
    "http://sub.raft.internal.example:3001",
  ]) {
    assert.equal(origins.has(lookAlike), false, lookAlike);
  }
});

test("isOfficialApiBuild is false only for non-official origins", () => {
  assert.equal(isOfficialApiBuild("https://api.raft.build"), true);
  assert.equal(isOfficialApiBuild("https://api-aws-staging.botiverse.dev"), true);
  assert.equal(isOfficialApiBuild(SELF_HOSTED), false);
});
