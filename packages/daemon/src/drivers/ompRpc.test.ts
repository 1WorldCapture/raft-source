import assert from "node:assert/strict";
import { test } from "vitest";
import { execFile } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { OmpDriver, OmpRpcProcessExitedError, OmpRpcProtocolError, OmpRpcRequestTimeoutError } from "./omp.js";
import type { ParsedEvent, SpawnContext } from "./types.js";

const execFileAsync = promisify(execFile);

// A fake omp that speaks the RPC protocol over real stdio (PM task #2
// acceptance: ready, negotiation, chunking, abnormal exit — plus the
// no-orphans stop test). Behaviors are selected by argv[2]; every mode except
// "never-ready" prints the ready frame first. Grandchildren spawn WITHOUT
// detaching so they inherit the fake's process group, matching how omp's own
// bash tools / subagents behave.
const FAKE_OMP_SCRIPT = `
const mode = process.argv[2] ?? "echo";
const send = (frame) => process.stdout.write(JSON.stringify(frame) + "\\n");

if (mode !== "never-ready") {
  send({ type: "ready", protocolVersion: 1, supportedProtocolVersions: mode === "v1-only" ? [1] : [1, 2], maxFrameBytes: 1048576, maxReassembledFrameBytes: 67108864 });
}

const pendingStates = [];
let sawFirstGetState = false;
process.stdin.setEncoding("utf8");
let buffer = "";
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  let index;
  while ((index = buffer.indexOf("\\n")) >= 0) {
    const line = buffer.slice(0, index);
    buffer = buffer.slice(index + 1);
    if (line.trim()) {
      let frame;
      try { frame = JSON.parse(line); } catch { continue; }
      if (frame.type === "negotiate_protocol") {
        // Negotiation is answered in every mode — the handshake must settle
        // even for a peer that never answers user commands.
        send({ id: frame.id, type: "response", command: "negotiate_protocol", success: true, data: { protocolVersion: frame.protocolVersion } });
      } else if (mode === "silent") {
        continue;
      } else if (mode === "out-of-order" && frame.type === "get_state") {
        // The driver's own settle-time get_state arrives first and gets a
        // plain echo; the out-of-order dance plays for the next two.
        if (!sawFirstGetState) {
          sawFirstGetState = true;
          send({ id: frame.id, type: "response", command: "get_state", success: true, data: {} });
        } else {
          pendingStates.push(frame.id);
          if (pendingStates.length === 2) {
            send({ id: pendingStates[1], type: "response", command: "get_state", success: true, data: { which: "second" } });
            send({ id: pendingStates[0], type: "response", command: "get_state", success: true, data: { which: "first" } });
          }
        }
      } else if (mode === "chunked" && frame.type === "get_state") {
        const payload = Buffer.from(JSON.stringify({ id: frame.id, type: "response", command: "get_state", success: true, data: { blob: "c".repeat(1024 * 1024 + 512) } }), "utf8");
        const chunkSize = 256 * 1024;
        const count = Math.ceil(payload.byteLength / chunkSize);
        for (let i = 0; i < count; i++) {
          send({ type: "rpc_chunk", chunkId: "rpc-1", index: i, count, byteLength: payload.byteLength, data: payload.subarray(i * chunkSize, (i + 1) * chunkSize).toString("base64") });
        }
      } else if (mode === "crash-on-command" && frame.type === "get_entries") {
        process.exit(7);
      } else if (mode === "spawn-child" && frame.type === "get_state") {
        const { spawn } = require("node:child_process");
        const sleeping = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
        sleeping.unref();
        send({ id: frame.id, type: "response", command: "get_state", success: true, data: { childPid: sleeping.pid } });
      } else if (frame.id !== undefined) {
        send({ id: frame.id, type: "response", command: frame.type, success: true, data: {} });
      }
    }
  }
});
`;

