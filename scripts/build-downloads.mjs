#!/usr/bin/env node
// Build the self-hosted /downloads release tree (task #4, phase 2).
//
// Input: artifacts built FROM THE SAME COMMIT as the server image (see the
// PR-B pipeline note in deploy/docker/README.md) — Computer SEA binaries per
// platform (`packages/computer/scripts/native/build.mjs` output) and the CLI
// tarball. Output: the directory layout the server route and the self-host
// nginx alias serve, byte-compatible with the legacy-cdn manifest format the
// Computer already reads (`manifest.json` latest pointer + per-version
// `targets[platformKey] = {file, sha256, size}`; platform keys are
// `<node-platform>-<arch>`, e.g. darwin-arm64 — kReleaseSource.ts:77).
//
// The two products version INDEPENDENTLY (@botiverse/raft-computer vs
// @botiverse/raft): the Computer SEA and the CLI tarball each get their own
// --computer-version / --cli-version trees. --version <v> is the shorthand
// for the rare case both ship the same version. A wrong pairing (e.g. the
// CLI's prerelease number stamped on the Computer tree) would make the
// server's isComputerOutdated and the task #5 upgrade backend compare
// against a garbage "latest" — the exact bug PM's round-1 review caught.
//
// Usage:
//   node scripts/build-downloads.mjs --computer-version 1.0.28 \
//     --cli-version 0.0.24 --out deploy/docker/downloads \
//     --computer-darwin-arm64 path/to/raft-computer-darwin-arm64 \
//     --computer-darwin-x64  path/...      [--computer-linux-x64 ...] [--computer-linux-arm64 ...] \
//     --cli path/to/raft-<cli-version>.tgz [--commit <sha>] [--daemon-version <v>]
// At least one --computer-* target and --cli are required. --commit stamps
// the source sha into every manifest so "same commit" is verifiable on the
// artifacts themselves. Re-running for the same version is idempotent
// (files are copied over, manifests rewritten).

import { createHash } from "node:crypto";
import { copyFile, mkdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";

function parseArgs(argv) {
  const args = {};
  for (let i = 2; i < argv.length; i += 2) {
    const key = argv[i];
    if (!key?.startsWith("--")) throw new Error(`Unexpected argument "${key}"`);
    args[key.slice(2)] = argv[i + 1];
  }
  return args;
}

const SEMVER_RE = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;
const PLATFORM_RE = /^(?:aix|android|darwin|freebsd|haiku|linux|openbsd|sunos|win32)-[A-Za-z0-9_]+$/;
const COMMIT_RE = /^[0-9a-f]{7,40}$/;

async function sha256(file) {
  const hash = createHash("sha256");
  hash.update(await readFile(file));
  return hash.digest("hex");
}

async function main() {
  const args = parseArgs(process.argv);
  // --version remains valid as the both-products shorthand.
  const computerVersion = args["computer-version"] ?? args.version;
  const cliVersion = args["cli-version"] ?? args.version;
  if (!computerVersion || !SEMVER_RE.test(computerVersion)) {
    throw new Error(`--computer-version <semver> is required (got "${computerVersion}")`);
  }
  if (!cliVersion || !SEMVER_RE.test(cliVersion)) {
    throw new Error(`--cli-version <semver> is required (got "${cliVersion}")`);
  }
  const outDir = args.out;
  if (!outDir) throw new Error("--out <dir> is required");
  const commit = args.commit;
  if (commit !== undefined && !COMMIT_RE.test(commit)) {
    throw new Error(`--commit must be a git sha (7-40 hex chars, got "${commit}")`);
  }

  const computerEntries = Object.entries(args)
    .filter(([key]) => key.startsWith("computer-") && key !== "computer-version")
    .map(([key, file]) => {
      const platformKey = key.slice("computer-".length);
      if (!PLATFORM_RE.test(platformKey)) throw new Error(`Invalid platform key "${platformKey}" (expected <node-platform>-<arch>)`);
      return { platformKey, file };
    });
  if (computerEntries.length === 0) throw new Error("At least one --computer-<platform> <file> is required");
  const cliFile = args.cli;
  if (!cliFile) throw new Error("--cli <tarball> is required");

  const targets = {};
  for (const { platformKey, file } of computerEntries) {
    const destName = `raft-computer-${platformKey}${platformKey.startsWith("win32") ? ".exe" : ""}`;
    const versionDir = path.join(outDir, "computer", computerVersion);
    await mkdir(versionDir, { recursive: true });
    await copyFile(file, path.join(versionDir, destName));
    const info = await stat(path.join(versionDir, destName));
    targets[platformKey] = { file: destName, sha256: await sha256(path.join(versionDir, destName)), size: info.size };
  }
  await writeFile(
    path.join(outDir, "computer", computerVersion, "manifest.json"),
    JSON.stringify({ version: computerVersion, ...(commit ? { commit } : {}), targets }, null, 2) + "\n",
  );
  // The daemon ships INSIDE the Computer SEA; the latest pointer carries the
  // same-commit daemon version so daemonVersionService reads it in private
  // mode (the daemon and CLI packages version independently).
  const daemonVersion = args["daemon-version"];
  await writeFile(
    path.join(outDir, "computer", "manifest.json"),
    JSON.stringify({ version: computerVersion, ...(daemonVersion ? { daemonVersion } : {}), ...(commit ? { commit } : {}) }, null, 2) + "\n",
  );

  const cliName = `raft-${cliVersion}.tgz`;
  const cliDir = path.join(outDir, "cli", cliVersion);
  await mkdir(cliDir, { recursive: true });
  await copyFile(cliFile, path.join(cliDir, cliName));
  const cliInfo = await stat(path.join(cliDir, cliName));
  await writeFile(
    path.join(cliDir, "manifest.json"),
    JSON.stringify({ version: cliVersion, ...(commit ? { commit } : {}), targets: { npm: { file: cliName, sha256: await sha256(path.join(cliDir, cliName)), size: cliInfo.size } } }, null, 2) + "\n",
  );
  await writeFile(
    path.join(outDir, "cli", "manifest.json"),
    JSON.stringify({ version: cliVersion, ...(commit ? { commit } : {}) }, null, 2) + "\n",
  );

  console.log(`[build-downloads] computer ${computerVersion} [${Object.keys(targets).join(", ")}] + cli ${cliVersion} -> ${outDir}${commit ? ` (commit ${commit.slice(0, 8)})` : ""}`);
}

main().catch((err) => {
  console.error(`[build-downloads] ${err.message}`);
  process.exit(1);
});
