import assert from "node:assert/strict";
import test from "node:test";
import {
  applyActivityEvent,
  applyLifecycleEvent,
  applyMachineStatusEvent,
} from "../src/office/applyOverviewEvents";
import type { AgentOverview, AgentOverviewAgent } from "../src/office/agentOverview";
import { durationTier, presenceDurationMs } from "../src/office/durationTier";
import { FAKE_OVERVIEW_SERVER_TIME, fakeAgentOverview } from "../src/office/fakeAgentOverview";
import { buildOfficeScene } from "../src/office/roomLayout";
import { TileType } from "../src/officePixel/office/types.js";

const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;

function bareAgent(overrides: Partial<AgentOverviewAgent> = {}): AgentOverviewAgent {
  return {
    id: "a1",
    name: "Ada",
    activity: "working",
    activityDetail: "typing",
    activitySince: 0,
    lifecycleStatus: "active",
    lifecycleStatusSince: 0,
    presence: "working",
    presenceSince: 0,
    ...overrides,
  };
}

test("unknown duration draws the first tier", () => {
  assert.equal(presenceDurationMs(null, 1_000), null);
  assert.equal(durationTier("working", null), 0);
  assert.equal(durationTier("idle", null), 0);
  assert.equal(durationTier("offline", null), 0);
});

test("duration tiers follow the configured thresholds", () => {
  assert.equal(durationTier("working", 10 * MINUTE), 0);
  assert.equal(durationTier("working", 30 * MINUTE), 1);
  assert.equal(durationTier("working", 2 * HOUR), 2);
  assert.equal(durationTier("idle", 10 * MINUTE), 0);
  assert.equal(durationTier("idle", 90 * MINUTE), 1);
  assert.equal(durationTier("idle", 3 * HOUR), 2);
  assert.equal(durationTier("offline", 20 * MINUTE), 0);
  assert.equal(durationTier("offline", 2 * HOUR), 1);
  assert.equal(durationTier("offline", 12 * HOUR), 2);
});

test("fake overview lays out one room per machine and all nine tiers", () => {
  const overview = fakeAgentOverview();
  const scene = buildOfficeScene(overview, FAKE_OVERVIEW_SERVER_TIME);
  const labels = scene.layout.areas?.map((area) => area.label);
  assert.deepEqual(labels, ["computer-a", "computer-b"]);
  assert.equal(scene.placements.length, 9);
  const tiers = scene.placements.map((placement) => `${placement.presence}:${placement.tier}`).sort();
  assert.deepEqual(tiers, [
    "idle:0",
    "idle:1",
    "idle:2",
    "offline:0",
    "offline:1",
    "offline:2",
    "working:0",
    "working:1",
    "working:2",
  ]);
  const doorCol = 13;
  assert.equal(scene.layout.tiles[6 * scene.layout.cols + doorCol], TileType.FLOOR_1);
  assert.equal(scene.layout.tiles[0], TileType.WALL);
});

test("presence since is kept until presence actually changes", () => {
  const agent = bareAgent({ presenceSince: 50, activity: "working", presence: "working" });
  const overview: AgentOverview = {
    serverTime: 1_000,
    machines: [{
      id: "m",
      name: "computer-a",
      isComputer: true,
      status: "online",
      statusSince: 0,
      lastHeartbeat: new Date(1_000).toISOString(),
      agents: [agent],
    }],
    unassignedAgents: 0,
  };
  const same = applyActivityEvent(overview, { agentId: "a1", activity: "thinking", detail: "still at it", observedAtMs: 800 }, 0);
  assert.equal(same.machines[0].agents[0].presence, "working");
  assert.equal(same.machines[0].agents[0].presenceSince, 50);
  assert.equal(same.machines[0].agents[0].activityDetail, "still at it");

  const idle = applyActivityEvent(overview, { agentId: "a1", activity: "online", observedAtMs: 800 }, 100);
  assert.equal(idle.machines[0].agents[0].presence, "idle");
  assert.equal(idle.machines[0].agents[0].presenceSince, 900);

  const unknown = applyActivityEvent(overview, { agentId: "a1", activity: "online" }, 0);
  assert.equal(unknown.machines[0].agents[0].presence, "idle");
  assert.equal(unknown.machines[0].agents[0].presenceSince, null);

  const stopped = applyLifecycleEvent(idle, {
    agentId: "a1",
    lifecycleStatus: "stopped",
    since: 950,
    serverTime: 1_100,
  });
  assert.equal(stopped.serverTime, 1_100);
  assert.equal(stopped.machines[0].agents[0].presence, "offline");
  assert.equal(stopped.machines[0].agents[0].presenceSince, 950);

  const offlineMachine = applyMachineStatusEvent(overview, { machineId: "m", status: "offline", since: 700 });
  assert.equal(offlineMachine.machines[0].status, "offline");
  assert.equal(offlineMachine.machines[0].agents[0].presence, "offline");
  assert.equal(offlineMachine.machines[0].agents[0].presenceSince, 700);

  const noSince = applyMachineStatusEvent(overview, { machineId: "m", status: "offline" });
  assert.equal(noSince.machines[0].agents[0].presence, "offline");
  assert.equal(noSince.machines[0].agents[0].presenceSince, null);
});

test("six machines wrap to two rows of three", () => {
  const overview = fakeAgentOverview();
  const machines = ["m1", "m2", "m3", "m4", "m5", "m6"].map((id, index) => ({
    ...overview.machines[0],
    id,
    name: `computer-${index + 1}`,
    agents: [],
  }));
  const scene = buildOfficeScene({ ...overview, machines, unassignedAgents: 0 }, FAKE_OVERVIEW_SERVER_TIME);
  assert.equal(scene.layout.areas?.length, 6);
  assert.equal(scene.layout.cols, 1 + 3 * 13);
  assert.ok(scene.layout.rows > 16);
  const door = 6 * scene.layout.cols + 13;
  assert.equal(scene.layout.tiles[door], TileType.FLOOR_1);
  const secondRowFloor = 16 * scene.layout.cols + 1;
  assert.equal(scene.layout.tiles[15 * scene.layout.cols + 1], TileType.WALL);
  assert.equal(scene.layout.tiles[secondRowFloor], TileType.FLOOR_2);
});
