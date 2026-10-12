/**
 * RFC 070 constructed wake context is gated per server by the
 * `constructed_wake_context` feature flag: the agent:start config carries
 * `constructedWakeContext: true` only when the flag evaluates on for the
 * agent's server, and a missing or off flag leaves the field out (the daemon
 * treats absent as off). Real DB rows and the real flag evaluation; only the
 * machine socket is stubbed.
 */
import { afterEach } from "vitest";
import { dbTest as test } from "../test/integration/dbTest.js";
import { closeTestDatabase } from "../test/integration/database.js";
import assert from "node:assert/strict";

import { getDb } from "../db/index.js";
import { agents, machines, serverMembers, servers, users } from "../db/schema.js";
import { AgentOrchestrator } from "./agentOrchestrator.js";
import { CONSTRUCTED_WAKE_CONTEXT_FEATURE_FLAG_KEY, createFeatureFlag } from "./featureFlagService.js";

afterEach(async () => {
  await closeTestDatabase();
});

class FlagProbeOrchestrator extends AgentOrchestrator {
  evaluate(serverId: string | null | undefined): Promise<boolean> {
    return this.constructedWakeContextEnabled(serverId);
  }
}

async function seed(slug: string) {
  const db = getDb();
  const [owner] = await db.insert(users).values({
    email: `${slug}@example.com`,
    name: "Wake Owner",
    passwordHash: "hash",
    emailVerified: true,
  }).returning();
  const [server] = await db.insert(servers).values({ name: "Wake", slug, ownerId: owner!.id }).returning();
  await db.insert(serverMembers).values({ serverId: server!.id, userId: owner!.id, role: "owner" });
  const [machine] = await db.insert(machines).values({
    serverId: server!.id,
    userId: owner!.id,
    name: "wake-mac",
    apiKeyHash: `hash-${slug}`,
  }).returning();
  const [agent] = await db.insert(agents).values({
    serverId: server!.id,
    name: "wake-agent",
    status: "inactive",
    runtime: "claude",
    model: "sonnet",
    executionMode: "byoc",
    machineId: machine!.id,
  }).returning();
  return { server: server!, machine: machine!, agent: agent! };
}

async function evaluateFor(slug: string): Promise<boolean> {
  const { server } = await seed(slug);
  const orchestrator = new FlagProbeOrchestrator();
  try {
    return await orchestrator.evaluate(server.id);
  } finally {
    await orchestrator.shutdown();
  }
}

// The agent:start config gets `constructedWakeContext: true` exactly when this evaluates true
// (agentOrchestrator.ts: `if (await this.constructedWakeContextEnabled(agent.serverId)) config.constructedWakeContext = true`).
// The decision is tested directly: driving a full `startAgent` leaves the dispatch/ack retry
// machinery spinning after the assertion, which pins a CPU and stalls the DB teardown.

test("constructed wake context: no flag means it is off", async ({ db }) => {
  void db;
  assert.equal(await evaluateFor("cwc-missing"), false);
});

test("constructed wake context: a flag that evaluates off leaves it off", async ({ db }) => {
  void db;
  await createFeatureFlag({ key: CONSTRUCTED_WAKE_CONTEXT_FEATURE_FLAG_KEY, randomizationUnit: "server", defaultEnabled: false });
  assert.equal(await evaluateFor("cwc-off"), false);
});

test("constructed wake context: a flag that evaluates on for the server turns it on", async ({ db }) => {
  void db;
  await createFeatureFlag({ key: CONSTRUCTED_WAKE_CONTEXT_FEATURE_FLAG_KEY, randomizationUnit: "server", defaultEnabled: true });
  assert.equal(await evaluateFor("cwc-on"), true);
});

test("constructed wake context: no server id means off", async ({ db }) => {
  void db;
  const orchestrator = new FlagProbeOrchestrator();
  try {
    assert.equal(await orchestrator.evaluate(null), false);
    assert.equal(await orchestrator.evaluate(undefined), false);
  } finally {
    await orchestrator.shutdown();
  }
});
