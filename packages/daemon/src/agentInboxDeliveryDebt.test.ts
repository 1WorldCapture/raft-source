import assert from "node:assert/strict";
import { test } from "vitest";
import {
  createSessionReadyDeliveryRetryState,
  prepareSessionInitDeliveryDebtRetry,
  type PendingInboxDeliveryProcess,
} from "./agentInboxDeliveryDebt.js";
import { RuntimeNotificationState } from "./runtimeNotificationState.js";

function makeProcess(overrides: {
  sessionId?: string | null;
  previousSessionId?: string | null;
  sessionReadyForDelivery?: boolean;
  inboxCount?: number;
  activation?: PendingInboxDeliveryProcess["activation"];
  consumesSpawnPrompt?: boolean;
} = {}): PendingInboxDeliveryProcess {
  const sessionId = overrides.sessionId ?? null;
  return {
    inbox: Array.from({ length: overrides.inboxCount ?? 1 }, (_, index) => ({
      message_id: `m-${index}`,
      content: `pending ${index}`,
    })) as PendingInboxDeliveryProcess["inbox"],
    config: { runtime: "omp", model: "kimi" },
    sessionId,
    sessionReadyForDelivery: overrides.sessionReadyForDelivery ?? false,
    launchId: null,
    driver: {
      supportsStdinNotification: true,
      ...(overrides.consumesSpawnPrompt ? { consumesSpawnPrompt: true } : {}),
    },
    notifications: new RuntimeNotificationState(),
    sessionReadyDeliveryRetry: createSessionReadyDeliveryRetryState(),
    activation: overrides.activation ?? { kind: "idle" },
  };
}

test("spawn_prompt carrier (flag on): a delivered activation skips the session_init fallback", async () => {
  // omp resume regression: the launch presets the resumed session id, so the
  // "session id changed" trigger never fires. The driver forwards ctx.prompt
  // itself (consumesSpawnPrompt), and the activation booking says the spawn
  // prompt carried this input — re-injecting would double-deliver.
  const ap = makeProcess({
    sessionId: "sess-1",
    sessionReadyForDelivery: true,
    activation: { kind: "delivered" },
    consumesSpawnPrompt: true,
  });
  const reason = prepareSessionInitDeliveryDebtRetry(ap, "sess-1");
  assert.equal(reason, null, "no fallback when the spawn prompt carrier is real");
  assert.equal(ap.sessionReadyForDelivery, true);
});

test("no flag: a delivered activation still falls back (runtimes that never consumed ctx.prompt)", async () => {
  // Fresh launch whose session_init flips the id null → real: the fallback
  // stays the delivery path for drivers that don't declare the capability.
  const ap = makeProcess({
    sessionId: "sess-1",
    sessionReadyForDelivery: false,
    activation: { kind: "delivered" },
  });
  const reason = prepareSessionInitDeliveryDebtRetry(ap, null);
  assert.equal(reason, "session_init_ready_with_pending_delivery");
});

test("no flag, unchanged session id: outcome unchanged (resume launches of other runtimes)", async () => {
  const ap = makeProcess({
    sessionId: "sess-1",
    sessionReadyForDelivery: true,
    activation: { kind: "idle" },
  });
  const reason = prepareSessionInitDeliveryDebtRetry(ap, "sess-1");
  assert.equal(reason, null);
});

test("non-delivered activations: the capability flag changes no outcome", async () => {
  // Transient wake without a folded startup input: the activation never
  // closed as spawn_prompt, so the skip guard must not fire — outcome stays
  // governed by the session-id/ready rules alone.
  for (const activation of [{ kind: "idle" as const }, { kind: "open" as const }, { kind: "closed" as const }]) {
    const ap = makeProcess({
      sessionId: "sess-1",
      sessionReadyForDelivery: true,
      activation,
      consumesSpawnPrompt: true,
    });
    const reason = prepareSessionInitDeliveryDebtRetry(ap, "sess-1");
    assert.equal(reason, null, "unchanged session id and ready session still yield null");
    assert.equal(ap.sessionReadyForDelivery, true);
  }
});

test("an empty inbox short-circuits regardless of activation state", async () => {
  const ap = makeProcess({
    sessionId: "sess-1",
    sessionReadyForDelivery: false,
    inboxCount: 0,
    activation: { kind: "delivered" },
    consumesSpawnPrompt: true,
  });
  assert.equal(prepareSessionInitDeliveryDebtRetry(ap, null), null);
});
