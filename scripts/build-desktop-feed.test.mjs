// Task #12 (phase 3-3): the desktop feed builder. The synthesized
// dual-arch latest-mac.yml must carry VERSION-PREFIXED urls (resolved
// against ${origin}/downloads/desktop/ by the app's private update
// checker) and correct sha512/size entries; the manifest continues the
// same-commit contract with the embedded product versions.
// Run: node --test scripts/build-desktop-feed.test.mjs
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { buildDesktopFeed, isDirectRun, latestMacYml } from "./build-desktop-feed.mjs";

const scriptDir = join(tmpdir(), "build-desktop-feed-");

function writeReleaseArtifacts(dir, version) {
  const payloads = {};
  for (const arch of ["arm64", "x64"]) {
    for (const format of ["dmg", "zip"]) {
      const name = `Raft-Desktop-${version}-${arch}.${format}`;
      // Distinct content per artifact so hashes are distinguishable.
      const payload = `desktop-artifact-${version}-${arch}-${format}\n`;
      writeFileSync(join(dir, name), payload);
      payloads[name] = {
        payload,
        sha512: createHash("sha512").update(payload).digest("base64"),
        sha256: createHash("sha256").update(payload).digest("hex"),
        size: Buffer.byteLength(payload),
      };
    }
  }
  return payloads;
}

test("feed tree: version-prefixed dual-arch yml + same-commit manifest", async (t) => {
  const root = mkdtempSync(scriptDir);
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const releaseDir = join(root, "release");
  mkdirSync(releaseDir, { recursive: true });
  const outDir = join(root, "downloads", "desktop");
  const payloads = writeReleaseArtifacts(releaseDir, "0.2.0");

  const manifest = await buildDesktopFeed({
    releaseDir,
    outDir,
    version: "0.2.0",
    commit: "abc123def456",
    origin: "https://raft.internal.example:18443",
    embedded: { computer: "1.0.29", cli: "0.0.24-zcode.1", daemon: "1.0.26" },
  });

  // All four artifacts copied under the version directory.
  assert.deepEqual(
    manifest.files.map((f) => f.name).sort(),
    ["Raft-Desktop-0.2.0-arm64.dmg", "Raft-Desktop-0.2.0-arm64.zip", "Raft-Desktop-0.2.0-x64.dmg", "Raft-Desktop-0.2.0-x64.zip"],
  );
  for (const file of manifest.files) {
    assert.equal(file.sha256, payloads[file.name].sha256, file.name);
    assert.equal(file.size, payloads[file.name].size, file.name);
  }
  assert.deepEqual(
    JSON.parse(readFileSync(join(outDir, "manifest.json"), "utf8")),
    {
      version: "0.2.0",
      commit: "abc123def456",
      origin: "https://raft.internal.example:18443",
      embedded: { computer: "1.0.29", cli: "0.0.24-zcode.1", daemon: "1.0.26" },
      files: manifest.files,
    },
  );

  // The yml the app's checker consumes: four entries, every url version-
  // prefixed relative to /downloads/desktop/, sha512 + size per file.
  const yml = readFileSync(join(outDir, "latest-mac.yml"), "utf8");
  const parsed = {
    version: /^version: (\S+)$/m.exec(yml)?.[1],
    urls: [...yml.matchAll(/url: (\S+)/g)].map((m) => m[1]),
    sha512s: [...yml.matchAll(/sha512: (\S+)/g)].map((m) => m[1]),
  };
  assert.equal(parsed.version, "0.2.0");
  assert.deepEqual(parsed.urls.sort(), [
    "0.2.0/Raft-Desktop-0.2.0-arm64.dmg",
    "0.2.0/Raft-Desktop-0.2.0-arm64.zip",
    "0.2.0/Raft-Desktop-0.2.0-x64.dmg",
    "0.2.0/Raft-Desktop-0.2.0-x64.zip",
  ]);
  // Every yml sha512 matches the artifact bytes (entries are emitted dmg/zip
  // per arch in the same order as urls).
  const expectedOrder = ["arm64.dmg", "arm64.zip", "x64.dmg", "x64.zip"];
  parsed.sha512s.forEach((sha, index) => {
    const name = `Raft-Desktop-0.2.0-${expectedOrder[index]}`;
    assert.equal(sha, payloads[name].sha512, name);
  });
});

test("latestMacYml shape matches what the app's checker parses (contract pin)", () => {
  const yml = latestMacYml("1.2.3", [
    { url: "1.2.3/a-arm64.dmg", sha512: "AAA=", size: 1 },
    { url: "1.2.3/a-arm64.zip", sha512: "BBB=", size: 2 },
  ]);
  assert.equal(yml,
    "version: 1.2.3\n" +
    "files:\n" +
    "  - url: 1.2.3/a-arm64.dmg\n" +
    "    sha512: AAA=\n" +
    "    size: 1\n" +
    "  - url: 1.2.3/a-arm64.zip\n" +
    "    sha512: BBB=\n" +
    "    size: 2\n");
});

test("isDirectRun matches paths containing spaces and other URL-encoded characters", () => {
  const file = "/tmp/dir with space/#hash/build-desktop-feed.mjs";
  const url = new URL(`file://${encodeURI(file).replace("#", "%23")}`).href;
  assert.equal(isDirectRun(url, file), true);
  assert.equal(isDirectRun(url, "/tmp/other.mjs"), false);
  assert.equal(isDirectRun(url, undefined), false);
});

test("the CLI really runs from a directory whose name contains a space", () => {
  const root = mkdtempSync(join(tmpdir(), "feed cli "));
  try {
    const copy = join(root, "build-desktop-feed.mjs");
    copyFileSync(fileURLToPath(new URL("./build-desktop-feed.mjs", import.meta.url)), copy);
    // No arguments: a running CLI must fail loudly (non-zero), not exit 0 silently.
    const result = spawnSync(process.execPath, [copy], { encoding: "utf8" });
    assert.notEqual(result.status, 0, `stdout=${result.stdout} stderr=${result.stderr}`);
    assert.match(result.stderr, /\[desktop-feed\]/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
