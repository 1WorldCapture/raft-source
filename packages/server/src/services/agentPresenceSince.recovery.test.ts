import { dbTest as test } from "../test/integration/dbTest.js";
import { closeTestDatabase } from "../test/integration/database.js";
import assert from "node:assert/strict";
import { afterEach } from "vitest";
import type { TrajectoryEntry } from "@botiverse/raft-shared";
import { getDb } from "../db/index.js";
import { agentActivityEvents, agents, machines, servers, users } from "../db/schema.js";
import { AgentOrchestrator } from "./agentOrchestrator.js";
import { appendAgentActivityEvent } from "./agentActivityLogService.js";

afterEach(async () => {
  await closeTestDatabase();
});

const OWNER_ID = "40000000-0000-4000-8000-000000000001";
const SERVER_ID = "40000000-0000-4000-8000-000000000002";
const MACHINE_ID = "40000000-0000-4000-8000-000000000003";

async function seedAgentRow(agentId: string, suffix: string) {
  const db = getDb();
  await db.insert(users).values({
    id: OWNER_ID,
    email: `owner-${suffix}@example.com`,
    name: `owner-${suffix}`,
    displayName: `owner-${suffix}`,
    passwordHash: "hash",
    emailVerified: true,
  }).onConflictDoNothing();
  await db.insert(servers).values({
    id: SERVER_ID,
    name: `Server ${suffix}`,
    slug: `server-${suffix}`,
    ownerId: OWNER_ID,
  }).onConflictDoNothing();
  await db.insert(machines).values({
    id: MACHINE_ID,
    serverId: SERVER_ID,
    userId: OWNER_ID,
    name: `machine-${suffix}`,
    apiKeyHash: "hash",
  }).onConflictDoNothing();
  await db.insert(agents).values({
    id: agentId,
    serverId: SERVER_ID,
    name: `agent-${suffix}`,
    status: "active",
    machineId: MACHINE_ID,
    model: "gpt-5",
    runtime: "codex",
  });
}

function statusEntry(activity: "online" | "thinking" | "working" | "error" | "offline", detail = ""): TrajectoryEntry {
  return { kind: "status", activity, activityKind: activity, detail, detailKind: "none" };
}

/**
 * Bare orchestrator with no in-memory activity state and no Redis — the exact
 * post-restart / post-TTL shape. `hasMachineLocally` is stubbed so the durable
 * log branch (not the offline derived branch) serves the activity, matching a
 * machine that is in fact connected.
 */
function makeRecoveryOrchestrator() {
  const orch = new AgentOrchestrator() as any;
  orch.hasMachineLocally = () => true;
  return orch;
}

test("recovers activitySince/presenceSince from the durable log after memory + Redis loss", async ({ db }) => {
  void db;
  const agentId = "40000000-0000-4000-8000-000000000011";
  await seedAgentRow(agentId, "11");

  const t0 = Date.now() - 30_000;
  const t1 = t0 + 10_000;
  const t2 = t0 + 20_000;
  // Newest-first reconstruction target: working@t2 on top of a thinking/working
  // run — the activity changed at t2, presence has been working since t0.
  await appendAgentActivityEvent(agentId, "working", "tool", [statusEntry("working", "tool")], new Date(t2));
  await appendAgentActivityEvent(agentId, "thinking", "", [statusEntry("thinking")], new Date(t1));
  await appendAgentActivityEvent(agentId, "working", "kickoff", [statusEntry("working", "kickoff")], new Date(t0));

  const orch = makeRecoveryOrchestrator();
  const activity = await orch.getActivity(agentId);
  assert.equal(activity.activity, "working");
  assert.equal(activity.activitySinceMs, t2);
  // thinking→working never resets presenceSince: the run started at t0.
  assert.equal(activity.presence, "working");
  assert.equal(activity.presenceSinceMs, t0);
});