function makeSpawnContext(workspace: string): SpawnContext {
  return {
    agentId: "agent-omp",
    standingPrompt: "standing",
    prompt: "hello",
    workingDirectory: workspace,
    slockCliPath: "/tmp/slock-cli.js",
    daemonApiKey: "daemon-token",
    launchId: "launch-1",
    config: {
      name: "OMP Agent",
      displayName: null,
      description: null,
      runtime: "omp",
      serverUrl: "https://slock.example",
      authToken: "agent-token",
      sessionId: null,
      model: "default",
      reasoningEffort: null,
      envVars: null,
      runtimeContext: {
        agentId: "agent-omp",
        serverId: "server-1",
        machineId: "machine-1",
        machineName: "Dev Machine",
        machineHostname: "host.local",
        machineOs: "darwin arm64",
        daemonVersion: "0.42.0",
        workspacePath: workspace,
      },
    },
  };
}

interface FakeOmp {
  driver: OmpDriver;
  proc: import("node:child_process").ChildProcess;
  /** Wait until the driver has seen ready and settled the protocol version. */
  waitReadyNegotiated(): Promise<void>;
  sleep(ms: number): Promise<void>;
}

async function startFakeOmp(mode: string, overrides: { readyTimeoutMs?: number } = {}): Promise<FakeOmp> {
  const workspace = mkdtempSync(path.join(os.tmpdir(), "slock-omp-rpc-"));
  const scriptPath = path.join(workspace, "fake-omp.cjs");
  writeFileSync(scriptPath, FAKE_OMP_SCRIPT);

  const driver = new OmpDriver();
  const { process: proc } = await driver.spawn(makeSpawnContext(workspace), {
    command: process.execPath,
    args: [scriptPath, mode],
    readyTimeoutMs: overrides.readyTimeoutMs,
  });

  // In production the session machinery feeds stdout lines to parseLine; the
  // tests play that role over the real pipe.
  let stdoutBuffer = "";
  proc.stdout?.setEncoding("utf8");
  proc.stdout?.on("data", (chunk: string) => {
    stdoutBuffer += chunk;
    let index: number;
    while ((index = stdoutBuffer.indexOf("\n")) >= 0) {
      const line = stdoutBuffer.slice(0, index);
      stdoutBuffer = stdoutBuffer.slice(index + 1);
      if (line.trim()) driver.parseLine(line);
    }
  });

  return {
    driver,
    proc,
    sleep: (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)),
    waitReadyNegotiated: async () => {
      // protocolSettled, not activeProtocolVersion: the version flips to 1 on
      // the ready frame before the negotiation confirms, so waiting on it
      // races the handshake.
      for (let i = 0; i < 500 && !driver.isProtocolSettled; i += 1) {
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      assert.equal(driver.isReady, true, "fake omp never became ready");
      assert.equal(driver.isProtocolSettled, true, "fake omp handshake never settled");
    },
  };
}

async function processAlive(pid: number): Promise<boolean> {
  try {
    await execFileAsync("kill", ["-0", String(pid)]);
    return true;
  } catch {
    return false;
  }
}

test("ready frame arms the driver and a supported v2 is negotiated", async () => {
  const fake = await startFakeOmp("echo");
  try {
    // The ready frame may land while spawn's async env setup yields; only the
    // settled state is contractual.
    await fake.waitReadyNegotiated();
    assert.equal(fake.driver.activeProtocolVersion, 2);
    assert.equal(fake.driver.protocolError, null);
    assert.equal(fake.driver.frameErrors.count, 0);
  } finally {
    fake.driver.stop({ sigtermGraceMs: 100 });
  }
});

test("parseLine routes mapped frames to the event normalizer and drops log-only ones", async () => {
  const fake = await startFakeOmp("echo");
  try {
    await fake.waitReadyNegotiated();

    const mapped = fake.driver.parseLine(JSON.stringify({
      type: "tool_execution_start",
      toolCallId: "call-1",
      toolName: "read",
      args: { path: "a.txt" },
    }));
    assert.deepEqual(mapped, [{ kind: "tool_call", name: "read", input: { path: "a.txt" } }]);

    const logOnly = fake.driver.parseLine(JSON.stringify({
      type: "subagent_lifecycle",
      subagentId: "s1",
      status: "started",
    }));
    assert.deepEqual(logOnly, []);

    const empty = fake.driver.parseLine(JSON.stringify({ type: "queue_update", steering: [], followUp: [] }));
    assert.deepEqual(empty, []);
  } finally {
    fake.driver.stop({ sigtermGraceMs: 100 });
  }
});

