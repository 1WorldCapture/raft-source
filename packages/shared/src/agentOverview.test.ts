import assert from "node:assert/strict";
import test from "node:test";
import { buildAgentOverviewResponse, type AgentOverviewAgentFact } from "./agentOverview.js";

function agentFact(overrides: Partial<AgentOverviewAgentFact> & { id: string }): AgentOverviewAgentFact {
  return {
    name: `agent-${overrides.id}`,
    machineId: null,
    lifecycleStatus: "active",
    activity: "online",
    activityDetail: "",
    activitySince: null,
    presence: "idle",
    presenceSince: null,
    lifecycleStatusSince: null,
    ...overrides,
  };
}

test("buildAgentOverviewResponse groups agents under their machines in order", () => {
  const response = buildAgentOverviewResponse({
    serverTime: 1759161600000,
    machines: [
      { id: "m1", name: "grokbot", isComputer: true, status: "online", statusSince: 1759161000000, lastHeartbeat: "2026-09-29T15:50:00.000Z" },
      { id: "m2", name: "backup", isComputer: false, status: "offline", statusSince: null, lastHeartbeat: null },
    ],
    agents: [
      agentFact({ id: "a1", machineId: "m2", activity: "working", presence: "working", activitySince: 1, presenceSince: 2 }),
      agentFact({ id: "a2", machineId: "m1" }),
      agentFact({ id: "a3", machineId: "m1", activity: "offline", presence: "offline" }),
    ],
  });

  assert.equal(response.serverTime, 1759161600000);
  assert.equal(response.unassignedAgents, 0);
  assert.equal(response.machines.length, 2);
  assert.deepEqual(response.machines[0].agents.map((agent) => agent.id), ["a2", "a3"]);
  assert.deepEqual(response.machines[1].agents.map((agent) => agent.id), ["a1"]);
  assert.equal(response.machines[0].isComputer, true);
  assert.equal(response.machines[0].lastHeartbeat, "2026-09-29T15:50:00.000Z");
  assert.equal(response.machines[1].lastHeartbeat, null);
});

test("buildAgentOverviewResponse keeps machines without agents with an empty array", () => {
  const response = buildAgentOverviewResponse({
    serverTime: 1,
    machines: [{ id: "m1", name: "empty", isComputer: false, status: "offline", statusSince: null, lastHeartbeat: null }],
    agents: [],
  });
  assert.deepEqual(response.machines[0].agents, []);
});

test("buildAgentOverviewResponse counts machineless agents without grouping them", () => {
  const response = buildAgentOverviewResponse({
    serverTime: 1,
    machines: [{ id: "m1", name: "m", isComputer: false, status: "online", statusSince: null, lastHeartbeat: null }],
    agents: [
      agentFact({ id: "a1", machineId: null }),
      agentFact({ id: "a2", machineId: null }),
      agentFact({ id: "a3", machineId: "m1" }),
    ],
  });
  assert.equal(response.unassignedAgents, 2);
  assert.deepEqual(response.machines[0].agents.map((agent) => agent.id), ["a3"]);
});

test("buildAgentOverviewResponse carries every since stamp through verbatim", () => {
  const response = buildAgentOverviewResponse({
    serverTime: 9,
    machines: [{ id: "m1", name: "m", isComputer: false, status: "online", statusSince: 1759161100000, lastHeartbeat: null }],
    agents: [
      agentFact({
        id: "a1",
        machineId: "m1",
        lifecycleStatus: "inactive",
        activitySince: 1759161200000,
        presenceSince: 1759161300000,
        lifecycleStatusSince: 1759161400000,
      }),
    ],
  });

  const projected = response.machines[0].agents[0];
  assert.equal(projected.activitySince, 1759161200000);
  assert.equal(projected.presenceSince, 1759161300000);
  assert.equal(projected.lifecycleStatus, "inactive");
  // The builder passes the caller-resolved stamps through; it must never
  // invent or drop values.
  assert.equal(projected.lifecycleStatusSince, 1759161400000);
  assert.equal(response.machines[0].statusSince, 1759161100000);
});

test("buildAgentOverviewResponse preserves unknown-since nulls verbatim", () => {
  const response = buildAgentOverviewResponse({
    serverTime: 9,
    machines: [],
    agents: [agentFact({ id: "a1", machineId: null, activitySince: null, presenceSince: null })],
  });
  assert.equal(response.unassignedAgents, 1);
  assert.equal(response.machines.length, 0);
});
