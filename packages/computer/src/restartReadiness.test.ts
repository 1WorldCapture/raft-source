import assert from "node:assert/strict";
import { test } from "vitest";
import { callerIsRunnerHosted, setParentPidReaderForTests, RUNNER_HOSTED_AGENT_ENV_VAR } from "./restartReadiness.js";

test("the daemon-set agent marker classifies the caller as runner-hosted", () => {
  assert.equal(callerIsRunnerHosted({ [RUNNER_HOSTED_AGENT_ENV_VAR]: "agent-1" }), true);
  assert.equal(callerIsRunnerHosted({}), false, "no marker and no service running is a person's terminal");
});

test("a descendant of the live service is runner-hosted even without the agent marker (in-process SDK lane)", () => {
  // pid 10 -> parent 20 -> parent 30 (the service). pi/kimi-sdk bash tools
  // run with the daemon's own env (no SLOCK_AGENT_ID), but the CLI they
  // invoke is still a descendant of the service.
  const parents = new Map([[10, 20], [20, 30]]);
  setParentPidReaderForTests((pid) => parents.get(pid) ?? null);
  try {
    assert.equal(callerIsRunnerHosted({}, { servicePid: 30, selfPid: 10 }), true);
    // An unrelated process tree is a person's terminal.
    assert.equal(callerIsRunnerHosted({}, { servicePid: 30, selfPid: 99 }), false);
  } finally {
    setParentPidReaderForTests(null);
  }
});

test("when the ancestor walk fails, doubt falls back to the IPC handoff (runner-hosted)", () => {
  setParentPidReaderForTests(() => {
    throw new Error("ps unavailable");
  });
  try {
    assert.equal(callerIsRunnerHosted({}, { servicePid: 30, selfPid: 10 }), true, "an unreadable tree must not authorize a stop");
  } finally {
    setParentPidReaderForTests(null);
  }
});

test("a walk that exhausts without reaching the service still falls back to hosted", () => {
  setParentPidReaderForTests((pid) => (pid === 10 ? 20 : 21));
  try {
    assert.equal(callerIsRunnerHosted({}, { servicePid: 99, selfPid: 10 }), true);
  } finally {
    setParentPidReaderForTests(null);
  }
});
