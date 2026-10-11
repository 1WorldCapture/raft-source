import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { test } from "vitest";
import { guardChildStdin } from "./probe.js";

/**
 * Task #22 generalised: every daemon child we write stdin to carries an
 * error listener, because a write to an exited child fails asynchronously
 * with EPIPE and an unhandled 'error' event takes down the whole daemon.
 * This pins the shared guard's contract; the sweep wires it at every spawn
 * site (claude/codex/grok/kimi/gemini/opencode/antigravity×2/runtimeSession,
 * plus the pre-existing omp and piCommandTool guards).
 */

test("a guarded child stdin can emit EPIPE without an unhandled error", () => {
  const proc = { stdin: new EventEmitter() } as never;
  guardChildStdin(proc);
  assert.doesNotThrow(() => {
    proc.stdin.emit("error", Object.assign(new Error("write EPIPE"), { code: "EPIPE" }));
  });
});

test("guardChildStdin is idempotent per process", () => {
  const proc = { stdin: new EventEmitter() } as never;
  guardChildStdin(proc);
  guardChildStdin(proc);
  assert.equal(proc.stdin.listenerCount("error"), 1, "one listener is enough; repeats must not stack");
});

test("a process without a piped stdin is a no-op", () => {
  assert.doesNotThrow(() => guardChildStdin({ stdin: null } as never));
});
