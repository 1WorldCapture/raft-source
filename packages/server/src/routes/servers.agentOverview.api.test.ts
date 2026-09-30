import { tokenForHuman } from "../test/integration/credentials.js";
import { createApiTest } from "../test/integration/apiTest.js";
import assert from "node:assert/strict";
import { eq } from "drizzle-orm";

import { seedPlaywrightScenario } from "../test/seedPlaywrightScenario.js";
import { createAgent } from "../services/agentService.js";
import { createServer } from "../services/serverService.js";
import { AgentOrchestrator } from "../services/agentOrchestrator.js";
import { getDb } from "../db/index.js";
import { agentActivityEvents, agents, machines, users } from "../db/schema.js";
import type { TrajectoryEntry } from "@botiverse/raft-shared";

const test = createApiTest({ humanActivityMuteFlagDefaultEnabled: true, onboardingOpenerFlagDefaultEnabled: false });

// The shared test harness swaps in a stub orchestrator whose getActivity is a
// constant. The overview contract IS the activity/presence projection, so
// these tests run against a real orchestrator (no Redis, no machine sockets —
// exactly the offline-derived + durable-recovery environment).
function useRealOrchestrator(app: { app: { set(key: string, value: unknown): void } }) {
  const orchestrator = new AgentOrchestrator();
  app.app.set("agentOrchestrator", orchestrator);
  return orchestrator;
}

// Pretend the seed machine is connected on this replica: the read model then
// reports it online and the activity read path takes the local/persisted
// branches instead of the offline-derived one.
function stubMachineConnected(orchestrator: AgentOrchestrator) {
  (orchestrator as unknown as { hasMachineLocally: (machineId: string) => boolean }).hasMachineLocally = () => true;
}

interface OverviewAgent {
  id: string;
  name: string;
  activity: string;
  activityDetail: string;
  activitySince: number | null;
  presence: string;
  presenceSince: number | null;
  lifecycleStatus: string;
  lifecycleStatusSince: number | null;
}
interface OverviewMachine {
  id: string;
  name: string;
  isComputer: boolean;
  status: string;
  statusSince: number | null;
  lastHeartbeat: string | null;
  agents: OverviewAgent[];
}
interface OverviewResponse {
  serverTime: number;
  unassignedAgents: number;
  machines: OverviewMachine[];
}

type StatusActivity = "online" | "thinking" | "working" | "error" | "offline";

function statusRow(agentId: string, activity: StatusActivity, detail: string, createdAt: Date) {
  const entries: TrajectoryEntry[] = [{ kind: "status", activity, activityKind: activity, detail, detailKind: "none" }];
  return {
    agentId,
    activity,
    detail,
    entries,
    createdAt,
  };
}

function statusEntry(activity: StatusActivity): TrajectoryEntry {
  return { kind: "status", activity, activityKind: activity, detail: "", detailKind: "none" };
}

async function getOverview(baseUrl: string, serverId: string, token: string) {
  return fetch(`${baseUrl}/api/servers/${serverId}/agent-overview`, {
    headers: { Authorization: `Bearer ${token}`, "X-Server-Id": serverId },
  });
}

