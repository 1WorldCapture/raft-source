import assert from "node:assert/strict";
import test from "node:test";
import { registerEmbeddedStubs, registerHostModeIpc, registerStandaloneIpc, type IpcMainLike } from "./ipc.ts";
import { StandaloneComputerHost } from "./standaloneHost.ts";

function fakeIpc() {
  const handlers = new Map<string, (event: unknown, ...args: unknown[]) => unknown>();
  const ipc: IpcMainLike = { handle: (channel, listener) => { handlers.set(channel, listener); } };
  return { ipc, handlers, call: (channel: string, ...args: unknown[]) => handlers.get(channel)!({}, ...args) };
}

test("host-mode is answered in both modes", () => {
  const embedded = fakeIpc();
  registerHostModeIpc(embedded.ipc, { mode: "embedded" });
  assert.deepEqual(embedded.call("computer:host-mode"), { mode: "embedded" });
  const standalone = fakeIpc();
  registerHostModeIpc(standalone.ipc, { mode: "standalone", home: "/h/.slock" });
  assert.deepEqual(standalone.call("computer:host-mode"), { mode: "standalone", home: "/h/.slock" });
});

test("in standalone mode the embedded computer:* actions refuse instead of acting", () => {
  const f = fakeIpc();
  registerEmbeddedStubs(f.ipc);
  for (const channel of ["computer:enable", "computer:start", "computer:stop", "computer:restart", "computer:recycle", "computer:upgrade", "computer:connect-deployment"]) {
    assert.throws(() => f.call(channel), /managed by the standalone Computer/, channel);
  }
  assert.equal(f.call("computer:status"), null);
  assert.deepEqual(f.call("computer:management"), { model: "standalone" });
});

test("standalone IPC drives the host: state, start, stop, install, upgrade", async () => {
  const f = fakeIpc();
  const log: string[] = [];
  const status = { home: "/h", service: { state: "running", pid: 1, version: "1.0.29", lastError: null }, desiredState: "running", servers: [], agentCount: 0, cursorSdk: { installed: true, version: "1", path: "/p" }, hostLifecycleOwner: "cli", migration: null } as never;
  const host = new StandaloneComputerHost({
    home: "/h", binaryPath: "/b", fileExists: async () => true,
    bundled: { binaryPath: "/app/raft-computer", binaryVersion: "1.0.30", cursorRoot: null },
    cli: { status: async () => status, start: async () => { log.push("start"); return { ok: true, state: "running", error: null }; }, stop: async () => { log.push("stop"); return { ok: true, state: "stopped", error: null }; }, version: async () => "1.0.29" },
    install: async (input) => { log.push("install"); return { binary: "upgraded", cursorSdk: "unavailable", binaryPath: input.binaryTarget, cursorSdkPath: "" }; },
  });
  const published: unknown[] = [];
  registerStandaloneIpc({ ipc: f.ipc, host, publish: (s) => published.push(s), quitting: () => false });
  assert.equal(((await f.call("standalone:state")) as { phase: string }).phase, "running");
  await f.call("standalone:stop");
  await f.call("standalone:start");
  await f.call("standalone:install");
  await f.call("standalone:upgrade");
  assert.deepEqual(log, ["stop", "start", "install", "stop", "install", "start"]);
  assert.deepEqual([...f.handlers.keys()].filter((k) => k.startsWith("standalone:")).sort(), ["standalone:install", "standalone:start", "standalone:state", "standalone:stop", "standalone:upgrade"]);
});