test("a v1-only server stays on v1 without a negotiation failure", async () => {
  const fake = await startFakeOmp("v1-only");
  try {
    await fake.waitReadyNegotiated();
    assert.equal(fake.driver.activeProtocolVersion, 1);
    assert.equal(fake.driver.protocolError, null);

    const response = await fake.driver.request({ type: "get_state" });
    assert.equal(response.success, true);
  } finally {
    fake.driver.stop({ sigtermGraceMs: 100 });
  }
});

test("responses correlate by id even when the peer answers out of order", async () => {
  const fake = await startFakeOmp("out-of-order");
  try {
    await fake.waitReadyNegotiated();

    const first = fake.driver.request({ type: "get_state" });
    const second = fake.driver.request({ type: "get_state" });
    const [a, b] = await Promise.all([first, second]);
    assert.equal((a.data as { which: string }).which, "first");
    assert.equal((b.data as { which: string }).which, "second");
  } finally {
    fake.driver.stop({ sigtermGraceMs: 100 });
  }
});

test("an oversized v2 response arrives chunked and resolves losslessly", async () => {
  const fake = await startFakeOmp("chunked");
  try {
    await fake.waitReadyNegotiated();

    const response = await fake.driver.request({ type: "get_state" });
    const blob = (response.data as { blob: string }).blob;
    assert.equal(blob.length, 1024 * 1024 + 512);
    assert.ok(blob.startsWith("ccc"));
  } finally {
    fake.driver.stop({ sigtermGraceMs: 100 });
  }
});

test("an abnormal exit rejects in-flight requests with a typed error", async () => {
  const fake = await startFakeOmp("crash-on-command");
  try {
    await fake.waitReadyNegotiated();
    await fake.sleep(100); // let the settle-time get_state echo land first

    const pending = fake.driver.request({ type: "get_entries" });
    await assert.rejects(pending, (error: unknown) => {
      assert.ok(error instanceof OmpRpcProcessExitedError);
      assert.match((error as OmpRpcProcessExitedError).message, /code 7/);
      return true;
    });
  } finally {
    fake.driver.stop({ sigtermGraceMs: 100 });
  }
});

test("a request beyond its timeout rejects without killing the process", async () => {
  const fake = await startFakeOmp("silent");
  try {
    await fake.waitReadyNegotiated();

    await assert.rejects(
      fake.driver.request({ type: "silent_probe" }, { timeoutMs: 50 }),
      (error: unknown) => {
        assert.ok(error instanceof OmpRpcRequestTimeoutError);
        assert.match((error as OmpRpcRequestTimeoutError).message, /timed out/);
        return true;
      },
    );
    assert.equal(fake.proc.exitCode, null, "the process must stay alive after a request timeout");
  } finally {
    fake.driver.stop({ sigtermGraceMs: 100 });
  }
});

test("a missing ready frame fails the launch instead of hanging", async () => {
  const fake = await startFakeOmp("never-ready", { readyTimeoutMs: 80 });
  try {
    for (let i = 0; i < 100 && !fake.driver.protocolError; i += 1) {
      await fake.sleep(10);
    }
    assert.match(fake.driver.protocolError ?? "", /did not send a ready frame/);
  } finally {
    fake.driver.stop({ sigtermGraceMs: 100 });
  }
});

test("stop takes down the whole process tree — no orphans survive", async () => {
  const fake = await startFakeOmp("spawn-child");
  try {
    await fake.waitReadyNegotiated();

    const response = await fake.driver.request({ type: "get_state" });
    const childPid = (response.data as { childPid: number }).childPid;
    assert.ok(childPid > 0);

    fake.driver.stop({ sigtermGraceMs: 150 });
    await fake.sleep(700);

    assert.equal(await processAlive(fake.proc.pid!), false, "the fake omp parent must be dead after stop");
    assert.equal(await processAlive(childPid), false, "the spawned grandchild must not outlive stop");
  } finally {
    fake.driver.stop({ sigtermGraceMs: 100 });
  }
});

