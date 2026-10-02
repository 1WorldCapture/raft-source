// Regressions for the tracked-delivery retry policy (task #8, #bugfix):
// the fixed 5-second re-send cadence plus an invisible per-track budget
// turned one unacknowledged mention into a quarter-hour storm. The policy
// that now governs re-sends must hold three properties:
//   1. backoff is exponential and capped — never a flat 5s drumbeat;
//   2. the budget is persistent: exhaustion produces a QUERYABLE terminal
//      verdict, not a silent tracker drop that lets the next track restart
//      the clock;
//   3. a late terminal_error only stops the tracked attempt its OWN
//      generation matches — an old process's error never cancels a
//      delivery a new process has taken over.
import assert from "node:assert/strict";
import { test } from "vitest";
import {
  AGENT_DELIVERY_ACK_BACKOFF_CAP_MS,
  AGENT_DELIVERY_ACK_MAX_ATTEMPTS,
  AGENT_DELIVERY_ACK_TIMEOUT_BASE_MS,
  agentDeliveryAckBackoffMs,
  agentDeliveryRetryExhaustion,
  terminalErrorMatchesTrackedGeneration,
  unconfirmableIdentityVerdict,
} from "./agentDeliveryRetryPolicy.js";

test("backoff doubles from the base and caps at 5 minutes", () => {
  // attempts = sends already made; the wait before the NEXT send doubles
  // per completed send: after 1 send wait 5s, after 2 wait 10s, after 3
  // wait 20s, and so on.
  assert.equal(agentDeliveryAckBackoffMs(0), 5_000);
  assert.equal(agentDeliveryAckBackoffMs(1), 5_000);
  assert.equal(agentDeliveryAckBackoffMs(2), 10_000);
  assert.equal(agentDeliveryAckBackoffMs(3), 20_000);
  assert.equal(agentDeliveryAckBackoffMs(4), 40_000);
  // Deep into the sequence the cap binds and STAYS bound — no drumbeat, no
  // overflow surprise.
  for (const attempts of [10, 20, AGENT_DELIVERY_ACK_MAX_ATTEMPTS, 1000]) {
    assert.equal(agentDeliveryAckBackoffMs(attempts), AGENT_DELIVERY_ACK_BACKOFF_CAP_MS);
  }
  assert.ok(agentDeliveryAckBackoffMs(-5) >= AGENT_DELIVERY_ACK_TIMEOUT_BASE_MS, "nonsense attempts still yields a sane delay");
});

test("exhaustion yields a queryable verdict with the budget's own facts", () => {
  const verdict = agentDeliveryRetryExhaustion(AGENT_DELIVERY_ACK_MAX_ATTEMPTS, 1_000, 61_000);
  assert.equal(verdict.code, "RETRY_EXHAUSTED");
  assert.equal(verdict.attempts, AGENT_DELIVERY_ACK_MAX_ATTEMPTS);
  assert.equal(verdict.firstAttemptAgeMs, 60_000);
});

test("a late terminal_error stops only the tracked attempt of its own generation", () => {
  const tracked = {
    machineId: "machine-1",
    mentionDelivery: { machineId: "machine-1", launchId: "launch-NEW", sessionId: "session-NEW" },
  };
  // Same generation: the error belongs to this attempt — it may stop it.
  assert.equal(
    terminalErrorMatchesTrackedGeneration(tracked, { machineId: "machine-1", launchId: "launch-NEW", sessionId: "session-NEW" }),
    true,
  );
  // OLD generation (stale process reporting after a restart): must NOT
  // cancel the attempt the new process took over.
  assert.equal(
    terminalErrorMatchesTrackedGeneration(tracked, { machineId: "machine-1", launchId: "launch-OLD", sessionId: "session-OLD" }),
    false,
  );
  // Any single disagreeing axis refuses the match.
  assert.equal(
    terminalErrorMatchesTrackedGeneration(tracked, { machineId: "machine-2", launchId: "launch-NEW", sessionId: "session-NEW" }),
    false,
  );
  // Untracked delivery: machine identity is the only signal available.
  assert.equal(
    terminalErrorMatchesTrackedGeneration({ machineId: "machine-1" }, { machineId: "machine-1", launchId: "any", sessionId: "any" }),
    true,
  );
});

test("an unconfirmable identity stops the current attempt but keeps the message recoverable", () => {
  const verdict = unconfirmableIdentityVerdict();
  assert.equal(verdict.stopCurrentAttempt, true);
  assert.equal(verdict.keepRecoverable, true);
});
