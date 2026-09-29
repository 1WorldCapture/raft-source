import assert from "node:assert/strict";
import { test as unitTest } from "vitest";
import { dbTest as test } from "../test/integration/dbTest.js";
import { computerOutageOccurrences, computers, machines, servers, users, agents } from "../db/schema.js";
import {
  deriveMachineStatusSince,
  getAgentLifecycleSince,
  getMachineStatusSince,
  type MachineStatusSinceFacts,
} from "./lifecycleSinceService.js";

const d = (iso: string) => new Date(iso);
const facts = (overrides: Partial<MachineStatusSinceFacts> = {}): MachineStatusSinceFacts => ({
  lastStatus: null,
  statusChangedAt: null,
  lastHeartbeat: null,
  createdAt: d("2026-09-01T00:00:00.000Z"),
  openOutageStartedAt: null,
  ...overrides,
});

unitTest("persisted since wins when it agrees with the live status", () => {
  const changed = d("2026-09-29T10:00:00.000Z");
  assert.equal(deriveMachineStatusSince("online", facts({ lastStatus: "online", statusChangedAt: changed })), changed.getTime());
  assert.equal(deriveMachineStatusSince("offline", facts({
    lastStatus: "offline",
    statusChangedAt: changed,
    openOutageStartedAt: d("2026-09-29T09:00:00.000Z"),
  })), changed.getTime());
});

unitTest("offline without an agreeing record falls back outage -> heartbeat -> created", () => {
  const outage = d("2026-09-29T09:00:00.000Z");
  const heartbeat = d("2026-09-29T08:00:00.000Z");
  // Persisted online, machine vanished during a server restart.
  assert.equal(deriveMachineStatusSince("offline", facts({
    lastStatus: "online",
    statusChangedAt: d("2026-09-20T00:00:00.000Z"),
    lastHeartbeat: heartbeat,
    openOutageStartedAt: outage,
  })), outage.getTime());
  // Raw daemon: no outage rows exist.
  assert.equal(deriveMachineStatusSince("offline", facts({ lastStatus: "online", lastHeartbeat: heartbeat })), heartbeat.getTime());
  // Never connected.
  assert.equal(deriveMachineStatusSince("offline", facts()), d("2026-09-01T00:00:00.000Z").getTime());
  // Connected once (per last_status) but no heartbeat or outage: unknown.
  assert.equal(deriveMachineStatusSince("offline", facts({ lastStatus: "online" })), null);
});

unitTest("online without an agreeing record is unknown", () => {
  assert.equal(deriveMachineStatusSince("online", facts({
    lastStatus: "offline",
    statusChangedAt: d("2026-09-29T10:00:00.000Z"),
    lastHeartbeat: d("2026-09-29T10:05:00.000Z"),
  })), null);
  assert.equal(deriveMachineStatusSince("online", facts()), null);
});

test("getMachineStatusSince reads persisted facts and open managed-Computer outages per server", async ({ db }) => {
  const [user] = await db.insert(users).values({ email: "since-read@example.com", name: "since-read", passwordHash: "x" }).returning();
  const [server] = await db.insert(servers).values({ name: "since-read", slug: "since-read", ownerId: user!.id }).returning();
  const [other] = await db.insert(servers).values({ name: "since-other", slug: "since-other", ownerId: user!.id }).returning();
  const online = d("2026-09-29T10:00:00.000Z");
  const outageAt = d("2026-09-29T11:00:00.000Z");
  const heartbeat = d("2026-09-29T11:30:00.000Z");
  const [managed, raw, foreign] = await db.insert(machines).values([
    { serverId: server!.id, userId: user!.id, name: "managed", apiKeyHash: "x", lastStatus: "online", statusChangedAt: online, lastHeartbeat: heartbeat },
    { serverId: server!.id, userId: user!.id, name: "raw", apiKeyHash: "x", lastStatus: "online", statusChangedAt: online, lastHeartbeat: heartbeat },
    { serverId: other!.id, userId: user!.id, name: "foreign", apiKeyHash: "x", lastStatus: "online", statusChangedAt: online },
  ]).returning();
  const [computer] = await db.insert(computers).values({
    serverId: server!.id, name: "managed", apiKeyHash: "x", apiKeyPrefix: "sk_computer_x", machineId: managed!.id,
  }).returning();
  await db.insert(computerOutageOccurrences).values({
    serverId: server!.id,
    computerId: computer!.id,
    machineId: managed!.id,
    connectionEpochId: "epoch-1",
    state: "pending",
    firstOfflineAt: outageAt,
    notifyAfter: outageAt,
  });

  const result = await getMachineStatusSince(server!.id, [
    { id: managed!.id, status: "offline" },
    { id: raw!.id, status: "offline" },
    { id: foreign!.id, status: "online" },
  ]);
  assert.equal(result.get(managed!.id), outageAt.getTime());
  assert.equal(result.get(raw!.id), heartbeat.getTime());
  assert.equal(result.has(foreign!.id), false, "machines of another server are never read");
  assert.equal((await getMachineStatusSince(server!.id, [{ id: raw!.id, status: "online" }])).get(raw!.id), online.getTime());
});

test("getAgentLifecycleSince returns status_changed_at as ms epoch", async ({ db }) => {
  const [user] = await db.insert(users).values({ email: "agent-since@example.com", name: "agent-since", passwordHash: "x" }).returning();
  const [server] = await db.insert(servers).values({ name: "agent-since", slug: "agent-since", ownerId: user!.id }).returning();
  const changed = d("2026-09-29T12:00:00.000Z");
  const [agent] = await db.insert(agents).values({ serverId: server!.id, name: "a1", statusChangedAt: changed }).returning();
  const result = await getAgentLifecycleSince(server!.id, [agent!.id, "00000000-0000-4000-8000-000000000000"]);
  assert.deepEqual([...result.entries()], [[agent!.id, changed.getTime()]]);
  assert.equal((await getAgentLifecycleSince(server!.id, [])).size, 0);
  const [other] = await db.insert(servers).values({ name: "agent-since-other", slug: "agent-since-other", ownerId: user!.id }).returning();
  assert.equal((await getAgentLifecycleSince(other!.id, [agent!.id])).size, 0, "agents of another server are never read");
});

test("getAgentLifecycleSince skips deleted agents", async ({ db }) => {
  const [user] = await db.insert(users).values({ email: "agent-since-del@example.com", name: "agent-since-del", passwordHash: "x" }).returning();
  const [server] = await db.insert(servers).values({ name: "agent-since-del", slug: "agent-since-del", ownerId: user!.id }).returning();
  const [agent] = await db.insert(agents).values({ serverId: server!.id, name: "gone", deletedAt: d("2026-09-29T12:00:00.000Z") }).returning();
  assert.equal((await getAgentLifecycleSince(server!.id, [agent!.id])).size, 0);
});