test("agent-overview groups agents per machine and counts machineless agents separately", async ({ app }) => {
  useRealOrchestrator(app);
  const seed = await seedPlaywrightScenario();
  const token = await tokenForHuman(seed.user.email);
  // Agents are created inactive until a daemon starts them; make the seeded
  // one active so the offline projection below comes from the machine fact.
  await getDb().update(agents).set({ status: "active" }).where(eq(agents.id, seed.agent.id));
  // createAgent auto-assigns the first machine; detach it so the overview
  // really has a machineless agent.
  const created = await createAgent(seed.server.id, "unassigned-agent");
  await getDb().update(agents).set({ machineId: null }).where(eq(agents.id, created.id));

  const res = await getOverview(app.baseUrl, seed.server.id, token);
  assert.equal(res.status, 200);
  const body = await res.json() as OverviewResponse;

  assert.equal(typeof body.serverTime, "number");
  assert.ok(Number.isFinite(body.serverTime));
  assert.equal(body.unassignedAgents, 1);

  assert.equal(body.machines.length, 1);
  const machine = body.machines[0];
  assert.equal(machine.id, seed.machine.id);
  assert.equal(machine.name, seed.machine.name);
  assert.equal(machine.isComputer, false);
  // No live daemon connection in the test harness.
  assert.equal(machine.status, "offline");
  assert.equal(machine.lastHeartbeat, null);
  // A machine that never connected has been offline since it was created.
  const [machineRow] = await getDb().select({ createdAt: machines.createdAt }).from(machines).where(eq(machines.id, seed.machine.id));
  assert.equal(machine.statusSince, machineRow!.createdAt.getTime());

  assert.equal(machine.agents.length, 1);
  const agent = machine.agents[0];
  assert.equal(agent.id, seed.agent.id);
  assert.equal(agent.name, seed.agent.name);
  assert.equal(agent.lifecycleStatus, "active");
  assert.ok(typeof agent.lifecycleStatusSince === "number");
  // Unreachable machine → activity and presence both read offline.
  assert.equal(agent.activity, "offline");
  assert.equal(agent.presence, "offline");
});

test("agent-overview keeps machines without agents with an empty agents array", async ({ app }) => {
  useRealOrchestrator(app);
  const seed = await seedPlaywrightScenario();
  const token = await tokenForHuman(seed.user.email);
  // Move the seeded agent off its machine so the machine has no agents.
  await getDb().update(agents).set({ machineId: null }).where(eq(agents.id, seed.agent.id));

  const res = await getOverview(app.baseUrl, seed.server.id, token);
  assert.equal(res.status, 200);
  const body = await res.json() as OverviewResponse;
  assert.equal(body.unassignedAgents, 1);
  assert.deepEqual(body.machines[0].agents, []);
});

test("agent-overview fills lifecycleStatusSince and machine statusSince from the persisted since records", async ({ app }) => {
  const orchestrator = useRealOrchestrator(app);
  stubMachineConnected(orchestrator);
  const seed = await seedPlaywrightScenario();
  const token = await tokenForHuman(seed.user.email);

  const lifecycleAt = new Date(Date.now() - 60_000);
  const machineStatusAt = new Date(Date.now() - 120_000);
  await getDb().update(agents).set({ statusChangedAt: lifecycleAt }).where(eq(agents.id, seed.agent.id));
  await getDb().update(machines).set({ lastStatus: "online", statusChangedAt: machineStatusAt }).where(eq(machines.id, seed.machine.id));

  const res = await getOverview(app.baseUrl, seed.server.id, token);
  assert.equal(res.status, 200);
  const body = await res.json() as OverviewResponse;

  // The live read-model status (stubbed online) agrees with the persisted
  // last_status, so the stored transition instant is served as-is.
  const machine = body.machines[0];
  assert.equal(machine.status, "online");
  assert.equal(machine.statusSince, machineStatusAt.getTime());

  const agent = machine.agents[0];
  assert.equal(agent.lifecycleStatusSince, lifecycleAt.getTime());
});

test("agent-overview falls back honestly: never-connected machine reports createdAt, missing transition reports null", async ({ app }) => {
  useRealOrchestrator(app);
  const seed = await seedPlaywrightScenario();
  const token = await tokenForHuman(seed.user.email);

  // No persisted transition facts at all: the machine row keeps
  // lastStatus/statusChangedAt/lastHeartbeat null and the agent's lifecycle
  // transition time is explicitly erased.
  await getDb().update(agents).set({ statusChangedAt: null }).where(eq(agents.id, seed.agent.id));

  const res = await getOverview(app.baseUrl, seed.server.id, token);
  assert.equal(res.status, 200);
  const body = await res.json() as OverviewResponse;

  const machine = body.machines[0];
  // Live status is offline (no daemon in the harness) and the machine never
  // connected: the honest start is its creation.
  assert.equal(machine.status, "offline");
  const [machineRow] = await getDb().select({ createdAt: machines.createdAt }).from(machines).where(eq(machines.id, seed.machine.id));
  assert.equal(machine.statusSince, machineRow!.createdAt.getTime());

  const agent = machine.agents[0];
  assert.equal(agent.lifecycleStatusSince, null);
});

