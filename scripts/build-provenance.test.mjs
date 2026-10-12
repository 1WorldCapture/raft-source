import assert from "node:assert/strict";
import { test } from "node:test";

import { buildCommitDefines, resolveBuildCommit, UNKNOWN_COMMIT } from "./build-provenance.mjs";

const FULL = "d85eb3371234567890abcdef1234567890abcdef";

test("resolveBuildCommit reads the full sha from git", () => {
  const got = resolveBuildCommit({ env: {}, runGit: () => `${FULL}\n` });
  assert.equal(got.sha, FULL);
  assert.equal(got.short, FULL.slice(0, 12));
  assert.equal(got.source, "git");
});

test("resolveBuildCommit keeps a short sha intact and does not pad it", () => {
  const got = resolveBuildCommit({ env: {}, runGit: () => "abc1234\n" });
  assert.equal(got.sha, "abc1234");
  assert.equal(got.short, "abc1234");
  assert.equal(got.source, "git");
});

test("RAFT_BUILD_COMMIT wins over git so release tooling can stamp explicitly", () => {
  const got = resolveBuildCommit({ env: { RAFT_BUILD_COMMIT: FULL }, runGit: () => "deadbeef\n" });
  assert.equal(got.sha, FULL);
  assert.equal(got.short, FULL.slice(0, 12));
  assert.equal(got.source, "env");
});

test("a blank RAFT_BUILD_COMMIT is ignored, not baked as an empty sha", () => {
  const got = resolveBuildCommit({ env: { RAFT_BUILD_COMMIT: "   " }, runGit: () => `${FULL}\n` });
  assert.equal(got.sha, FULL);
  assert.equal(got.source, "git");
});

test("a git failure falls back to the explicit unknown marker instead of throwing", () => {
  const got = resolveBuildCommit({
    env: {},
    runGit: () => { throw new Error("not a git repository"); },
  });
  assert.deepEqual(got, { sha: UNKNOWN_COMMIT, short: UNKNOWN_COMMIT, source: "unknown" });
});

test("a non-sha answer from git is not presented as build provenance", () => {
  // `git rev-parse HEAD` outside a repo can echo input; never bake that as a sha.
  const got = resolveBuildCommit({ env: {}, runGit: () => "HEAD\n" });
  assert.equal(got.sha, UNKNOWN_COMMIT);
  assert.equal(got.source, "unknown");
});

test("buildCommitDefines emits json-stringified define entries for the prefix", () => {
  const defines = buildCommitDefines("RAFT_DAEMON", { env: { RAFT_BUILD_COMMIT: FULL } });
  assert.deepEqual(defines, {
    __RAFT_DAEMON_COMMIT_SHA__: JSON.stringify(FULL),
    __RAFT_DAEMON_COMMIT_SHORT__: JSON.stringify(FULL.slice(0, 12)),
  });
  // Values must be valid JS literals so `define` cannot produce broken output.
  assert.equal(JSON.parse(defines.__RAFT_DAEMON_COMMIT_SHA__), FULL);
});

test("buildCommitDefines still produces a usable map when provenance is unknown", () => {
  const defines = buildCommitDefines("RAFT_COMPUTER", {
    env: {},
    runGit: () => { throw new Error("no git"); },
  });
  assert.equal(JSON.parse(defines.__RAFT_COMPUTER_COMMIT_SHA__), UNKNOWN_COMMIT);
  assert.equal(JSON.parse(defines.__RAFT_COMPUTER_COMMIT_SHORT__), UNKNOWN_COMMIT);
});

test("resolves against the real repository without throwing", () => {
  const got = resolveBuildCommit();
  assert.equal(typeof got.sha, "string");
  assert.ok(got.sha.length > 0);
  // In this repo git IS available, so provenance must be real, not unknown.
  assert.equal(got.source, "git");
  assert.match(got.sha, /^[0-9a-f]{7,40}$/);
});