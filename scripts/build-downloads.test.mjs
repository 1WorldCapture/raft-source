// Task #4 (phase 2, PR-B round-1 fix): the download tree stamps the two
// products' INDEPENDENT versions — @botiverse/raft-computer for the SEA
// tree, @botiverse/raft for the CLI tree. The bug this guards against:
// one --version for both trees let the CLI's prerelease number land on the
// Computer manifest, which would poison isComputerOutdated and the task #5
// upgrade backend. Run: node --test scripts/build-downloads.test.mjs
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { promisify } from "node:util";

const run = promisify(execFile);
const script = join(dirname(fileURLToPath(import.meta.url)), "build-downloads.mjs");

const SEA_PAYLOAD = "sea-payload";
const TGZ_PAYLOAD = "tgz-payload";

async function buildDownloads(outDir, extraArgs) {
  const { stdout } = await run(process.execPath, [script, "--out", outDir, ...extraArgs]);
  return stdout;
}

function readJson(file) {
  return JSON.parse(readFileSync(file, "utf8"));
}

test("divergent computer/cli versions stamp their own trees and manifests", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "build-downloads-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const sea = join(root, "raft-computer-darwin-arm64");
  writeFileSync(sea, SEA_PAYLOAD);
  const tgz = join(root, "cli-packed.tgz");
  writeFileSync(tgz, TGZ_PAYLOAD);
  const outDir = join(root, "out");

  const stdout = await buildDownloads(outDir, [
    "--computer-version", "1.0.28",
    "--cli-version", "0.0.24-zcode.1",
    "--daemon-version", "1.0.25",
    "--commit", "0123456789abcdef",
    "--computer-darwin-arm64", sea,
    "--cli", tgz,
  ]);
  assert.match(stdout, /computer 1\.0\.28/);
  assert.match(stdout, /cli 0\.0\.24-zcode\.1/);

  // Latest pointers carry their own product version + the commit stamp.
  const computerLatest = readJson(join(outDir, "computer", "manifest.json"));
  assert.equal(computerLatest.version, "1.0.28");
  assert.equal(computerLatest.daemonVersion, "1.0.25");
  assert.equal(computerLatest.commit, "0123456789abcdef");
  const cliLatest = readJson(join(outDir, "cli", "manifest.json"));
  assert.equal(cliLatest.version, "0.0.24-zcode.1");
  assert.equal(cliLatest.commit, "0123456789abcdef");

  // Versioned trees live under their OWN version with byte-exact targets.
  const compDir = join(outDir, "computer", "1.0.28");
  const compManifest = readJson(join(compDir, "manifest.json"));
  assert.equal(compManifest.version, "1.0.28");
  assert.equal(compManifest.commit, "0123456789abcdef");
  assert.deepEqual(compManifest.targets["darwin-arm64"], {
    file: "raft-computer-darwin-arm64",
    sha256: createHash("sha256").update(SEA_PAYLOAD).digest("hex"),
    size: Buffer.byteLength(SEA_PAYLOAD),
  });
  assert.equal(readFileSync(join(compDir, "raft-computer-darwin-arm64"), "utf8"), SEA_PAYLOAD);

  const cliDir = join(outDir, "cli", "0.0.24-zcode.1");
  const cliManifest = readJson(join(cliDir, "manifest.json"));
  assert.equal(cliManifest.version, "0.0.24-zcode.1");
  assert.equal(cliManifest.targets.npm.file, "raft-0.0.24-zcode.1.tgz");
  assert.equal(readFileSync(join(cliDir, "raft-0.0.24-zcode.1.tgz"), "utf8"), TGZ_PAYLOAD);

  // No cross-contamination: neither tree appears under the other's version.
  assert.ok(!existsSync(join(outDir, "computer", "0.0.24-zcode.1")));
  assert.ok(!existsSync(join(outDir, "cli", "1.0.28")));

  // Installer scripts ship at the computer-tree root (same commit as the
  // binaries) so `${origin}/downloads/computer/install.sh` resolves.
  for (const installer of ["install.sh", "install.ps1"]) {
    assert.ok(existsSync(join(outDir, "computer", installer)), `${installer} must land in the tree`);
  }
});

test("--version shorthand stamps both trees when the products match", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "build-downloads-shorthand-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const sea = join(root, "raft-computer-linux-x64");
  writeFileSync(sea, SEA_PAYLOAD);
  const tgz = join(root, "cli.tgz");
  writeFileSync(tgz, TGZ_PAYLOAD);
  const outDir = join(root, "out");

  await buildDownloads(outDir, ["--version", "2.0.0", "--computer-linux-x64", sea, "--cli", tgz]);
  assert.equal(readJson(join(outDir, "computer", "manifest.json")).version, "2.0.0");
  assert.equal(readJson(join(outDir, "cli", "manifest.json")).version, "2.0.0");
  assert.ok(existsSync(join(outDir, "computer", "2.0.0", "raft-computer-linux-x64")));
  assert.ok(existsSync(join(outDir, "cli", "2.0.0", "raft-2.0.0.tgz")));
});

test("refuses to run without product versions or with a bad commit", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "build-downloads-refuse-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const sea = join(root, "raft-computer-darwin-arm64");
  writeFileSync(sea, SEA_PAYLOAD);
  const tgz = join(root, "cli.tgz");
  writeFileSync(tgz, TGZ_PAYLOAD);

  await assert.rejects(
    buildDownloads(join(root, "out1"), ["--computer-darwin-arm64", sea, "--cli", tgz]),
    /--computer-version <semver> is required/,
  );
  await assert.rejects(
    buildDownloads(join(root, "out2"), ["--computer-version", "1.0.28", "--cli", tgz]),
    /--cli-version <semver> is required/,
  );
  await assert.rejects(
    buildDownloads(join(root, "out3"), [
      "--computer-version", "1.0.28", "--cli-version", "1.0.28",
      "--commit", "not-a-sha",
      "--computer-darwin-arm64", sea, "--cli", tgz,
    ]),
    /--commit must be a git sha/,
  );
});