test("agent-overview recovers offline since stamps from the durable log after memory + Redis loss", async ({ app }) => {
  useRealOrchestrator(app);
  const seed = await seedPlaywrightScenario();
  const token = await tokenForHuman(seed.user.email);
  // Active lifecycle so the presence run boundary tracks the raw activity
  // values instead of the whole run collapsing to offline via the lifecycle.
  await getDb().update(agents).set({ status: "active" }).where(eq(agents.id, seed.agent.id));

  const t0 = Date.now() - 20_000;
  const t2 = Date.now() - 5_000;
  // The app orchestrator starts with empty memory and no Redis — exactly the
  // post-restart / post-TTL shape. The newest durable offline row is the
  // authority the recovery path rebuilds the stamps from.
  await getDb().insert(agentActivityEvents).values([
    statusRow(seed.agent.id, "offline", "Runtime interrupted", new Date(t2)),
    statusRow(seed.agent.id, "working", "", new Date(t0)),
  ]);

  const res = await getOverview(app.baseUrl, seed.server.id, token);
  assert.equal(res.status, 200);
  const body = await res.json() as OverviewResponse;
  const agent = body.machines[0].agents[0];
  assert.equal(agent.activity, "offline");
  assert.equal(agent.presence, "offline");
  // Recovered from the durable rows — real transition instants, not the
  // request time, and not a fabricated fallback.
  assert.equal(agent.activitySince, t2);
  // Offline presence starts at the earliest known cause that holds now: the
  // activity went offline at t2, and the never-connected machine has been
  // offline since its row was created.
  const machine = body.machines[0];
  assert.equal(machine.status, "offline");
  assert.equal(agent.presenceSince, Math.min(t2, machine.statusSince!));
});

test("agent-overview offline presence takes the earliest known cause when no activity row exists", async ({ app }) => {
  useRealOrchestrator(app);
  const seed = await seedPlaywrightScenario();
  const token = await tokenForHuman(seed.user.email);

  const res = await getOverview(app.baseUrl, seed.server.id, token);
  assert.equal(res.status, 200);
  const body = await res.json() as OverviewResponse;
  const agent = body.machines[0].agents[0];
  assert.equal(agent.activity, "offline");
  assert.equal(agent.activitySince, null, "no durable activity row: activity since stays unknown");
  // Offline presence still has known causes: the inactive lifecycle and the
  // never-connected machine. It takes the earliest of their starts.
  assert.notEqual(agent.lifecycleStatus, "active");
  assert.equal(
    agent.presenceSince,
    Math.min(agent.lifecycleStatusSince!, body.machines[0].statusSince!),
  );
});

