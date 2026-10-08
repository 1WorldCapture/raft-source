// Private-deployment update checker (phase 3-2): feed parsing, artifact
// selection (dual-arch trees), URL safety (same-origin enforcement — a
// tampered feed must never steer the user to an external site), version
// gating, and the detect-only lifecycle. Plus a structural pin that the
// checker is only started on the GUI path (never in headless __service
// children that re-exec this binary).
import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  isNewerVersion,
  parseLatestMacYml,
  resolvePrivateDownloadUrl,
  selectDownloadFile,
  startPrivateUpdateChecker,
} from "./privateUpdateChecker.ts";

const ORIGIN = "https://raft.internal.example:8443";

// A realistic dual-arch latest-mac.yml exactly as scripts/build-desktop-feed.mjs
// publishes it (task #12): version-prefixed urls under /downloads/desktop/,
// zip (updater artifact) AND dmg (manual install) for both architectures,
// unordered. PR #171 review: the checker must pick the dmg for THIS arch,
// never the first entry.
const DUAL_ARCH_YML = [
  "version: 0.2.0",
  "releaseDate: '2026-10-06T13:00:00.000Z'",
  "path: 0.2.0/Raft-Desktop-0.2.0-arm64-mac.zip",
  "sha512: AAAA",
  "files:",
  "  - url: 0.2.0/Raft-Desktop-0.2.0-x64-mac.zip",
  "    sha512: BBBB",
  "    size: 191000000",
  "  - url: 0.2.0/Raft-Desktop-0.2.0-x64.dmg",
  "    sha512: CCCC",
  "    size: 201000000",
  "  - url: 0.2.0/Raft-Desktop-0.2.0-arm64-mac.zip",
  "    sha512: DDDD",
  "    size: 193000000",
  "  - url: 0.2.0/Raft-Desktop-0.2.0-arm64.dmg",
  "    sha512: EEEE",
  "    size: 210000000",
].join("\n");

test("parseLatestMacYml reads the version and every files entry", () => {
  const parsed = parseLatestMacYml(DUAL_ARCH_YML);
  assert.ok(parsed);
  assert.equal(parsed.version, "0.2.0");
  assert.deepEqual(parsed.files.map((f) => f.url), [
    "0.2.0/Raft-Desktop-0.2.0-x64-mac.zip",
    "0.2.0/Raft-Desktop-0.2.0-x64.dmg",
    "0.2.0/Raft-Desktop-0.2.0-arm64-mac.zip",
    "0.2.0/Raft-Desktop-0.2.0-arm64.dmg",
  ]);
  assert.equal(parsed.files.find((f) => f.url.endsWith("arm64.dmg"))?.size, 210000000);
});

test("parseLatestMacYml rejects missing fields and non-strict versions", () => {
  assert.equal(parseLatestMacYml("version: 0.2.0\n"), null); // no files
  assert.equal(parseLatestMacYml("files:\n  - url: x.dmg\n"), null); // no version
  assert.equal(parseLatestMacYml("version: 0.2.0-beta.1\nfiles:\n  - url: x.dmg\n"), null);
  assert.equal(parseLatestMacYml("version: latest\nfiles:\n  - url: x.dmg\n"), null);
  assert.equal(parseLatestMacYml(""), null);
});

test("selectDownloadFile picks the dmg for THIS arch only", () => {
  const parsed = parseLatestMacYml(DUAL_ARCH_YML)!;
  assert.equal(selectDownloadFile(parsed.files, "arm64")?.url, "0.2.0/Raft-Desktop-0.2.0-arm64.dmg");
  assert.equal(selectDownloadFile(parsed.files, "x64")?.url, "0.2.0/Raft-Desktop-0.2.0-x64.dmg");
  // No entry for this arch → nothing to offer.
  assert.equal(selectDownloadFile(parsed.files.filter((f) => !f.url.includes("x64")), "x64"), null);
});

test("selectDownloadFile falls back to THIS arch's zip when the feed has no dmg for it", () => {
  const parsed = parseLatestMacYml(DUAL_ARCH_YML)!;
  const zipsOnly = parsed.files.filter((f) => f.url.endsWith(".zip"));
  assert.equal(selectDownloadFile(zipsOnly, "arm64")?.url, "0.2.0/Raft-Desktop-0.2.0-arm64-mac.zip");
  assert.equal(selectDownloadFile(zipsOnly, "x64")?.url, "0.2.0/Raft-Desktop-0.2.0-x64-mac.zip");
  // The feed script's artifactName form (no -mac suffix).
  const plain = [{ url: "0.2.0/Raft-Desktop-0.2.0-arm64.zip", size: 5 }];
  assert.equal(selectDownloadFile(plain, "arm64")?.url, "0.2.0/Raft-Desktop-0.2.0-arm64.zip");
  assert.equal(selectDownloadFile(plain, "x64"), null);
  // A dmg for this arch still wins over a zip.
  const both = [{ url: "0.2.0/Raft-Desktop-0.2.0-arm64.zip" }, { url: "0.2.0/Raft-Desktop-0.2.0-arm64.dmg" }];
  assert.equal(selectDownloadFile(both, "arm64")?.url, "0.2.0/Raft-Desktop-0.2.0-arm64.dmg");
});

