#!/usr/bin/env node
// Build the private deployment's desktop feed from electron-builder output
// (task #12, phase 3-3).
//
// electron-builder writes ONE latest-mac.yml per architecture pass (the
// second arch overwrites the first), so the dual-arch feed must be
// synthesized: this script collects the four artifacts (dmg+zip ×
// arm64+x64), hashes them, and writes the tree the private updater consumes
// (apps/raft-desktop-electron/src/main/privateUpdateChecker.ts) and a
// future signed build's electron-updater would consume — same generic-
// provider format, urls prefixed with the version segment:
//
//   <out>/<v>/Raft-Desktop-<v>-{arm64,x64}.dmg|.zip
//   <out>/latest-mac.yml      files: 4 entries (url: <v>/<name>, sha512, size)
//   <out>/manifest.json       { version, commit, embedded, files:[{name,sha256,size}] }
//
// The manifest continues the same-commit contract: `commit` is the checkout
// the artifacts were built from, `embedded` records the workspace package
// versions baked into the app (single source: packages/computer/scripts/
// embeddedVersionDefines.mjs — the same values tsup defines into the main
// bundle).
//
// Usage (normally invoked by build-release-artifacts.mjs, macOS only):
//   node scripts/build-desktop-feed.mjs --release-dir <dir> --version <v> \
//     --commit <sha> --embedded-computer <v> --embedded-cli <v> \
//     --embedded-daemon <v> --out <downloads>/desktop

import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { copyFile, mkdir, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { pipeline } from "node:stream/promises";

const ARCHES = ["arm64", "x64"];
const FORMATS = ["dmg", "zip"];

function parseArgs(argv) {
  const args = {};
  for (let i = 2; i < argv.length; i += 2) {
    const key = argv[i];
    if (!key?.startsWith("--")) throw new Error(`Unexpected argument "${key}"`);
    args[key.slice(2)] = argv[i + 1];
  }
  return args;
}

/** Streamed hash — the artifacts are ~200MB each; never buffer one in memory. */
async function hashFile(file, algorithm, encoding) {
  const hash = createHash(algorithm);
  await pipeline(createReadStream(file), hash);
  return hash.digest(encoding);
}

async function sha512Base64(file) {
  return hashFile(file, "sha512", "base64");
}

async function sha256Hex(file) {
  return hashFile(file, "sha256", "hex");
}

export function latestMacYml(version, files) {
  const lines = [`version: ${version}`];
  if (files.length > 0) {
    lines.push("files:");
    for (const file of files) {
      lines.push(`  - url: ${file.url}`);
      lines.push(`    sha512: ${file.sha512}`);
      lines.push(`    size: ${file.size}`);
    }
  }
  return `${lines.join("\n")}\n`;
}

export function desktopManifest(version, commit, origin, embedded, files) {
  return {
    version,
    commit,
    // The origin baked into this build (VITE_API_URL): must equal the
    // SERVER_URL of the deployment serving this tree — an app installed from
    // here talks to that server from first launch.
    origin,
    embedded,
    files: files.map((file) => ({ name: file.name, sha256: file.sha256, size: file.size })),
  };
}

export async function buildDesktopFeed(deps) {
  const { releaseDir, outDir, version, commit, origin, embedded } = deps;
  const versionDir = path.join(outDir, version);
  await mkdir(versionDir, { recursive: true });

  const ymlFiles = [];
  const manifestFiles = [];
  for (const arch of ARCHES) {
    for (const format of FORMATS) {
      const name = `Raft-Desktop-${version}-${arch}.${format}`;
      const source = path.join(releaseDir, name);
      const size = (await stat(source)).size;
      await copyFile(source, path.join(versionDir, name));
      ymlFiles.push({
        // Version-prefixed relative url: resolved against
        // ${origin}/downloads/desktop/ by the checker (and electron-updater).
        url: `${version}/${name}`,
        sha512: await sha512Base64(source),
        size,
      });
      manifestFiles.push({ name, sha256: await sha256Hex(source), size });
    }
  }

  await writeFile(path.join(outDir, "latest-mac.yml"), latestMacYml(version, ymlFiles), "utf8");
  const manifest = desktopManifest(version, commit, origin, embedded, manifestFiles);
  await writeFile(path.join(outDir, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  return manifest;
}

async function main() {
  const args = parseArgs(process.argv);
  for (const required of ["release-dir", "version", "commit", "origin", "embedded-computer", "embedded-cli", "embedded-daemon", "out"]) {
    if (!args[required]) throw new Error(`--${required} is required`);
  }
  const manifest = await buildDesktopFeed({
    releaseDir: path.resolve(args["release-dir"]),
    outDir: path.resolve(args.out),
    version: args.version,
    commit: args.commit,
    origin: args.origin,
    embedded: { computer: args["embedded-computer"], cli: args["embedded-cli"], daemon: args["embedded-daemon"] },
  });
  console.log(`[desktop-feed] wrote ${args.out}: version ${manifest.version}, ${manifest.files.length} files, commit ${manifest.commit.slice(0, 8)}`);
}

// CLI entry only when run directly; tests import the helpers.
if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname)) {
  main().catch((err) => {
    console.error(`[desktop-feed] ${err.message}`);
    process.exit(1);
  });
}