test("agent-overview since keeps heartbeats, resets on real changes, and survives a restart-shaped orchestrator swap", async ({ app }) => {
  const orchestrator = useRealOrchestrator(app);
  stubMachineConnected(orchestrator);
  const seed = await seedPlaywrightScenario();
  const token = await tokenForHuman(seed.user.email);
  // Agents are created inactive until a daemon starts them; the projection
  // under test needs an active agent on a connected machine.
  await getDb().update(agents).set({ status: "active" }).where(eq(agents.id, seed.agent.id));
  const agentId = seed.agent.id;
  const broadcast = orchestrator as unknown as {
    broadcastActivity: (
      agentId: string,
      activity: StatusActivity,
      detail: string,
      detailKind: string,
      entries: TrajectoryEntry[] | undefined,
      nowOverride?: number,
      options?: { isHeartbeat?: boolean },
    ) => unknown;
  };

  const t0 = Date.now() - 9_000;
  const t1 = Date.now() - 7_000;
  const t2 = Date.now() - 5_000;
  const t3 = Date.now() - 3_000;

  // t0: first observation — a real value change that lands a durable row.
  broadcast.broadcastActivity(agentId, "working", "kickoff", "other", [statusEntry("working")], t0);
  // t1: heartbeat-style refresh reasserting the same value — must persist
  // nothing and leave the stamps alone.
  broadcast.broadcastActivity(agentId, "working", "kickoff", "other", undefined, t1, { isHeartbeat: true });
  // t2: an entries-bearing same-value frame persists a row but still must not
  // move the since stamps.
  broadcast.broadcastActivity(agentId, "working", "kickoff", "other", [statusEntry("working")], t2);

  const workingRows = await getDb()
    .select({ createdAt: agentActivityEvents.createdAt })
    .from(agentActivityEvents)
    .where(eq(agentActivityEvents.agentId, agentId));
  // The heartbeat at t1 persisted nothing; t0 and t2 are the only working rows.
  assert.deepEqual(
    workingRows.map((row) => row.createdAt.getTime()).sort((a, b) => a - b),
    [t0, t2],
  );

  const first = await getOverview(app.baseUrl, seed.server.id, token);
  assert.equal(first.status, 200);
  const firstBody = await first.json() as OverviewResponse;
  const firstAgent = firstBody.machines[0].agents[0];
  assert.equal(firstAgent.activity, "working");
  assert.equal(firstAgent.presence, "working");
  // The heartbeat instants never became the since stamps.
  assert.equal(firstAgent.activitySince, t0);
  assert.equal(firstAgent.presenceSince, t0);

  // t3: real activity change (working→thinking). The activity stamp resets,
  // the presence run continues.
  broadcast.broadcastActivity(agentId, "thinking", "", "other", [statusEntry("thinking")], t3);

  const second = await getOverview(app.baseUrl, seed.server.id, token);
  const secondAgent = (await second.json() as OverviewResponse).machines[0].agents[0];
  assert.equal(secondAgent.activity, "thinking");
  assert.equal(secondAgent.activitySince, t3);
  assert.equal(secondAgent.presence, "working");
  assert.equal(secondAgent.presenceSince, t0);

  // Restart shape: a fresh orchestrator has empty memory and no Redis — the
  // stamps must come back from the durable activity log, unchanged.
  const restarted = useRealOrchestrator(app);
  stubMachineConnected(restarted);
  const afterRestart = await getOverview(app.baseUrl, seed.server.id, token);
  const restartAgent = (await afterRestart.json() as OverviewResponse).machines[0].agents[0];
  assert.equal(restartAgent.activity, "thinking");
  assert.equal(restartAgent.activitySince, t3);
  assert.equal(restartAgent.presence, "working");
  assert.equal(restartAgent.presenceSince, t0);
});