test("a Redis mirror hit serves the stamps without scanning the durable log", async ({ db }) => {
  void db;
  const agentId = "40000000-0000-4000-8000-000000000021";
  await seedAgentRow(agentId, "21");

  // Durable rows exist — a scan WOULD find them if one ran.
  await appendAgentActivityEvent(agentId, "working", "", [statusEntry("working")], new Date(Date.now() - 10_000));

  const scanCalls: string[] = [];
  const orch = makeRecoveryOrchestrator();
  (orch as unknown as Record<string, unknown>).resolveRecentPersistedActivity = async () => {
    scanCalls.push("scan");
    return null;
  };
  orch.replicaStateStore = {
    ...orch.replicaStateStore,
    isAvailable: () => true,
    getAgentActivity: async () => ({
      activity: "working" as const,
      detail: "",
      detailKind: "none" as const,
      updatedAt: Date.now(),
      activitySinceMs: 4242,
      presence: "working" as const,
      presenceSinceMs: 4242,
    }),
  };

  const activity = await orch.getActivity(agentId);
  assert.equal(activity.activity, "working");
  // The mirror is the authority — the durable log stays untouched.
  assert.deepEqual(scanCalls, []);
  assert.equal(activity.activitySinceMs, 4242);
  assert.equal(activity.presence, "working");
  assert.equal(activity.presenceSinceMs, 4242);
});

test("a Redis miss falls through to exactly one durable-log recovery", async ({ db }) => {
  void db;
  const agentId = "40000000-0000-4000-8000-000000000022";
  await seedAgentRow(agentId, "22");

  const t0 = Date.now() - 10_000;
  await appendAgentActivityEvent(agentId, "thinking", "", [statusEntry("thinking")], new Date(t0));

  const scanCalls: string[] = [];
  const orch = makeRecoveryOrchestrator();
  (orch as unknown as Record<string, unknown>).resolveRecentPersistedActivity = async () => {
    scanCalls.push("scan");
    return null;
  };
  orch.replicaStateStore = {
    ...orch.replicaStateStore,
    isAvailable: () => true,
    getAgentActivity: async () => null, // expired / absent hash
    setAgentActivity: async () => {},
  };

  const activity = await orch.getActivity(agentId);
  // The mirror missed, so the derived value (online, machine stubbed local)
  // is served with anchors rebuilt from the durable log — scanned once.
  assert.deepEqual(scanCalls, ["scan"]);
  assert.equal(activity.activity, "online");
  assert.equal(activity.presence, "idle");
  assert.equal(activity.activitySinceMs, null);
  assert.equal(activity.presenceSinceMs, null);
});

test("writes the recovered anchor back so later reads skip the rescan", async ({ db }) => {
  void db;
  const agentId = "40000000-0000-4000-8000-000000000012";
  await seedAgentRow(agentId, "12");

  const t0 = Date.now() - 10_000;
  await appendAgentActivityEvent(agentId, "working", "", [statusEntry("working")], new Date(t0));

  const writes: Array<{ since: unknown }> = [];
  const orch = makeRecoveryOrchestrator();
  orch.replicaStateStore = {
    ...orch.replicaStateStore,
    isAvailable: () => true,
    getAgentActivity: async () => null, // simulates the expired 600s hash
    setAgentActivity: async (_agentId: string, _a: string, _d: string, _k: string, _o: number | undefined, since: unknown) => {
      writes.push({ since });
    },
  };

  const activity = await orch.getActivity(agentId);
  assert.equal(activity.activity, "working");
  assert.equal(activity.activitySinceMs, t0);
  // First read rescans the durable log, then mirrors the anchor into Redis.
  assert.equal(writes.length, 1);
  assert.deepEqual(writes[0].since, { activitySinceMs: t0, presence: "working", presenceSinceMs: t0 });
});

test("returns null since when nothing durable exists — never the read time", async ({ db }) => {
  void db;
  const agentId = "40000000-0000-4000-8000-000000000013";
  await seedAgentRow(agentId, "13");

  const before = Date.now();
  const orch = makeRecoveryOrchestrator();
  const activity = await orch.getActivity(agentId);
  // Machine stubbed local so the derived value is online, but there is no
  // durable row at all: both stamps must stay null, not fall back to "now".
  assert.equal(activity.activity, "online");
  assert.equal(activity.activitySinceMs, null);
  assert.equal(activity.presenceSinceMs, null);
  assert.ok(Date.now() >= before);
});

test("scan cap: a run longer than the scan limit yields null, not the oldest scanned row", async ({ db }) => {
  const dbh = getDb();
  const agentId = "40000000-0000-4000-8000-000000000014";
  await seedAgentRow(agentId, "14");

  // 501 identical working rows — more than the default 500-row scan budget.
  // Newest row lands inside the 90s freshness window so the durable log
  // branch serves the value and the recovery scan runs.
  const base = Date.now() - 580_000;
  const values = Array.from({ length: 501 }, (_, i) => ({
    agentId,
    activity: "working" as const,
    detail: `row-${i}`,
    entries: [statusEntry("working")],
    createdAt: new Date(base + i * 1000),
  }));
  await dbh.insert(agentActivityEvents).values(values);

  const orch = makeRecoveryOrchestrator();
  const activity = await orch.getActivity(agentId);
  assert.equal(activity.activity, "working");
  // The true run start is beyond the cap — unknown, explicitly null. Serving
  // values[0].createdAt here would fabricate a shorter idle/working span.
  assert.equal(activity.activitySinceMs, null);
  assert.equal(activity.presenceSinceMs, null);
});

