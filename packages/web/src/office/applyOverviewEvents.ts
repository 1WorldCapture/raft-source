import type { AgentOverview, AgentOverviewAgent, OfficePresence } from "./agentOverview";

export interface ActivityEvent {
  agentId: string;
  activity: string;
  detail?: string;
  timestamp?: number;
}

export interface LifecycleEvent {
  agentId: string;
  lifecycleStatus: string;
  since: number;
  serverTime: number;
}

export interface MachineStatusEvent {
  machineId: string;
  status: "online" | "offline";
  since?: number | null;
}

function presenceFromActivity(activity: string): OfficePresence | null {
  if (activity === "thinking" || activity === "working") return "working";
  if (activity === "online" || activity === "error") return "idle";
  if (activity === "offline") return "offline";
  return null;
}

export function derivePresence(
  agent: Pick<AgentOverviewAgent, "activity" | "lifecycleStatus" | "presence">,
  machineStatus: "online" | "offline",
): OfficePresence {
  if (machineStatus === "offline") return "offline";
  if (agent.lifecycleStatus !== "active") return "offline";
  return presenceFromActivity(agent.activity) ?? agent.presence;
}

function withPresence(
  agent: AgentOverviewAgent,
  next: OfficePresence,
  since: number | null,
): AgentOverviewAgent {
  if (next === agent.presence) return agent;
  return { ...agent, presence: next, presenceSince: since };
}

function mapAgents(
  overview: AgentOverview,
  visit: (agent: AgentOverviewAgent, machineStatus: "online" | "offline") => AgentOverviewAgent,
): AgentOverview {
  return {
    ...overview,
    machines: overview.machines.map((machine) => ({
      ...machine,
      agents: machine.agents.map((agent) => visit(agent, machine.status)),
    })),
    unassignedAgents: overview.unassignedAgents.map((agent) => visit(agent, "online")),
  };
}

export function applyActivityEvent(overview: AgentOverview, event: ActivityEvent): AgentOverview {
  return mapAgents(overview, (agent, machineStatus) => {
    if (agent.id !== event.agentId) return agent;
    const updated: AgentOverviewAgent = {
      ...agent,
      activity: event.activity,
      activityDetail: event.detail ?? agent.activityDetail,
    };
    const next = derivePresence(updated, machineStatus);
    const since = next === agent.presence ? agent.presenceSince : (event.timestamp ?? overview.serverTime);
    return withPresence(updated, next, since);
  });
}

export function applyLifecycleEvent(overview: AgentOverview, event: LifecycleEvent): AgentOverview {
  const nextOverview = mapAgents(
    { ...overview, serverTime: event.serverTime },
    (agent, machineStatus) => {
      if (agent.id !== event.agentId) return agent;
      const updated: AgentOverviewAgent = {
        ...agent,
        lifecycleStatus: event.lifecycleStatus,
        lifecycleStatusSince: event.since,
      };
      const next = derivePresence(updated, machineStatus);
      return withPresence(updated, next, next === agent.presence ? agent.presenceSince : event.since);
    },
  );
  return nextOverview;
}

export function applyMachineStatusEvent(overview: AgentOverview, event: MachineStatusEvent): AgentOverview {
  return {
    ...overview,
    machines: overview.machines.map((machine) => {
      if (machine.id !== event.machineId) return machine;
      const statusSince = event.since ?? machine.statusSince;
      return {
        ...machine,
        status: event.status,
        statusSince,
        agents: machine.agents.map((agent) => {
          const next = derivePresence(agent, event.status);
          const since = next === agent.presence ? agent.presenceSince : (event.since ?? overview.serverTime);
          return withPresence(agent, next, since);
        }),
      };
    }),
  };
}