test("resolvePrivateDownloadUrl enforces https same-origin exactly", () => {
  const warnings: string[] = [];
  const log = (m: string) => warnings.push(m);
  const base = `${ORIGIN}/downloads/desktop/`;
  // Relative reference resolves against the downloads base.
  assert.equal(resolvePrivateDownloadUrl(ORIGIN, "Raft-Desktop-0.2.0-arm64.dmg", log), `${base}Raft-Desktop-0.2.0-arm64.dmg`);
  // Absolute URL on the exact origin is fine.
  assert.equal(resolvePrivateDownloadUrl(ORIGIN, `${base}x.dmg`, log), `${base}x.dmg`);
  // Everything else is discarded with a warning.
  assert.equal(resolvePrivateDownloadUrl(ORIGIN, "https://evil.example/x.dmg", log), null);
  assert.equal(resolvePrivateDownloadUrl(ORIGIN, "https://raft.internal.example:8444/x.dmg", log), null); // port change
  assert.equal(resolvePrivateDownloadUrl(ORIGIN, "https://raft.internal.example.evil.com/x.dmg", log), null); // look-alike
  assert.equal(resolvePrivateDownloadUrl(ORIGIN, "http://raft.internal.example:8443/x.dmg", log), null); // scheme downgrade
  assert.equal(resolvePrivateDownloadUrl(ORIGIN, "file:///etc/passwd", log), null);
  assert.equal(resolvePrivateDownloadUrl(ORIGIN, "https://user:pw@raft.internal.example:8443/x.dmg", log), null);
  assert.equal(resolvePrivateDownloadUrl(ORIGIN, "https://raft.internal.example:8443/x.dmg?q=1", log), null);
  // A garbage RELATIVE reference still resolves inside the origin — the
  // same-origin rule is the security boundary, and such a link merely 404s
  // on our own server. (Only values that ESCAPE the origin are discarded.)
  assert.equal(resolvePrivateDownloadUrl(ORIGIN, "not a url", log), `${ORIGIN}/downloads/desktop/not%20a%20url`);
  assert.ok(warnings.length > 0);
});

test("isNewerVersion is strict-triple only", () => {
  assert.equal(isNewerVersion("0.2.0", "0.1.8"), true);
  assert.equal(isNewerVersion("1.0.0", "0.9.9"), true);
  assert.equal(isNewerVersion("0.1.8", "0.1.8"), false);
  assert.equal(isNewerVersion("0.1.7", "0.1.8"), false);
  assert.equal(isNewerVersion("0.1.9-beta", "0.1.8"), false); // not strict semver → never prompt
  assert.equal(isNewerVersion("v0.2.0", "0.1.8"), false);
});

function checkerWith(
  feed: () => Response | Error,
  opened: string[],
  currentVersion = "0.1.8",
  arch = "arm64",
) {
  return startPrivateUpdateChecker({
    origin: ORIGIN,
    appVersion: currentVersion,
    openExternal: (url) => { opened.push(url); },
    arch,
    fetchImpl: (async () => {
      const outcome = feed();
      if (outcome instanceof Error) throw outcome;
      return outcome;
    }) as typeof fetch,
    initialDelayMs: 60_000, // no stray near-term timer in tests
    intervalMs: 60_000,
  });
}

test("checker: newer version becomes available and opens THIS arch's dmg", async () => {
  const opened: string[] = [];
  const checker = checkerWith(() => new Response(DUAL_ARCH_YML), opened);
  await checker.check();
  assert.deepEqual(checker.status(), { state: "available", version: "0.2.0", size: 210000000 });
  assert.equal(checker.openDownload(), true);
  // Version-prefixed feed urls resolve into the versioned directory and
  // still pass the same-origin gate (end-to-end contract with task #12's
  // scripts/build-desktop-feed.mjs output).
  assert.deepEqual(opened, [`${ORIGIN}/downloads/desktop/0.2.0/Raft-Desktop-0.2.0-arm64.dmg`]);
});

