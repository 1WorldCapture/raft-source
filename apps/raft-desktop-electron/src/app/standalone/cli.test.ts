import assert from "node:assert/strict";
import test from "node:test";
import { createStandaloneCli, parseCommandJson, parseStatusJson, type RunCommand } from "./cli.ts";

const STATUS = {
  home: "/Users/x/.slock",
  service: { state: "running", pid: 42, version: "1.0.29", lastError: null, desiredState: "running" },
  servers: [{ serverId: "s1", slug: "raft", serverUrl: "https://raft.example", daemonState: "online", agentCount: 3, newFutureField: 1 }],
  agentCount: 3,
  cursorSdk: { installed: true, version: "1.0.36", path: "/Users/x/.slock/runtime/cursor-sdk" },
  hostLifecycleOwner: "cli",
  migration: { state: "none", resultFile: null },
  somethingNew: true,
};

test("status JSON: the v1 shape parses, extra fields are ignored", () => {
  const status = parseStatusJson(`${JSON.stringify(STATUS)}\n`);
  assert.equal(status.service.state, "running");
  assert.equal(status.desiredState, "running");
  assert.equal(status.servers[0]?.agentCount, 3);
  assert.equal(status.cursorSdk.installed, true);
  assert.equal(status.hostLifecycleOwner, "cli");
});

test("status JSON: a user-stopped Computer is distinguishable from a failed one", () => {
  const stopped = parseStatusJson(JSON.stringify({ ...STATUS, service: { state: "stopped", desiredState: "stopped" } }));
  const failed = parseStatusJson(JSON.stringify({ ...STATUS, service: { state: "stopped", desiredState: "running", lastError: "exit 1" } }));
  assert.deepEqual([stopped.service.state, stopped.desiredState], ["stopped", "stopped"]);
  assert.deepEqual([failed.desiredState, failed.service.lastError], ["running", "exit 1"]);
});

test("status JSON: last line wins (log noise before it is tolerated); missing optional blocks get defaults", () => {
  const status = parseStatusJson(`warning: something\n${JSON.stringify({ home: "/h", service: { state: "starting" } })}\n`);
  assert.deepEqual([status.service.state, status.desiredState, status.servers.length, status.cursorSdk.installed, status.migration], ["starting", null, 0, false, null]);
});

test("status JSON: garbage and wrong shapes are errors, not silent defaults", () => {
  assert.throws(() => parseStatusJson("not json"), /not JSON/);
  assert.throws(() => parseStatusJson(JSON.stringify({ home: "/h", service: { state: "weird" } })), /unexpected JSON shape/);
  assert.throws(() => parseStatusJson(JSON.stringify({ service: { state: "running" } })), /unexpected JSON shape/);
});

test("command JSON: ok, error, and unreadable output", () => {
  assert.deepEqual(parseCommandJson('{"ok":true,"state":"stopped","desiredState":"stopped","error":null}'), { ok: true, state: "stopped", error: null });
  assert.deepEqual(parseCommandJson('{"ok":false,"state":null,"error":{"code":"service_failed","message":"boom"}}'), { ok: false, state: null, error: { code: "service_failed", message: "boom" } });
  assert.equal(parseCommandJson("oops").error?.code, "bad_output");
});

test("the CLI wrapper runs the right commands with the standalone home in the env", async () => {
  const calls: Array<{ file: string; args: string[]; home: string | undefined }> = [];
  const run: RunCommand = async (file, args, { env }) => {
    calls.push({ file, args, home: env.RAFT_HOME });
    if (args[0] === "status") return { stdout: JSON.stringify(STATUS), stderr: "", code: 0 };
    if (args[0] === "--version") return { stdout: "raft-computer 1.0.29\n", stderr: "", code: 0 };
    return { stdout: JSON.stringify({ ok: true, state: args[0] === "start" ? "running" : "stopped", error: null }), stderr: "", code: 0 };
  };
  const cli = createStandaloneCli({ binaryPath: "/bin/raft-computer", home: "/iso/.slock", run, baseEnv: {} });
  assert.equal((await cli.status()).service.pid, 42);
  assert.deepEqual(await cli.start(), { ok: true, state: "running", error: null });
  assert.deepEqual(await cli.stop(), { ok: true, state: "stopped", error: null });
  assert.equal(await cli.version(), "1.0.29");
  assert.deepEqual(calls.map((c) => c.args), [["status", "--json"], ["start", "--json"], ["stop", "--json"], ["--version"]]);
  assert.ok(calls.every((c) => c.file === "/bin/raft-computer" && c.home === "/iso/.slock"));
});

test("a failing status command surfaces as an error with the stderr", async () => {
  const cli = createStandaloneCli({ binaryPath: "/bin/x", home: "/h", baseEnv: {}, run: async () => ({ stdout: "", stderr: "boom", code: 2 }) });
  await assert.rejects(cli.status(), /status failed \(2\): boom/);
  assert.equal(await cli.version(), null);
});

test("end to end with a real child process (fake raft-computer script)", { skip: process.platform === "win32" }, async () => {
  const { mkdtemp, rm, writeFile, chmod } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const path = await import("node:path");
  const dir = await mkdtemp(path.join(tmpdir(), "fake-computer-"));
  try {
    const script = path.join(dir, "raft-computer");
    await writeFile(script, `#!/bin/sh
case "$1" in
  status) echo '{"home":"'"$RAFT_HOME"'","service":{"state":"stopped","desiredState":"stopped"}}';;
  start) echo '{"ok":true,"state":"running","error":null}';;
  stop) echo '{"ok":true,"state":"stopped","error":null}';;
  --version) echo 'raft-computer 9.9.9';;
  *) echo "bad" >&2; exit 3;;
esac
`);
    await chmod(script, 0o755);
    const cli = createStandaloneCli({ binaryPath: script, home: dir });
    const status = await cli.status();
    assert.deepEqual([status.home, status.service.state, status.desiredState], [dir, "stopped", "stopped"]);
    assert.equal((await cli.start()).state, "running");
    assert.equal((await cli.stop()).state, "stopped");
    assert.equal(await cli.version(), "9.9.9");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("contract fixture: the exact output of the computer package's projectStatusJson (PR #263) parses, null placeholders included", () => {
  const real = '{"home":"/home/x/.slock","socket":"/home/x/.slock/computer/run/service.sock","service":{"state":"running","pid":7,"version":"1.0.29","lastError":null,"desiredState":"running"},"servers":[{"serverId":"s1","slug":"srv","serverUrl":"https://example.test","daemonState":"online","lastError":null,"agentCount":null}],"agentCount":null,"cursorSdk":{"installed":false,"version":null,"path":null},"hostLifecycleOwner":null,"migration":{"state":"none","resultFile":"/home/x/.slock/computer/migrate-result.json"}}';
  const status = parseStatusJson(real);
  assert.deepEqual([status.service.state, status.service.pid, status.desiredState, status.agentCount, status.servers[0]?.agentCount, status.servers[0]?.daemonState], ["running", 7, "running", 0, 0, "online"]);
  assert.deepEqual([status.cursorSdk.installed, status.hostLifecycleOwner, status.migration?.state], [false, null, "none"]);
});
