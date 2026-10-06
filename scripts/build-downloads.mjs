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
// Usage:
//   node scripts/build-downloads.mjs --version 1.2.3 --out deploy/docker/downloads \
//     --computer-darwin-arm64 path/to/raft-computer-darwin-arm64 \
//     --computer-darwin-x64  path/...      [--computer-linux-x64 ...] [--computer-linux-arm64 ...] \
//     --cli path/to/raft-1.2.3.tgz
// At least one --computer-* target and --cli are required. Re-running for the
// same version is idempotent (files are copied over, manifests rewritten).

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

const PLATFORM_RE = /^(?:aix|android|darwin|freebsd|haiku|linux|openbsd|sunos|win32)-[A-Za-z0-9_]+$/;

async function sha256(file) {
  const hash = createHash("sha256");
  hash.update(await readFile(file));
  return hash.digest("hex");
}

async function main() {
  const args = parseArgs(process.argv);
  const version = args.version;
  if (!version || !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version)) {
    throw new Error(`--version <semver> is required (got "${version}")`);
  }
  const outDir = args.out;
  if (!outDir) throw new Error("--out <dir> is required");

  const computerEntries = Object.entries(args)
    .filter(([key]) => key.startsWith("computer-"))
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
    const versionDir = path.join(outDir, "computer", version);
    await mkdir(versionDir, { recursive: true });
    await copyFile(file, path.join(versionDir, destName));
    const info = await stat(path.join(versionDir, destName));
    targets[platformKey] = { file: destName, sha256: await sha256(path.join(versionDir, destName)), size: info.size };
  }
  await writeFile(path.join(outDir, "computer", version, "manifest.json"), JSON.stringify({ version, targets }, null, 2) + "\n");
  await writeFile(path.join(outDir, "computer", "manifest.json"), JSON.stringify({ version }, null, 2) + "\n");

  const cliName = `raft-${version}.tgz`;
  const cliDir = path.join(outDir, "cli", version);
  await mkdir(cliDir, { recursive: true });
  await copyFile(cliFile, path.join(cliDir, cliName));
  const cliInfo = await stat(path.join(cliDir, cliName));
  await writeFile(
    path.join(cliDir, "manifest.json"),
    JSON.stringify({ version, targets: { npm: { file: cliName, sha256: await sha256(path.join(cliDir, cliName)), size: cliInfo.size } } }, null, 2) + "\n",
  );
  await writeFile(path.join(outDir, "cli", "manifest.json"), JSON.stringify({ version }, null, 2) + "\n");

  console.log(`[build-downloads] ${version}: computer [${Object.keys(targets).join(", ")}] + cli -> ${outDir}`);
}

main().catch((err) => {
  console.error(`[build-downloads] ${err.message}`);
  process.exit(1);
});
