import { createApiTest } from "../test/integration/apiTest.js";
/**
 * Task #30: POST /api/agents without machineId must not silently bind to an
 * offline machine (0.2.3 quick check: affinity landed on an offline
 * grok-bot-vm and every start failed with machine_affinity_unavailable).
 *
 *   - online machine (heartbeat inside the continuity window) wins;
 *   - no online machine → affinity stays EMPTY plus a warning on the
 *     returned row (never a silent offline bind);
 *   - explicit machineId is never overridden.
 */
import assert from "node:assert/strict";
import argon2 from "argon2";

import { getDb } from "../db/index.js";
import { users, machines } from "../db/schema.js";
import { eq } from "drizzle-orm";
import { createServer } from "../services/serverService.js";
import {
  createAgent,
  pickOnlineMachineForServer,
  assignMachine,
} from "../services/agentService.js";
import { registerMachine } from "../services/machineService.js";
import { MACHINE_ONLINE_CONTINUITY_MS } from "../services/machineService.js";

const test = createApiTest({ humanActivityMuteFlagDefaultEnabled: true, onboardingOpenerFlagDefaultEnabled: false });

async function seedOwnerWithServer() {
  const db = getDb();
  const [owner] = await db.insert(users).values({
    email: "affinity-owner@slock.test",
    name: "affinity-owner",
    displayName: "Affinity Owner",
    passwordHash: await argon2.hash("password123"),
    emailVerified: true,
    profileSetupCompletedAt: new Date(),
  }).returning();
  const server = await createServer("Affinity Server", `affinity-${Date.now()}`, owner.id);
  return { owner, server };
}

async function setHeartbeat(machineId: string, at: Date) {
  await getDb().update(machines).set({ lastHeartbeat: at }).where(eq(machines.id, machineId));
}

test("createAgent binds to the online machine, not an older offline one", async ({ db }) => {
  void db;
  const { owner, server } = await seedOwnerWithServer();
  const offline = await registerMachine(server.id, owner.id, "affinity-offline");
  const online = await registerMachine(server.id, owner.id, "affinity-online");
  await setHeartbeat(offline.machine.id, new Date(Date.now() - 10 * 60 * 1000));
  await setHeartbeat(online.machine.id, new Date());

  const agent = await createAgent(server.id, "affinity-picks-online", { runtime: "claude" });
  assert.equal(agent.machineId, online.machine.id, "the fresh-heartbeat machine must win");
  assert.equal(agent.machineAffinityWarning, null);
});

test("createAgent with no online machine leaves affinity empty and returns a warning", async ({ db }) => {
  void db;
  const { owner, server } = await seedOwnerWithServer();
  const offline = await registerMachine(server.id, owner.id, "affinity-stale");
  await setHeartbeat(offline.machine.id, new Date(Date.now() - 10 * 60 * 1000));

  const agent = await createAgent(server.id, "affinity-none-online", { runtime: "claude" });
  assert.equal(agent.machineId, null, "must NOT silently bind to the offline machine");
  assert.match(agent.machineAffinityWarning ?? "", /not bound to a computer/i);

  const rows = await getDb().select({ machineId: machines.id })
    .from(machines).where(eq(machines.id, offline.machine.id));
  assert.equal(rows.length, 1);
});

test("createAgent with no machines at all also leaves affinity empty with a warning", async ({ db }) => {
  void db;
  const { server } = await seedOwnerWithServer();
  const agent = await createAgent(server.id, "affinity-no-machines", { runtime: "claude" });
  assert.equal(agent.machineId, null);
  assert.match(agent.machineAffinityWarning ?? "", /not bound to a computer/i);
});

test("an explicit machineId is never overridden by auto-pick", async ({ db }) => {
  void db;
  const { owner, server } = await seedOwnerWithServer();
  const offline = await registerMachine(server.id, owner.id, "affinity-explicit-offline");
  await setHeartbeat(offline.machine.id, new Date(Date.now() - 10 * 60 * 1000));
  const agent = await createAgent(server.id, "affinity-explicit", { runtime: "claude", machineId: offline.machine.id });
  assert.equal(agent.machineId, offline.machine.id);
  assert.equal(agent.machineAffinityWarning, null);
});

test("pickOnlineMachineForServer honors the continuity window and recency order", async ({ db }) => {
  void db;
  const { owner, server } = await seedOwnerWithServer();
  const stale = await registerMachine(server.id, owner.id, "pick-stale");
  const fresh = await registerMachine(server.id, owner.id, "pick-fresh");
  const base = Date.now();
  await setHeartbeat(stale.machine.id, new Date(base - MACHINE_ONLINE_CONTINUITY_MS - 1_000));
  await setHeartbeat(fresh.machine.id, new Date(base));

  assert.equal((await pickOnlineMachineForServer(server.id, getDb(), base))?.id, fresh.machine.id,
    "inside the window the freshest heartbeat wins");
  assert.equal(
    await pickOnlineMachineForServer(server.id, getDb(), base + MACHINE_ONLINE_CONTINUITY_MS + 1),
    null,
    "past the window everything is offline; nothing may be picked",
  );
});

test("startAgent binds an unassigned agent to an online machine (task #30 lazy bind)", async ({ db }) => {
  void db;
  const { owner, server } = await seedOwnerWithServer();
  const machine = await registerMachine(server.id, owner.id, "lazy-bind-machine");
  await setHeartbeat(machine.machine.id, new Date());
  const agent = await createAgent(server.id, "lazy-bind-agent", { runtime: "claude", machineId: undefined });
  // Force the unassigned path (creation above may have bound it).
  await getDb().update((await import("../db/schema.js")).agents)
    .set({ machineId: null })
    .where(eq((await import("../db/schema.js")).agents.id, agent.id));

  const { AgentOrchestrator } = await import("./agentOrchestrator.js");
  const { redisReplicaStateStore } = await import("./replicaStateStore.js");
  const orchestrator = new AgentOrchestrator(redisReplicaStateStore, {
    now: () => Date.now(),
    scheduleRepeated: () => 0,
    cancelRepeated: () => undefined,
    setTimeout: () => 0,
    clearTimeout: () => undefined,
  } as never);
  await assert.rejects(
    orchestrator.startAgent(agent.id, {}),
    /No computer is online|offline|Machine offline|daemon/i,
    "dispatch fails downstream, but only AFTER the lazy bind",
  );
  const [after] = await getDb().select().from((await import("../db/schema.js")).agents)
    .where(eq((await import("../db/schema.js")).agents.id, agent.id));
  assert.equal(after.machineId, machine.machine.id, "the start must have bound the online machine");
});
