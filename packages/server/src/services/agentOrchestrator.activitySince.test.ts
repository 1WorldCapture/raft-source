import assert from "node:assert/strict";
import { test } from "vitest";
import {
  AgentOrchestrator,
  planActivityBroadcastAction,
  planActivitySinceReset,
  planPresenceAnchorPersist,
} from "./agentOrchestrator.js";
import type { AgentActivitySinceMirror } from "./replicaStateStore.js";

// Stable fake clock: `now` is a closure over a mutable value so writes can
// advance time deterministically.
function makeFakeClock(start = 1_000_000) {
  const clock = {
    nowMs: start,
    now: () => clock.nowMs,
    scheduleRepeated: () => null,
    cancelRepeated: () => {},
    setTimeout: () => null,
    clearTimeout: () => {},
  };
  return clock;
}

function makeRecordingReplicaStateStore() {
  const writes: Array<{ agentId: string; activity: string; since: AgentActivitySinceMirror | undefined }> = [];
  return {
    writes,
    isAvailable: () => false,
    registerMachineReplica: async () => "gen",
    restoreMachineReplicaGeneration: async () => {},
    unregisterMachineReplica: async () => {},
    refreshMachineReplica: async () => {},
    hasMachineReplica: async () => false,
    getMachineReplicaOwner: async () => null,
    bumpMachineStatusVersion: async () => 1,
    getMachineStatusVersion: () => 1,
    acquireWakeLock: async () => true,
    releaseWakeLock: async () => {},
    setAgentActivity: async (agentId: string, activity: string, _detail: string, _detailKind: string, _observedAtMs: number | undefined, since: AgentActivitySinceMirror | undefined) => {
      writes.push({ agentId, activity, since });
    },
    getAgentActivity: async () => null,
    setAgentRuntimeError: async () => {},
    getAgentRuntimeError: async () => null,
    setMachineMeta: async () => {},
    getMachineMeta: async () => null,
    clearMachineMeta: async () => {},
  };
}

function seedAgent(orch: AgentOrchestrator, agentId: string, overrides: { status?: string; machineId?: string | null } = {}) {
  (orch as any).agentStateCache.set(agentId, {
    id: agentId,
    status: overrides.status ?? "active",
    machineId: overrides.machineId ?? null,
    sessionId: null,
    expectedLaunchId: null,
    launchGuardMode: "legacy",
    serverId: "server-1",
    name: "DevJayson",
    displayName: null,
    description: null,
    model: "test-model",
    runtime: "test",
    lastRuntimeError: null,
    runtimeState: "unknown",
    reasoningEffort: null,
    envVars: null,
    runtimeConfig: {},
  });
}

test("planActivitySinceReset keeps both stamps when a frame reasserts the current values", () => {
  const plan = planActivitySinceReset({
    previousActivity: "working",
    previousActivitySinceMs: 100,
    previousPresence: "working",
    previousPresenceSinceMs: 100,
    nextActivity: "working",
    nextPresence: "working",
    resetAtMs: 500,
  });
  // Heartbeat / refresh frame: nothing may reset.
  assert.equal(plan.activityChanged, false);
  assert.equal(plan.presenceChanged, false);
  assert.equal(plan.activitySinceMs, 100);
  assert.equal(plan.presenceSinceMs, 100);
});

test("planActivitySinceReset: thinking→working resets activitySince but not presenceSince", () => {
  const plan = planActivitySinceReset({
    previousActivity: "thinking",
    previousActivitySinceMs: 100,
    previousPresence: "working",
    previousPresenceSinceMs: 90,
    nextActivity: "working",
    nextPresence: "working",
    resetAtMs: 500,
  });
  assert.equal(plan.activityChanged, true);
  assert.equal(plan.presenceChanged, false);
  assert.equal(plan.activitySinceMs, 500);
  assert.equal(plan.presenceSinceMs, 90);
});

test("planActivitySinceReset: working→online resets both stamps", () => {
  const plan = planActivitySinceReset({
    previousActivity: "working",
    previousActivitySinceMs: 100,
    previousPresence: "working",
    previousPresenceSinceMs: 100,
    nextActivity: "online",
    nextPresence: "idle",
    resetAtMs: 700,
  });
  assert.equal(plan.activityChanged, true);
  assert.equal(plan.presenceChanged, true);
  assert.equal(plan.activitySinceMs, 700);
  assert.equal(plan.presenceSinceMs, 700);
});

test("planActivitySinceReset keeps unknown previous stamps null until a real change", () => {
  const unchanged = planActivitySinceReset({
    previousActivity: "online",
    previousActivitySinceMs: undefined,
    previousPresence: "idle",
    previousPresenceSinceMs: undefined,
    nextActivity: "online",
    nextPresence: "idle",
    resetAtMs: 5,
  });
  assert.equal(unchanged.activitySinceMs, null);
  assert.equal(unchanged.presenceSinceMs, null);

  const changed = planActivitySinceReset({
    previousActivity: "online",
    previousActivitySinceMs: undefined,
    previousPresence: "idle",
    previousPresenceSinceMs: undefined,
    nextActivity: "offline",
    nextPresence: "offline",
    resetAtMs: 5,
  });
  assert.equal(changed.activitySinceMs, 5);
  assert.equal(changed.presenceSinceMs, 5);
});

