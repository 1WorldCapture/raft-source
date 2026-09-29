import assert from "node:assert/strict";
import { dbTest as test } from "../test/integration/dbTest.js";
import { eq } from "drizzle-orm";
import { machines, servers, users } from "../db/schema.js";
import { MACHINE_ONLINE_CONTINUITY_MS, recordMachineStatusTransition } from "./machineService.js";

async function seedMachine(db: any, name: string, lastHeartbeat: Date | null = null) {
  const [user] = await db.insert(users).values({
    email: `${name}@example.com`,
    name,
    passwordHash: "test",
  }).returning();
  const [server] = await db.insert(servers).values({ name, slug: name, ownerId: user!.id }).returning();
  const [machine] = await db.insert(machines).values({
    serverId: server!.id,
    userId: user!.id,
    name,
    apiKeyHash: "test",
    lastHeartbeat,
  }).returning();
  return machine!;
}

const t0 = new Date("2026-09-29T10:00:00.000Z");
const at = (ms: number) => new Date(t0.getTime() + ms);

test("machine status since only moves on real transitions", async ({ db }) => {
  const machine = await seedMachine(db, "machine-since-transitions");
  const read = async () => {
    const [row] = await db.select({ lastStatus: machines.lastStatus, statusChangedAt: machines.statusChangedAt })
      .from(machines).where(eq(machines.id, machine.id));
    return row!;
  };

  assert.deepEqual(await recordMachineStatusTransition(machine.id, "online", t0), t0);
  assert.deepEqual(await read(), { lastStatus: "online", statusChangedAt: t0 });

  // Server restart / grace reconnect with a fresh heartbeat keeps the since.
  await db.update(machines).set({ lastHeartbeat: at(60_000) }).where(eq(machines.id, machine.id));
  assert.deepEqual(await recordMachineStatusTransition(machine.id, "online", at(90_000)), t0);

  assert.deepEqual(await recordMachineStatusTransition(machine.id, "offline", at(120_000)), at(120_000));
  // A duplicate offline projection keeps the first offline time.
  assert.deepEqual(await recordMachineStatusTransition(machine.id, "offline", at(180_000)), at(120_000));
  assert.deepEqual(await read(), { lastStatus: "offline", statusChangedAt: at(120_000) });

  assert.deepEqual(await recordMachineStatusTransition(machine.id, "online", at(300_000)), at(300_000));
});

test("an online commit after a stale heartbeat starts a new online stretch", async ({ db }) => {
  // Persisted online but the machine vanished while the server was down: no
  // offline projection ran, so the stale heartbeat is the only evidence.
  const machine = await seedMachine(db, "machine-since-stale", t0);
  await db.update(machines).set({ lastStatus: "online", statusChangedAt: at(-3_600_000) })
    .where(eq(machines.id, machine.id));

  const reconnectAt = at(MACHINE_ONLINE_CONTINUITY_MS + 1_000);
  assert.deepEqual(await recordMachineStatusTransition(machine.id, "online", reconnectAt), reconnectAt);
});

test("unknown machines record nothing", async ({ db: _db }) => {
  assert.equal(await recordMachineStatusTransition("00000000-0000-4000-8000-000000000000", "online", t0), null);
});
