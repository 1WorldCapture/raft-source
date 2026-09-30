import type { AgentOverview, AgentOverviewAgent, OfficePresence } from "./agentOverview";

const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;

/** Fixed clock so the nine tiers stay put while this fixture is on screen. */
export const FAKE_OVERVIEW_SERVER_TIME = 1_700_000_000_000;

function agent(
  id: string,
  name: string,
  presence: OfficePresence,
  agoMs: number | null,
  activity: string,
  detail: string,
): AgentOverviewAgent {
  return {
    id,
    name,
    activity,
    activityDetail: detail,
    activitySince: agoMs == null ? null : FAKE_OVERVIEW_SERVER_TIME - agoMs,
    lifecycleStatus: "active",
    lifecycleStatusSince: FAKE_OVERVIEW_SERVER_TIME - 4 * HOUR,
    presence,
    presenceSince: agoMs == null ? null : FAKE_OVERVIEW_SERVER_TIME - agoMs,
  };
}

/**
 * Two machines, nine duration tiers, matching the accepted Pixel Agents demo.
 * Swap this out when GET /api/servers/:id/agent-overview is live.
 */
export function fakeAgentOverview(): AgentOverview {
  return {
    serverTime: FAKE_OVERVIEW_SERVER_TIME,
    machines: [
      {
        id: "machine-computer-a",
        name: "computer-a",
        isComputer: true,
        status: "online",
        statusSince: FAKE_OVERVIEW_SERVER_TIME - 5 * HOUR,
        lastHeartbeat: FAKE_OVERVIEW_SERVER_TIME,
        agents: [
          agent("agent-work-0", "工作短", "working", 10 * MINUTE, "working", "正在写代码"),
          agent("agent-work-1", "工作中", "working", 60 * MINUTE, "working", "正在改测试"),
          agent("agent-idle-0", "空闲短", "idle", 10 * MINUTE, "online", "等下一条消息"),
          agent("agent-idle-1", "空闲中", "idle", 90 * MINUTE, "online", "在房间里走动"),
          agent("agent-off-0", "离线短", "offline", 20 * MINUTE, "offline", "刚刚离开"),
        ],
      },
      {
        id: "machine-computer-b",
        name: "computer-b",
        isComputer: true,
        status: "online",
        statusSince: FAKE_OVERVIEW_SERVER_TIME - 6 * HOUR,
        lastHeartbeat: FAKE_OVERVIEW_SERVER_TIME,
        agents: [
          agent("agent-work-2", "工作长", "working", 3 * HOUR, "thinking", "长时间思考"),
          agent("agent-idle-2", "空闲长", "idle", 4 * HOUR, "online", "穿过门去另一间"),
          agent("agent-off-1", "离线中", "offline", 2 * HOUR, "offline", "沙发上休息"),
          agent("agent-off-2", "离线长", "offline", 13 * HOUR, "offline", "已经离开很久"),
        ],
      },
    ],
    unassignedAgents: [],
  };
}
