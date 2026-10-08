/**
 * Fake Cursor SDK host fixture for focused driver tests.
 *
 * A real child process speaking the cursorSdk private IPC protocol
 * (protocol.ts), executable by plain Node. It validates the production
 * spawn contract end-to-end (stdio ipc channel, RAFT_CURSOR_SDK_HOST_ENTRY
 * entry guard, host_ready/init handshake, run/steer/stop settlement) without
 * importing @cursor/sdk.
 *
 * Scenario knobs:
 *   - env FAKE_HOST_MODE: happy (default) | hang_run | hang_stop | crash_after_init | poisoned
 *   - run text markers: "RUN_ERROR:<msg>" (error settle), "HANG_RUN" (never settle)
 *   - steer text markers: "REVERT:<msg>" | "FAIL:<msg>" | "HANG" | else delivered
 */

const PROTOCOL_VERSION = 1;

function send(message) {
  if (process.send) {
    try {
      process.send(message);
    } catch {
      /* channel closed */
    }
  }
}

function errClassOf(text, fallback) {
  const match = /errorClass=(\w+)/.exec(text ?? "");
  return match ? match[1] : fallback;
}

const mode = process.env.FAKE_HOST_MODE ?? "happy";
let runCount = 0;
let stopped = false;

function handleInit(init) {
  if (init.protocolVersion !== PROTOCOL_VERSION) {
    send({
      kind: "init_result",
      ok: false,
      sessionId: null,
      error: { message: "protocol mismatch", errorClass: "protocol" },
    });
    return;
  }
  process.stderr.write("[fake-host] initialized\n");
  send({ kind: "init_result", ok: true, sessionId: `fake-session-${Date.now()}` });
  if (mode === "crash_after_init") {
    setTimeout(() => process.exit(3), 10);
  }
}

function handleRunSubmit(msg) {
  runCount += 1;
  if (mode === "poisoned") {
    // Like the real host when agent.send rejects: failed attempt, then settlement.
    const error = { message: "Cursor rejected a concurrent run", errorClass: "busy" };
    send({ kind: "attempt_result", attemptId: msg.attemptId ?? null, result: "failed", error });
    send({ kind: "run_settled", runId: msg.runId, finishReason: "error", error });
    return;
  }
  if (msg.attemptId !== null && msg.attemptId !== undefined) {
    send({ kind: "attempt_result", attemptId: msg.attemptId, result: "complete_delivered" });
  }
  if (runCount === 1) {
    send({ kind: "session_init", sessionId: `fake-session-${runCount}` });
  }
  send({
    kind: "run_event",
    payload: { type: "user_echo", payloadBytes: Buffer.byteLength(msg.text ?? "", "utf8") },
  });
  send({ kind: "run_event", payload: { type: "assistant_text", text: `ack: ${(msg.text ?? "").slice(0, 40)}` } });
  if ((msg.text ?? "").startsWith("RUN_ERROR:")) {
    const detail = msg.text.slice("RUN_ERROR:".length);
    setTimeout(() => {
      send({
        kind: "run_settled",
        runId: msg.runId,
        finishReason: "error",
        error: { message: detail || "scripted failure", errorClass: "host_internal" },
      });
    }, 20);
    return;
  }
  if ((msg.text ?? "").startsWith("HANG_RUN")) {
    return; // never settles; stop() decides the outcome
  }
  setTimeout(() => {
    send({ kind: "run_settled", runId: msg.runId, finishReason: "completed" });
  }, 20);
}

function handleSteerSubmit(msg) {
  const text = msg.text ?? "";
  if (text.startsWith("HANG")) return; // never answers: ACK timeout driver-side
  if (text.startsWith("REVERT:")) {
    send({
      kind: "attempt_result",
      attemptId: msg.attemptId ?? null,
      result: "revert",
      error: { message: text.slice("REVERT:".length) || "agent busy", errorClass: "unknown_agent" },
    });
    return;
  }
  if (text.startsWith("FAIL:")) {
    send({
      kind: "attempt_result",
      attemptId: msg.attemptId ?? null,
      result: "failed",
      error: { message: text.slice("FAIL:".length) || "not found", errorClass: "agent_not_found" },
    });
    return;
  }
  setTimeout(() => {
    send({
      kind: "attempt_result",
      attemptId: msg.attemptId ?? null,
      result: "complete_delivered",
    });
  }, 5);
}

function handleStop(msg) {
  if (stopped) return;
  stopped = true;
  if (mode === "hang_stop") {
    process.stderr.write(`[fake-host] hanging on stop: ${msg.reason}\n`);
    return; // never settles, never exits: driver must force-kill the group
  }
  const settleIn = mode === "hang_run" ? 100 : 10;
  setTimeout(() => {
    send({ kind: "shutdown_settled", outcome: "clean" });
    setTimeout(() => {
      try {
        process.disconnect?.();
      } catch {}
      process.exit(0);
    }, 10);
  }, settleIn);
}

// Entry guard: mirrors the production host contract.
if (process.env.RAFT_CURSOR_SDK_HOST_ENTRY !== "1") {
  process.stderr.write("[fake-host] missing entry guard env\n");
  process.exit(1);
}

send({ kind: "host_ready", protocolVersion: PROTOCOL_VERSION });

process.on("message", (message) => {
  if (!message || typeof message !== "object") return;
  switch (message.kind) {
    case "init":
      handleInit(message);
      break;
    case "run_submit":
      handleRunSubmit(message);
      break;
    case "steer_submit":
      handleSteerSubmit(message);
      break;
    case "stop":
      handleStop(message);
      break;
    default:
      break;
  }
});

process.on("disconnect", () => {
  process.exit(0);
});

// Forced-kill escalation probe: deliberately survive the stop-deadline
// SIGTERM so tests can prove the driver escalates to SIGKILL of the whole
// process group.
if (process.env.FAKE_IGNORE_SIGTERM === "1") {
  const ignore = (signal) => {
    process.stderr.write(`[fake-host] ignoring ${signal}\n`);
  };
  process.on("SIGTERM", () => ignore("SIGTERM"));
  process.on("SIGINT", () => ignore("SIGINT"));
}