test("planPresenceAnchorPersist anchors only real changes on refresh frames", () => {
  // Heartbeat / probe / delivery-ack refresh frames carry real observations;
  // a value change on them must reach the durable log.
  for (const action of ["heartbeat-refresh", "probe-refresh", "delivery-ack-refresh"] as const) {
    assert.equal(planPresenceAnchorPersist({ broadcastAction: action, activityChanged: true, presenceChanged: false }), true, action);
    assert.equal(planPresenceAnchorPersist({ broadcastAction: action, activityChanged: false, presenceChanged: true }), true, action);
    assert.equal(planPresenceAnchorPersist({ broadcastAction: action, activityChanged: false, presenceChanged: false }), false, action);
  }
  // Debounced status-only frames are the non-persistable liveness stream
  // (runtime_progress hearts, online pulses, ready-reconcile projections) —
  // APM 1.6 (6a) keeps them out of the durable log entirely.
  assert.equal(planPresenceAnchorPersist({ broadcastAction: "debounce-only", activityChanged: true, presenceChanged: true }), false);
  // persist-and-emit-now already lands its own durable row.
  assert.equal(planPresenceAnchorPersist({ broadcastAction: "persist-and-emit-now", activityChanged: true, presenceChanged: true }), false);
});

test("planActivityBroadcastAction keeps refresh frames non-persisting (anchor precondition)", () => {
  // A value-carrying heartbeat frame is exactly the case the anchor covers.
  assert.equal(planActivityBroadcastAction({
    hasEntries: false,
    isHeartbeat: true,
    isProbeResponse: false,
    isDeliveryAckTurnActive: false,
    shouldPersistStatusOnly: true,
  }), "heartbeat-refresh");
});

test("writeAgentActivitySnapshot: heartbeats keep since, real changes reset it, Redis mirror carries the fields", async () => {
  const clock = makeFakeClock();
  const store = makeRecordingReplicaStateStore();
  const orch = new AgentOrchestrator(store as any, clock as any);
  const agentId = "a1a1a1a1-0000-4000-8000-000000000001";
  seedAgent(orch, agentId);

  const write = (activity: string, at: number) => {
    clock.nowMs = at;
    return (orch as any).writeAgentActivitySnapshot(agentId, activity, "", "none", at);
  };

  // The very first frame has no previous value in memory (fresh process):
  // nothing proves a change, so both stamps stay unresolved and the Redis
  // mirror is asked to keep whatever still matches.
  const unresolved = write("online", 500);
  assert.equal(unresolved.previousKnown, false);
  assert.equal(unresolved.snapshot.activitySinceMs, null);
  assert.equal(unresolved.snapshot.presenceSinceMs, null);
  assert.equal(unresolved.snapshot.activitySinceUnresolved, true);
  assert.equal(store.writes[0].since?.preserveMatching, true);

  // A real change against the now-known value establishes both stamps.
  const first = write("working", 1000);
  assert.equal(first.snapshot.activity, "working");
  assert.equal(first.snapshot.activitySinceMs, 1000);
  assert.equal(first.snapshot.presence, "working");
  assert.equal(first.snapshot.presenceSinceMs, 1000);

  // Heartbeat-style reassert at a later instant: nothing resets.
  const heartbeat = write("working", 2000);
  assert.equal(heartbeat.snapshot.activitySinceMs, 1000);
  assert.equal(heartbeat.snapshot.presenceSinceMs, 1000);

  // thinking→working: activity value changed, presence did not.
  const thinking = write("thinking", 3000);
  assert.equal(thinking.snapshot.activitySinceMs, 3000);
  assert.equal(thinking.snapshot.presenceSinceMs, 1000);

  // working→online: activity and presence both change.
  const idle = write("online", 4000);
  assert.equal(idle.snapshot.activitySinceMs, 4000);
  assert.equal(idle.snapshot.presence, "idle");
  assert.equal(idle.snapshot.presenceSinceMs, 4000);

  // Another idle reassert (e.g. refresh) keeps the idle stamps.
  const idleAgain = write("online", 5000);
  assert.equal(idleAgain.snapshot.activitySinceMs, 4000);
  assert.equal(idleAgain.snapshot.presenceSinceMs, 4000);

  // The Redis mirror received the same since fields on every known write.
  const known = store.writes.filter((w) => w.since?.preserveMatching !== true);
  assert.deepEqual(known[1].since, { activitySinceMs: 1000, presence: "working", presenceSinceMs: 1000 });
  assert.deepEqual(known[3].since, { activitySinceMs: 4000, presence: "idle", presenceSinceMs: 4000 });
});

test("writeAgentActivitySnapshot: a known non-active lifecycle status projects offline presence", () => {
  const clock = makeFakeClock();
  const store = makeRecordingReplicaStateStore();
  const orch = new AgentOrchestrator(store as any, clock as any);
  const agentId = "a1a1a1a1-0000-4000-8000-000000000002";
  seedAgent(orch, agentId, { status: "stopped" });
  // Known previous value (working) so the offline projection is a real change.
  (orch as any).agentActivity.set(agentId, {
    activity: "working", detail: "", detailKind: "none", updatedAt: 0,
    activitySinceMs: 1, presence: "working", presenceSinceMs: 1,
  });

  const result = (orch as any).writeAgentActivitySnapshot(agentId, "online", "", "none", 1000);
  assert.equal(result.snapshot.presence, "offline");
  assert.equal(result.snapshot.presenceSinceMs, 1000);
});

test("writeAgentActivitySnapshot: a locally connected machine keeps the working projection online-side", () => {
  const clock = makeFakeClock();
  const store = makeRecordingReplicaStateStore();
  const orch = new AgentOrchestrator(store as any, clock as any);
  const agentId = "a1a1a1a1-0000-4000-8000-000000000003";
  seedAgent(orch, agentId, { machineId: "machine-1" });
  // No real machine connection is registered, so the sync machine fact is
  // unknown and must NOT fabricate an offline presence.
  const result = (orch as any).writeAgentActivitySnapshot(agentId, "online", "", "none", 1000);
  assert.equal(result.snapshot.presence, "idle");
});