test("agent-overview idle-entry since survives hours of silence, Redis TTL expiry, and a restart", async ({ app }) => {
  const orchestrator = useRealOrchestrator(app);
  stubMachineConnected(orchestrator);
  const seed = await seedPlaywrightScenario();
  const token = await tokenForHuman(seed.user.email);
  await getDb().update(agents).set({ status: "active" }).where(eq(agents.id, seed.agent.id));
  const agentId = seed.agent.id;
  const broadcast = orchestrator as unknown as {
    broadcastActivity: (
      agentId: string,
      activity: StatusActivity,
      detail: string,
      detailKind: string,
      entries: TrajectoryEntry[] | undefined,
      nowOverride?: number,
    ) => unknown;
  };

  const workingStart = Date.now() - 3 * 60 * 60 * 1_000;
  const idleStart = workingStart + 60_000;

  // The working stretch opens with an entries-bearing frame (tool work), then
  // ends the way a real daemon reports it: the idle frame carries its own
  // status entry (packages/daemon agentProcessManager broadcastActivity always
  // attaches one), so it persists as a durable row on arrival.
  broadcast.broadcastActivity(agentId, "working", "Running tool", "running_command", [statusEntry("working")], workingStart);
  broadcast.broadcastActivity(
    agentId,
    "online",
    "Process idle",
    "idle",
    [{ kind: "status", activity: "online", activityKind: "online", detail: "Process idle", detailKind: "idle" }],
    idleStart,
  );

  const rows = await getDb()
    .select({ activity: agentActivityEvents.activity, createdAt: agentActivityEvents.createdAt })
    .from(agentActivityEvents)
    .where(eq(agentActivityEvents.agentId, agentId));
  assert.deepEqual(
    rows.map((row) => [row.activity, row.createdAt.getTime()]).sort((a, b) => (a[1] as number) - (b[1] as number)),
    [["working", workingStart], ["online", idleStart]],
  );

  // Hours of silence follow: nothing writes the agent again. The fresh
  // orchestrator is the post-restart shape (empty memory, no Redis = the
  // expired 600s hash), and the idle row is far beyond the 90s freshness
  // window, so both stamps can only come from the durable-log recovery scan.
  const restarted = useRealOrchestrator(app);
  stubMachineConnected(restarted);
  const res = await getOverview(app.baseUrl, seed.server.id, token);
  assert.equal(res.status, 200);
  const body = await res.json() as OverviewResponse;
  const agent = body.machines[0].agents[0];
  assert.equal(agent.activity, "online");
  assert.equal(agent.presence, "idle");
  // The idle transition instant itself — not the request time, not the older
  // working row, and not a fabricated fallback.
  assert.equal(agent.activitySince, idleStart);
  assert.equal(agent.presenceSince, idleStart);
});

test("agent-overview is isolated per server: other servers' agents never leak", async ({ app }) => {
  useRealOrchestrator(app);
  const seed = await seedPlaywrightScenario();
  const token = await tokenForHuman(seed.user.email);
  const [owner] = await getDb().select({ id: users.id }).from(users).where(eq(users.email, seed.user.email)).limit(1);
  const otherServer = await createServer("Other server", `other-${seed.server.slug}`, owner!.id);
  await createAgent(otherServer.id, "other-server-agent");

  const res = await getOverview(app.baseUrl, seed.server.id, token);
  assert.equal(res.status, 200);
  const body = await res.json() as OverviewResponse;
  const agentIds = body.machines.flatMap((machine) => machine.agents.map((agent) => agent.id));
  assert.ok(agentIds.includes(seed.agent.id));
  // The other server's agent is neither grouped nor counted here.
  assert.equal(agentIds.length, 1);
  assert.equal(body.unassignedAgents, 0);
});

test("agent-overview rejects non-members and admits regular members", async ({ app }) => {
  const seed = await seedPlaywrightScenario();
  const name = `outsider-${Math.random().toString(36).slice(2, 8)}`;
  const [outsiderUser] = await getDb().insert(users).values({
    name,
    email: `${name}@test.invalid`,
    displayName: name,
    passwordHash: "hash",
    emailVerified: true,
  }).returning();
  const outsiderToken = await tokenForHuman(outsiderUser!.email);

  const rejected = await getOverview(app.baseUrl, seed.server.id, outsiderToken);
  // The router-level requireServerMatchesParam middleware rejects non-members
  // with 403 before the handler's own membership 404 can run.
  assert.equal(rejected.status, 403);

  // Regular members may read the overview (status facts only).
  const memberToken = await tokenForHuman(seed.extraHuman.email);
  const admitted = await getOverview(app.baseUrl, seed.server.id, memberToken);
  assert.equal(admitted.status, 200);
  const body = await admitted.json() as OverviewResponse;
  assert.equal(body.machines.length, 1);
});
