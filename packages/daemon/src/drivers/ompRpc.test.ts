import assert from "node:assert/strict";
import { test } from "vitest";
import { execFile } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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

test("omp attention RPC preserves recommendation and leaves notice-only bodies for targeted check", async () => {
  const { formatInboxUpdateRuntimeInput } = await import("../agentRuntimeInput.js");
  const { prepareTargetCheck } = await import("../agentInboxTargetCheck.js");
  const { AgentVisibleDeliveryLedger } = await import("../agentVisibleDeliveryLedger.js");
  const fake = await startFakeOmp("echo");
  try {
    await fake.waitReadyNegotiated();
    fake.driver.parseLine(JSON.stringify({ type: "agent_start" }));
    fake.driver.parseLine(JSON.stringify({ type: "turn_start" }));
    const messages: Parameters<typeof formatInboxUpdateRuntimeInput>[0] = [
      { channel_id: "channel-a", channel_name: "a", channel_type: "channel", sender_id: "u1", sender_type: "human", sender_name: "owner", timestamp: "2026-10-06T00:00:00Z", message_id: "ordinary", seq: 1, content: "ordinary body" },
      { channel_id: "dm-1", channel_name: "owner", channel_type: "dm", sender_id: "u1", sender_type: "human", sender_name: "owner", timestamp: "2026-10-06T00:00:01Z", message_id: "dm-1", seq: 2, content: "DM body" },
    ];
    const notice = formatInboxUpdateRuntimeInput(messages, fake.driver);
    const encoded = fake.driver.encodeStdinMessage(notice, null, { mode: "busy" });
    assert.ok(encoded);
    const frame = JSON.parse(encoded);
    assert.equal(frame.type, "steer");
    assert.match(frame.message, /Suggested first among these updates: "dm:@owner"/);
    assert.match(frame.message, /finish your current step/);
    assert.doesNotMatch(frame.message, /ordinary body|DM body/);
    fake.proc.stdin!.write(`${encoded}\n`);
    const plan = prepareTargetCheck(messages, { target: "dm:@owner" });
    assert.equal(plan.response.messages[0]?.content, "DM body", "steered notice is not a body read");
    const ledger = new AgentVisibleDeliveryLedger();
    const consumed = ledger.recordConsumed("agent-omp", { messages: plan.consumedMessages, source: "agent_api_events_local" })!;
    const remaining = messages.filter((message) => !consumed.shouldSuppress(message));
    assert.deepEqual(remaining.map((message) => message.message_id), ["ordinary"]);
    assert.equal(prepareTargetCheck(remaining, { target: "dm:@owner" }).response.returned_count, 0);
  } finally {
    fake.driver.stop({ sigtermGraceMs: 100 });
  }
});

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
if ((mode === "resume-crash" || mode === "resume-crash-late") && process.argv.includes("--resume")) {
  // A failed resume dies BEFORE the ready frame (session load happens
  // first); resume-crash-late models the slow path where extension
  // discovery + session load push the exit well past any fixed window
  // (PM task #4 r2: measured 1.6s on real omp 18.6.1).
  process.stderr.write("Could not restore model cursor/gone-model\\n");
  if (mode === "resume-crash-late") {
    setTimeout(() => process.exit(3), 1200);
  } else {
    process.exit(3);
  }
} else {
  send({ type: "ready", protocolVersion: 1, supportedProtocolVersions: [1, 2], maxFrameBytes: 1048576, maxReassembledFrameBytes: 67108864 });
}
const sessionId = process.argv.includes("--resume") ? process.argv[process.argv.indexOf("--resume") + 1] : "fresh-session-1";
if (process.argv[3] === "record") {
  fs.writeFileSync(process.argv[4], JSON.stringify(process.argv.slice(2)));
}
// Task #5 seams: launch argv/env proof and inbound frame logging, both
// keyed on env so the argv-based record seam above stays untouched.
if (process.env.OMP_FAKE_ARGV_LOG) {
  fs.writeFileSync(process.env.OMP_FAKE_ARGV_LOG, JSON.stringify({
    argv: process.argv.slice(2),
    pathHead: (process.env.PATH || "").split(process.platform === "win32" ? ";" : ":")[0],
    slockCliTransportDir: process.env.SLOCK_CLI_TRANSPORT_DIR || null,
    slockServerUrl: process.env.SLOCK_SERVER_URL || null,
  }, null, 2));
}
const frameLog = process.env.OMP_FAKE_FRAME_LOG
  ? (entry) => fs.appendFileSync(process.env.OMP_FAKE_FRAME_LOG, JSON.stringify(entry) + "\\n")
  : null;
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
    if (frameLog) frameLog(frame);
    if (mode === "host-tools" && frame.type === "prompt") {
      // Emulate omp calling back into the host (task #5): one managed tool
      // call per prompt; "cancel" follows with a host_tool_cancel.
      const toolMode = process.env.OMP_FAKE_HOST_TOOL_MODE || "call";
      const toolName = toolMode === "unknown"
        ? "missing_tool"
        : (process.env.OMP_FAKE_HOST_TOOL_NAME || "srv_tool");
      send({ type: "host_tool_call", id: "host_1", toolCallId: "toolu_1", toolName, arguments: { x: 1 } });
      if (toolMode === "cancel") {
        setTimeout(() => send({ type: "host_tool_cancel", id: "host_cancel_1", targetId: "host_1" }), 150);
      }
      continue;
    }
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

