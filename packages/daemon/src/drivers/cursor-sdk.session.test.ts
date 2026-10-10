import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "vitest";
import { CURSOR_SDK_RESUME_UNUSABLE_MARKER } from "../cursorSdk/sessionReset.js";
import {
  CursorSdkAssetsUnavailableError,
  CursorSdkRuntimeSession,
  type CursorSdkCredentialLease,
  type CursorSdkHostConnection,
  type CursorSdkHostSpawnInput,
  type CursorSdkRuntimeSessionDeps,
} from "./cursor-sdk.js";
import type {
  CursorSdkHostboundMessage,
  CursorSdkHostToDriverMessage,
} from "../cursorSdk/protocol.js";
import type { AgentConfig } from "@botiverse/raft-shared";
import type { ParsedEvent, RuntimeExitInfo, SpawnContext } from "./types.js";

// ── Test plumbing ────────────────────────────────────────────────────────────

const FIXTURE_HOST_PATH = fileURLToPath(
  new URL("../cursorSdk/testdata/fakeCursorSdkHost.mjs", import.meta.url),
);

function makeConfig(overrides: Partial<AgentConfig> = {}): AgentConfig {
  return {
    name: "Cursor Agent",
    displayName: null,
    description: null,
    runtime: "cursor-sdk",
    serverUrl: "https://slock.example",
    authToken: "agent-token",
    sessionId: null,
    model: "default",
    reasoningEffort: null,
    envVars: null,
    runtimeContext: null,
    ...overrides,
  };
}

function makeSpawnContext(overrides: Partial<SpawnContext> = {}): SpawnContext {
  return {
    agentId: "agent-1",
    standingPrompt: "standing instructions" as SpawnContext["standingPrompt"],
    prompt: "wake prompt" as SpawnContext["prompt"],
    // Must be a real directory: real-child tests spawn the host with this cwd.
    workingDirectory: os.tmpdir(),
    slockCliPath: "/tmp/slock-cli.js",
    daemonApiKey: "daemon-token",
    config: makeConfig(),
    ...overrides,
  };
}

/**
 * In-process scripted host connection. Handshake is auto-answered so tests
 * control every later message deterministically.
 */
class ScriptedHostConnection implements CursorSdkHostConnection {
  readonly pid = 424_242;
  readonly sent: CursorSdkHostboundMessage[] = [];
  /** Recorded terminations, e.g. ["group:SIGTERM", "group:SIGKILL"]. */
  readonly signals: string[] = [];
  sendRefusals = 0;
  /** When false, init_result is NOT auto-answered (test drives it manually). */
  autoInitResult = true;
  /**
   * When true (default), a `stop` message is answered like the production
   * host: shutdown_settled clean, then a real exit(0). Races under test set
   * this false to withhold the ACK or the exit.
   */
  autoStopSettle = true;
  private readonly bus = new EventEmitter();

  deliver(message: CursorSdkHostToDriverMessage): void {
    this.bus.emit("message", message);
  }

  emitStderr(text: string): void {
    this.bus.emit("stderr", text);
  }

  exitNow(code: number | null, signal: NodeJS.Signals | null): void {
    this.bus.emit("exit", { code, signal });
  }

  send(message: CursorSdkHostboundMessage): boolean {
    if (this.sendRefusals > 0) {
      this.sendRefusals -= 1;
      return false;
    }
    this.sent.push(message);
    if (message.kind === "init") {
      queueMicrotask(() => {
        this.deliver({ kind: "host_ready", protocolVersion: 1 });
        if (this.autoInitResult) {
          this.deliver({ kind: "init_result", ok: true, sessionId: null });
        }
      });
    }
    if (message.kind === "stop" && this.autoStopSettle) {
      queueMicrotask(() => {
        this.deliver({ kind: "shutdown_settled", outcome: "clean" });
        setTimeout(() => this.exitNow(0, null), 5);
      });
    }
    return true;
  }

  terminate(signal: NodeJS.Signals): void {
    this.signals.push(`pid:${signal}`);
  }

  terminateGroup(signal: NodeJS.Signals): void {
    this.signals.push(`group:${signal}`);
  }

  onMessage(cb: (message: unknown) => void): void {
    this.bus.on("message", cb);
  }

  onStderr(cb: (text: string) => void): void {
    this.bus.on("stderr", cb);
  }

  onExit(cb: (info: { code: number | null; signal: NodeJS.Signals | null }) => void): void {
    this.bus.on("exit", cb);
  }

  runs(): CursorSdkHostboundMessage[] {
    return this.sent.filter((m) => m.kind === "run_submit");
  }

  steers(): CursorSdkHostboundMessage[] {
    return this.sent.filter((m) => m.kind === "steer_submit");
  }
}

interface CapturedRun {
  events: ParsedEvent[];
  stderrTexts: string[];
  errors: Error[];
  exits: RuntimeExitInfo[];
  closes: RuntimeExitInfo[];
}

function capture(session: CursorSdkRuntimeSession): CapturedRun {
  const captured: CapturedRun = { events: [], stderrTexts: [], errors: [], exits: [], closes: [] };
  session.on("runtime_event", (event) => captured.events.push(event));
  session.on("stderr", (text) => captured.stderrTexts.push(text));
  session.on("error", (error) => captured.errors.push(error));
  session.on("exit", (info) => captured.exits.push(info));
  session.on("close", (info) => captured.closes.push(info));
  return captured;
}

function kind<T extends ParsedEvent["kind"]>(captured: CapturedRun, eventKind: T): ParsedEvent[] {
  return captured.events.filter((event) => event.kind === eventKind);
}

