import { test, onTestFinished } from "vitest";
import assert from "node:assert/strict";
import { and, eq, isNull } from "drizzle-orm";
import { randomUUID } from "node:crypto";

import { closeTestDatabase, openTestDatabase } from "../test/integration/database.js";
import { getDb } from "../db/index.js";
import { agents, channels, machines, serverMembers, servers, users } from "../db/schema.js";
import { createAgent, PmAlreadyProvisionedError } from "./agentService.js";
import {
  PM_IDENTITY,
  PM_RUNTIME_PREFERENCE,
  maybeProvisionServerPm,
  selectPmRuntimeFromReported,
} from "./serverPmProvisioning.js";
import { findOrCreateDM } from "./channelService.js";

async function openDb() {
  await openTestDatabase("pglite://");
  onTestFinished(async () => closeTestDatabase());
  return getDb();
}

async function seedOwnerServer(db: ReturnType<typeof getDb>) {
  const name = `pm-owner-${randomUUID().slice(0, 8)}`;
  const [owner] = await db.insert(users).values({
    email: `${name}@test.invalid`,
    name,
    displayName: name,
    passwordHash: "test-password-hash",
  }).returning();
  const [server] = await db.insert(servers).values({
    name: `PM server ${name}`,
    slug: `pm-${randomUUID().slice(0, 8)}`,
    ownerId: owner.id,
  }).returning();
  await db.insert(serverMembers).values({ serverId: server.id, userId: owner.id, role: "owner" });
  return { owner, server };
}

async function seedMachine(
  db: ReturnType<typeof getDb>,
  input: { serverId: string; userId: string; runtimes?: string[] | null },
) {
  const [machine] = await db.insert(machines).values({
    serverId: input.serverId,
    userId: input.userId,
    name: `machine-${randomUUID().slice(0, 8)}`,
    apiKeyHash: "test-machine-key-hash",
    runtimes: input.runtimes === undefined ? null : input.runtimes,
  }).returning();
  return machine;
}

async function listServerAgents(db: ReturnType<typeof getDb>, serverId: string) {
  return db.select().from(agents).where(and(eq(agents.serverId, serverId), isNull(agents.deletedAt)));
}

async function getServerPmAgentId(db: ReturnType<typeof getDb>, serverId: string): Promise<string | null> {
  const [row] = await db
    .select({ pmAgentId: servers.pmAgentId })
    .from(servers)
    .where(eq(servers.id, serverId));
  return row?.pmAgentId ?? null;
}

test("selectPmRuntimeFromReported honors the declared preference order", () => {
  assert.equal(selectPmRuntimeFromReported(["omp", "codex", "claude"]), PM_RUNTIME_PREFERENCE[0]);
  assert.equal(selectPmRuntimeFromReported(["omp", "codex"]), "codex");
  assert.equal(selectPmRuntimeFromReported(["pi", "omp"]), "omp");
  assert.equal(selectPmRuntimeFromReported([]), null);
  assert.equal(selectPmRuntimeFromReported(null), null);
  assert.equal(selectPmRuntimeFromReported(["gemini"]), null);
});

test("provisions a PM agent when an owner machine first reports runtimes", async () => {
  const db = await openDb();
  const { owner, server } = await seedOwnerServer(db);
  const machine = await seedMachine(db, { serverId: server.id, userId: owner.id, runtimes: ["claude"] });

  const agentId = await maybeProvisionServerPm({ machineId: machine.id });

  assert.ok(agentId);
  const [pm] = await db.select().from(agents).where(eq(agents.id, agentId));
  assert.equal(pm.name, PM_IDENTITY.name);
  assert.equal(pm.displayName, PM_IDENTITY.displayName);
  assert.equal(pm.description, PM_IDENTITY.description);
  assert.equal(pm.avatarUrl, PM_IDENTITY.avatarUrl);
  assert.equal(pm.runtime, "claude");
  assert.equal(pm.machineId, machine.id);
  assert.equal(pm.creatorType, "user");
  assert.equal(pm.creatorId, owner.id);

  assert.equal(await getServerPmAgentId(db, server.id), agentId);

  // The provisioning user gets a visible DM with the new PM.
  const dm = await findOrCreateDM(server.id, owner.id, agentId);
  assert.ok(dm);
});

