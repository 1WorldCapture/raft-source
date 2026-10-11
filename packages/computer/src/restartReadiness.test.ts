import assert from "node:assert/strict";
import { test } from "vitest";
import { callerIsRunnerHosted } from "./restartReadiness.js";

test("callerIsRunnerHosted is true only when the daemon-set agent env var is present", () => {
  assert.equal(callerIsRunnerHosted({}), false);
  assert.equal(callerIsRunnerHosted({ SLOCK_AGENT_ID: "" }), false);
  assert.equal(callerIsRunnerHosted({ SLOCK_AGENT_ID: "bf000419-4d0a-48bd-a142-42fdeb7c1675" }), true);
});