async function waitFor<T>(probe: () => T | undefined, timeoutMs = 4_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = probe();
    if (value !== undefined) return value;
    if (Date.now() > deadline) throw new Error("waitFor timed out");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

function makeSessionDeps(input: {
  connection?: CursorSdkHostConnection;
  spawnCalls?: Array<CursorSdkHostSpawnInput>;
  ackTimeoutMs?: number;
  leaseError?: Error;
  assetsError?: Error;
} = {}): { deps: CursorSdkRuntimeSessionDeps; cleanup: () => void } {
  const tmpHome = mkdtempSync(path.join(os.tmpdir(), "cursor-sdk-session-test-"));
  const connection = input.connection ?? new ScriptedHostConnection();
  const deps: CursorSdkRuntimeSessionDeps = {
    resolveAssets: () => {
      if (input.assetsError) throw input.assetsError;
      return {
        root: tmpHome,
        nodePath: process.execPath,
        runtimeEntryPath: FIXTURE_HOST_PATH,
        authEntryPath: path.join(tmpHome, "authHost.mjs"),
        sdkVersion: "1.0.36",
        nodeVersion: "24.15.0",
      };
    },
    resolveCredentialLease: async () => {
      if (input.leaseError) throw input.leaseError;
      return {
        apiKey: "fixture-key-material",
        connectionId: "conn-1",
        generation: 1,
        principalId: "user-1",
        backendUrl: "https://cursor.example",
      };
    },
    prepareTransport: async () => ({
      slockDir: path.join(tmpHome, "cli"),
      tokenFile: path.join(tmpHome, "cli", "agent-token"),
      agentCredentialProxyUrl: null,
      wrapperPath: path.join(tmpHome, "cli", "raft"),
      spawnEnv: { PATH: process.env.PATH ?? "", HOME: os.homedir() },
      slockHome: tmpHome,
    }),
    prepareManagedMcp: async () => null,
    ...(input.connection
      ? { spawnHost: () => connection }
      : {
          spawnHost: (spawnInput: CursorSdkHostSpawnInput) => {
            input.spawnCalls?.push(spawnInput);
            return spawnRealHost(spawnInput);
          },
        }),
    ackTimeoutMs: input.ackTimeoutMs ?? 400,
    hostInitTimeoutMs: 2_000,
    shutdownGraceMs: 400,
    killEscalationMs: 300,
  };
  return {
    deps,
    cleanup: () => rmSync(tmpHome, { recursive: true, force: true }),
  };
}

// Real-child spawn using the production connection implementation.
function spawnRealHost(spawnInput: CursorSdkHostSpawnInput): CursorSdkHostConnection {
  // Mirrors the production ChildProcessHostConnection spawn contract exactly
  // (private IPC stdio, POSIX-detached process group). The production class
  // itself is exercised through the default spawnHost seam in the session.
  const child = spawn(spawnInput.command, spawnInput.args, {
    cwd: spawnInput.cwd,
    env: spawnInput.env,
    stdio: ["ignore", "pipe", "pipe", "ipc"],
    detached: process.platform !== "win32",
  });
  const bus = new EventEmitter();
  child.on("error", () => {
    /* spawn/pipe failures surface via exit; keep the error event handled */
  });
  child.on("message", (message: unknown) => bus.emit("message", message));
  child.stderr?.on("data", (chunk: Buffer) => bus.emit("stderr", String(chunk)));
  child.stdout?.resume();
  child.on("exit", (code, signal) => {
    bus.emit("exit", { code, signal });
    bus.removeAllListeners();
  });
  return {
    get pid() {
      return child.pid;
    },
    send: (message) => {
      if (!child.connected) return false;
      try {
        return child.send(message) !== false;
      } catch {
        return false;
      }
    },
    terminate: (signal) => {
      try {
        child.kill(signal);
      } catch {}
    },
    terminateGroup: (signal) => {
      try {
        if (child.pid && process.platform !== "win32") process.kill(-child.pid, signal);
        else child.kill(signal);
      } catch {
        try {
          child.kill(signal);
        } catch {}
      }
    },
    onMessage: (cb) => bus.on("message", cb),
    onStderr: (cb) => bus.on("stderr", cb),
    onExit: (cb) => bus.on("exit", cb),
  };
}

function makeSession(
  deps: CursorSdkRuntimeSessionDeps,
  configOverrides: Partial<AgentConfig> = {},
): { session: CursorSdkRuntimeSession; ids: string[] } {
  const ids: string[] = [];
  const session = new CursorSdkRuntimeSession(
    makeSpawnContext({ config: makeConfig(configOverrides) }),
    (sessionId) => {
      ids.push(sessionId ?? "null");
    },
    deps,
  );
  return { session, ids };
}

// ── Standing-prompt rule mount ──────────────────────────────────────────────

test("host launch mounts the standing prompt as an alwaysApply project rule and refreshes it on relaunch", async () => {
  const { deps, cleanup } = makeSessionDeps();
  const workspace = mkdtempSync(path.join(os.tmpdir(), "cursor-sdk-rule-ws-"));
  const rulePath = path.join(workspace, ".cursor", "rules", "raft-agent.mdc");
  try {
    // First launch: the rule file must exist and carry the exact prompt.
    const session = new CursorSdkRuntimeSession(
      makeSpawnContext({
        standingPrompt: "always reply via the raft CLI" as SpawnContext["standingPrompt"],
        workingDirectory: workspace,
      }),
      () => {},
      deps,
    );
    const startResult = await session.start({ text: "first turn" });
    assert.deepEqual(startResult, { ok: true, acceptedAs: "prompt" });
    assert.equal(existsSync(rulePath), true, "rule file written on first launch");
    assert.equal(
      readFileSync(rulePath, "utf8"),
      ["---", "alwaysApply: true", "---", "", "always reply via the raft CLI", ""].join("\n"),
    );
    await session.stop({ reason: "test-done" });
    assert.equal(session.closed, true);

    // Second launch (a fresh session over the same workspace, as a resume
    // relaunch would be): the rule file must be OVERWRITTEN with the latest
    // prompt, never left stale.
    const relaunched = new CursorSdkRuntimeSession(
      makeSpawnContext({
        standingPrompt: "updated standing instructions v2" as SpawnContext["standingPrompt"],
        workingDirectory: workspace,
      }),
      () => {},
      deps,
    );
    const relaunchResult = await relaunched.start({ text: "relaunched turn" });
    assert.deepEqual(relaunchResult, { ok: true, acceptedAs: "prompt" });
    assert.equal(
      readFileSync(rulePath, "utf8"),
      ["---", "alwaysApply: true", "---", "", "updated standing instructions v2", ""].join("\n"),
      "rule file refreshed with the latest standing prompt",
    );
    await relaunched.stop({ reason: "test-done" });
  } finally {
    rmSync(workspace, { recursive: true, force: true });
    cleanup();
  }
});

// ── Same-host follow-up ─────────────────────────────────────────────────────

test("same-host follow-up: second turn reuses the persistent host process", async () => {
  const script = new ScriptedHostConnection();
  const { deps, cleanup } = makeSessionDeps({ connection: script });
  const { session } = makeSession(deps);
  const captured = capture(session);
  try {
    const startResult = await session.start({ text: "first turn" });
    assert.deepEqual(startResult, { ok: true, acceptedAs: "prompt" });

    script.deliver({ kind: "session_init", sessionId: "sdk-session-1" });
    script.deliver({ kind: "run_event", payload: { type: "assistant_text", text: "one" } });
    script.deliver({ kind: "run_settled", runId: (script.runs()[0] as { runId: string }).runId, finishReason: "completed" });
    await waitFor(() => (kind(captured, "turn_end").length >= 1 ? true : undefined));

    // Idle follow-up on the SAME host: accepted as a new prompt turn.
    const sendResult = session.send({ mode: "idle", text: "second turn" });
    assert.deepEqual(sendResult, { ok: true, acceptedAs: "prompt" });
    assert.equal(script.runs().length, 2, "second run submitted to the same host");
    assert.equal(session.pid, 424_242);

    const secondRunId = (script.runs()[1] as { runId: string }).runId;
    script.deliver({ kind: "run_event", payload: { type: "assistant_text", text: "two" } });
    script.deliver({ kind: "run_settled", runId: secondRunId, finishReason: "completed" });
    await waitFor(() => (kind(captured, "turn_end").length >= 2 ? true : undefined));
    assert.equal(kind(captured, "turn_end").length, 2);
    assert.equal(kind(captured, "session_init").length, 1, "session_init announced once");

    await session.stop({ reason: "test-done" });
    assert.equal(session.closed, true);
  } finally {
    cleanup();
  }
});

// ── Active steer ─────────────────────────────────────────────────────────────

test("active steer: busy send becomes a steer with a delivered attempt outcome", async () => {
  const script = new ScriptedHostConnection();
  const { deps, cleanup } = makeSessionDeps({ connection: script });
  const { session } = makeSession(deps);
  const captured = capture(session);
  try {
    await session.start({ text: "first turn" });
    const runId = (script.runs()[0] as { runId: string }).runId;

    // Run not settled yet: APM-projected busy → steer, and idle-labeled sends
    // during an active run also steer (never a second Run).
    const busy = session.send({ mode: "busy", text: "mid-turn input", attemptId: "att-busy" });
    assert.deepEqual(busy, { ok: true, acceptedAs: "steer" });
    const idle = session.send({ mode: "idle", text: "also mid-turn", attemptId: "att-idle" });
    assert.equal(idle.ok, false, "second steer while one is pending must be rejected");

    script.deliver({ kind: "attempt_result", attemptId: "att-busy", result: "complete_delivered" });
    await waitFor(() => (kind(captured, "delivery_outcome").length > 0 ? true : undefined));
    assert.deepEqual(kind(captured, "delivery_outcome"), [
      { kind: "delivery_outcome", source: "cursor_sdk", attemptId: "att-busy", outcome: "delivered" },
    ]);

    script.deliver({ kind: "run_settled", runId, finishReason: "completed" });
    await waitFor(() => (kind(captured, "turn_end").length >= 1 ? true : undefined));
    assert.equal(kind(captured, "turn_end").length, 1);
    await session.stop({ reason: "test-done" });
  } finally {
    cleanup();
  }
});

// ── Steer revert: APM unique fallback + suppression ─────────────────────────

test("steer revert maps to deferred_to_idle with no runtime error UI and suppresses further steering", async () => {
  const script = new ScriptedHostConnection();
  const { deps, cleanup } = makeSessionDeps({ connection: script });
  const { session } = makeSession(deps);
  const captured = capture(session);
  try {
    await session.start({ text: "first turn" });
    const runId = (script.runs()[0] as { runId: string }).runId;

    const steer = session.send({ mode: "busy", text: "REVERT please", attemptId: "att-r" });
    assert.deepEqual(steer, { ok: true, acceptedAs: "steer" });
    script.deliver({
      kind: "attempt_result",
      attemptId: "att-r",
      result: "revert",
      error: { message: "agent busy", errorClass: "unknown_agent" },
    });
    await waitFor(() => (kind(captured, "delivery_outcome").length > 0 ? true : undefined));

    // Unique fallback: exactly one deferred_to_idle, no error event, no
    // delivery_error — the revert is NOT a runtime error.
    assert.deepEqual(kind(captured, "delivery_outcome"), [
      { kind: "delivery_outcome", source: "cursor_sdk", attemptId: "att-r", outcome: "deferred_to_idle" },
    ]);
    assert.equal(kind(captured, "error").length, 0);
    assert.equal(kind(captured, "delivery_error").length, 0);

    // Suppression: further busy steering on this run refuses until idle.
    const retry = session.send({ mode: "busy", text: "try again", attemptId: "att-r2" });
    assert.deepEqual(retry, { ok: false, reason: "busy_rejected" });

    script.deliver({ kind: "run_settled", runId, finishReason: "completed" });
    await waitFor(() => (kind(captured, "turn_end").length >= 1 ? true : undefined));
    // True idle reached: suppression lifts.
    const afterIdle = session.send({ mode: "busy", text: "fresh turn" });
    assert.deepEqual(afterIdle, { ok: true, acceptedAs: "prompt" });
    await session.stop({ reason: "test-done" });
  } finally {
    cleanup();
  }
});

test("null-attempt steer revert keeps existing turn.agent_busy debt semantics", async () => {
  const script = new ScriptedHostConnection();
  const { deps, cleanup } = makeSessionDeps({ connection: script });
  const { session } = makeSession(deps);
  const captured = capture(session);
  try {
    await session.start({ text: "first turn" });
    const steer = session.send({ mode: "busy", text: "REVERT no watermark" });
    assert.deepEqual(steer, { ok: true, acceptedAs: "steer" });
    script.deliver({
      kind: "attempt_result",
      attemptId: null,
      result: "revert",
      error: { message: "agent busy", errorClass: "unknown_agent" },
    });
    await waitFor(() => (kind(captured, "delivery_error").length > 0 ? true : undefined));
    assert.equal(kind(captured, "delivery_outcome").length, 0, "no invented APM debt without attemptId");
    const [deliveryError] = kind(captured, "delivery_error") as Array<{
      code?: string;
      source?: string;
      requestMethod?: string;
    }>;
    assert.equal(deliveryError.code, "turn.agent_busy");
    assert.equal(deliveryError.source, "cursor_sdk_response");
    assert.equal(deliveryError.requestMethod, "turn/steer");
    assert.equal(kind(captured, "error").length, 0);
    await session.stop({ reason: "test-done" });
  } finally {
    cleanup();
  }
});

// ── Delayed / stale ACK ──────────────────────────────────────────────────────

test("delayed ACK: turn_end waits for the outstanding steer ACK even after the run settles", async () => {
  const script = new ScriptedHostConnection();
  const { deps, cleanup } = makeSessionDeps({ connection: script });
  const { session } = makeSession(deps);
  const captured = capture(session);
  try {
    await session.start({ text: "first turn" });
    const runId = (script.runs()[0] as { runId: string }).runId;
    session.send({ mode: "busy", text: "slow ack", attemptId: "att-slow" });

    script.deliver({ kind: "run_settled", runId, finishReason: "completed" });
    await new Promise((resolve) => setTimeout(resolve, 80));
    assert.equal(kind(captured, "turn_end").length, 0, "turn_end must wait for ACK settlement");

    script.deliver({ kind: "attempt_result", attemptId: "att-slow", result: "complete_delivered" });
    await waitFor(() => (kind(captured, "turn_end").length >= 1 ? true : undefined));
    assert.equal(kind(captured, "turn_end").length, 1, "exactly one turn_end after ACK settles");
    await session.stop({ reason: "test-done" });
  } finally {
    cleanup();
  }
});

test("stale ACK: results for old attempts and runs are discarded", async () => {
  const script = new ScriptedHostConnection();
  const { deps, cleanup } = makeSessionDeps({ connection: script });
  const { session } = makeSession(deps);
  const captured = capture(session);
  try {
    await session.start({ text: "first turn" });
    const runId = (script.runs()[0] as { runId: string }).runId;
    script.deliver({ kind: "run_settled", runId, finishReason: "completed" });
    await waitFor(() => (kind(captured, "turn_end").length >= 1 ? true : undefined));

    // Old attempt id from a previous epoch/run: dropped, no outcome invented.
    script.deliver({
      kind: "attempt_result",
      attemptId: "att-from-the-past",
      result: "complete_delivered",
    });
    // Old run settlement: dropped.
    script.deliver({ kind: "run_settled", runId: "run-from-the-past", finishReason: "completed" });
    await new Promise((resolve) => setTimeout(resolve, 60));
    assert.equal(kind(captured, "delivery_outcome").length, 0);
    assert.equal(kind(captured, "turn_end").length, 1);
    assert.ok(captured.stderrTexts.some((text) => text.includes("discarded stale")));
    await session.stop({ reason: "test-done" });
  } finally {
    cleanup();
  }
});

test("ACK timeout maps to unknown, never deferred_to_idle", async () => {
  const script = new ScriptedHostConnection();
  const { deps, cleanup } = makeSessionDeps({ connection: script, ackTimeoutMs: 120 });
  const { session } = makeSession(deps);
  const captured = capture(session);
  try {
    await session.start({ text: "first turn" });
    const runId = (script.runs()[0] as { runId: string }).runId;
    session.send({ mode: "busy", text: "HANG no ack", attemptId: "att-hang" });

    script.deliver({ kind: "run_settled", runId, finishReason: "completed" });
    await waitFor(() => (kind(captured, "turn_end").length >= 1 ? true : undefined), 3_000);
    assert.deepEqual(kind(captured, "delivery_outcome"), [
      { kind: "delivery_outcome", source: "cursor_sdk", attemptId: "att-hang", outcome: "unknown" },
    ]);
    assert.equal(kind(captured, "delivery_error").length, 0);
    assert.equal(kind(captured, "turn_end").length, 1);
    await session.stop({ reason: "test-done" });
  } finally {
    cleanup();
  }
});

// ── End boundary ─────────────────────────────────────────────────────────────

test("run error emits error then exactly one turn_end; duplicate settlements are ignored", async () => {
  const script = new ScriptedHostConnection();
  const { deps, cleanup } = makeSessionDeps({ connection: script });
  const { session } = makeSession(deps);
  const captured = capture(session);
  try {
    await session.start({ text: "RUN_ERROR: kaboom" });
    const runId = (script.runs()[0] as { runId: string }).runId;
    script.deliver({ kind: "run_event", payload: { type: "assistant_text", text: "partial" } });
    script.deliver({
      kind: "run_settled",
      runId,
      finishReason: "error",
      error: { message: "kaboom", errorClass: "host_internal" },
    });
    await waitFor(() => (kind(captured, "turn_end").length >= 1 ? true : undefined));
    // Duplicate terminal for the same run must not double turn_end.
    script.deliver({ kind: "run_settled", runId, finishReason: "completed" });
    await new Promise((resolve) => setTimeout(resolve, 60));
    assert.equal(kind(captured, "turn_end").length, 1);
    const [errorEvent] = kind(captured, "error") as Array<{ message?: string }>;
    assert.equal(errorEvent.message, "kaboom");
    await session.stop({ reason: "test-done" });
  } finally {
    cleanup();
  }
});

test("genuine steer failure surfaces cursor_sdk_response delivery_error", async () => {
  const script = new ScriptedHostConnection();
  const { deps, cleanup } = makeSessionDeps({ connection: script });
  const { session } = makeSession(deps);
  const captured = capture(session);
  try {
    await session.start({ text: "first turn" });
    session.send({ mode: "busy", text: "FAIL gone", attemptId: "att-f" });
    script.deliver({
      kind: "attempt_result",
      attemptId: "att-f",
      result: "failed",
      error: { message: "agent missing", errorClass: "agent_not_found" },
    });
    await waitFor(() => (kind(captured, "delivery_error").length > 0 ? true : undefined));
    const [failure] = kind(captured, "delivery_error") as Array<{
      message?: string;
      code?: string;
      source?: string;
    }>;
    assert.equal(failure.message, "agent missing");
    assert.equal(failure.source, "cursor_sdk_response");
    assert.equal(failure.code, "runtime.delivery_error");
    // Attempt watermark settles honestly as unknown (neither delivered nor deferred).
    await waitFor(() => (kind(captured, "delivery_outcome").length > 0 ? true : undefined));
    assert.deepEqual(kind(captured, "delivery_outcome"), [
      { kind: "delivery_outcome", source: "cursor_sdk", attemptId: "att-f", outcome: "unknown" },
    ]);
    await session.stop({ reason: "test-done" });
  } finally {
    cleanup();
  }
});

// ── busy readiness ───────────────────────────────────────────────────────────

test("busy readiness closes only at true idle, never while ACK-pending", async () => {
  const script = new ScriptedHostConnection();
  const { deps, cleanup } = makeSessionDeps({ connection: script, ackTimeoutMs: 250 });
  const { session } = makeSession(deps);
  try {
    await session.start({ text: "first turn" });
    const runId = (script.runs()[0] as { runId: string }).runId;
    assert.deepEqual(session.busyDeliveryReadiness(), { ready: true }, "active run keeps gate open");
    session.send({ mode: "busy", text: "steer", attemptId: "att-x" });
    script.deliver({ kind: "run_settled", runId, finishReason: "completed" });
    await new Promise((resolve) => setTimeout(resolve, 60));
    // Terminal run but ACK still pending: must NOT claim no_active_turn.
    assert.deepEqual(
      session.busyDeliveryReadiness(),
      { ready: true },
      "ACK-pending run must not reconcile APM to idle",
    );
    script.deliver({ kind: "attempt_result", attemptId: "att-x", result: "complete_delivered" });
    await new Promise((resolve) => setTimeout(resolve, 60));
    assert.deepEqual(session.busyDeliveryReadiness(), {
      ready: false,
      reason: "no_active_turn",
    });
    await session.stop({ reason: "test-done" });
  } finally {
    cleanup();
  }
});

// ── Blocked inputs & fail-closed startup ────────────────────────────────────

test("send is synchronous and blocked before the host is ready", async () => {
  const script = new ScriptedHostConnection();
  const { deps, cleanup } = makeSessionDeps({ connection: script });
  const { session } = makeSession(deps);
  try {
    const startPromise = session.start({ text: "first turn" });
    const duringStart = session.send({ mode: "busy", text: "too early" });
    assert.deepEqual(duringStart, { ok: false, reason: "busy_rejected" });
    const result = await startPromise;
    assert.deepEqual(result, { ok: true, acceptedAs: "prompt" });
    // Sync send contract: plain value, never a promise.
    const sendResult = session.send({ mode: "idle", text: "later" });
    assert.equal(typeof (sendResult as unknown as Promise<unknown>).then, "undefined");
    await session.stop({ reason: "test-done" });
  } finally {
    cleanup();
  }
});

test("missing assets fail closed without spawning a host", async () => {
  const spawnCalls: CursorSdkHostSpawnInput[] = [];
  const { deps, cleanup } = makeSessionDeps({
    spawnCalls,
    assetsError: new CursorSdkAssetsUnavailableError("asset module is not staged"),
  });
  const { session } = makeSession(deps);
  const captured = capture(session);
  try {
    await assert.rejects(() => session.start({ text: "first" }), /unavailable/i);
    assert.equal(spawnCalls.length, 0);
    assert.equal(session.closed, true);
    assert.equal(kind(captured, "error").length, 1);
    assert.equal(captured.closes.length, 1);
  } finally {
    cleanup();
  }
});

test("credential lease failure fails closed without spawning a host", async () => {
  const spawnCalls: CursorSdkHostSpawnInput[] = [];
  const { deps, cleanup } = makeSessionDeps({
    spawnCalls,
    leaseError: new Error("broker rejected the connection"),
  });
  const { session } = makeSession(deps);
  const captured = capture(session);
  try {
    await assert.rejects(() => session.start({ text: "first" }), /broker rejected/);
    assert.equal(spawnCalls.length, 0, "no host process may spawn without a verified lease");
    assert.equal(session.closed, true);
  } finally {
    cleanup();
  }
});

test("no attemptId on start: no delivery_outcome is invented", async () => {
  const script = new ScriptedHostConnection();
  const { deps, cleanup } = makeSessionDeps({ connection: script });
  const { session } = makeSession(deps);
  const captured = capture(session);
  try {
    await session.start({ text: "first turn" });
    const runId = (script.runs()[0] as { runId: string }).runId;
    script.deliver({ kind: "attempt_result", attemptId: null, result: "complete_delivered" });
    script.deliver({ kind: "run_settled", runId, finishReason: "completed" });
    await waitFor(() => (kind(captured, "turn_end").length >= 1 ? true : undefined));
    assert.equal(kind(captured, "delivery_outcome").length, 0);
    assert.equal(kind(captured, "delivery_error").length, 0);
    await session.stop({ reason: "test-done" });
  } finally {
    cleanup();
  }
});

test("host death mid-run: error + single turn_end + unknown outcomes + close", async () => {
  const script = new ScriptedHostConnection();
  const { deps, cleanup } = makeSessionDeps({ connection: script });
  const { session } = makeSession(deps);
  const captured = capture(session);
  try {
    await session.start({ text: "first turn" });
    session.send({ mode: "busy", text: "steer", attemptId: "att-doom" });
    script.exitNow(3, null);
    await waitFor(() => (captured.closes.length > 0 ? true : undefined));
    assert.equal(kind(captured, "turn_end").length, 1);
    assert.equal(kind(captured, "error").length, 1);
    assert.deepEqual(kind(captured, "delivery_outcome"), [
      { kind: "delivery_outcome", source: "cursor_sdk", attemptId: "att-doom", outcome: "unknown" },
    ]);
    assert.equal(captured.exits[0].code, 3);
    assert.equal(session.closed, true);
  } finally {
    cleanup();
  }
});

// ── Real child-process host (production spawn contract) ─────────────────────

function realHostDeps(mode: string, extraEnv: Record<string, string> = {}) {
  const spawnCalls: CursorSdkHostSpawnInput[] = [];
  const base = makeSessionDeps({ spawnCalls });
  const transport = base.deps.prepareTransport!;
  const deps: CursorSdkRuntimeSessionDeps = {
    ...base.deps,
    prepareTransport: async (ctx, env) => {
      const result = await transport(ctx, env);
      return {
        ...result,
        spawnEnv: { ...result.spawnEnv, FAKE_HOST_MODE: mode, ...extraEnv },
      };
    },
  };
  return { deps, spawnCalls, cleanup: base.cleanup };
}

test("real host: happy path over private IPC with entry guard", async () => {
  const { deps, spawnCalls, cleanup } = realHostDeps("happy");
  const { session, ids } = makeSession(deps);
  const captured = capture(session);
  try {
    const result = await session.start({ text: "hello host" });
    assert.deepEqual(result, { ok: true, acceptedAs: "prompt" });
    assert.equal(spawnCalls.length, 1);
    const spawnInput = spawnCalls[0];
    assert.equal(spawnInput.command, process.execPath);
    assert.equal(spawnInput.args[0], FIXTURE_HOST_PATH);
    assert.equal(spawnInput.env["RAFT_CURSOR_SDK_HOST_ENTRY"], "1");
    assert.equal(spawnInput.env["CURSOR_API_KEY"], undefined, "lease must ride IPC, not env");
    assert.equal(spawnInput.env["CURSOR_BACKEND_URL"], undefined);

    await waitFor(() => (kind(captured, "turn_end").length >= 1 ? true : undefined));
    assert.equal(kind(captured, "session_init").length, 1);
    const texts = captured.events.filter((event) => event.kind === "text") as Array<{ text: string }>;
    assert.equal(texts[0].text, "ack: hello host");
    // The SDK user echo must never re-enter as content.
    assert.ok(ids.length >= 1 && ids[0].startsWith("fake-session-"));

    await session.stop({ reason: "test-done" });
    assert.equal(session.closed, true);
    const closeInfo = captured.closes[0];
    assert.equal(closeInfo.code, 0);
    assert.equal(closeInfo.reason, "requested");
    assert.ok(captured.stderrTexts.some((text) => text.includes("outcome=clean")));
  } finally {
    cleanup();
  }
});

test("real host: stop settles a hanging run gracefully with proof", async () => {
  const { deps, cleanup } = realHostDeps("hang_run");
  const { session } = makeSession(deps);
  const captured = capture(session);
  try {
    await session.start({ text: "HANG_RUN forever" });
    await session.stop({ reason: "test-stop", forceAfterMs: 1_000 });
    assert.equal(session.closed, true);
    assert.ok(
      captured.stderrTexts.some((text) => text.includes("outcome=clean")),
      "graceful stop must present shutdown_settled proof",
    );
    const closeInfo = captured.closes[0];
    assert.equal(closeInfo.code, 0);
    assert.equal(closeInfo.reason, "requested");
    assert.equal(session.isAlive(), false);
  } finally {
    cleanup();
  }
});

test("real host: stop deadline escalates to process-group termination", async () => {
  const { deps, cleanup } = realHostDeps("hang_stop", { FAKE_IGNORE_SIGTERM: "1" });
  const { session } = makeSession(deps);
  const captured = capture(session);
  try {
    await session.start({ text: "HANG_RUN forever" });
    const pid = session.pid;
    assert.ok(typeof pid === "number");
    await session.stop({ reason: "test-force", forceAfterMs: 200 });
    assert.equal(session.closed, true);
    // Deadline path: no "clean" proof may be claimed.
    assert.ok(!captured.stderrTexts.some((text) => text.includes("outcome=clean")));
    const closeInfo = captured.closes[0];
    assert.equal(closeInfo.reason, "requested");
    // The process group must actually be dead.
    let alive = true;
    try {
      process.kill(pid!, 0);
    } catch {
      alive = false;
    }
    assert.equal(alive, false, "host process group must be terminated");
  } finally {
    cleanup();
  }
});

test("real host: crash after init surfaces error and closes the session", async () => {
  const { deps, cleanup } = realHostDeps("crash_after_init");
  const { session } = makeSession(deps);
  const captured = capture(session);
  try {
    await session.start({ text: "doomed" });
    await waitFor(() => (captured.closes.length > 0 ? true : undefined));
    assert.equal(session.closed, true);
    assert.equal(captured.exits[0].code, 3);
    assert.equal(kind(captured, "error").length, 1);
    // A run was in flight when the host died: exactly one turn_end.
    await waitFor(() => (kind(captured, "turn_end").length >= 1 ? true : undefined));
    assert.equal(kind(captured, "turn_end").length, 1);
  } finally {
    cleanup();
  }
});

// ── Start/stop race + shutdown-proof regressions ─────────────────────────────

test("stop during async lease resolution never spawns a host", async () => {
  const spawnCalls: CursorSdkHostSpawnInput[] = [];
  let releaseLease: (lease: CursorSdkCredentialLease) => void = () => {};
  const leaseGate = new Promise<CursorSdkCredentialLease>((resolve) => {
    releaseLease = resolve;
  });
  const base = makeSessionDeps({ spawnCalls });
  const deps: CursorSdkRuntimeSessionDeps = {
    ...base.deps,
    resolveCredentialLease: () => leaseGate,
  };
  const { session } = makeSession(deps);
  const captured = capture(session);
  try {
    const startPromise = session.start({ text: "first" });
    // stop() wins the race while the lease promise is still pending.
    await session.stop({ reason: "user-stop" });
    assert.equal(session.closed, true);
    assert.equal(captured.closes.length, 1, "stop finalizes immediately when no host exists");

    // The lease resolves AFTER the stop: the start must abort, never spawn.
    releaseLease({
      apiKey: "late-key",
      connectionId: "conn",
      generation: 1,
      principalId: "user-1",
      backendUrl: "https://cursor.example",
    });
    assert.deepEqual(await startPromise, { ok: false, reason: "closed" });
    assert.equal(spawnCalls.length, 0, "no host may spawn after a stop won the race");
    assert.equal(kind(captured, "error").length, 0, "a superseded start is not a runtime error");
    // The stopped session never reopens for deliveries.
    assert.deepEqual(session.send({ mode: "idle", text: "later" }), { ok: false, reason: "closed" });
  } finally {
    base.cleanup();
  }
});

test("stop during init handshake aborts start and escalates the spawned group", async () => {
  const script = new ScriptedHostConnection();
  script.autoInitResult = false;
  script.autoStopSettle = false;
  const { deps, cleanup } = makeSessionDeps({ connection: script });
  const { session } = makeSession(deps);
  const captured = capture(session);
  try {
    const startPromise = session.start({ text: "first" });
    await new Promise((resolve) => setTimeout(resolve, 30));
    await session.stop({ reason: "user-stop", forceAfterMs: 80 });
    assert.deepEqual(await startPromise, { ok: false, reason: "closed" });
    assert.equal(session.closed, true);
    // No shutdown ACK and no exit were ever observed: bounded escalation
    // must have run through group SIGTERM to group SIGKILL.
    assert.ok(script.signals.includes("group:SIGTERM"), "group SIGTERM required");
    assert.ok(script.signals.includes("group:SIGKILL"), "SIGKILL escalation required without an observed exit");
    const closeInfo = captured.closes[0];
    assert.equal(closeInfo.code, null, "no exit code may be fabricated without an observed exit");
    assert.equal(closeInfo.signal, null);
    assert.equal(closeInfo.reason, "requested");
    assert.equal(kind(captured, "error").length, 0, "a stop-superseded init is not a runtime error");
    assert.ok(
      captured.stderrTexts.some((text) => text.includes("ack=timeout")),
      "the missing proof must be logged honestly",
    );
    assert.deepEqual(session.send({ mode: "idle", text: "after" }), { ok: false, reason: "closed" });
  } finally {
    cleanup();
  }
});

test("clean ACK still requires a real process exit; escalates without fabricating one", async () => {
  const script = new ScriptedHostConnection();
  script.autoStopSettle = false;
  const { deps, cleanup } = makeSessionDeps({ connection: script });
  const { session } = makeSession(deps);
  const captured = capture(session);
  try {
    await session.start({ text: "first turn" });
    const stopPromise = session.stop({ reason: "test", forceAfterMs: 200 });
    // The host ACKs clean but NEVER actually exits and ignores signals.
    script.deliver({ kind: "shutdown_settled", outcome: "clean" });
    await stopPromise;
    assert.ok(
      script.signals.includes("group:SIGTERM"),
      "a clean ACK alone must not prevent escalation when no real exit is observed",
    );
    assert.ok(script.signals.includes("group:SIGKILL"), "SIGKILL escalation required");
    assert.ok(
      captured.stderrTexts.some((text) => text.includes("clean ACK without observed exit")),
      "the missing exit must be logged honestly",
    );
    assert.equal(captured.closes[0].code, null, "no fabricated exit code");
    assert.equal(session.closed, true);
  } finally {
    cleanup();
  }
});

test("deadline/forced shutdown ACK is not treated as a clean stop", async () => {
  const script = new ScriptedHostConnection();
  script.autoStopSettle = false;
  const { deps, cleanup } = makeSessionDeps({ connection: script });
  const { session } = makeSession(deps);
  const captured = capture(session);
  try {
    await session.start({ text: "first turn" });
    const stopPromise = session.stop({ reason: "test", forceAfterMs: 200 });
    // The host ADMITS incomplete cleanup, then truly exits (code 1, matching
    // the production host's non-clean exit code).
    script.deliver({ kind: "shutdown_settled", outcome: "deadline" });
    script.exitNow(1, null);
    await stopPromise;
    // close/exit emit one macrotask after the observed exit settles.
    await waitFor(() => (captured.closes.length > 0 ? true : undefined));
    assert.ok(
      captured.stderrTexts.some(
        (text) => text.includes("outcome=deadline") && text.includes("not clean"),
      ),
      "deadline ACK must be logged as not clean",
    );
    assert.ok(
      !captured.stderrTexts.some((text) => text.includes("outcome=clean")),
      "no clean-stop claim may be logged for a deadline ACK",
    );
    assert.equal(captured.closes[0].code, 1, "exit info must come from the real observed exit");
    assert.equal(session.closed, true);
  } finally {
    cleanup();
  }
});

test("init failure terminates the spawned child with bounded escalation", async () => {
  const script = new ScriptedHostConnection();
  script.autoInitResult = false;
  script.autoStopSettle = false;
  const { deps, cleanup } = makeSessionDeps({ connection: script });
  deps.shutdownGraceMs = 100;
  deps.killEscalationMs = 100;
  const { session } = makeSession(deps);
  const captured = capture(session);
  try {
    const startPromise = session.start({ text: "first" });
    await new Promise((resolve) => setTimeout(resolve, 20));
    script.deliver({
      kind: "init_result",
      ok: false,
      sessionId: null,
      error: { message: "auth rejected", errorClass: "auth" },
    });
    await assert.rejects(() => startPromise, /auth rejected/);
    assert.equal(session.closed, true);
    assert.ok(script.sent.some((m) => m.kind === "stop"), "graceful stop attempted first");
    assert.ok(
      script.signals.some((sig) => sig.startsWith("group:SIGTERM")),
      "an init failure must terminate the spawned group",
    );
    assert.equal(kind(captured, "error").length, 1, "genuine init failure stays visible");
  } finally {
    cleanup();
  }
});

test("IPC send false (closed/backpressure) is never queued or resent", async () => {
  const script = new ScriptedHostConnection();
  const { deps, cleanup } = makeSessionDeps({ connection: script });
  const { session } = makeSession(deps);
  const captured = capture(session);
  try {
    await session.start({ text: "first turn" });
    const runId = (script.runs()[0] as { runId: string }).runId;
    script.deliver({ kind: "run_settled", runId, finishReason: "completed" });
    await waitFor(() => (kind(captured, "turn_end").length >= 1 ? true : undefined));

    // The channel refuses the next submission once (dead-channel semantics:
    // production send() false never means "retry me").
    script.sendRefusals = 1;
    const rejected = session.send({ mode: "idle", text: "must-not-be-resent" });
    assert.equal(rejected.ok, false);
    assert.equal(rejected.reason, "closed");

    // Channel open again: the refused text was never handed off, never
    // parked, and never re-sent; the accepted text is handed off exactly once.
    const accepted = session.send({ mode: "idle", text: "fresh submission" });
    assert.deepEqual(accepted, { ok: true, acceptedAs: "prompt" });
    const runTexts = script.runs().map((m) => (m as { text: string }).text);
    assert.equal(runTexts.includes("must-not-be-resent"), false, "refused submission must never reach the host");
    assert.equal(runTexts.filter((text) => text === "fresh submission").length, 1, "exactly one hand-off per accepted message");
    assert.equal(new Set(runTexts).size, runTexts.length, "no message is ever submitted twice");
    await session.stop({ reason: "test" });
  } finally {
    cleanup();
  }
});

// ── Repeated submit failures: session reset (resumed) and backoff (fresh) ───

async function failSubmit(
  script: ScriptedHostConnection,
  session: CursorSdkRuntimeSession,
  captured: CapturedRun,
  attemptId: string,
  result: "failed" | "revert" | "complete_delivered" = "failed",
): Promise<void> {
  const before = kind(captured, "delivery_outcome").length;
  const sent = session.send({ mode: "idle", text: `msg ${attemptId}`, attemptId });
  assert.equal(sent.ok, true, `send ${attemptId} accepted`);
  script.deliver({
    kind: "attempt_result",
    attemptId,
    result,
    ...(result === "complete_delivered" ? {} : { error: { message: "rejected", errorClass: "auth" } }),
  } as CursorSdkHostToDriverMessage);
  await waitFor(() => (kind(captured, "delivery_outcome").length > before ? true : undefined));
}

async function failSubmitWith(
  script: ScriptedHostConnection,
  session: CursorSdkRuntimeSession,
  captured: CapturedRun,
  attemptId: string,
  errorClass: string,
): Promise<void> {
  const before = kind(captured, "delivery_outcome").length;
  assert.equal(session.send({ mode: "idle", text: `msg ${attemptId}`, attemptId }).ok, true);
  script.deliver({ kind: "attempt_result", attemptId, result: "failed", error: { message: "rejected", errorClass } } as CursorSdkHostToDriverMessage);
  await waitFor(() => (kind(captured, "delivery_outcome").length > before ? true : undefined));
}

test("resumed session that never accepted a run: ONE unknown_agent submit failure requests a session reset", async () => {
  const script = new ScriptedHostConnection();
  const { deps, cleanup } = makeSessionDeps({ connection: script });
  const { session } = makeSession(deps, { sessionId: "saved-session" });
  const captured = capture(session);
  try {
    await session.start({ text: "first", attemptId: "a0" });
    script.deliver({ kind: "attempt_result", attemptId: "a0", result: "failed", error: { message: "x", errorClass: "unknown_agent" } });
    await waitFor(() => (captured.stderrTexts.some((t) => t.includes(CURSOR_SDK_RESUME_UNUSABLE_MARKER)) ? true : undefined));
    await waitFor(() => (session.closed ? true : undefined));
  } finally {
    cleanup();
  }
});

test("unknown_agent does not reset a fresh session, nor a plain busy one on a resumed session", async () => {
  for (const [sessionId, errorClass] of [[undefined, "unknown_agent"], ["saved-session", "busy"]] as const) {
    const script = new ScriptedHostConnection();
    const { deps, cleanup } = makeSessionDeps({ connection: script });
    const { session } = makeSession(deps, sessionId ? { sessionId } : {});
    const captured = capture(session);
    try {
      await session.start({ text: "first", attemptId: "a0" });
      script.deliver({ kind: "attempt_result", attemptId: "a0", result: "failed", error: { message: "x", errorClass } });
      await waitFor(() => (kind(captured, "delivery_outcome").length > 0 ? true : undefined));
      assert.equal(captured.stderrTexts.some((t) => t.includes(CURSOR_SDK_RESUME_UNUSABLE_MARKER)), false, `${sessionId}/${errorClass}`);
      assert.equal(session.closed, false);
    } finally {
      cleanup();
    }
  }
});

test("resumed session that already accepted a run: unknown_agent is not treated as a dead session", async () => {
  const script = new ScriptedHostConnection();
  const { deps, cleanup } = makeSessionDeps({ connection: script });
  const { session } = makeSession(deps, { sessionId: "saved-session" });
  const captured = capture(session);
  try {
    await session.start({ text: "first", attemptId: "a0" });
    script.deliver({ kind: "attempt_result", attemptId: "a0", result: "complete_delivered" });
    await waitFor(() => (kind(captured, "delivery_outcome").length > 0 ? true : undefined));
    await failSubmitWith(script, session, captured, "a1", "unknown_agent");
    assert.equal(captured.stderrTexts.some((t) => t.includes(CURSOR_SDK_RESUME_UNUSABLE_MARKER)), false);
  } finally {
    cleanup();
  }
});

test("resumed session: 3 consecutive failed submits request a session reset and stop the session", async () => {
  const script = new ScriptedHostConnection();
  const { deps, cleanup } = makeSessionDeps({ connection: script });
  const { session } = makeSession(deps, { sessionId: "saved-session" });
  const captured = capture(session);
  try {
    await session.start({ text: "first", attemptId: "a0" });
    script.deliver({ kind: "attempt_result", attemptId: "a0", result: "failed", error: { message: "x", errorClass: "auth" } });
    await waitFor(() => (kind(captured, "delivery_outcome").length > 0 ? true : undefined));
    await failSubmit(script, session, captured, "a1");
    assert.equal(captured.stderrTexts.some((t) => t.includes(CURSOR_SDK_RESUME_UNUSABLE_MARKER)), false, "not yet");
    await failSubmit(script, session, captured, "a2");
    await waitFor(() => (captured.stderrTexts.some((t) => t.includes(CURSOR_SDK_RESUME_UNUSABLE_MARKER)) ? true : undefined));
    await waitFor(() => (session.closed ? true : undefined));
    assert.equal(script.runs().length, 3, "each failed attempt was sent exactly once, never resent");
  } finally {
    cleanup();
  }
});

test("a success between failures resets the count; revert is not counted", async () => {
  const script = new ScriptedHostConnection();
  const { deps, cleanup } = makeSessionDeps({ connection: script });
  const { session } = makeSession(deps, { sessionId: "saved-session" });
  const captured = capture(session);
  try {
    await session.start({ text: "first", attemptId: "a0" });
    script.deliver({ kind: "attempt_result", attemptId: "a0", result: "failed", error: { message: "x", errorClass: "auth" } });
    await waitFor(() => (kind(captured, "delivery_outcome").length > 0 ? true : undefined));
    await failSubmit(script, session, captured, "a2", "revert");
    await failSubmit(script, session, captured, "a3");
    assert.equal(session.closed, false, "revert in between does not count, and only 2 failures so far");
    // A run the SDK accepted resets the streak (and proves the session works).
    const sent = session.send({ mode: "idle", text: "ok", attemptId: "a4" });
    assert.equal(sent.ok, true);
    script.deliver({ kind: "attempt_result", attemptId: "a4", result: "complete_delivered" });
    const runId = (script.runs().at(-1) as { runId: string }).runId;
    script.deliver({ kind: "run_settled", runId, finishReason: "completed" });
    await waitFor(() => (kind(captured, "turn_end").length >= 1 ? true : undefined));
    await failSubmit(script, session, captured, "a5");
    await failSubmit(script, session, captured, "a6");
    assert.equal(session.closed, false);
    assert.equal(captured.stderrTexts.some((t) => t.includes(CURSOR_SDK_RESUME_UNUSABLE_MARKER)), false);
    await session.stop({ reason: "test-done" });
  } finally {
    cleanup();
  }
});

test("fresh session: repeated failures back off instead of resetting, then surface an error", async () => {
  const script = new ScriptedHostConnection();
  let now = 1_000_000;
  const { deps, cleanup } = makeSessionDeps({ connection: script });
  const { session } = makeSession({ ...deps, nowMs: () => now });
  const captured = capture(session);
  try {
    await session.start({ text: "first", attemptId: "a0" });
    script.deliver({ kind: "attempt_result", attemptId: "a0", result: "failed", error: { message: "x", errorClass: "auth" } });
    await waitFor(() => (kind(captured, "delivery_outcome").length > 0 ? true : undefined));
    await failSubmit(script, session, captured, "a1");
    await failSubmit(script, session, captured, "a2");
    assert.equal(session.closed, false, "fresh sessions are never reset");
    assert.equal(captured.stderrTexts.some((t) => t.includes(CURSOR_SDK_RESUME_UNUSABLE_MARKER)), false);
    // In the 60 s backoff window the SDK is not hit again.
    const runsBefore = script.runs().length;
    assert.deepEqual(session.send({ mode: "idle", text: "x", attemptId: "b" }), { ok: false, reason: "busy_rejected" });
    assert.equal(script.runs().length, runsBefore);
    now += 61_000;
    await failSubmit(script, session, captured, "a3");
    now += 61_000;
    await failSubmit(script, session, captured, "a4");
    now += 61_000;
    await failSubmit(script, session, captured, "a5");
    assert.deepEqual(session.send({ mode: "idle", text: "x", attemptId: "c" }), { ok: false, reason: "busy_rejected" });
    now += 61_000;
    assert.deepEqual(session.send({ mode: "idle", text: "x", attemptId: "d" }), { ok: false, reason: "busy_rejected" }, "5 minute backoff after twice the limit");
    assert.ok(kind(captured, "error").length >= 1, "visible error after twice the limit");
    await session.stop({ reason: "test-done" });
  } finally {
    cleanup();
  }
});

test("real host (poisoned resumed session): 3 rejected submits end the session with the reset marker", async () => {
  const { deps, cleanup } = realHostDeps("poisoned");
  const { session } = makeSession(deps, { sessionId: "saved-session" });
  const captured = capture(session);
  try {
    await session.start({ text: "first", attemptId: "p0" });
    for (const id of ["p1", "p2"]) {
      await waitFor(() => (session.closed || kind(captured, "delivery_outcome").length >= Number(id.slice(1)) ? true : undefined));
      if (session.closed) break;
      session.send({ mode: "idle", text: `again ${id}`, attemptId: id });
    }
    await waitFor(() => (session.closed ? true : undefined), 8_000);
    assert.ok(captured.stderrTexts.some((t) => t.includes(CURSOR_SDK_RESUME_UNUSABLE_MARKER)));
    assert.ok(captured.exits.length >= 1, "session exited so the daemon can cold-start a new one");
  } finally {
    cleanup();
  }
});

// ── Late steer ack: honored once, gate released only then ───────────────────

test("late steer ack: settles unknown at the bound, holds the gate, then releases it once and reports delivered", async () => {
  const script = new ScriptedHostConnection();
  const { deps, cleanup } = makeSessionDeps({ connection: script, ackTimeoutMs: 50 });
  const { session } = makeSession(deps);
  const captured = capture(session);
  try {
    await session.start({ text: "first turn" });
    assert.deepEqual(session.send({ mode: "busy", text: "slow steer", attemptId: "s1" }), { ok: true, acceptedAs: "steer" });
    await waitFor(() => (kind(captured, "delivery_outcome").length > 0 ? true : undefined));
    assert.deepEqual(kind(captured, "delivery_outcome"), [
      { kind: "delivery_outcome", source: "cursor_sdk", attemptId: "s1", outcome: "unknown" },
    ]);
    // The SDK may still apply the steer: the gate must stay closed at the timeout.
    assert.equal(session.send({ mode: "busy", text: "second", attemptId: "s2" }).ok, false);

    script.deliver({ kind: "attempt_result", attemptId: "s1", result: "complete_delivered" });
    await waitFor(() => (kind(captured, "delivery_outcome").length > 1 ? true : undefined));
    assert.deepEqual(kind(captured, "delivery_outcome")[1], {
      kind: "delivery_outcome", source: "cursor_sdk", attemptId: "s1", outcome: "delivered", late: true,
    });
    assert.ok(captured.stderrTexts.some((t) => /late steer ack after \d+ms/.test(t)));
    assert.ok(!captured.stderrTexts.some((t) => t.includes("discarded stale attempt result")), "no longer noise");

    // Gate released exactly once: one new steer is accepted, a second is not.
    assert.deepEqual(session.send({ mode: "busy", text: "third", attemptId: "s3" }), { ok: true, acceptedAs: "steer" });
    assert.equal(session.send({ mode: "busy", text: "fourth", attemptId: "s4" }).ok, false);

    // A duplicate late ack changes nothing.
    script.deliver({ kind: "attempt_result", attemptId: "s1", result: "complete_delivered" });
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(kind(captured, "delivery_outcome").length, 2);
    assert.equal(session.send({ mode: "busy", text: "fifth", attemptId: "s5" }).ok, false);
    const state = session.describeStallState();
    assert.equal(state.hasRun, true);
    assert.equal(typeof state.lastHostMessageAgeMs, "number");
    assert.ok(!JSON.stringify(state).includes("slow steer"), "metadata only");
    await session.stop({ reason: "test-done" });
  } finally {
    cleanup();
  }
});

// ── Stream coalescing: whole blocks to the APM, per-chunk progress kept ─────

const trajectoryKinds = (captured: CapturedRun) =>
  captured.events
    .filter((event) => event.kind === "text" || event.kind === "thinking" || event.kind === "tool_call" || event.kind === "turn_end" || event.kind === "internal_progress")
    .map((event) => (event.kind === "text" || event.kind === "thinking" ? `${event.kind}:${event.text}` : event.kind));

test("streamed chunks become one block, every chunk still signals progress, and the last block precedes turn_end", async () => {
  const script = new ScriptedHostConnection();
  const { deps, cleanup } = makeSessionDeps({ connection: script });
  const { session } = makeSession(deps);
  const captured = capture(session);
  try {
    await session.start({ text: "first turn" });
    const runId = (script.runs()[0] as { runId: string }).runId;
    for (const text of ["I'll read the new PM message", " from the Raft thread", " where I was mentioned."]) {
      script.deliver({ kind: "run_event", payload: { type: "assistant_thinking", text } });
    }
    script.deliver({ kind: "run_event", payload: { type: "assistant_text", text: "\n\n" } }); // blank chunk: progress only
    script.deliver({ kind: "run_event", payload: { type: "assistant_text", text: "Done." } });
    await waitFor(() => (captured.events.filter((event) => event.kind === "internal_progress").length >= 5 ? true : undefined));
    // Nothing visible yet except the thinking block flushed by the kind switch.
    assert.deepEqual(captured.events.filter((event) => event.kind === "thinking"), [
      { kind: "thinking", text: "I'll read the new PM message from the Raft thread where I was mentioned." },
    ]);
    script.deliver({ kind: "run_settled", runId, finishReason: "completed" });
    await waitFor(() => (kind(captured, "turn_end").length >= 1 ? true : undefined));
    const order = trajectoryKinds(captured);
    assert.equal(order.filter((entry) => entry === "internal_progress").length, 5, "one progress signal per chunk");
    assert.deepEqual(order.filter((entry) => entry !== "internal_progress"), [
      "thinking:I'll read the new PM message from the Raft thread where I was mentioned.",
      "text:Done.",
      "turn_end",
    ]);
    assert.deepEqual(kind(captured, "internal_progress")[0], {
      kind: "internal_progress", source: "cursor_sdk_stream", itemType: "assistant_thinking", payloadBytes: 28,
    });
    await session.stop({ reason: "test-done" });
  } finally {
    cleanup();
  }
});

test("a tool call flushes the text before it; blank and ellipsis-only blocks are dropped", async () => {
  const script = new ScriptedHostConnection();
  const { deps, cleanup } = makeSessionDeps({ connection: script });
  const { session } = makeSession(deps);
  const captured = capture(session);
  try {
    await session.start({ text: "first turn" });
    script.deliver({ kind: "run_event", payload: { type: "assistant_thinking", text: "…" } });
    script.deliver({ kind: "run_event", payload: { type: "assistant_text", text: "Reading the file" } });
    script.deliver({ kind: "run_event", payload: { type: "tool_call", name: "read", input: {} } });
    await waitFor(() => (kind(captured, "tool_call").length >= 1 ? true : undefined));
    const order = trajectoryKinds(captured).filter((entry) => entry !== "internal_progress");
    assert.deepEqual(order, ["text:Reading the file", "tool_call"], "ellipsis dropped, text emitted before the tool call");
    await session.stop({ reason: "test-done" });
  } finally {
    cleanup();
  }
});

test("stop flushes buffered text before the session closes", async () => {
  const script = new ScriptedHostConnection();
  const { deps, cleanup } = makeSessionDeps({ connection: script });
  const { session } = makeSession(deps);
  const captured = capture(session);
  try {
    await session.start({ text: "first turn" });
    script.deliver({ kind: "run_event", payload: { type: "assistant_text", text: "last words" } });
    await waitFor(() => (kind(captured, "internal_progress").length >= 1 ? true : undefined));
    await session.stop({ reason: "test-done" });
    assert.ok(captured.events.some((event) => event.kind === "text" && event.text === "last words"));
  } finally {
    cleanup();
  }
});