test("prefers reported runtimes by the declared preference order", async () => {
  const db = await openDb();
  const { owner, server } = await seedOwnerServer(db);
  const machine = await seedMachine(db, { serverId: server.id, userId: owner.id, runtimes: ["omp", "codex"] });

  const agentId = await maybeProvisionServerPm({ machineId: machine.id });
  assert.ok(agentId);
  const [pm] = await db.select().from(agents).where(eq(agents.id, agentId));
  assert.equal(pm.runtime, "codex");
});

test("does not provision when no reported runtime matches the preference", async () => {
  const db = await openDb();
  const { owner, server } = await seedOwnerServer(db);
  const machine = await seedMachine(db, { serverId: server.id, userId: owner.id, runtimes: ["gemini"] });

  const agentId = await maybeProvisionServerPm({ machineId: machine.id });
  assert.equal(agentId, null);
  const rows = await listServerAgents(db, server.id);
  assert.equal(rows.length, 0);
  assert.equal(await getServerPmAgentId(db, server.id), null);
});

test("is idempotent across repeated capabilities reports", async () => {
  const db = await openDb();
  const { owner, server } = await seedOwnerServer(db);
  const machine = await seedMachine(db, { serverId: server.id, userId: owner.id, runtimes: ["claude"] });

  const first = await maybeProvisionServerPm({ machineId: machine.id });
  const second = await maybeProvisionServerPm({ machineId: machine.id });

  assert.ok(first);
  assert.equal(second, null);
  const rows = await listServerAgents(db, server.id);
  assert.equal(rows.length, 1);
  assert.equal(await getServerPmAgentId(db, server.id), first);
});

test("does not override a PM that was already set (user-chosen)", async () => {
  const db = await openDb();
  const { owner, server } = await seedOwnerServer(db);
  const machine = await seedMachine(db, { serverId: server.id, userId: owner.id, runtimes: ["claude"] });
  const [chosen] = await db.insert(agents).values({
    serverId: server.id,
    name: "Chosen",
    displayName: "Chosen",
    runtime: "codex",
  }).returning();
  await db.update(servers).set({ pmAgentId: chosen.id }).where(eq(servers.id, server.id));

  const result = await maybeProvisionServerPm({ machineId: machine.id });

  assert.equal(result, null);
  assert.equal(await getServerPmAgentId(db, server.id), chosen.id);
  const rows = await listServerAgents(db, server.id);
  assert.equal(rows.length, 1);
});

test("skips provisioning when the registering user is not owner/admin", async () => {
  const db = await openDb();
  const { owner, server } = await seedOwnerServer(db);
  const memberName = `pm-member-${randomUUID().slice(0, 8)}`;
  const [member] = await db.insert(users).values({
    email: `${memberName}@test.invalid`,
    name: memberName,
    displayName: memberName,
    passwordHash: "test-password-hash",
  }).returning();
  await db.insert(serverMembers).values({ serverId: server.id, userId: member.id, role: "member" });
  const machine = await seedMachine(db, { serverId: server.id, userId: member.id, runtimes: ["claude"] });
  // Sanity: an owner-owned machine would provision; this one must not.
  await seedMachine(db, { serverId: server.id, userId: owner.id, runtimes: null });

  const result = await maybeProvisionServerPm({ machineId: machine.id });

  assert.equal(result, null);
  const rows = await listServerAgents(db, server.id);
  assert.equal(rows.length, 0);
});

test("skips provisioning when the server is soft-deleted", async () => {
  const db = await openDb();
  const { owner, server } = await seedOwnerServer(db);
  const machine = await seedMachine(db, { serverId: server.id, userId: owner.id, runtimes: ["claude"] });
  await db.update(servers).set({ deletedAt: new Date() }).where(eq(servers.id, server.id));

  const result = await maybeProvisionServerPm({ machineId: machine.id });

  assert.equal(result, null);
});

test("claimServerPm loser rolls back cleanly and leaves no orphan agent", async () => {
  const db = await openDb();
  const { owner, server } = await seedOwnerServer(db);

  const winner = await createAgent(server.id, "PM", {
    runtime: "claude",
    claimServerPm: true,
    creatorType: "user",
    creatorId: owner.id,
  });
  assert.equal(await getServerPmAgentId(db, server.id), winner.id);

  await assert.rejects(
    () => createAgent(server.id, "PM-shadow", {
      runtime: "claude",
      claimServerPm: true,
      creatorType: "user",
      creatorId: owner.id,
    }),
    PmAlreadyProvisionedError,
  );

  const rows = await listServerAgents(db, server.id);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].id, winner.id);
  assert.equal(await getServerPmAgentId(db, server.id), winner.id);
});