test("scan cap boundary: a run that ends inside the window still recovers", async ({ db }) => {
  const dbh = getDb();
  const agentId = "40000000-0000-4000-8000-000000000015";
  await seedAgentRow(agentId, "15");

  const base = Date.now() - 600_000;
  const values = [
    ...Array.from({ length: 6 }, (_, i) => ({
      agentId,
      activity: "working" as const,
      detail: "",
      entries: [statusEntry("working")],
      createdAt: new Date(base + i * 1000),
    })),
    {
      agentId,
      activity: "online" as const,
      detail: "",
      entries: [statusEntry("online")],
      createdAt: new Date(base + 100_000),
    },
  ];
  await dbh.insert(agentActivityEvents).values(values);

  const orch = makeRecoveryOrchestrator();
  const activity = await orch.getActivity(agentId);
  // Newest row is online (idle presence); the older working run is fully
  // inside the window, so its boundary is conclusive.
  assert.equal(activity.activity, "online");
  assert.equal(activity.activitySinceMs, base + 100_000);
  assert.equal(activity.presence, "idle");
  assert.equal(activity.presenceSinceMs, base + 100_000);
});

test("presence run boundary differs from activity run boundary across an idle gap", async ({ db }) => {
  const dbh = getDb();
  const agentId = "40000000-0000-4000-8000-000000000016";
  await seedAgentRow(agentId, "16");

  const t0 = Date.now() - 40_000;
  const t1 = t0 + 10_000;
  const t2 = t0 + 20_000;
  const t3 = t0 + 30_000;
  // Newest-first: thinking(t3), working(t2), thinking(t1), working(t0). The
  // activity run (thinking) is just the newest row and starts at t3, while
  // every row projects working presence — the presence run spans all four
  // rows back to t0. The two boundaries must diverge.
  await dbh.insert(agentActivityEvents).values([
    { agentId, activity: "thinking", detail: "", entries: [statusEntry("thinking")], createdAt: new Date(t3) },
    { agentId, activity: "working", detail: "", entries: [statusEntry("working")], createdAt: new Date(t2) },
    { agentId, activity: "thinking", detail: "", entries: [statusEntry("thinking")], createdAt: new Date(t1) },
    { agentId, activity: "working", detail: "", entries: [statusEntry("working")], createdAt: new Date(t0) },
  ]);

  const orch = makeRecoveryOrchestrator();
  const activity = await orch.getActivity(agentId);
  assert.equal(activity.activity, "thinking");
  assert.equal(activity.activitySinceMs, t3);
  assert.equal(activity.presence, "working");
  assert.equal(activity.presenceSinceMs, t0);
});

/** Redis-shaped mirror double that honours preserveMatching like the Lua script. */
function makeMirrorStore(initial?: Record<string, unknown>) {
  let hash: Record<string, any> | null = initial ? { ...initial } : null;
  const writes: Array<Record<string, unknown>> = [];
  return {
    writes,
    isAvailable: () => true,
    getAgentActivity: async () => (hash ? { ...hash } : null),
    setAgentActivity: async (_id: string, activity: string, detail: string, detailKind: string, observedAtMs: number | undefined, since: any) => {
      writes.push({ activity, observedAtMs, since });
      const prev = hash ?? {};
      const next: Record<string, any> = { activity, detail, detailKind, updatedAt: Date.now() };
      if (observedAtMs !== undefined) next.observedAtMs = observedAtMs;
      if (since?.preserveMatching) {
        if (prev.activity === activity && prev.activitySinceMs !== undefined) next.activitySinceMs = prev.activitySinceMs;
        if (since.presence) {
          next.presence = since.presence;
          if (prev.presence === since.presence && prev.presenceSinceMs !== undefined) next.presenceSinceMs = prev.presenceSinceMs;
        }
      } else {
        if (since?.activitySinceMs != null) next.activitySinceMs = since.activitySinceMs;
        if (since?.presence != null) next.presence = since.presence;
        if (since?.presenceSinceMs != null) next.presenceSinceMs = since.presenceSinceMs;
      }
      hash = next;
    },
  };
}

