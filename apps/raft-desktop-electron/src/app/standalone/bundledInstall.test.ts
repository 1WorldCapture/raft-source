import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { compareVersions, installBundledComputer, parseVersion } from "./bundledInstall.ts";

async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), "bundled-install-"));
  const resources = path.join(root, "resources");
  const cursor = path.join(resources, "cursor-sdk");
  await mkdir(path.join(cursor, "host"), { recursive: true });
  await writeFile(path.join(cursor, "manifest.json"), JSON.stringify({ sdkVersion: "1.0.36" }));
  await writeFile(path.join(cursor, "host", "runtimeHost.mjs"), "// host");
  await mkdir(path.join(resources, "computer"), { recursive: true });
  await writeFile(path.join(resources, "computer", "raft-computer"), "#!/bin/sh\necho new\n");
  await writeFile(path.join(resources, "computer", "photon_rs_bg.wasm"), "wasm-bytes");
  return {
    root,
    bundled: { binaryPath: path.join(resources, "computer", "raft-computer"), photonWasmPath: path.join(resources, "computer", "photon_rs_bg.wasm"), binaryVersion: "1.0.30", cursorRoot: cursor },
    binaryTarget: path.join(root, "home", ".local", "bin", "raft-computer"),
    home: path.join(root, "home", ".slock"),
  };
}

test("version comparison: numeric, pre-release below release, unparsable is older", () => {
  assert.ok(compareVersions("1.0.30", "1.0.29") > 0);
  assert.ok(compareVersions("1.0.9", "1.0.10") < 0, "numeric, not lexical");
  assert.equal(compareVersions("1.0.29", "1.0.29"), 0);
  assert.ok(compareVersions("0.0.24", "0.0.24-zcode.1") > 0);
  assert.ok(compareVersions("1.0.0", null) > 0);
  assert.ok(compareVersions("garbage", "1.0.0") < 0);
  assert.equal(parseVersion("v2.1.3")?.core.join("."), "2.1.3");
  assert.equal(parseVersion("nope"), null);
});

