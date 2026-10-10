#!/usr/bin/env node
// Stage the standalone Computer that ships INSIDE the desktop app (#computer-extract PR 4).
//
//   node scripts/stageBundledComputer.mjs --target darwin-arm64|darwin-x64|linux-x64 [--out <dir>] [--from <dist-native dir>]
//
// Builds the single-file `raft-computer` for the target with the Computer package's own SEA pipeline
// (packages/computer/scripts/native/build.mjs: the same binary the CDN ships), then lays it out as
//   <out>/raft-computer            executable
//   <out>/photon_rs_bg.wasm        sidecar the binary reads from next to itself
//   <out>/version.txt              the Computer's package version (what `raft-computer --version` reports)
// electron-builder copies <out> to <resources>/computer (extraResources); at run time the app copies it to
// ~/.local/bin (src/app/standalone/bundledInstall.ts). `--from` stages an already built dist-native tree.
import { execFileSync } from "node:child_process";
import { chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const TARGETS = ["darwin-arm64", "darwin-x64", "linux-x64"];
const HERE = path.dirname(fileURLToPath(import.meta.url));
const APP_ROOT = path.resolve(HERE, "..");
const COMPUTER_ROOT = path.resolve(APP_ROOT, "..", "..", "packages", "computer");

export function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i += 2) {
    const key = argv[i];
    if (!key?.startsWith("--") || argv[i + 1] === undefined) throw new Error(`bad argument near "${key}"`);
    args[key.slice(2)] = argv[i + 1];
  }
  if (!TARGETS.includes(args.target)) throw new Error(`--target must be one of: ${TARGETS.join(", ")}`);
  return args;
}

export function stagedLayout(outDir) {
  return {
    binary: path.join(outDir, "raft-computer"),
    wasm: path.join(outDir, "photon_rs_bg.wasm"),
    version: path.join(outDir, "version.txt"),
  };
}

export function computerPackageVersion() {
  return JSON.parse(readFileSync(path.join(COMPUTER_ROOT, "package.json"), "utf8")).version;
}

/** Copy a built dist-native tree into the layout above. */
export function stageFrom(builtDir, target, outDir, version) {
  const source = path.join(builtDir, `raft-computer-${target}`);
  const wasm = path.join(builtDir, "photon_rs_bg.wasm");
  for (const file of [source, wasm]) if (!existsSync(file)) throw new Error(`missing build output: ${file}`);
  rmSync(outDir, { recursive: true, force: true });
  mkdirSync(outDir, { recursive: true });
  const layout = stagedLayout(outDir);
  copyFileSync(source, layout.binary);
  chmodSync(layout.binary, 0o755);
  copyFileSync(wasm, layout.wasm);
  writeFileSync(layout.version, `${version}\n`);
  return layout;
}

/** What the packaging verify step checks (also covered by unit tests). Throws with every problem found. */
export function verifyStaged(outDir, expectedVersion) {
  const layout = stagedLayout(outDir);
  const problems = [];
  if (!existsSync(layout.binary)) problems.push(`missing ${layout.binary}`);
  if (!existsSync(layout.wasm)) problems.push(`missing ${layout.wasm}`);
  if (!existsSync(layout.version)) problems.push(`missing ${layout.version}`);
  else if (readFileSync(layout.version, "utf8").trim() !== expectedVersion) problems.push(`version.txt is not ${expectedVersion}`);
  if (problems.length > 0) throw new Error(`bundled Computer is incomplete: ${problems.join("; ")}`);
  return layout;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const [platform, arch] = args.target.split("-");
  const outDir = path.resolve(args.out ?? path.join(APP_ROOT, "build", "computer", args.target));
  const version = computerPackageVersion();
  let builtDir = args.from ? path.resolve(args.from) : null;
  if (!builtDir) {
    builtDir = path.join(COMPUTER_ROOT, "dist-native");
    execFileSync(process.execPath, [path.join(COMPUTER_ROOT, "scripts", "native", "build.mjs"), "--platform", platform, "--arch", arch, "--out-dir", builtDir], { stdio: "inherit" });
  }
  stageFrom(builtDir, args.target, outDir, version);
  verifyStaged(outDir, version);
  console.log(`[stage-computer] ${args.target} v${version} -> ${outDir}`);
  // When the host can run it, prove the staged binary reports the version it claims.
  if (process.platform === platform && process.arch === (arch === "x64" ? "x64" : arch)) {
    const reported = execFileSync(stagedLayout(outDir).binary, ["--version"], { encoding: "utf8" }).trim();
    if (!reported.includes(version)) throw new Error(`staged binary reports "${reported}", expected ${version}`);
    console.log(`[stage-computer] --version -> ${reported}`);
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    main();
  } catch (error) {
    console.error(`[stage-computer] FAILED: ${error.message}`);
    process.exit(1);
  }
}
