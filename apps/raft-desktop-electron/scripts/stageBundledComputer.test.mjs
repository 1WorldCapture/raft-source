// Run: node --test scripts/stageBundledComputer.test.mjs
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { parseArgs, stageFrom, stagedLayout, verifyStaged } from "./stageBundledComputer.mjs";

function built() {
  const root = mkdtempSync(path.join(tmpdir(), "stage-computer-"));
  const dist = path.join(root, "dist-native");
  mkdirSync(dist);
  writeFileSync(path.join(dist, "raft-computer-linux-x64"), "#!/bin/sh\necho raft-computer 1.2.3\n");
  writeFileSync(path.join(dist, "photon_rs_bg.wasm"), "wasm");
  return { root, dist };
}

test("argument parsing accepts only the supported targets", () => {
  assert.equal(parseArgs(["--target", "darwin-arm64"]).target, "darwin-arm64");
  assert.throws(() => parseArgs(["--target", "win32-x64"]), /must be one of/);
  assert.throws(() => parseArgs(["--target"]), /bad argument/);
  assert.throws(() => parseArgs([]), /must be one of/);
});

test("staging lays out binary, wasm sidecar and version.txt; the binary is executable", () => {
  const { root, dist } = built();
  try {
    const out = path.join(root, "stage");
    const layout = stageFrom(dist, "linux-x64", out, "1.2.3");
    assert.equal(readFileSync(layout.version, "utf8"), "1.2.3\n");
    assert.equal(readFileSync(layout.wasm, "utf8"), "wasm");
    assert.ok((statSync(layout.binary).mode & 0o111) !== 0);
    assert.deepEqual(verifyStaged(out, "1.2.3"), layout);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("staging a missing build output fails with the file name; restaging replaces the old tree", () => {
  const { root, dist } = built();
  try {
    assert.throws(() => stageFrom(dist, "darwin-arm64", path.join(root, "x"), "1.2.3"), /missing build output.*raft-computer-darwin-arm64/);
    const out = path.join(root, "stage");
    stageFrom(dist, "linux-x64", out, "1.2.3");
    writeFileSync(path.join(out, "stale.txt"), "x");
    stageFrom(dist, "linux-x64", out, "1.2.4");
    assert.throws(() => readFileSync(path.join(out, "stale.txt")));
    assert.equal(readFileSync(stagedLayout(out).version, "utf8"), "1.2.4\n");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("verify reports every problem at once, including a version mismatch", () => {
  const { root } = built();
  try {
    const out = path.join(root, "empty");
    mkdirSync(out);
    assert.throws(() => verifyStaged(out, "1.2.3"), /missing .*raft-computer; missing .*photon_rs_bg\.wasm; missing .*version\.txt/);
    writeFileSync(stagedLayout(out).binary, "b");
    writeFileSync(stagedLayout(out).wasm, "w");
    writeFileSync(stagedLayout(out).version, "9.9.9\n");
    assert.throws(() => verifyStaged(out, "1.2.3"), /version\.txt is not 1\.2\.3/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
