import assert from "node:assert/strict";
import test from "node:test";
import type { StandaloneCli, StandaloneStatus } from "./cli.ts";
import { StandaloneComputerHost } from "./standaloneHost.ts";
import { resolveBundledComputer } from "./bundled.ts";

function status(overrides: Partial<StandaloneStatus["service"]> & { desiredState?: "running" | "stopped" | null } = {}): StandaloneStatus {
  const { desiredState = "running", ...service } = overrides;
  return {
    home: "/h", desiredState, servers: [], agentCount: 2, hostLifecycleOwner: "cli", migration: null,
    cursorSdk: { installed: true, version: "1.0.36", path: "/h/runtime/cursor-sdk" },
    service: { state: "running", pid: 1, version: "1.0.29", lastError: null, ...service },
  };
}

function harness(opts: { present?: boolean; statuses?: Array<StandaloneStatus | Error>; bundledVersion?: string | null } = {}) {
  const calls: string[] = [];
  const queue = [...(opts.statuses ?? [status()])];
  const cli: StandaloneCli = {
    status: async () => { const next = queue.length > 1 ? queue.shift()! : queue[0]!; if (next instanceof Error) throw next; return next; },
    start: async () => { calls.push("start"); return { ok: true, state: "running", error: null }; },
    stop: async () => { calls.push("stop"); return { ok: true, state: "stopped", error: null }; },
    version: async () => "1.0.29",
  };
  const installs: Array<string | null> = [];
  const host = new StandaloneComputerHost({
    home: "/h", binaryPath: "/bin/raft-computer", cli,
    bundled: { binaryPath: "/app/computer/raft-computer", binaryVersion: opts.bundledVersion === undefined ? "1.0.30" : opts.bundledVersion, cursorRoot: "/app/cursor-sdk" },
    fileExists: async () => opts.present ?? true,
    install: async (input) => { installs.push(input.installedBinaryVersion); calls.push("install"); return { binary: "upgraded", cursorSdk: "current", binaryPath: input.binaryTarget, cursorSdkPath: "" }; },
  });
  return { host, calls, installs };
}

test("phases: not installed, running, starting, failed, stopped by the user vs stopped unexpectedly, unreachable", async () => {
  assert.equal((await harness({ present: false }).host.getState()).phase, "not_installed");
  assert.equal((await harness({ statuses: [status()] }).host.getState()).phase, "running");
  assert.equal((await harness({ statuses: [status({ state: "starting" })] }).host.getState()).phase, "starting");
  const failed = await harness({ statuses: [status({ state: "failed", lastError: "exit 1" })] }).host.getState();
  assert.deepEqual([failed.phase, failed.error], ["failed", "exit 1"]);
  const byUser = await harness({ statuses: [status({ state: "stopped", desiredState: "stopped" })] }).host.getState();
  assert.equal(byUser.phase, "stopped_by_user");
  assert.equal(byUser.error, null, "a deliberate Stop is not an error");
  const crashed = await harness({ statuses: [status({ state: "stopped", desiredState: "running", lastError: "killed" })] }).host.getState();
  assert.deepEqual([crashed.phase, crashed.error], ["stopped", "killed"]);
  const unreachable = await harness({ statuses: [new Error("boom")] }).host.getState();
  assert.deepEqual([unreachable.phase, unreachable.error], ["unreachable", "boom"]);
});

test("an upgrade is offered only when the app carries a newer Computer than the installed one", async () => {
  assert.equal((await harness({ bundledVersion: "1.0.30" }).host.getState()).upgradeAvailable, true);
  assert.equal((await harness({ bundledVersion: "1.0.29" }).host.getState()).upgradeAvailable, false);
  assert.equal((await harness({ bundledVersion: null }).host.getState()).upgradeAvailable, false);
});

test("start and stop run the CLI and return the refreshed state; a failing command is reported on the state", async () => {
  const h = harness({ statuses: [status()] }); // state read AFTER start
  const started = await h.host.start();
  assert.deepEqual(h.calls, ["start"]);
  assert.equal(started.phase, "running");
  const failingHost = new StandaloneComputerHost({
    home: "/h", binaryPath: "/b", bundled: { binaryPath: null, binaryVersion: null, cursorRoot: null }, fileExists: async () => true,
    cli: { status: async () => status({ state: "stopped" }), start: async () => ({ ok: false, state: null, error: { code: "x", message: "port busy" } }), stop: async () => ({ ok: true, state: "stopped", error: null }), version: async () => null },
  });
  assert.equal((await failingHost.start()).error, "port busy");
});

test("lifecycle commands never overlap", async () => {
  let active = 0;
  let maxActive = 0;
  const slow = async () => { active += 1; maxActive = Math.max(maxActive, active); await new Promise((r) => setTimeout(r, 15)); active -= 1; return { ok: true, state: "running" as const, error: null }; };
  const host = new StandaloneComputerHost({
    home: "/h", binaryPath: "/b", bundled: { binaryPath: null, binaryVersion: null, cursorRoot: null }, fileExists: async () => true,
    cli: { status: async () => status(), start: slow, stop: slow, version: async () => null },
  });
  await Promise.all([host.start(), host.stop(), host.start()]);
  assert.equal(maxActive, 1);
});

test("upgrade: a running Computer is stopped, replaced and brought back; a user-stopped one stays stopped", async () => {
  const running = harness({ statuses: [status()] });
  const result = await running.host.upgradeFromBundle();
  assert.deepEqual(running.calls, ["stop", "install", "start"]);
  assert.deepEqual([result.restarted, result.install.binary], [true, "upgraded"]);
  assert.deepEqual(running.installs, ["1.0.29"], "the installed version is passed so the copy is version-gated");

  const stopped = harness({ statuses: [status({ state: "stopped", desiredState: "stopped" })] });
  const second = await stopped.host.upgradeFromBundle();
  assert.deepEqual(stopped.calls, ["install"]);
  assert.equal(second.restarted, false);
});

test("a failed copy during an upgrade never leaves agents down: the old Computer is started again", async () => {
  const calls: string[] = [];
  const host = new StandaloneComputerHost({
    home: "/h", binaryPath: "/b", bundled: { binaryPath: "/app/raft-computer", binaryVersion: "2.0.0", cursorRoot: null }, fileExists: async () => true,
    cli: { status: async () => status(), start: async () => { calls.push("start"); return { ok: true, state: "running", error: null }; }, stop: async () => { calls.push("stop"); return { ok: true, state: "stopped", error: null }; }, version: async () => "1.0.29" },
    install: async () => { throw new Error("disk full"); },
  });
  await assert.rejects(host.upgradeFromBundle(), /disk full/);
  assert.deepEqual(calls, ["stop", "start"]);
});

test("bundled resource lookup: dev builds and builds without the Computer report nothing", () => {
  assert.deepEqual(resolveBundledComputer({ isPackaged: false, resourcesPath: "/r" }), { binaryPath: null, binaryVersion: null, cursorRoot: null });
  assert.deepEqual(resolveBundledComputer({ isPackaged: true, resourcesPath: "/r", exists: () => false }), { binaryPath: null, binaryVersion: null, cursorRoot: null });
  const present = resolveBundledComputer({ isPackaged: true, resourcesPath: "/r", exists: () => true, readText: () => "1.0.30\n" });
  assert.equal(present.binaryVersion, "1.0.30");
  assert.ok(present.binaryPath?.endsWith("raft-computer"));
  assert.equal(present.cursorRoot, "/r/cursor-sdk");
});