test("silently gives up when an agent named PM already exists", async () => {
  const db = await openDb();
  const { owner, server } = await seedOwnerServer(db);
  const machine = await seedMachine(db, { serverId: server.id, userId: owner.id, runtimes: ["claude"] });
  const [existingPm] = await db.insert(agents).values({
    serverId: server.id,
    name: "PM",
    displayName: "PM",
    runtime: "codex",
  }).returning();

  // Repeated reports must not retry the doomed create (no error churn):
  // the name twin is detected up front.
  const first = await maybeProvisionServerPm({ machineId: machine.id });
  const second = await maybeProvisionServerPm({ machineId: machine.id });

  assert.equal(first, null);
  assert.equal(second, null);
  assert.equal(await getServerPmAgentId(db, server.id), null);
  const rows = await listServerAgents(db, server.id);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].id, existingPm.id);
});

test("does not auto-provision for a server created before the feature cutover", async () => {
  const db = await openDb();
  const { owner, server } = await seedOwnerServer(db);
  const machine = await seedMachine(db, { serverId: server.id, userId: owner.id, runtimes: ["claude"] });
  // Legacy server: predates PM_AUTO_PROVISION_SINCE — its PM comes from the
  // user's choice in the onboarding guide, never from the hook.
  await db.update(servers).set({ createdAt: new Date("2026-01-01T00:00:00Z") }).where(eq(servers.id, server.id));

  const result = await maybeProvisionServerPm({ machineId: machine.id });

  assert.equal(result, null);
  assert.equal(await getServerPmAgentId(db, server.id), null);
  const rows = await listServerAgents(db, server.id);
  assert.equal(rows.length, 0);
});

test("does not auto-provision when the setup guide was dismissed", async () => {
  const db = await openDb();
  const { owner, server } = await seedOwnerServer(db);
  const machine = await seedMachine(db, { serverId: server.id, userId: owner.id, runtimes: ["claude"] });
  await db.update(servers).set({ pmSetupDismissedAt: new Date() }).where(eq(servers.id, server.id));

  const result = await maybeProvisionServerPm({ machineId: machine.id });

  assert.equal(result, null);
  assert.equal(await getServerPmAgentId(db, server.id), null);
  const rows = await listServerAgents(db, server.id);
  assert.equal(rows.length, 0);
});

test("returns null without throwing for an unknown machine", async () => {
  await openDb();
  const result = await maybeProvisionServerPm({ machineId: randomUUID() });
  assert.equal(result, null);
});

test("a failing DM setup does not fail provisioning", async () => {
  const db = await openDb();
  const { owner, server } = await seedOwnerServer(db);
  const machine = await seedMachine(db, { serverId: server.id, userId: owner.id, runtimes: ["claude"] });
  const throwingIo = {
    to: () => {
      throw new Error("socket room failure");
    },
  };

  const agentId = await maybeProvisionServerPm({ machineId: machine.id, io: throwingIo });

  assert.ok(agentId);
  assert.equal(await getServerPmAgentId(db, server.id), agentId);
  const [dmCount] = await db.select({ id: channels.id }).from(channels).where(and(eq(channels.serverId, server.id), eq(channels.type, "dm")));
  assert.ok(dmCount);
});

test("a system-provisioned PM keeps the setup gate open; the user's own first agent completes setup", async () => {
  const db = await openDb();
  const { owner, server } = await seedOwnerServer(db);
  const machine = await seedMachine(db, { serverId: server.id, userId: owner.id, runtimes: ["claude"] });

  const pmId = await maybeProvisionServerPm({ machineId: machine.id });
  assert.ok(pmId);

  // The preseeded PM is not a fact about the user having finished setup:
  // the gate stays open for the user's own onboarding.
  const [afterPm] = await db
    .select({ setupStatus: serverMembers.setupStatus })
    .from(serverMembers)
    .where(and(eq(serverMembers.serverId, server.id), eq(serverMembers.userId, owner.id)));
  assert.equal(afterPm.setupStatus, "not_started");

  // The user's own first agent completes setup, exactly as before.
  await createAgent(server.id, "Worker", { runtime: "claude", creatorType: "user", creatorId: owner.id });
  const [afterUserAgent] = await db
    .select({ setupStatus: serverMembers.setupStatus })
    .from(serverMembers)
    .where(and(eq(serverMembers.serverId, server.id), eq(serverMembers.userId, owner.id)));
  assert.equal(afterUserAgent.setupStatus, "complete");
});
