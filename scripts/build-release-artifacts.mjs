#!/usr/bin/env node
// Build ALL self-hosted client artifacts from the CURRENT checkout and feed
// them to build-downloads (task #4, phase 2 — PR-B pipeline).
//
// "Same-commit" is the contract: every artifact (Computer SEA per platform,
// CLI tarball, daemon version stamp) comes from this one checkout, matching
// the server image built from the same SHA. The script refuses to run over
// a dirty tree so nobody ships artifacts mixing uncommitted changes, and
// stamps the sha into every manifest (--commit) so the contract is
// verifiable on the served artifacts themselves.
//
// Usage (repo root; the BUILD host needs network — the SEA step downloads
// the target platform's official node binary. The DEPLOYMENT does not:
// everything below is served offline from ./downloads):
//   node scripts/build-release-artifacts.mjs --out deploy/docker/downloads \
//     [--platforms darwin-arm64,darwin-x64,linux-x64] [--force]
//
// Each (platform, arch) runs packages/computer/scripts/native/build.mjs;
// the CLI and daemon packages are bundled and packed. Product versions are
// read from their OWN package.json — @botiverse/raft-computer for the SEA
// tree, @botiverse/raft for the CLI tree, @botiverse/raft-daemon for the
// daemon tree and stamp — the three version independently and must never
// be conflated. Everything is then handed to scripts/build-downloads.mjs,
// which writes the manifest tree.

import { execFileSync } from "node:child_process";
import { readFile, rm } from "node:fs/promises";
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

  // CLI tarball (self-host variant, acceptance D3): the tsup bundle is
  // self-contained, so the variant package.json drops dependency
  // declarations — offline `npm i -g <tgz>` succeeds with zero registry.
  run("pnpm", ["--filter", "@botiverse/raft", "build"], { cwd: repoRoot });
  const cliPackage = JSON.parse(await readFile(path.join(repoRoot, "packages/cli/package.json"), "utf8"));
  const cliVersion = cliPackage.version;
  run("node", [
    path.join(repoRoot, "scripts/pack-selfhost-tarball.mjs"),
    "--package-dir", "packages/cli", "--dist-dir", "dist",
    "--out", "packages/computer/dist-native", "--name", "raft",
  ], { cwd: repoRoot });
  const cliDest = path.join(seaDir, `raft-${cliVersion}.tgz`);

  // Independent product versions: the SEA tree carries the Computer package
  // version, the CLI tree the CLI package version, the daemon tree/pointer
  // the daemon package version. Never pass one package's version for another.
  const computerPackage = JSON.parse(await readFile(path.join(repoRoot, "packages/computer/package.json"), "utf8"));
  const daemonPackage = JSON.parse(await readFile(path.join(repoRoot, "packages/daemon/package.json"), "utf8"));

  // Daemon tarball (acceptance D3): SELF-HOST build target only —
  // noExternal bundle (every runtime dependency inlined) emitted to
  // dist-selfhost, plus the CLI dist the runner transport injects, plus
  // bin wrappers; packed as a dependency-free variant. The official daemon
  // `build` and its npm publish path stay byte-identical.
  const daemonSelfhostDir = path.join(repoRoot, "packages/daemon", "dist-selfhost");
  await rm(daemonSelfhostDir, { recursive: true, force: true });
  run("pnpm", ["--filter", "@botiverse/raft-daemon", "exec", "tsup", "--config", "tsup.selfhost.config.ts"], { cwd: repoRoot });
  const { cp } = await import("node:fs/promises");
  await cp(path.join(repoRoot, "packages/cli/dist"), path.join(daemonSelfhostDir, "cli"), { recursive: true });
  run("node", ["scripts/write-dist-bins.mjs", "--dist", "dist-selfhost"], {
    cwd: path.join(repoRoot, "packages/daemon"),
  });
  run("node", [
    path.join(repoRoot, "scripts/pack-selfhost-tarball.mjs"),
    "--package-dir", "packages/daemon", "--dist-dir", "dist-selfhost",
    "--out", "packages/computer/dist-native", "--name", "raft-daemon",
  ], { cwd: repoRoot });
  const daemonDest = path.join(seaDir, `raft-daemon-${daemonPackage.version}.tgz`);

  const buildDownloadsArgs = [
    path.join(repoRoot, "scripts/build-downloads.mjs"),
    "--computer-version", computerPackage.version,
    "--cli-version", cliVersion,
    "--daemon-version", daemonPackage.version,
    "--daemon", daemonDest,
    "--commit", sha,
    "--out", outDir,
    "--cli", cliDest,
    "--computer-wasm", path.join(seaDir, "photon_rs_bg.wasm"),
    ...seaFiles.flatMap(([platform, file]) => [`--computer-${platform}`, file]),
  ];
  run("node", buildDownloadsArgs, { cwd: repoRoot });
  // Acceptance D3 verification baked into the pipeline: the tarballs must
  // install with ZERO registry access and the daemon must complete a real
  // connection handshake from the installed bundle.
  run("node", [
    path.join(repoRoot, "scripts/verify-selfhost-tarball.mjs"),
    "--cli", cliDest,
    "--daemon", daemonDest,
  ], { cwd: repoRoot });
  console.log(`[release] done: ${outDir} (computer ${computerPackage.version} / cli ${cliVersion} / daemon ${daemonPackage.version}, ${platforms.length} platforms, sha ${sha.slice(0, 8)})`);
}

main().catch((err) => {
  console.error(`[release] ${err.message}`);
  process.exit(1);
});