async function settle() {
  for (let i = 0; i < 10; i += 1) await new Promise((resolve) => setTimeout(resolve, 5));
}

test("restart: the first frame keeps the mirror's since instead of fabricating a new start", async ({ db }) => {
  void db;
  const agentId = "40000000-0000-4000-8000-000000000031";
  await seedAgentRow(agentId, "31");
  const startedAt = Date.now() - 20 * 60_000;
  const store = makeMirrorStore({
    activity: "working", detail: "tool", detailKind: "none", updatedAt: Date.now(),
    observedAtMs: Date.now() - 5_000, activitySinceMs: startedAt, presence: "working", presenceSinceMs: startedAt,
  });
  const orch = makeRecoveryOrchestrator();
  orch.replicaStateStore = { ...orch.replicaStateStore, ...store };
  const anchors: string[] = [];
  const persist = orch.persistActivityEvent.bind(orch);
  orch.persistActivityEvent = (...args: unknown[]) => {
    anchors.push(String(args[5] ?? ""));
    return persist(...args);
  };

  // Restarted process: memory is empty; a heartbeat reasserts "working".
  orch.broadcastActivity(agentId, "working", "tool", "none", undefined, undefined, { isHeartbeat: true });
  await settle();

  const read = await orch.getActivity(agentId);
  assert.equal(read.activity, "working");
  assert.equal(read.activitySinceMs, startedAt, "the 20-minute run survives the restart");
  assert.equal(read.presenceSinceMs, startedAt);
  assert.deepEqual(anchors.filter((key) => key.startsWith("presence-anchor:")), [], "no fabricated anchor row");
});

test("restart without Redis: the first frame's since is rebuilt from the durable log", async ({ db }) => {
  void db;
  const agentId = "40000000-0000-4000-8000-000000000032";
  await seedAgentRow(agentId, "32");
  const startedAt = Date.now() - 20 * 60_000;
  await appendAgentActivityEvent(agentId, "working", "", [statusEntry("working")], new Date(startedAt));
  const orch = makeRecoveryOrchestrator();

  orch.broadcastActivity(agentId, "working", "", "none", undefined, undefined, { isHeartbeat: true });
  await settle();

  const read = await orch.getActivity(agentId);
  assert.equal(read.activitySinceMs, startedAt);
  assert.equal(read.presenceSinceMs, startedAt);
});

test("two reads across the recovery write-back both serve the live working run", async ({ db }) => {
  void db;
  const agentId = "40000000-0000-4000-8000-000000000033";
  await seedAgentRow(agentId, "33");
  const startedAt = Date.now() - 5 * 60_000;
  const latest = Date.now() - 10_000;
  await appendAgentActivityEvent(agentId, "working", "", [statusEntry("working")], new Date(startedAt));
  await appendAgentActivityEvent(agentId, "working", "tool", [statusEntry("working", "tool")], new Date(latest));
  const store = makeMirrorStore();
  const orch = makeRecoveryOrchestrator();
  orch.hasMachineLocally = () => false; // read through the mirror like a non-owner replica
  orch.replicaStateStore = { ...orch.replicaStateStore, ...store };

  const first = await orch.getActivity(agentId);
  assert.equal(first.activity, "working");
  assert.equal(first.activitySinceMs, startedAt);
  assert.equal(store.writes.at(-1)?.observedAtMs, latest, "write-back carries the newest row time, not the run start");

  const second = await orch.getActivity(agentId);
  assert.equal(second.activity, "working", "the written-back mirror is not judged stale");
  assert.equal(second.activitySinceMs, startedAt);
  assert.equal(second.presenceSinceMs, startedAt);
});

test("without Redis the durable-log recovery is cached, not rescanned per read", async ({ db }) => {
  void db;
  const agentId = "40000000-0000-4000-8000-000000000034";
  await seedAgentRow(agentId, "34");
  await appendAgentActivityEvent(agentId, "working", "", [statusEntry("working")], new Date(Date.now() - 10_000));
  const orch = makeRecoveryOrchestrator();
  let scans = 0;
  const recover = orch.recoverPresenceAnchor.bind(orch);
  orch.recoverPresenceAnchor = (...args: unknown[]) => {
    scans += 1;
    return recover(...args);
  };
  await orch.getActivity(agentId);
  await orch.getActivity(agentId);
  await orch.getActivity(agentId);
  assert.equal(scans, 1);
});
