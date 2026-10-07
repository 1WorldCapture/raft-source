// dist:linux must not silently produce a build baked to the official backend.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";

// @ts-expect-error plain .mjs script without type declarations
import { checkLinuxBuildOrigin } from "../../scripts/require-linux-build-origin.mjs";

test("missing VITE_API_URL is refused", () => {
  const r = checkLinuxBuildOrigin({});
  assert.equal(r.ok, false);
  assert.match(r.message, /requires VITE_API_URL/);
});

test("an official origin is refused unless explicitly allowed", () => {
  assert.equal(checkLinuxBuildOrigin({ VITE_API_URL: "https://api.raft.build" }).ok, false);
  assert.equal(checkLinuxBuildOrigin({ VITE_API_URL: "https://api.raft.build", RAFT_LINUX_ALLOW_OFFICIAL_ORIGIN: "1" }).ok, true);
  assert.equal(checkLinuxBuildOrigin({ RAFT_LINUX_ALLOW_OFFICIAL_ORIGIN: "1" }).ok, true);
});

test("a private https origin is accepted and a malformed one is refused", () => {
  const ok = checkLinuxBuildOrigin({ VITE_API_URL: "https://raft.example:8443" });
  assert.equal(ok.ok, true);
  assert.match(ok.message, /raft\.example:8443/);
  assert.equal(checkLinuxBuildOrigin({ VITE_API_URL: "https://raft.example/path?x=1" }).ok, false);
});

test("the script exits non-zero without VITE_API_URL", () => {
  const script = fileURLToPath(new URL("../../scripts/require-linux-build-origin.mjs", import.meta.url));
  const env = { ...process.env };
  delete env.VITE_API_URL;
  delete env.RAFT_LINUX_ALLOW_OFFICIAL_ORIGIN;
  const r = spawnSync(process.execPath, [script], { env, encoding: "utf8" });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /dist:linux/);
});
