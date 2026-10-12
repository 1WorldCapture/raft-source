import { createApiTest } from "../test/integration/apiTest.js";
/**
 * B1 follow-ups (PM review of #347):
 *
 *   1. A human channel resume carries a resume prompt, which classifies the
 *      start as automatic — but a human act must lift a tripped wake
 *      crash-loop block like a manual start (previously it was refused while
 *      the route still reported ok:true).
 *   2. A refused automatic wake marks the catch-up owed, so the cooldown-end
 *      re-wake (scheduleWakeCrashLoopCatchup) has a debt to act on.
 */
import assert from "node:assert/strict";
import argon2 from "argon2";

import { getDb } from "../db/index.js";
import { users } from "../db/schema.js";
import { createServer } from "../services/serverService.js";
import { createAgent, assignMachine } from "../services/agentService.js";
import { registerMachine } from "../services/machineService.js";
import { AgentOrchestrator } from "./agentOrchestrator.js";
import { redisReplicaStateStore } from "./replicaStateStore.js";
import { localWakeCrashLoopStateStore } from "../replicaRouter.js";
import { freshWakeCrashLoopEpisode, WakeCrashLoopBreaker } from "./wakeCrashLoopBreaker.js";

const test = createApiTest({ humanActivityMuteFlagDefaultEnabled: true, onboardingOpenerFlagDefaultEnabled: false });

function makeClock() {
  return {
    now: () => Date.now(),
    scheduleRepeated: () => 0,
    cancelRepeated: () => undefined,
    setTimeout: () => 0,
    clearTimeout: () => undefined,
  };
}

async function seedBlockedAgentFixture(blocked: boolean) {
  const db = getDb();
  const [owner] = await db.insert(users).values({
    email: "wcl-followup-owner@slock.test",
    name: "wcl-followup-owner",
    displayName: "WCL Followup Owner",
    passwordHash: await argon2.hash("password123"),
    emailVerified: true,
    profileSetupCompletedAt: new Date(),
  }).returning();
  // createServer already adds the owner as a server member.
  const server = await createServer("WCL Followup Server", `wcl-followup-${Date.now()}`, owner.id);
  const agent = await createAgent(server.id, "wcl-followup-agent", { runtime: "claude" });
  const { machine } = await registerMachine(server.id, owner.id, "wcl-followup-daemon");
  await assignMachine(agent.id, machine.id);

  if (blocked) {
    // In tests Redis is unavailable, so the replica store routes to the
    // module-local in-memory CAS store the orchestrator's breaker also uses.
    const blockedState = {
      ...freshWakeCrashLoopEpisode(1),
      earlyExitCount: 3,
      blocked: true,
      blockedAtMs: Date.now(),
    };
    await localWakeCrashLoopStateStore.compareAndSetWakeCrashLoopState(agent.id, 0, blockedState);
  }
  return { owner, server, agent };
}

test("an automatic resume wake is refused while the breaker is tripped, and marks the catch-up owed", async ({ db }) => {
  void db;
  const { agent } = await seedBlockedAgentFixture(true);
  const orchestrator = new AgentOrchestrator(redisReplicaStateStore, makeClock() as never);

  const result = await orchestrator.startAgent(agent.id, { resumePrompt: "catch up please" });
  assert.deepEqual(result, { outcome: "skipped", reason: "wake_crash_loop_blocked" });

  const breaker = new WakeCrashLoopBreaker(redisReplicaStateStore);
  assert.equal(await breaker.isCatchupOwed(agent.id), true, "a refused wake must mark the catch-up owed");
});

test("a human resume wake passes the tripped-breaker gate (and fails later at dispatch, not at the gate)", async ({ db }) => {
  void db;
  const { agent } = await seedBlockedAgentFixture(true);
  const orchestrator = new AgentOrchestrator(redisReplicaStateStore, makeClock() as never);

  let captured: unknown;
  try {
    await orchestrator.startAgent(agent.id, { resumePrompt: "catch up please", human: true });
  } catch (err) {
    captured = err;
  }
  assert.ok(captured instanceof Error, "a human wake must pass the gate and proceed to dispatch");
  assert.doesNotMatch(captured.message, /wake_crash_loop_blocked/, "the failure must not be the breaker refusal");
});