test("stop delivers the abort command before the SIGTERM lands", async () => {
  const workspace = mkdtempSync(path.join(os.tmpdir(), "slock-omp-abort-"));
  const logPath = path.join(workspace, "events.log");
  const scriptPath = path.join(workspace, "fake-omp-abort.cjs");
  writeFileSync(scriptPath, `
const fs = require("node:fs");
const log = (event) => fs.appendFileSync(process.argv[2], event + "\\n");
const send = (frame) => process.stdout.write(JSON.stringify(frame) + "\\n");
send({ type: "ready", protocolVersion: 1, supportedProtocolVersions: [1, 2], maxFrameBytes: 1048576, maxReassembledFrameBytes: 67108864 });
process.stdin.setEncoding("utf8");
let buffer = "";
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  let index;
  while ((index = buffer.indexOf("\\n")) >= 0) {
    const line = buffer.slice(0, index);
    buffer = buffer.slice(index + 1);
    if (!line.trim()) continue;
    const frame = JSON.parse(line);
    log("frame:" + frame.type);
    if (frame.type === "negotiate_protocol") {
      send({ id: frame.id, type: "response", command: "negotiate_protocol", success: true, data: { protocolVersion: 2 } });
    } else {
      send({ id: frame.id, type: "response", command: frame.type, success: true, data: {} });
    }
  }
});
process.on("SIGTERM", () => {
  log("SIGTERM");
  process.exit(0);
});
`);

  const driver = new OmpDriver();
  const { process: proc } = await driver.spawn(makeSpawnContext(workspace), {
    command: process.execPath,
    args: [scriptPath, logPath],
    readyTimeoutMs: 5000,
  });
  try {
    // Drain stdout so negotiation settles, like the session machinery would.
    let stdoutBuffer = "";
    proc.stdout?.setEncoding("utf8");
    proc.stdout?.on("data", (chunk: string) => {
      stdoutBuffer += chunk;
      let index: number;
      while ((index = stdoutBuffer.indexOf("\n")) >= 0) {
        const line = stdoutBuffer.slice(0, index);
        stdoutBuffer = stdoutBuffer.slice(index + 1);
        if (line.trim()) driver.parseLine(line);
      }
    });
    for (let i = 0; i < 300 && driver.activeProtocolVersion === 0; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.equal(driver.isReady, true);

    driver.stop({ sigtermGraceMs: 200 });
    await new Promise((resolve) => setTimeout(resolve, 700));

    const events = readFileSync(logPath, "utf8").trim().split("\n")
      .filter((event) => event === "frame:abort" || event === "SIGTERM");
    assert.equal(events[0], "frame:abort", "the abort command must reach the child first");
    assert.equal(events[1], "SIGTERM", "SIGTERM must only land after the abort was delivered");
  } finally {
    driver.stop({ sigtermGraceMs: 100 });
  }
});

test("a stale process exit does not disturb a freshly spawned session", async () => {
  const fakeA = await startFakeOmp("echo");
  await fakeA.waitReadyNegotiated();

  // stop() then spawn() again on the SAME driver — the resume flow of task #4.
  fakeA.driver.stop({ sigtermGraceMs: 50 });
  const workspaceB = mkdtempSync(path.join(os.tmpdir(), "slock-omp-restart-"));
  const scriptB = path.join(workspaceB, "fake-omp-b.cjs");
  writeFileSync(scriptB, FAKE_OMP_SCRIPT);
  const { process: procB } = await fakeA.driver.spawn(makeSpawnContext(workspaceB), {
    command: process.execPath,
    args: [scriptB, "echo"],
    readyTimeoutMs: 5000,
  });
  let stdoutBuffer = "";
  procB.stdout?.setEncoding("utf8");
  procB.stdout?.on("data", (chunk: string) => {
    stdoutBuffer += chunk;
    let index: number;
    while ((index = stdoutBuffer.indexOf("\n")) >= 0) {
      const line = stdoutBuffer.slice(0, index);
      stdoutBuffer = stdoutBuffer.slice(index + 1);
      if (line.trim()) fakeA.driver.parseLine(line);
    }
  });

  try {
    // A's exit fires while B is starting; the driver must stay on B's side.
    await fakeA.sleep(300);
    assert.equal(fakeA.driver.isReady, true, "the new session must reach ready");
    assert.equal(fakeA.driver.activeProtocolVersion, 2, "the new session must negotiate v2");
    assert.equal(fakeA.driver.protocolError, null, "the stale exit must not surface as a protocol error");

    const response = await fakeA.driver.request({ type: "get_state" });
    assert.equal(response.success, true, "the new session must answer requests");
    assert.equal(procB.exitCode, null, "the new process must still be alive");
  } finally {
    fakeA.driver.stop({ sigtermGraceMs: 100 });
  }
});

// ── Session control (phase-1 task #4) ──

const FAKE_SESSION_SCRIPT = `
const fs = require("node:fs");
const mode = process.argv[2] ?? "echo";
const send = (frame) => process.stdout.write(JSON.stringify(frame) + "\\n");
if (mode === "resume-crash" && process.argv.includes("--resume")) {
  process.stderr.write("Could not restore model cursor/gone-model\\n");
  process.exit(3);
}
send({ type: "ready", protocolVersion: 1, supportedProtocolVersions: [1, 2], maxFrameBytes: 1048576, maxReassembledFrameBytes: 67108864 });
const sessionId = process.argv.includes("--resume") ? process.argv[process.argv.indexOf("--resume") + 1] : "fresh-session-1";
if (process.argv[3] === "record") {
  fs.writeFileSync(process.argv[4], JSON.stringify(process.argv.slice(2)));
}
let refused = mode === "refuse-delivery";
process.stdin.setEncoding("utf8");
let buffer = "";
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  let index;
  while ((index = buffer.indexOf("\\n")) >= 0) {
    const line = buffer.slice(0, index);
    buffer = buffer.slice(index + 1);
    if (!line.trim()) continue;
    const frame = JSON.parse(line);
    if (frame.type === "negotiate_protocol") {
      send({ id: frame.id, type: "response", command: "negotiate_protocol", success: true, data: { protocolVersion: 2 } });
    } else if (frame.type === "get_state") {
      send({ id: frame.id, type: "response", command: "get_state", success: true, data: { sessionId, sessionFile: "/tmp/s.jsonl" } });
    } else if (refused && (frame.type === "prompt" || frame.type === "steer")) {
      send({ id: frame.id, type: "response", command: frame.type, success: false, error: "model not available" });
      refused = false;
    } else if (frame.id !== undefined) {
      send({ id: frame.id, type: "response", command: frame.type, success: true, data: {} });
    }
  }
});
`;

interface SessionHarness {
  driver: OmpDriver;
  proc: import("node:child_process").ChildProcess;
  events: ParsedEvent[];
  sleep(ms: number): Promise<void>;
  waitUntil(predicate: () => boolean, ms?: number): Promise<void>;
}

async function startSessionFake(mode: string, configSessionId: string | null): Promise<SessionHarness> {
  const workspace = mkdtempSync(path.join(os.tmpdir(), "slock-omp-session-"));
  const scriptPath = path.join(workspace, "fake-omp-session.cjs");
  writeFileSync(scriptPath, FAKE_SESSION_SCRIPT);

  const driver = new OmpDriver();
  const ctx = makeSpawnContext(workspace);
  if (configSessionId) (ctx.config as { sessionId?: string | null }).sessionId = configSessionId;
  const { process: proc } = await driver.spawn(ctx, {
    command: process.execPath,
    extraArgs: [scriptPath, mode],
  });

  const harness: SessionHarness = {
    driver,
    proc,
    events: [],
    sleep: (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)),
    waitUntil: async (predicate: () => boolean, ms = 3000) => {
      const started = Date.now();
      while (!predicate() && Date.now() - started < ms) {
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
    },
  };

  let stdoutBuffer = "";
  proc.stdout?.setEncoding("utf8");
  proc.stdout?.on("data", (chunk: string) => {
    stdoutBuffer += chunk;
    let index: number;
    while ((index = stdoutBuffer.indexOf("\n")) >= 0) {
      const line = stdoutBuffer.slice(0, index);
      stdoutBuffer = stdoutBuffer.slice(index + 1);
      if (line.trim()) harness.events.push(...driver.parseLine(line));
    }
  });
  return harness;
}

test("idle delivery sends a prompt and busy delivery sends a steer, without trailing newlines", async () => {
  const harness = await startSessionFake("echo", null);
  try {
    await harness.waitUntil(() => harness.driver.isProtocolSettled);

    const idle = harness.driver.encodeStdinMessage("first message", null, { mode: "idle" });
    assert.ok(idle && idle.length > 0, "idle delivery must encode");
    assert.ok(!idle.endsWith("\n"), "the encoded line must not carry a trailing newline (runtimeSession adds it)");
    const idleFrame = JSON.parse(idle) as { type: string; message: string };
    assert.equal(idleFrame.type, "prompt");
    assert.equal(idleFrame.message, "first message");

    const busy = harness.driver.encodeStdinMessage("follow-up", null, { mode: "busy" });
    assert.ok(busy && busy.length > 0);
    const busyFrame = JSON.parse(busy) as { type: string; message: string };
    assert.equal(busyFrame.type, "steer");
    assert.equal(busyFrame.message, "follow-up");

    harness.proc.stdin?.write(idle + "\n");
    harness.proc.stdin?.write(busy + "\n");
    await harness.sleep(150);
  } finally {
    harness.driver.stop({ sigtermGraceMs: 100 });
  }
});

test("a refused prompt or steer surfaces as an error event", async () => {
  const harness = await startSessionFake("refuse-delivery", null);
  try {
    await harness.waitUntil(() => harness.driver.isProtocolSettled);

    const encoded = harness.driver.encodeStdinMessage("do things", null, { mode: "idle" });
    assert.ok(encoded);
    harness.proc.stdin?.write(encoded + "\n");

    await harness.waitUntil(() => harness.events.some((event) => event.kind === "error"));
    const errorEvent = harness.events.find((event) => event.kind === "error") as { message: string };
    assert.match(errorEvent.message, /OMP refused prompt/);
    assert.match(errorEvent.message, /model not available/);
  } finally {
    harness.driver.stop({ sigtermGraceMs: 100 });
  }
});

test("resume succeeds with the recorded session id and announces session_init", async () => {
  const harness = await startSessionFake("echo", "recorded-session-42");
  try {
    await harness.waitUntil(() => harness.driver.currentSessionId !== null);

    assert.equal(harness.driver.currentSessionId, "recorded-session-42");
    const init = harness.events.find((event) => event.kind === "session_init") as { sessionId: string };
    assert.equal(init.sessionId, "recorded-session-42");
    assert.equal(harness.driver.resumeFallback, null, "a successful resume must not raise the fallback diagnostic");
  } finally {
    harness.driver.stop({ sigtermGraceMs: 100 });
  }
});

test("a failed resume falls back to a fresh session with a diagnostic", async () => {
  const harness = await startSessionFake("resume-crash", "lost-session-7");
  try {
    await harness.waitUntil(() => harness.driver.currentSessionId !== null, 5000);

    assert.equal(harness.driver.currentSessionId, "fresh-session-1", "the fallback must start a fresh session");
    const init = harness.events.find((event) => event.kind === "session_init") as { sessionId: string };
    assert.equal(init.sessionId, "fresh-session-1");
    const diagnostic = harness.events.find((event) => event.kind === "runtime_diagnostic") as { message?: string };
    assert.ok(diagnostic, "the fallback must surface a diagnostic");
    assert.match(diagnostic.message ?? "", /could not resume session lost-session-7/);
    assert.match(diagnostic.message ?? "", /Could not restore model/, "the diagnostic carries the first exit's stderr summary");
  } finally {
    harness.driver.stop({ sigtermGraceMs: 100 });
  }
});

test("a fresh launch (no recorded session) does not pass --resume and gets a fresh id", async () => {
  const harness = await startSessionFake("echo", null);
  try {
    await harness.waitUntil(() => harness.driver.currentSessionId !== null);
    assert.equal(harness.driver.currentSessionId, "fresh-session-1");
  } finally {
    harness.driver.stop({ sigtermGraceMs: 100 });
  }
});
