import assert from "node:assert/strict";
import test from "node:test";
import { createMigrationController } from "./migrationIpc.ts";
import type { MigrateRun } from "./migration.ts";
import type { InstallResult } from "./bundledInstall.ts";

const bundled = { binaryPath: "/res/computer/raft-computer", binaryVersion: "1.0.30", photonWasmPath: "/res/computer/photon_rs_bg.wasm", cursorRoot: "/res/cursor-sdk" };

function setup(over: { final?: MigrateRun["outcome"]; present?: boolean; installed?: string | null; installFails?: boolean; modeFails?: boolean } = {}) {
  const runs: Array<{ apply: boolean; binaryPath: string }> = [];
  const installs: Array<{ binaryPath: string | null; cursorRoot: string | null; home: string; installedBinaryVersion: string | null }> = [];
  const modes: unknown[] = [];
  let switched = 0;
  const controller = createMigrationController({
    bundled,
    binaryTarget: "/home/u/.local/bin/raft-computer",
    getFromHome: async () => "/app/home",
    userDataDir: "/ud",
    publish: () => undefined,
    switchToStandalone: () => { switched++; },
    run: async (input): Promise<MigrateRun> => {
      runs.push({ apply: input.apply, binaryPath: input.binaryPath });
      return input.apply
        ? { outcome: over.final ?? "success", events: [], final: { result: (over.final ?? "success") as "success", from: "/app/home", to: "/home/u/.slock", error: null, serviceState: "running" }, detail: null, exitCode: 0 }
        : { outcome: "planned", events: [{ step: "preflight", status: "ok", detail: { to: "/home/u/.slock" } }], final: null, detail: null, exitCode: 0 };
    },
    fileExists: () => over.present ?? false,
    readVersion: async () => over.installed ?? null,
    install: async (input) => {
      installs.push({ binaryPath: input.bundled.binaryPath, cursorRoot: input.bundled.cursorRoot, home: input.home, installedBinaryVersion: input.installedBinaryVersion });
      if (over.installFails && input.bundled.binaryPath === null) throw new Error("disk full");
      return { binary: input.bundled.binaryPath ? "installed" : "unavailable", cursorSdk: input.bundled.cursorRoot ? "installed" : "unavailable", binaryPath: "", cursorSdkPath: "" } as InstallResult;
    },
    writeMode: async (_dir, mode) => { if (over.modeFails) throw new Error("EACCES"); modes.push(mode); },
  });
  return { controller, installs, modes, runs, switched: () => switched };
}

test("a build without a bundled Computer has no migration entry", () => {
  const c = createMigrationController({ bundled: { binaryPath: null, binaryVersion: null, cursorRoot: null }, binaryTarget: "/b", getFromHome: async () => "/h", userDataDir: "/ud", publish: () => undefined, switchToStandalone: () => undefined });
  assert.equal(c.getState().phase, "unavailable");
});

test("before the move: only the binary (+wasm) is installed, version-gated, never the Cursor SDK (the target home must stay empty)", async () => {
  const { controller, installs, runs } = setup({ present: true, installed: "1.0.29" });
  const state = await controller.plan();
  assert.equal(state.phase, "ready");
  assert.deepEqual(installs, [{ binaryPath: bundled.binaryPath, cursorRoot: null, home: "/app/home", installedBinaryVersion: "1.0.29" }]);
  assert.deepEqual(runs, [{ apply: false, binaryPath: "/home/u/.local/bin/raft-computer" }]);
});

test("a machine without raft-computer installs the bundled one first (no version to compare)", async () => {
  const { controller, installs } = setup({ present: false });
  await controller.plan();
  assert.equal(installs[0].installedBinaryVersion, null);
});

test("after a successful move: Cursor SDK copied next to the moved home, computer-host.json written, then the app switches", async () => {
  const { controller, installs, modes, switched } = setup();
  await controller.plan();
  const state = await controller.apply();
  assert.equal(state.phase, "success");
  assert.deepEqual(installs.at(-1), { binaryPath: null, cursorRoot: bundled.cursorRoot, home: "/home/u/.slock", installedBinaryVersion: null });
  assert.deepEqual(modes, [{ mode: "standalone", home: "/home/u/.slock" }]);
  assert.equal(switched(), 1);
});

test("a failed Cursor SDK copy after the move is a warning, not a failure: the mode still switches", async () => {
  const { controller, modes, switched } = setup({ installFails: true });
  await controller.plan();
  const state = await controller.apply();
  assert.equal(state.phase, "success");
  assert.match(state.warnings[0] ?? "", /Cursor SDK could not be copied.*disk full/);
  assert.deepEqual([modes.length, switched()], [1, 1]);
});

test("if computer-host.json cannot be written the app does NOT restart, and the error says the Computer already moved", async () => {
  const { controller, switched } = setup({ modeFails: true });
  await controller.plan();
  const state = await controller.apply();
  assert.equal(state.phase, "error");
  assert.match(state.error ?? "", /already moved|was moved/);
  assert.equal(switched(), 0);
});

test("rolled back: nothing is written and the app stays embedded", async () => {
  const { controller, modes, switched } = setup({ final: "rolled_back" });
  await controller.plan();
  const state = await controller.apply();
  assert.equal(state.phase, "rolled_back");
  assert.deepEqual([modes.length, switched()], [0, 0]);
});