async function startSessionFake(
  mode: string,
  configSessionId: string | null,
  options: { prompt?: string | null } = {},
): Promise<SessionHarness> {
  const workspace = mkdtempSync(path.join(os.tmpdir(), "slock-omp-session-"));
  const scriptPath = path.join(workspace, "fake-omp-session.cjs");
  writeFileSync(scriptPath, FAKE_SESSION_SCRIPT);

  const driver = new OmpDriver();
  const ctx = makeSpawnContext(workspace);
  if (configSessionId) (ctx.config as { sessionId?: string | null }).sessionId = configSessionId;
  if (options.prompt !== undefined) ctx.prompt = (options.prompt ?? "") as typeof ctx.prompt;
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
  // The resume handoff leaves stdout explicitly paused; attaching a data
  // listener does not clear an explicit pause (verified on Node 26), so the
  // machinery resume() is part of the handover contract.
  proc.stdout?.resume();
  return harness;
}

test("delivery encoding follows omp's real run state, not the APM's belief (task #7)", async () => {
  const harness = await startSessionFake("echo", null);
  try {
    await harness.waitUntil(() => harness.driver.isProtocolSettled);
    const typeOf = (line: string | null): string => (JSON.parse(line ?? "{}") as { type?: string }).type ?? "?";

    // ① Cold start: no turn frame observed yet — even a "busy" delivery is a
    // prompt (state uncertain; a redundant prompt cannot deadlock).
    const cold = harness.driver.encodeStdinMessage("first message", null, { mode: "busy" });
    assert.equal(typeOf(cold), "prompt", "an unobserved run state must encode as prompt");
    assert.ok(cold && !cold.endsWith("\n"), "no trailing newline (runtimeSession adds it)");

    // ③ A run in progress (agent_start/turn_start seen, no boundary since):
    // busy rides the run as a steer; it ends with the original prompt's
    // prompt_result or session_settled.
    harness.driver.parseLine(JSON.stringify({ type: "agent_start" }));
    harness.driver.parseLine(JSON.stringify({ type: "turn_start" }));
    const midTurn = harness.driver.encodeStdinMessage("follow-up", null, { mode: "busy" });
    assert.equal(typeOf(midTurn), "steer", "an open run must take a steer");

    // ② After the boundary closes the round, the next delivery is a prompt
    // again, and each round produces exactly one turn_end.
    let turnEnds = 0;
    turnEnds += harness.driver.parseLine(JSON.stringify({ type: "message_end" })).filter((e) => e.kind === "turn_end").length;
    turnEnds += harness.driver.parseLine(JSON.stringify({ type: "prompt_result", id: "p1", agentInvoked: true, status: "completed", sessionSettled: true })).filter((e) => e.kind === "turn_end").length;
    assert.equal(turnEnds, 1, "exactly one turn_end per completed round");
    const afterRound = harness.driver.encodeStdinMessage("next round", null, { mode: "busy" });
    assert.equal(typeOf(afterRound), "prompt", "a closed run must encode as prompt");

    // ④ A restarted daemon (fresh driver, nothing observed) behaves like ①.
    // Covered structurally by the reset in spawn; the cold assertion above is
    // the same state.

    harness.proc.stdin?.write((cold ?? "") + "\n");
    harness.proc.stdin?.write((midTurn ?? "") + "\n");
    harness.proc.stdin?.write((afterRound ?? "") + "\n");
    await harness.sleep(150);
  } finally {
    harness.driver.stop({ sigtermGraceMs: 100 });
  }
});

test("a steer refused at the run boundary falls back to a prompt once (task #7 ⑤)", async () => {
  // prompt: "" keeps the fake's refuse-once aimed at THIS test's steer —
  // the startup carrier must not consume the refusal.
  const harness = await startSessionFake("refuse-delivery", null, { prompt: "" });
  try {
    await harness.waitUntil(() => harness.driver.isProtocolSettled);

    // Open a run so the busy delivery encodes as a steer.
    harness.driver.parseLine(JSON.stringify({ type: "agent_start" }));
    harness.driver.parseLine(JSON.stringify({ type: "turn_start" }));
    const steer = harness.driver.encodeStdinMessage("mid-turn message", null, { mode: "busy" });
    assert.equal((JSON.parse(steer ?? "{}") as { type?: string }).type, "steer");
    harness.proc.stdin?.write(steer + "\n");

    // The fake refuses the first steer; the driver must re-deliver the same
    // message as a prompt, and the fake (refuse-once) accepts it.
    await harness.waitUntil(() => harness.events.some((event) => event.kind === "error" && /steer/.test(event.message)), 3000);
    await harness.sleep(300);
    const promptErrors = harness.events.filter((event) => event.kind === "error" && /prompt/.test(event.message));
    assert.equal(promptErrors.length, 0, "the prompt fallback must not surface as an error");
  } finally {
    harness.driver.stop({ sigtermGraceMs: 100 });
  }
});

