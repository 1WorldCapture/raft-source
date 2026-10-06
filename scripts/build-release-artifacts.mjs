#!/usr/bin/env node
// Build ALL self-hosted client artifacts from the CURRENT checkout and feed
// them to build-downloads (task #4, phase 2 — PR-B pipeline).
//
// "Same-commit" is the contract: every artifact (Computer SEA per platform,
// CLI tarball, daemon version stamp) comes from this one checkout, matching
// the server image built from the same SHA. The script refuses to run over
// a dirty tree so nobody ships artifacts mixing uncommitted changes.
//
// Usage (repo root, network available — the SEA step downloads the target
// platform's official node binary):
//   node scripts/build-release-artifacts.mjs --out deploy/docker/downloads \
//     [--platforms darwin-arm64,darwin-x64,linux-x64] [--force]
//
// Each (platform, arch) runs packages/computer/scripts/native/build.mjs;
// the CLI is bundled and packed; the daemon version is read from
// packages/daemon/package.json. Everything is then handed to
// scripts/build-downloads.mjs, which writes the manifest tree.

import { execFileSync } from "node:child_process";
import { readFile, rename, rm } from "node:fs/promises";
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

function run(cmd, args, opts = {}) {
  console.log(`[release] ${cmd} ${args.join(" ")}`);
  execFileSync(cmd, args, { stdio: "inherit", ...opts });
}

const DEFAULT_PLATFORMS = ["darwin-arm64", "darwin-x64", "linux-x64"];

async function main() {
  const args = parseArgs(process.argv);
  const outDir = args.out;
  if (!outDir) throw new Error("--out <dir> is required (e.g. deploy/docker/downloads)");
  const platforms = (args.platforms ?? DEFAULT_PLATFORMS.join(",")).split(",").map((p) => p.trim()).filter(Boolean);
  const repoRoot = path.resolve(import.meta.dirname, "..");

  if (!args.force) {
    const status = execFileSync("git", ["status", "--porcelain"], { cwd: repoRoot, encoding: "utf8" });
    if (status.trim()) {
      throw new Error(
        "Working tree is dirty. The same-commit contract requires a clean checkout " +
          "(commit or stash first, or pass --force if you really mean it).",
      );
    }
  }
  const sha = execFileSync("git", ["rev-parse", "HEAD"], { cwd: repoRoot, encoding: "utf8" }).trim();
  console.log(`[release] building artifacts for ${sha}`);

  run("pnpm", ["--filter", "@botiverse/raft-computer", "build:deps"], { cwd: repoRoot });
  const seaDir = path.join(repoRoot, "packages/computer/dist-native");
  await rm(seaDir, { recursive: true, force: true });
  const seaFiles = [];
  for (const platform of platforms) {
    const [os, arch] = platform.split("-");
    run("node", ["scripts/native/build.mjs", "--platform", os, "--arch", arch], {
      cwd: path.join(repoRoot, "packages/computer"),
    });
    seaFiles.push([platform, path.join(seaDir, `raft-computer-${platform}`)]);
  }

  run("pnpm", ["--filter", "@botiverse/raft", "build"], { cwd: repoRoot });
  const packDir = path.join(repoRoot, "packages/cli");
  run("npm", ["pack", "--pack-destination", seaDir], { cwd: packDir, shell: process.platform === "win32" });
  const cliPackage = JSON.parse(await readFile(path.join(repoRoot, "packages/cli/package.json"), "utf8"));
  const cliVersion = cliPackage.version;
  const packedName = `${cliPackage.name.replace(/^@/, "").replace("/", "-")}-${cliVersion}.tgz`;
  const cliDest = path.join(seaDir, `raft-${cliVersion}.tgz`);
  await rename(path.join(seaDir, packedName), cliDest);

  const daemonPackage = JSON.parse(await readFile(path.join(repoRoot, "packages/daemon/package.json"), "utf8"));

  const buildDownloadsArgs = [
    path.join(repoRoot, "scripts/build-downloads.mjs"),
    "--version", cliVersion,
    "--daemon-version", daemonPackage.version,
    "--out", outDir,
    "--cli", cliDest,
    ...seaFiles.flatMap(([platform, file]) => [`--computer-${platform}`, file]),
  ];
  run("node", buildDownloadsArgs, { cwd: repoRoot });
  console.log(`[release] done: ${outDir} (computer ${cliVersion} / daemon ${daemonPackage.version}, ${platforms.length} platforms, sha ${sha.slice(0, 8)})`);
}

main().catch((err) => {
  console.error(`[release] ${err.message}`);
  process.exit(1);
});
