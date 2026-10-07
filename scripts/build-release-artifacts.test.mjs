// --only argument handling for the release pipeline. Both cases fail before
// any build step runs, so the script can be spawned safely (no electron-builder).
// Run: node --test scripts/build-release-artifacts.test.mjs
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const script = join(fileURLToPath(new URL(".", import.meta.url)), "build-release-artifacts.mjs");

function run(...args) {
  return spawnSync("node", [script, "--out", "/nonexistent/never-written", "--desktop-origin", "https://raft.example:18443", ...args], {
    encoding: "utf8",
  });
}

test("--only rejects unknown steps", () => {
  const result = run("--only", "linux");
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /--only must be one of: desktop \(got: linux\)/);
});

test("--only desktop needs a macOS host", { skip: process.platform === "darwin" }, () => {
  const result = run("--only", "desktop");
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /--only desktop needs a macOS host/);
});
