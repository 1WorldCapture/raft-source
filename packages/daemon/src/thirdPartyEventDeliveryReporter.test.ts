import assert from "node:assert/strict";
import { test } from "vitest";
import { createThirdPartyEventDeliveryReporter, type ThirdPartyEventDeliveryReportOutcome } from "./thirdPartyEventDeliveryReporter.js";

const EVENT = "aaaaaaaa-0000-4000-8000-000000000175";

function makeReporter(statusSequence: (number | undefined)[], retryBaseMs = 5) {
  const outcomes: ThirdPartyEventDeliveryReportOutcome[] = [];
  const statuses = [...statusSequence];
  const reporter = createThirdPartyEventDeliveryReporter({
    resolveTarget: () => ({ serverUrl: "https://slock.test", apiKey: "sk_agent_x" }),
    fetch: async () => {
      const status = statuses.shift();
      if (status === undefined) throw new Error("network down");
      return new Response("{}", { status });
    },
    retryBaseMs: () => retryBaseMs,
    onOutcome: (outcome) => outcomes.push(outcome),
  });
  return { reporter, outcomes };
}

async function settle(ms = 30): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

test("a 401 drops the batch instead of retrying forever (agent deleted / credential revoked)", async () => {
  // First attempt 500 (retryable), then 401 forever if retried.
  const { reporter, outcomes } = makeReporter([500, 401, 401, 401]);
  reporter.report("agent-1", [EVENT]);
  await settle(60);
  const rejections = outcomes.filter((outcome) => outcome.outcome === "rejected");
  assert.equal(rejections.length, 1, "the 401 batch is dropped exactly once");
  assert.equal(rejections[0]?.httpStatus, 401);
  assert.deepEqual(reporter.pendingEventIds("agent-1"), [], "the ids are released, not pinned");
  // No further attempts happen after the drop.
  const reportedAfterDrop = outcomes.filter((outcome) => outcome.outcome === "retry_scheduled").length;
  await settle(60);
  assert.equal(
    outcomes.filter((outcome) => outcome.outcome === "retry_scheduled").length,
    reportedAfterDrop,
    "no retry is scheduled after a 401 drop",
  );
});

test("a 403 drops the batch the same way", async () => {
  const { reporter, outcomes } = makeReporter([403]);
  reporter.report("agent-1", [EVENT]);
  await settle(30);
  assert.equal(outcomes.filter((outcome) => outcome.outcome === "rejected" && outcome.httpStatus === 403).length, 1);
  assert.deepEqual(reporter.pendingEventIds("agent-1"), []);
});

test("forget drops everything the agent still owes (proxy deregistration)", async () => {
  // All attempts fail with 500 → keeps retrying with backoff.
  const { reporter } = makeReporter([500, 500, 500, 500, 500, 500]);
  reporter.report("agent-1", [EVENT]);
  await settle(20);
  assert.equal(reporter.pendingEventIds("agent-1").length, 1, "still pending before forget");
  reporter.forget("agent-1");
  assert.deepEqual(reporter.pendingEventIds("agent-1"), [], "forget clears the pending set");
  // Even after the old retry window passes, nothing reports.
  await settle(120);
  assert.deepEqual(reporter.pendingEventIds("agent-1"), []);
});