test("fresh machine: binary and cursor-sdk are copied, binary is executable, no temp files are left", async () => {
  const f = await fixture();
  try {
    const result = await installBundledComputer({ bundled: f.bundled, binaryTarget: f.binaryTarget, home: f.home, installedBinaryVersion: null, platform: "linux" });
    assert.deepEqual([result.binary, result.cursorSdk], ["installed", "installed"]);
    assert.equal(await readFile(f.binaryTarget, "utf8"), "#!/bin/sh\necho new\n");
    assert.ok(((await stat(f.binaryTarget)).mode & 0o111) !== 0, "executable");
    assert.equal(await readFile(path.join(f.home, "runtime", "cursor-sdk", "host", "runtimeHost.mjs"), "utf8"), "// host");
    assert.equal(await readFile(path.join(path.dirname(f.binaryTarget), "photon_rs_bg.wasm"), "utf8"), "wasm-bytes", "the sidecar sits beside the binary");
    assert.deepEqual((await readdir(path.dirname(f.binaryTarget))).sort(), ["photon_rs_bg.wasm", "raft-computer"], "no temp files left");
    assert.deepEqual((await readdir(path.join(f.home, "runtime"))).sort(), ["cursor-sdk"]);
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
});

test("same or newer machine copy is left alone; an older one is atomically replaced", async () => {
  const f = await fixture();
  try {
    await mkdir(path.dirname(f.binaryTarget), { recursive: true });
    await writeFile(f.binaryTarget, "existing");
    const same = await installBundledComputer({ bundled: f.bundled, binaryTarget: f.binaryTarget, home: f.home, installedBinaryVersion: "1.0.30", platform: "linux" });
    assert.equal(same.binary, "current");
    assert.equal(await readFile(f.binaryTarget, "utf8"), "existing");
    const newer = await installBundledComputer({ bundled: f.bundled, binaryTarget: f.binaryTarget, home: f.home, installedBinaryVersion: "1.0.99", platform: "linux" });
    assert.equal(newer.binary, "current");
    const older = await installBundledComputer({ bundled: f.bundled, binaryTarget: f.binaryTarget, home: f.home, installedBinaryVersion: "1.0.29", platform: "linux" });
    assert.equal(older.binary, "upgraded");
    assert.equal(await readFile(f.binaryTarget, "utf8"), "#!/bin/sh\necho new\n");
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
});

test("cursor-sdk: same version stays, older/unreadable tree is replaced whole (no stale files)", async () => {
  const f = await fixture();
  try {
    const target = path.join(f.home, "runtime", "cursor-sdk");
    await mkdir(path.join(target, "stale"), { recursive: true });
    await writeFile(path.join(target, "manifest.json"), JSON.stringify({ sdkVersion: "1.0.36" }));
    await writeFile(path.join(target, "stale", "keep.txt"), "x");
    const same = await installBundledComputer({ bundled: f.bundled, binaryTarget: f.binaryTarget, home: f.home, installedBinaryVersion: null, platform: "linux" });
    assert.equal(same.cursorSdk, "current");
    await writeFile(path.join(target, "manifest.json"), JSON.stringify({ sdkVersion: "1.0.20" }));
    const upgraded = await installBundledComputer({ bundled: f.bundled, binaryTarget: f.binaryTarget, home: f.home, installedBinaryVersion: "1.0.30", platform: "linux" });
    assert.equal(upgraded.cursorSdk, "upgraded");
    await assert.rejects(stat(path.join(target, "stale", "keep.txt")), "old tree fully replaced");
    assert.equal(await readFile(path.join(target, "host", "runtimeHost.mjs"), "utf8"), "// host");
    assert.deepEqual((await readdir(path.join(f.home, "runtime"))).sort(), ["cursor-sdk"], "no .old/.tmp leftovers");
    await writeFile(path.join(target, "manifest.json"), "{broken");
    assert.equal((await installBundledComputer({ bundled: f.bundled, binaryTarget: f.binaryTarget, home: f.home, installedBinaryVersion: "1.0.30", platform: "linux" })).cursorSdk, "upgraded", "unreadable manifest counts as not installed");
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
});

test("quarantine is stripped on macOS only, from the temp copy before it goes live", async () => {
  const f = await fixture();
  try {
    const stripped: string[] = [];
    await installBundledComputer({ bundled: f.bundled, binaryTarget: f.binaryTarget, home: f.home, installedBinaryVersion: null, platform: "darwin", removeQuarantine: async (t) => { stripped.push(t); } });
    assert.equal(stripped.length, 2);
    assert.ok(stripped.every((t) => t.includes(".tmp-")), "stripped before the rename");
    stripped.length = 0;
    await rm(f.binaryTarget);
    await installBundledComputer({ bundled: f.bundled, binaryTarget: f.binaryTarget, home: f.home, installedBinaryVersion: null, platform: "linux", removeQuarantine: async (t) => { stripped.push(t); } });
    assert.deepEqual(stripped, []);
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
});

test("nothing bundled (dev build) is not an error: both report unavailable and nothing is written", async () => {
  const f = await fixture();
  try {
    const result = await installBundledComputer({ bundled: { binaryPath: null, binaryVersion: null, cursorRoot: null }, binaryTarget: f.binaryTarget, home: f.home, installedBinaryVersion: null, platform: "linux" });
    assert.deepEqual([result.binary, result.cursorSdk], ["unavailable", "unavailable"]);
    await assert.rejects(stat(f.binaryTarget));
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
});

test("the photon sidecar is replaced together with an upgraded binary and not touched when the binary is current", async () => {
  const f = await fixture();
  try {
    await installBundledComputer({ bundled: f.bundled, binaryTarget: f.binaryTarget, home: f.home, installedBinaryVersion: null, platform: "linux" });
    const wasmTarget = path.join(path.dirname(f.binaryTarget), "photon_rs_bg.wasm");
    await writeFile(wasmTarget, "old-wasm");
    await installBundledComputer({ bundled: f.bundled, binaryTarget: f.binaryTarget, home: f.home, installedBinaryVersion: "1.0.30", platform: "linux" });
    assert.equal(await readFile(wasmTarget, "utf8"), "old-wasm", "current binary: nothing rewritten");
    await installBundledComputer({ bundled: f.bundled, binaryTarget: f.binaryTarget, home: f.home, installedBinaryVersion: "1.0.29", platform: "linux" });
    assert.equal(await readFile(wasmTarget, "utf8"), "wasm-bytes", "upgrade: sidecar refreshed with the binary");
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
});