test("checker: x64 machine gets the x64 dmg from the same feed", async () => {
  const opened: string[] = [];
  const checker = checkerWith(() => new Response(DUAL_ARCH_YML), opened, "0.1.8", "x64");
  await checker.check();
  assert.deepEqual(checker.status(), { state: "available", version: "0.2.0", size: 201000000 });
  assert.equal(checker.openDownload(), true);
  assert.deepEqual(opened, [`${ORIGIN}/downloads/desktop/0.2.0/Raft-Desktop-0.2.0-x64.dmg`]);
});

test("checker: a zip-only arm64 feed offers the zip; the other arch stays quiet", async () => {
  const opened: string[] = [];
  const zipOnlyArm64 = "version: 0.2.0\nfiles:\n  - url: 0.2.0/Raft-Desktop-0.2.0-arm64.zip\n    sha512: ZZZZ\n    size: 193000000\n";
  const arm = checkerWith(() => new Response(zipOnlyArm64), opened);
  await arm.check();
  assert.deepEqual(arm.status(), { state: "available", version: "0.2.0", size: 193000000 });
  assert.equal(arm.openDownload(), true);
  assert.deepEqual(opened, [`${ORIGIN}/downloads/desktop/0.2.0/Raft-Desktop-0.2.0-arm64.zip`]);
  const x64 = checkerWith(() => new Response(zipOnlyArm64), [], "0.1.8", "x64");
  await x64.check();
  assert.deepEqual(x64.status(), { state: "none" });
});

test("checker: same/older version, 404, tampered feed, and network failure all stay quiet", async () => {
  const opened: string[] = [];
  for (const feed of [
    () => new Response(DUAL_ARCH_YML.replace("version: 0.2.0", "version: 0.1.8")), // same version
    () => new Response(DUAL_ARCH_YML.replace("version: 0.2.0", "version: 0.1.7")), // older
    () => new Response("not found", { status: 404 }), // no desktop artifacts yet
    () => new Response(DUAL_ARCH_YML.replace("0.2.0/Raft-Desktop-0.2.0-arm64.dmg", "https://evil.example/Raft-Desktop-0.2.0-arm64.dmg")), // tampered (selected, then rejected by the origin gate)
    () => new Error("ENETDOWN"),
  ]) {
    const checker = checkerWith(feed, opened);
    await checker.check();
    assert.deepEqual(checker.status(), { state: "none" });
    assert.equal(checker.openDownload(), false);
  }
  assert.deepEqual(opened, []);
});

test("checker: a later quiet check invalidates the previous artifact (no stale open)", async () => {
  const opened: string[] = [];
  let feed: () => Response | Error = () => new Response(DUAL_ARCH_YML);
  const checker = checkerWith(() => feed(), opened);
  await checker.check();
  assert.equal(checker.status().state, "available");
  assert.equal(checker.currentInfo()?.version, "0.2.0");
  // The next daily check finds the feed gone (server dropped the tree).
  feed = () => new Response("gone", { status: 404 });
  await checker.check();
  assert.deepEqual(checker.status(), { state: "none" });
  assert.equal(checker.currentInfo(), null);
  assert.equal(checker.openDownload(), false); // stale URL must NOT open
  assert.deepEqual(opened, []);
});

test("checker: status stream notifies listeners", async () => {
  const opened: string[] = [];
  const events: string[] = [];
  const checker = checkerWith(() => new Response(DUAL_ARCH_YML), opened);
  const unsubscribe = checker.onStatus((status) => events.push(status.state));
  await checker.check();
  unsubscribe();
  assert.deepEqual(events.slice(0, 2), ["checking", "available"]);
});

test("structural: the checker starts only on the GUI path (never in headless children)", async () => {
  // src/app/index.ts re-execs this binary as headless __service/__run
  // Computer children; the checker must be created AFTER the single-instance
  // lock branch (inside app ready), not at module scope where headless
  // children would evaluate it too. (PR #171 review.)
  const appIndex = await readFile(
    path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "app", "index.ts"),
    "utf8",
  );
  const whenReadyAt = appIndex.indexOf("void app.whenReady().then(async () => {");
  const createAt = appIndex.indexOf("startPrivateUpdateChecker({");
  const lockAt = appIndex.indexOf("requestSingleInstanceLock");
  assert.ok(whenReadyAt > 0 && lockAt > 0, "index.ts must keep its whenReady/lock structure");
  assert.ok(createAt > whenReadyAt, "startPrivateUpdateChecker must live inside the whenReady (GUI) path");
  // And no module-scope creation before the lock check.
  assert.ok(createAt > lockAt, "startPrivateUpdateChecker must come after the single-instance lock branch");
});