test("a refused prompt or steer surfaces as an error event", async () => {
  // prompt: "" keeps the fake's refuse-once aimed at THIS test's delivery.
  const harness = await startSessionFake("refuse-delivery", null, { prompt: "" });
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

test("a resume that exits late (past any fixed window) still falls back", async () => {
  // PM task #4 r2: the fallback condition is exit-before-ready, not a fixed
  // timer — real omp's extension discovery + session load can push a failed
  // resume's exit well past a small window (measured 1.6s on 18.6.1).
  const harness = await startSessionFake("resume-crash-late", "lost-session-late");
  try {
    await harness.waitUntil(() => harness.driver.currentSessionId !== null, 8000);

    assert.equal(harness.driver.currentSessionId, "fresh-session-1", "the late exit must still fall back to a fresh session");
    const diagnostic = harness.events.find((event) => event.kind === "runtime_diagnostic") as { message?: string };
    assert.ok(diagnostic, "the fallback must surface a diagnostic");
    assert.match(diagnostic.message ?? "", /lost-session-late/);
  } finally {
    harness.driver.stop({ sigtermGraceMs: 100 });
  }
});

test("resume handoff delivers every byte exactly once, in wire order", async () => {
  // PM task #4 r3: ready + a following frame + half a negotiate response
  // sharing ONE write must all survive the resume handoff — the scanner
  // pauses the stream at handoff and unshifts the tail, so the session
  // machinery's reader replays every byte and completes the partial line.
  const workspace = mkdtempSync(path.join(os.tmpdir(), "slock-omp-handoff-"));
  const scriptPath = path.join(workspace, "fake-omp-handoff.cjs");
  // Negotiate is the first request after spawn (the counter resets per
  // launch), so its id is omp-1 and the fake can pre-write half the response.
  const negotiateResponse = JSON.stringify({
    id: "omp-1",
    type: "response",
    command: "negotiate_protocol",
    success: true,
    data: { protocolVersion: 2 },
  });
  const negotiateFirstHalf = negotiateResponse.slice(0, Math.floor(negotiateResponse.length / 2));
  writeFileSync(scriptPath, `
const ready = JSON.stringify({ type: "ready", protocolVersion: 1, supportedProtocolVersions: [1, 2], maxFrameBytes: 1048576, maxReassembledFrameBytes: 67108864 });
const toolCall = JSON.stringify({ type: "tool_execution_start", toolCallId: "call-1", toolName: "read", args: { path: "a.txt" } });
// ONE write: ready + notice frame + the first half of a negotiate response.
process.stdout.write(ready + "\\n" + toolCall + "\\n" + ${JSON.stringify(negotiateFirstHalf)});
let buffer = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  let index;
  while ((index = buffer.indexOf("\\n")) >= 0) {
    const line = buffer.slice(0, index);
    buffer = buffer.slice(index + 1);
    if (!line.trim()) continue;
    const frame = JSON.parse(line);
    if (frame.type === "negotiate_protocol") {
      // The remaining half arrives later; it completes the unshifted partial line.
      process.stdout.write(${JSON.stringify(negotiateResponse.slice(Math.floor(negotiateResponse.length / 2)))} + "\\n");
    } else if (frame.type === "get_state") {
      process.stdout.write(JSON.stringify({ id: frame.id, type: "response", command: "get_state", success: true, data: { sessionId: "handoff-session-1" } }) + "\\n");
    }
  }
});
`);

  const driver = new OmpDriver();
  const ctx = makeSpawnContext(workspace);
  (ctx.config as { sessionId?: string | null }).sessionId = "recorded-handoff";
  const { process: proc } = await driver.spawn(ctx, {
    command: process.execPath,
    extraArgs: [scriptPath],
  });

  // The session machinery: every complete stdout line goes through parseLine.
  const events: ParsedEvent[] = [];
  let stdoutBuffer = "";
  proc.stdout?.setEncoding("utf8");
  proc.stdout?.on("data", (chunk: string) => {
    stdoutBuffer += chunk;
    let index: number;
    while ((index = stdoutBuffer.indexOf("\n")) >= 0) {
      const line = stdoutBuffer.slice(0, index);
      stdoutBuffer = stdoutBuffer.slice(index + 1);
      if (line.trim()) events.push(...driver.parseLine(line));
    }
  });
  // Same handover contract as the production machinery: clear the explicit
  // pause the resume handoff left on the stream.
  proc.stdout?.resume();

  try {
    const started = Date.now();
    while ((!driver.isProtocolSettled || driver.currentSessionId === null) && Date.now() - started < 5000) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }

    const kinds = events.map((event) => event.kind);
    assert.deepEqual(
      kinds.filter((kind) => kind === "tool_call"),
      ["tool_call"],
      "the tool call sharing the ready chunk must be mapped exactly once",
    );
    assert.ok(kinds.indexOf("tool_call") < kinds.indexOf("session_init"), "wire order must be preserved into the event stream");
    assert.ok(events.some((event) => event.kind === "session_init"), "get_state after settle must announce session_init");
    assert.equal(driver.currentSessionId, "handoff-session-1");
    assert.equal(driver.activeProtocolVersion, 2, "the split negotiate response must complete and settle v2");
    assert.equal(driver.frameErrors.count, 0, "no byte may be lost or duplicated into a frame error");
  } finally {
    driver.stop({ sigtermGraceMs: 100 });
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

// ============================================================================
// Spawn_prompt carrier — the APM books launch activation as
// delivered(spawn_prompt), so the driver MUST forward ctx.prompt itself
// (resume launches strand the startup input otherwise: the session_init
// fallback never fires when the session id is preset and unchanged).
// ============================================================================

test("fresh launch forwards ctx.prompt as exactly one post-handshake prompt", async () => {
  const frameLogPath = path.join(os.tmpdir(), `slock-omp-startup-fresh-${process.pid}-${Date.now()}.jsonl`);
  process.env.OMP_FAKE_FRAME_LOG = frameLogPath;
  let harness: SessionHarness | null = null;
  try {
    harness = await startSessionFake("echo", null);
    await harness.waitUntil(() => existsSync(frameLogPath) && readJsonLines(frameLogPath).some((frame) => frame.type === "prompt" && frame.message === "hello"));
    await harness.sleep(250);
    const prompts = readJsonLines(frameLogPath).filter((frame) => frame.type === "prompt");
    assert.equal(prompts.length, 1, "exactly one startup prompt, no duplicates");
    assert.equal(harness.events.filter((event) => event.kind === "error").length, 0, "the carrier delivery must resolve cleanly");
  } finally {
    harness?.driver.stop({ sigtermGraceMs: 100 });
    delete process.env.OMP_FAKE_FRAME_LOG;
    rmSync(frameLogPath, { force: true });
  }
});

test("resume launch forwards ctx.prompt once after the handshake settles", async () => {
  const frameLogPath = path.join(os.tmpdir(), `slock-omp-startup-resume-${process.pid}-${Date.now()}.jsonl`);
  process.env.OMP_FAKE_FRAME_LOG = frameLogPath;
  let harness: SessionHarness | null = null;
  try {
    harness = await startSessionFake("echo", "recorded-session-42");
    await harness.waitUntil(() => existsSync(frameLogPath) && readJsonLines(frameLogPath).some((frame) => frame.type === "prompt" && frame.message === "hello"));
    await harness.sleep(250);
    const prompts = readJsonLines(frameLogPath).filter((frame) => frame.type === "prompt");
    assert.equal(prompts.length, 1, "the resume launch must deliver the startup input exactly once");
    assert.equal(harness.driver.currentSessionId, "recorded-session-42", "the carrier rides the resumed session");
  } finally {
    harness?.driver.stop({ sigtermGraceMs: 100 });
    delete process.env.OMP_FAKE_FRAME_LOG;
    rmSync(frameLogPath, { force: true });
  }
});

test("a failed resume re-mounts the carrier so the startup input is not lost", async () => {
  const frameLogPath = path.join(os.tmpdir(), `slock-omp-startup-fallback-${process.pid}-${Date.now()}.jsonl`);
  process.env.OMP_FAKE_FRAME_LOG = frameLogPath;
  let harness: SessionHarness | null = null;
  try {
    harness = await startSessionFake("resume-crash", "lost-session-7");
    await harness.waitUntil(() => harness.driver.currentSessionId === "fresh-session-1", 5000);
    await harness.waitUntil(() => existsSync(frameLogPath) && readJsonLines(frameLogPath).some((frame) => frame.type === "prompt" && frame.message === "hello"));
    const prompts = readJsonLines(frameLogPath).filter((frame) => frame.type === "prompt");
    assert.equal(prompts.length, 1, "the carrier must re-mount on the fallback launch and deliver once");
  } finally {
    harness?.driver.stop({ sigtermGraceMs: 100 });
    delete process.env.OMP_FAKE_FRAME_LOG;
    rmSync(frameLogPath, { force: true });
  }
});

test("no ctx.prompt — the carrier sends no startup prompt", async () => {
  const frameLogPath = path.join(os.tmpdir(), `slock-omp-startup-none-${process.pid}-${Date.now()}.jsonl`);
  process.env.OMP_FAKE_FRAME_LOG = frameLogPath;
  let harness: SessionHarness | null = null;
  try {
    harness = await startSessionFake("echo", null, { prompt: "" });
    await harness.waitUntil(() => harness.driver.isProtocolSettled);
    await harness.sleep(300);
    const prompts = existsSync(frameLogPath) ? readJsonLines(frameLogPath).filter((frame) => frame.type === "prompt") : [];
    assert.equal(prompts.length, 0, "an empty ctx.prompt must not produce a startup prompt");
  } finally {
    harness?.driver.stop({ sigtermGraceMs: 100 });
    delete process.env.OMP_FAKE_FRAME_LOG;
    rmSync(frameLogPath, { force: true });
  }
});

// ============================================================================
// Task #5 — Raft integration: system prompt, CLI env, managed MCP host tools
// ============================================================================

import type { Server as HttpServer, IncomingMessage, ServerResponse } from "node:http";
import { createServer as createHttpServer } from "node:http";

const MANAGED_TOOL_SNAPSHOT = {
  catalogVersion: 1,
  tools: [
    {
      mcpServerId: "mcp_1",
      serverName: "srv",
      toolName: "real_tool",
      runtimeName: "srv_tool",
      title: "Managed Tool",
      description: "A managed tool for tests",
      inputSchema: { type: "object", properties: { x: { type: "number" } }, required: ["x"] },
      configVersion: 1,
      assignmentVersion: 1,
    },
  ],
};

interface ManagedMcpMock {
  url: string;
  /** Bodies received on POST /internal/agent-api/mcp/call. */
  calls: Array<Record<string, unknown>>;
  /** Resolves when a /call request closes WITHOUT a response (client abort). */
  waitAborted(): Promise<void>;
  close(): Promise<void>;
}

function startManagedMcpMock(opts: { callResult?: unknown; callStatus?: number } = {}): Promise<ManagedMcpMock> {
  return new Promise((resolve) => {
    const calls: Array<Record<string, unknown>> = [];
    let abortWait: (() => void) | null = null;
    const server: HttpServer = createHttpServer((req: IncomingMessage, res: ServerResponse) => {
      if (req.url === "/internal/agent-api/mcp/tools") {
        res.setHeader("Content-Type", "application/json");
        res.end(JSON.stringify(MANAGED_TOOL_SNAPSHOT));
        return;
      }
      if (req.url === "/internal/agent-api/mcp/call" && req.method === "POST") {
        let body = "";
        req.on("data", (chunk: Buffer) => {
          body += chunk.toString("utf8");
        });
        req.on("end", () => {
          calls.push(JSON.parse(body || "{}") as Record<string, unknown>);
          // A hanging call models a long-running tool; the abort test relies
          // on the server observing the socket close before any response.
          if (opts.callStatus === 0) {
            abortWait?.();
            req.on("close", () => abortWait?.());
            return;
          }
          res.setHeader("Content-Type", "application/json");
          res.statusCode = opts.callStatus ?? 200;
          res.end(JSON.stringify(opts.callResult ?? { content: [{ type: "text", text: "managed-ok" }] }));
        });
        return;
      }
      res.statusCode = 404;
      res.end("{}");
    });
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      resolve({
        url: `http://127.0.0.1:${port}`,
        calls,
        waitAborted: () => new Promise((resolveAbort) => {
          abortWait = resolveAbort;
        }),
        close: () => new Promise((resolveClose) => server.close(() => resolveClose())),
      });
    });
  });
}

function readJsonLines(filePath: string): Array<Record<string, unknown>> {
  return readFileSync(filePath, "utf8")
    .split("\n")
    .filter((line) => line.trim())
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

interface HostToolsHarness {
  driver: OmpDriver;
  proc: import("node:child_process").ChildProcess;
  events: ParsedEvent[];
  mock: ManagedMcpMock;
  frameLogPath: string;
  argvLogPath: string;
  waitUntil(predicate: () => boolean, ms?: number): Promise<void>;
  cleanup(): void;
}

async function startHostToolsFake(options: {
  sessionId?: string | null;
  standingPrompt?: string;
  hostToolMode?: "call" | "unknown" | "cancel";
  mock?: ManagedMcpMock;
  prompt?: string | null;
} = {}): Promise<HostToolsHarness> {
  const workspace = mkdtempSync(path.join(os.tmpdir(), "slock-omp-hosttools-"));
  const scriptPath = path.join(workspace, "fake-omp-session.cjs");
  writeFileSync(scriptPath, FAKE_SESSION_SCRIPT);
  const mock = options.mock ?? await startManagedMcpMock();

  const frameLogPath = path.join(workspace, "frames.log");
  const argvLogPath = path.join(workspace, "argv.json");
  process.env.OMP_FAKE_FRAME_LOG = frameLogPath;
  process.env.OMP_FAKE_ARGV_LOG = argvLogPath;
  if (options.hostToolMode) process.env.OMP_FAKE_HOST_TOOL_MODE = options.hostToolMode;

  const driver = new OmpDriver();
  const ctx = makeSpawnContext(workspace);
  ctx.config.serverUrl = mock.url;
  (ctx.config as { agentCredentialKey?: string | null }).agentCredentialKey = "test-agent-credential";
  if (options.sessionId) (ctx.config as { sessionId?: string | null }).sessionId = options.sessionId;
  if (options.standingPrompt) ctx.standingPrompt = options.standingPrompt;
  if (options.prompt !== undefined) ctx.prompt = (options.prompt ?? "") as typeof ctx.prompt;
  const { process: proc } = await driver.spawn(ctx, {
    command: process.execPath,
    extraArgs: [scriptPath, "host-tools"],
  });

  const events: ParsedEvent[] = [];
  let stdoutBuffer = "";
  proc.stdout?.setEncoding("utf8");
  proc.stdout?.on("data", (chunk: string) => {
    stdoutBuffer += chunk;
    let index: number;
    while ((index = stdoutBuffer.indexOf("\n")) >= 0) {
      const line = stdoutBuffer.slice(0, index);
      stdoutBuffer = stdoutBuffer.slice(index + 1);
      if (line.trim()) events.push(...driver.parseLine(line));
    }
  });
  proc.stdout?.resume();

  const cleanup = (): void => {
    driver.stop({ sigtermGraceMs: 100 });
    delete process.env.OMP_FAKE_FRAME_LOG;
    delete process.env.OMP_FAKE_ARGV_LOG;
    delete process.env.OMP_FAKE_HOST_TOOL_MODE;
  };

  return {
    driver,
    proc,
    events,
    mock,
    frameLogPath,
    argvLogPath,
    waitUntil: async (predicate: () => boolean, ms = 5000) => {
      const started = Date.now();
      while (!predicate() && Date.now() - started < ms) {
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
    },
    cleanup,
  };
}

test("managed tools ride the ready chain: set_host_tools lands before get_state and before whenReady", async () => {
  const harness = await startHostToolsFake();
  try {
    await harness.waitUntil(() => harness.driver.isProtocolSettled);
    const frames = readJsonLines(harness.frameLogPath);
    const types = frames.map((frame) => frame.type as string);
    const negotiate = types.indexOf("negotiate_protocol");
    const setTools = types.indexOf("set_host_tools");
    const getState = types.indexOf("get_state");
    assert.ok(negotiate >= 0 && setTools > negotiate && getState > setTools,
      `registration must sit between negotiate and get_state, saw: ${types.join(",")}`);
    const setToolsFrame = frames[setTools] as { tools?: Array<{ name?: string; parameters?: { required?: string[] } }> };
    assert.equal(setToolsFrame.tools?.[0]?.name, "srv_tool");
    assert.deepEqual(setToolsFrame.tools?.[0]?.parameters?.required, ["x"], "the input schema must pass through");
    // The spawn_prompt carrier (ctx.prompt forwarding): the startup prompt
    // may only reach omp AFTER host tools register — the first model call of
    // the launch must see the managed tools (task #5 contract).
    const startupPromptIndex = types.indexOf("prompt");
    assert.ok(startupPromptIndex > setTools, `startup prompt must follow host tool registration, saw: ${types.join(",")}`);
    const startupPrompt = frames[startupPromptIndex] as { message?: string };
    assert.equal(startupPrompt.message, "hello", "the carrier forwards the launch's ctx.prompt verbatim");
  } finally {
    harness.cleanup();
    await harness.mock.close();
  }
});

test("a host tool call executes against the managed endpoint and completes exactly once", async () => {
  const harness = await startHostToolsFake({ hostToolMode: "call", prompt: "" });
  try {
    await harness.waitUntil(() => harness.driver.isProtocolSettled);

    const idle = harness.driver.encodeStdinMessage("run the tool", null, { mode: "idle" });
    harness.proc.stdin?.write(idle + "\n");
    await harness.waitUntil(() => readJsonLines(harness.frameLogPath).some((frame) => frame.type === "host_tool_result"));

    const results = readJsonLines(harness.frameLogPath).filter((frame) => frame.type === "host_tool_result");
    assert.equal(results.length, 1, "exactly one completion per host_tool_call");
    const result = results[0] as { id: string; isError?: boolean; result?: { content?: Array<{ text?: string }> } };
    assert.equal(result.id, "host_1");
    assert.notEqual(result.isError, true);
    assert.equal(result.result?.content?.[0]?.text, "managed-ok");
    assert.deepEqual(harness.mock.calls, [
      {
        mcpServerId: "mcp_1",
        toolName: "real_tool",
        arguments: { x: 1 },
        expectedConfigVersion: 1,
        expectedAssignmentVersion: 1,
      },
    ], "the managed call must carry the snapshot's identity and version pins");
  } finally {
    harness.cleanup();
    await harness.mock.close();
  }
});

test("a managed tool error surfaces as an isError host_tool_result", async () => {
  const mock = await startManagedMcpMock({ callResult: { content: [{ type: "text", text: "boom" }], isError: true } });
  const harness = await startHostToolsFake({ hostToolMode: "call", mock, prompt: "" });
  try {
    await harness.waitUntil(() => harness.driver.isProtocolSettled);
    const idle = harness.driver.encodeStdinMessage("run the tool", null, { mode: "idle" });
    harness.proc.stdin?.write(idle + "\n");
    await harness.waitUntil(() => readJsonLines(harness.frameLogPath).some((frame) => frame.type === "host_tool_result"));
    const result = readJsonLines(harness.frameLogPath).find((frame) => frame.type === "host_tool_result") as { isError?: boolean; result?: { content?: Array<{ text?: string }> } };
    assert.equal(result.isError, true, "the tool error must reach omp as isError");
    assert.equal(result.result?.content?.[0]?.text, "boom");
  } finally {
    harness.cleanup();
    await mock.close();
  }
});

test("an unknown host tool is refused immediately without touching the endpoint", async () => {
  const harness = await startHostToolsFake({ hostToolMode: "unknown", prompt: "" });
  try {
    await harness.waitUntil(() => harness.driver.isProtocolSettled);
    const idle = harness.driver.encodeStdinMessage("run the tool", null, { mode: "idle" });
    harness.proc.stdin?.write(idle + "\n");
    await harness.waitUntil(() => readJsonLines(harness.frameLogPath).some((frame) => frame.type === "host_tool_result"));
    const result = readJsonLines(harness.frameLogPath).find((frame) => frame.type === "host_tool_result") as { isError?: boolean; result?: { content?: Array<{ text?: string }> } };
    assert.equal(result.isError, true);
    assert.match(result.result?.content?.[0]?.text ?? "", /missing_tool/);
    assert.equal(harness.mock.calls.length, 0, "no managed call may leave the daemon");
  } finally {
    harness.cleanup();
    await harness.mock.close();
  }
});

test("host_tool_cancel aborts the in-flight managed call and no result is sent", async () => {
  // callStatus 0 = the mock holds the request open and reports client aborts.
  const mock = await startManagedMcpMock({ callStatus: 0 });
  const harness = await startHostToolsFake({ hostToolMode: "cancel", mock, prompt: "" });
  try {
    await harness.waitUntil(() => harness.driver.isProtocolSettled);
    const idle = harness.driver.encodeStdinMessage("run the tool", null, { mode: "idle" });
    harness.proc.stdin?.write(idle + "\n");

    await harness.waitUntil(() => readJsonLines(harness.frameLogPath).some((frame) => frame.type === "host_tool_cancel"));
    await Promise.race([harness.mock.waitAborted(), new Promise((resolve) => setTimeout(resolve, 3000))]);

    const results = readJsonLines(harness.frameLogPath).filter((frame) => frame.type === "host_tool_result");
    assert.equal(results.length, 0, "a cancelled call must not complete");
  } finally {
    harness.cleanup();
    await mock.close();
  }
});

test("launch argv carries the standing prompt file and the isolation overlay, fresh and resumed", async () => {
  const STANDING = "RAFT-STANDING-PROMPT-MARKER alpha beta";
  // Fresh launch.
  const fresh = await startHostToolsFake({ standingPrompt: STANDING });
  let argvDump: { argv: string[]; pathHead: string; slockCliTransportDir: string | null; slockServerUrl: string | null };
  try {
    await fresh.waitUntil(() => fresh.driver.isProtocolSettled);
    argvDump = JSON.parse(readFileSync(fresh.argvLogPath, "utf8")) as typeof argvDump;
    const promptFlag = argvDump.argv.indexOf("--append-system-prompt");
    const configFlag = argvDump.argv.indexOf("--config");
    assert.ok(promptFlag > 0 && configFlag > promptFlag, `argv must carry both flags: ${argvDump.argv.join(" ")}`);
    const promptFile = readFileSync(argvDump.argv[promptFlag + 1], "utf8");
    assert.ok(promptFile.includes(STANDING), "the prompt file must carry the standing prompt");
    assert.ok(promptFile.startsWith("以下 Raft 指引优先"), "appended content must open with the precedence declaration (task #7 ruling)");
    const overlay = readFileSync(argvDump.argv[configFlag + 1], "utf8");
    assert.match(overlay, /disabledExtensions:/);
    for (const name of ["AGENTS.md", "CLAUDE.md", "GEMINI.md", "copilot-instructions.md"]) {
      assert.ok(overlay.includes(`- context-file:project:${name}`), `overlay must disable the project-level ${name}`);
    }
    assert.ok(!overlay.includes("disabledProviders:"), "provider-level kills stay off: user-level context remains loaded (PM ruling)");
    // CLI env proof (task #5 acceptance): the raft wrapper dir leads PATH.
    assert.equal(argvDump.pathHead, argvDump.slockCliTransportDir, "the CLI transport dir must lead PATH so bash reaches raft");
    assert.equal(argvDump.slockServerUrl, fresh.mock.url, "the server URL env must point at the daemon endpoint");
  } finally {
    fresh.cleanup();
    await fresh.mock.close();
  }

  // Resumed launch (and every wake that spawns again): same flags, plus --resume.
  const resumed = await startHostToolsFake({ standingPrompt: STANDING, sessionId: "recorded-handoff" });
  try {
    await resumed.waitUntil(() => resumed.driver.isProtocolSettled);
    const dump = JSON.parse(readFileSync(resumed.argvLogPath, "utf8")) as { argv: string[] };
    assert.ok(dump.argv.includes("--append-system-prompt"), "resumed launch must carry --append-system-prompt");
    assert.ok(dump.argv.includes("--config"), "resumed launch must carry the isolation overlay");
    const resumeFlag = dump.argv.indexOf("--resume");
    assert.ok(resumeFlag > 0 && dump.argv[resumeFlag + 1] === "recorded-handoff");
    assert.ok(readFileSync(dump.argv[dump.argv.indexOf("--append-system-prompt") + 1], "utf8").includes(STANDING));
  } finally {
    resumed.cleanup();
    await resumed.mock.close();
  }
});

// ============================================================================
// Task #6 — models & login: detectModels, --model/--thinking launch fields
// ============================================================================

import { detectOmpModels, mapOmpThinkingLevel } from "./omp.js";

const FAKE_DETECT_SCRIPT = `
const mode = process.argv[2];
const send = (frame) => process.stdout.write(JSON.stringify(frame) + "\\n");
send({ type: "ready", protocolVersion: 1, supportedProtocolVersions: [1, 2], maxFrameBytes: 1048576, maxReassembledFrameBytes: 67108864 });
let buffer = "";
process.stdin.setEncoding("utf8");
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
    } else if (frame.type === "get_login_providers") {
      const providers = mode === "detect-nologin"
        ? [{ id: "cursor", available: true, authenticated: false }, { id: "kimi-code", available: true, authenticated: false }]
        : [{ id: "cursor", available: true, authenticated: false }, { id: "kimi-code", available: true, authenticated: true }];
      send({ id: frame.id, type: "response", command: "get_login_providers", success: true, data: { providers } });
    } else if (frame.type === "get_available_models") {
      const models = mode === "detect-empty" ? [] : [
        { id: "k3", provider: "kimi-code", name: "K3", reasoning: true, thinking: { efforts: ["low", "medium", "high", "xhigh"] } },
        { id: "composer-1", provider: "cursor", name: "Composer 1", reasoning: false },
        { id: "ghost", provider: "unauthenticated-provider", name: "Ghost" },
      ];
      send({ id: frame.id, type: "response", command: "get_available_models", success: true, data: { models } });
    }
  }
});
`;

test("detectModels returns live launchable models filtered to authenticated providers", async () => {
  const outcome = await detectOmpModels({
    command: process.execPath,
    args: [writeDetectScript("detect-ok"), "detect-ok"],
  });
  assert.equal(outcome.kind, "live");
  const models = outcome.kind === "live" ? outcome.value.models : [];
  assert.deepEqual(models.map((model) => model.id), ["kimi-code/k3"],
    "unauthenticated providers (cursor, ghost) must be dropped (cross-check against get_login_providers)");
  assert.equal(models[0]?.verified, "launchable");
  assert.match(models[0]?.label ?? "", /K3/);
  assert.deepEqual(models[0]?.supportedReasoningEfforts, ["low", "medium", "high", "xhigh"]);
});

test("detectModels reports missing_config with omp_login recovery when nothing is logged in", async () => {
  const outcome = await detectOmpModels({
    command: process.execPath,
    args: [writeDetectScript("detect-nologin"), "detect-nologin"],
  });
  assert.deepEqual(outcome, { kind: "missing_config", recovery: "omp_login" });
});

test("detectModels reports no_models when logged in but the catalog is empty", async () => {
  const outcome = await detectOmpModels({
    command: process.execPath,
    args: [writeDetectScript("detect-empty"), "detect-empty"],
  });
  assert.deepEqual(outcome, { kind: "no_models", recovery: "omp_login" });
});

test("mapOmpThinkingLevel maps Raft efforts onto omp's vocabulary", () => {
  assert.equal(mapOmpThinkingLevel("low"), "low");
  assert.equal(mapOmpThinkingLevel("xhigh"), "xhigh");
  assert.equal(mapOmpThinkingLevel("max"), "max");
  assert.equal(mapOmpThinkingLevel("ultra"), "max", "ultra clamps to omp's top level");
  assert.equal(mapOmpThinkingLevel("nonsense"), null);
});

function writeDetectScript(mode: string): string {
  const workspace = mkdtempSync(path.join(os.tmpdir(), "slock-omp-detect-"));
  const scriptPath = path.join(workspace, "fake-omp-detect.cjs");
  writeFileSync(scriptPath, FAKE_DETECT_SCRIPT);
  return scriptPath;
}

test("launch argv carries --model and --thinking from the runtime config", async () => {
  const workspace = mkdtempSync(path.join(os.tmpdir(), "slock-omp-launch-"));
  const scriptPath = path.join(workspace, "fake-omp-session.cjs");
  writeFileSync(scriptPath, FAKE_SESSION_SCRIPT);
  const argvLogPath = path.join(workspace, "argv.json");
  process.env.OMP_FAKE_ARGV_LOG = argvLogPath;

  const driver = new OmpDriver();
  const ctx = makeSpawnContext(workspace);
  ctx.config = { ...ctx.config, model: "cursor/k3", reasoningEffort: "ultra" } as typeof ctx.config;
  const spawn = await driver.spawn(ctx, { command: process.execPath, extraArgs: [scriptPath, "echo"] });
  try {
    // The fake dumps argv at startup; poll briefly for the file to land.
    const started = Date.now();
    while (!existsSync(argvLogPath) && Date.now() - started < 3000) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    const dump = JSON.parse(readFileSync(argvLogPath, "utf8")) as { argv: string[] };
    const modelFlag = dump.argv.indexOf("--model");
    const thinkingFlag = dump.argv.indexOf("--thinking");
    assert.ok(modelFlag > 0, `argv must carry --model: ${dump.argv.join(" ")}`);
    assert.equal(dump.argv[modelFlag + 1], "cursor/k3");
    assert.ok(thinkingFlag > modelFlag, "argv must carry --thinking");
    assert.equal(dump.argv[thinkingFlag + 1], "max", "ultra must clamp to omp's max level");
  } finally {
    driver.stop({ sigtermGraceMs: 100 });
    delete process.env.OMP_FAKE_ARGV_LOG;
  }
});

test("a bad --model id surfaces the omp stderr through the whenReady rejection", async () => {
  const workspace = mkdtempSync(path.join(os.tmpdir(), "slock-omp-badmodel-"));
  const scriptPath = path.join(workspace, "fake-omp-badmodel.cjs");
  // Real omp exits BEFORE the ready frame with a "Model not found" stderr
  // when --model names an unknown id (measured on 18.6.1); the fake mirrors
  // that shape. The fresh-launch flow resolves spawn() immediately and the
  // failure surfaces through whenReady().
  writeFileSync(scriptPath, `
if (process.argv.includes("--model")) {
  process.stderr.write("Model not found: cursor/definitely-not-XYZ\\n");
  process.stderr.write("Run omp models find <pattern> to search, or omp models to list all.\\n");
  process.exit(3);
}
process.stdout.write(JSON.stringify({ type: "ready", protocolVersion: 1, supportedProtocolVersions: [1, 2], maxFrameBytes: 1048576, maxReassembledFrameBytes: 67108864 }) + "\\n");
process.stdin.setEncoding("utf8");
process.stdin.on("data", () => {});
`);

  const driver = new OmpDriver();
  const ctx = makeSpawnContext(workspace);
  ctx.config = { ...ctx.config, model: "cursor/definitely-not-XYZ" } as typeof ctx.config;
  await driver.spawn(ctx, { command: process.execPath, extraArgs: [scriptPath] });
  await assert.rejects(
    () => driver.whenReady(),
    (error: unknown) => {
      assert.ok(error instanceof OmpRpcProcessExitedError, `expected OmpRpcProcessExitedError, got ${String(error)}`);
      assert.match(error.message, /Model not found/);
      assert.match(error.message, /omp models find/, "the stderr guidance must reach the operator");
      return true;
    },
    "the failure must surface quickly instead of waiting out the ready timer",
  );
});
