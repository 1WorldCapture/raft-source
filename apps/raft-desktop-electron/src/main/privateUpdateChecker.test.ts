// Private-deployment update checker (phase 3-2): feed parsing, URL safety
// (same-origin enforcement — a tampered feed must never steer the user to an
// external site), version gating, and the detect-only lifecycle.
import assert from "node:assert/strict";
import test from "node:test";

import {
  isNewerVersion,
  parseLatestMacYml,
  resolvePrivateDownloadUrl,
  startPrivateUpdateChecker,
} from "./privateUpdateChecker.ts";

const ORIGIN = "https://raft.internal.example:8443";

function yml(fields: { version?: string; path?: string; url?: string; size?: number } = {}): string {
  const lines: string[] = [];
  if (fields.version !== undefined) lines.push(`version: ${fields.version}`);
  if (fields.path !== undefined) lines.push(`path: ${fields.path}`);
  if (fields.url !== undefined) {
    lines.push("files:");
    lines.push(`  - url: ${fields.url}`);
    if (fields.size !== undefined) lines.push(`    size: ${fields.size}`);
  }
  return `${lines.join("\n")}\n`;
}

test("parseLatestMacYml reads version, first files url and size", () => {
  assert.deepEqual(
    parseLatestMacYml(yml({ version: "0.2.0", url: "Raft-Desktop-0.2.0-arm64.dmg", size: 123 })),
    { version: "0.2.0", fileUrl: "Raft-Desktop-0.2.0-arm64.dmg", size: 123 },
  );
  // electron-builder emits more fields than we consume — extras are ignored.
  const rich = [
    "version: 0.2.0",
    "releaseDate: '2026-10-06T00:00:00.000Z'",
    "githubArtifactName: irrelevant",
    "path: Raft-Desktop-0.2.0-arm64-mac.zip",
    "sha512: AAAA",
    "files:",
    "  - url: Raft-Desktop-0.2.0-arm64-mac.zip",
    "    sha512: AAAA",
    "    size: 999",
  ].join("\n");
  assert.deepEqual(parseLatestMacYml(rich), { version: "0.2.0", fileUrl: "Raft-Desktop-0.2.0-arm64-mac.zip", size: 999 });
});

test("parseLatestMacYml rejects missing fields and non-strict versions", () => {
  assert.equal(parseLatestMacYml(yml({ url: "x.dmg" })), null); // no version
  assert.equal(parseLatestMacYml(yml({ version: "0.2.0" })), null); // no url/path
  assert.equal(parseLatestMacYml(yml({ version: "0.2.0-beta.1", url: "x.dmg" })), null); // prerelease is not strict
  assert.equal(parseLatestMacYml(yml({ version: "latest", url: "x.dmg" })), null);
  assert.equal(parseLatestMacYml(""), null);
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

function checkerWith(feed: () => Response | Error, opened: string[], currentVersion = "0.1.8") {
  return startPrivateUpdateChecker({
    origin: ORIGIN,
    appVersion: currentVersion,
    openExternal: (url) => { opened.push(url); },
    fetchImpl: (async () => {
      const outcome = feed();
      if (outcome instanceof Error) throw outcome;
      return outcome;
    }) as typeof fetch,
    initialDelayMs: 60_000, // no stray near-term timer in tests
    intervalMs: 60_000,
  });
}

test("checker: newer version on the server becomes available and opens the validated URL", async () => {
  const opened: string[] = [];
  const checker = checkerWith(() => new Response(yml({ version: "0.2.0", url: "Raft-Desktop-0.2.0-arm64.dmg" })), opened);
  await checker.check();
  assert.deepEqual(checker.status(), { state: "available", version: "0.2.0" });
  assert.equal(checker.openDownload(), true);
  assert.deepEqual(opened, [`${ORIGIN}/downloads/desktop/Raft-Desktop-0.2.0-arm64.dmg`]);
});

test("checker: same/older version, 404, malformed feed, and network failure all stay quiet", async () => {
  const opened: string[] = [];
  for (const feed of [
    () => new Response(yml({ version: "0.1.8", url: "x.dmg" })), // same version
    () => new Response(yml({ version: "0.1.7", url: "x.dmg" })), // older
    () => new Response("not found", { status: 404 }), // no desktop artifacts yet
    () => new Response(yml({ version: "0.3.0", url: "https://evil.example/x.dmg" })), // tampered feed
    () => new Response(yml({ version: "0.3.0-rc.1", url: "x.dmg" })), // non-strict version
    () => new Error("ENETDOWN"),
  ]) {
    const checker = checkerWith(feed, opened);
    await checker.check();
    assert.deepEqual(checker.status(), { state: "none" });
    assert.equal(checker.openDownload(), false);
  }
  assert.deepEqual(opened, []);
});

test("checker: status stream notifies listeners", async () => {
  const opened: string[] = [];
  const events: string[] = [];
  const checker = checkerWith(() => new Response(yml({ version: "0.2.0", url: "x.dmg" })), opened);
  const unsubscribe = checker.onStatus((status) => events.push(status.state));
  await checker.check();
  unsubscribe();
  assert.deepEqual(events.slice(0, 2), ["checking", "available"]);
});
