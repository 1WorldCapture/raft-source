#!/usr/bin/env node
// Pack a SELF-HOST tarball variant (acceptance D3): the dist bundle is
// self-contained, so the variant package.json carries NO dependencies —
// `npm i -g <tgz>` then succeeds with zero registry access. The source
// package.json is never modified (official publish path stays identical).
//
// Usage:
//   node scripts/pack-selfhost-tarball.mjs --package-dir packages/cli \
//     --dist-dir dist --out packages/computer/dist-native --name raft
//   node scripts/pack-selfhost-tarball.mjs --package-dir packages/daemon \
//     --dist-dir dist-selfhost --out ... --name raft-daemon
import { execFileSync } from "node:child_process";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
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

const repoRoot = path.resolve(import.meta.dirname, "..");

async function main() {
  const args = parseArgs(process.argv);
  const packageDir = path.resolve(repoRoot, args["package-dir"] ?? "");
  const distDirName = args["dist-dir"];
  const outDir = args.out;
  const outName = args.name;
  if (!packageDir || !distDirName || !outDir || !outName) {
    throw new Error("--package-dir, --dist-dir, --out and --name are required");
  }

  const pkg = JSON.parse(await readFile(path.join(packageDir, "package.json"), "utf8"));
  const version = pkg.version;
  // The self-host variant: identical identity, no dependency declarations —
  // the bundle under dist/ already contains everything.
  const variant = { ...pkg };
  delete variant.dependencies;
  delete variant.devDependencies;
  delete variant.peerDependencies;
  delete variant.optionalDependencies;
  delete variant.scripts;

  const staging = await mkdtemp(path.join(tmpdir(), "selfhost-pack-"));
  try {
    await writeFile(path.join(staging, "package.json"), `${JSON.stringify(variant, null, 2)}\n`);
    await cp(path.join(packageDir, distDirName), path.join(staging, "dist"), { recursive: true });
    const packed = `${pkg.name.replace(/^@/, "").replace("/", "-")}-${version}.tgz`;
    execFileSync("npm", ["pack", "--pack-destination", staging], { cwd: staging, stdio: "pipe" });
    await mkdir(path.resolve(repoRoot, outDir), { recursive: true });
    const dest = path.resolve(repoRoot, outDir, `${outName}-${version}.tgz`);
    await rm(dest, { force: true });
    await cp(path.join(staging, packed), dest);
    console.log(`[selfhost-pack] ${outName}-${version}.tgz (no dependencies) -> ${outDir}`);
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
}

main().catch((err) => {
  console.error(`[selfhost-pack] ${err.message}`);
  process.exit(1);
});
