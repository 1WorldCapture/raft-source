import type { AgentActivityKind } from "./index.js";
import type { AgentPresence } from "./agentPresence.js";

/**
 * Dashboard agent-overview contract (mgmt-dashboard task #4).
 *
 * The endpoint answer is a machine-grouped snapshot of every agent in one
 * server: unassigned agents are counted but never grouped, machines without
 * agents still appear with an empty `agents` array, and every "since" field is
 * an epoch-ms timestamp or null when the true transition time is unknown.
 * Null is the honest "unknown" — never fabricate a timestamp.
 */

/** Per-machine projection inside the overview. */
export interface AgentOverviewMachineAgent {
  id: string;
  name: string;
  activity: AgentActivityKind;
  activityDetail: string;
  /** Epoch ms of the last raw-activity VALUE change; null when unknown. */
  activitySince: number | null;
  presence: AgentPresence;
  /** Epoch ms of the last presence VALUE change; null when unknown. */
  presenceSince: number | null;
  lifecycleStatus: string;
  /**
   * Epoch ms of the last lifecycle status change (agents.statusChangedAt);
   * null when the transition time is unknown or the agent row is gone.
   */
  lifecycleStatusSince: number | null;
}

export interface AgentOverviewMachine {
  id: string;
  name: string;
  isComputer: boolean;
  status: "online" | "offline";
  /**
   * Epoch ms of the last machine connection-status change; null when no
   * trustworthy start exists (see lifecycleSinceService.deriveMachineStatusSince).
   */
  statusSince: number | null;
  /** ISO timestamp of the last machine heartbeat; null when never seen. */
  lastHeartbeat: string | null;
  agents: AgentOverviewMachineAgent[];
}

export interface AgentOverviewResponse {
  /** Epoch ms server clock at response build time. */
  serverTime: number;
  /** Agents whose machineId is null — counted here, never grouped. */
  unassignedAgents: number;
  machines: AgentOverviewMachine[];
}

/** Resolved per-agent facts the route hands to the pure builder. */
export interface AgentOverviewAgentFact {
  id: string;
  name: string;
  machineId: string | null;
  lifecycleStatus: string;
  activity: AgentActivityKind;
  activityDetail: string;
  activitySince: number | null;
  presence: AgentPresence;
  presenceSince: number | null;
  /** Epoch ms of the last lifecycle status change; null when unknown. */
  lifecycleStatusSince: number | null;
}

/** Resolved per-machine facts the route hands to the pure builder. */
export interface AgentOverviewMachineFact {
  id: string;
  name: string;
  isComputer: boolean;
  status: "online" | "offline";
  /** Epoch ms of the last machine status change; null when unknown. */
  statusSince: number | null;
  lastHeartbeat: string | null;
}

/**
 * Pure grouping: assign agents to their machines (input order preserved on
 * both sides), count machineless agents without grouping them, and carry the
 * caller-resolved "since" stamps through unchanged.
 */
export function buildAgentOverviewResponse(input: {
  serverTime: number;
  machines: AgentOverviewMachineFact[];
  agents: AgentOverviewAgentFact[];
}): AgentOverviewResponse {
  const agentsByMachineId = new Map<string, AgentOverviewAgentFact[]>();
  let unassignedAgents = 0;
  for (const agent of input.agents) {
    if (agent.machineId === null) {
      unassignedAgents += 1;
      continue;
    }
    const bucket = agentsByMachineId.get(agent.machineId);
    if (bucket) {
      bucket.push(agent);
    } else {
      agentsByMachineId.set(agent.machineId, [agent]);
    }
  }
  return {
    serverTime: input.serverTime,
    unassignedAgents,
    machines: input.machines.map((machine) => ({
      id: machine.id,
      name: machine.name,
      isComputer: machine.isComputer,
      status: machine.status,
      statusSince: machine.statusSince,
      lastHeartbeat: machine.lastHeartbeat,
      agents: (agentsByMachineId.get(machine.id) ?? []).map((agent) => ({
        id: agent.id,
        name: agent.name,
        activity: agent.activity,
        activityDetail: agent.activityDetail,
        activitySince: agent.activitySince,
        presence: agent.presence,
        presenceSince: agent.presenceSince,
        lifecycleStatus: agent.lifecycleStatus,
        lifecycleStatusSince: agent.lifecycleStatusSince,
      })),
    })),
  };
}
