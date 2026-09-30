import type { AgentOverview, AgentOverviewAgent } from "./agentOverview";
import { derivePresence } from "./derivePresence";
import type { AgentPresence } from "./derivePresence";

export interface ActivityEvent {
  agentId: string;
  activity: string;
  detail?: string;
  /** Daemon clock (ms epoch). Calibrate with the server offset. Absent → unknown duration. */
  observedAtMs?: number | null;
}

export interface LifecycleEvent {
  agentId: string;
  lifecycleStatus: string;
  /** Server clock (ms epoch) when this lifecycle began. */
  since?: number | null;
  serverTime: number;
}

export interface MachineStatusEvent {
  machineId: string;
  status: "online" | "offline";
  /** Server clock (ms epoch). Absent → unknown duration. */
  since?: number | null;
}

function finiteMs(value: number | null | undefined): number | null {
  if (value == null || !Number.isFinite(value)) return null;
  return value;
}

/** Daemon `Date.now()` shifted onto the server clock. Not the browser's current time. */
export function calibrateObservedAt(observedAtMs: number, clockOffsetMs: number): number {
  return observedAtMs + clockOffsetMs;
}

function withPresence(
  agent: AgentOverviewAgent,
  next: AgentPresence,
  since: number | null,
): AgentOverviewAgent {
  if (next === agent.presence) return agent;
  return { ...agent, presence: next, presenceSince: since };
}

function project(
  agent: AgentOverviewAgent,
  machineStatus: "online" | "offline",
  since: number | null,
): AgentOverviewAgent {
  const next = derivePresence({
    activity: agent.activity,
    lifecycleStatus: agent.lifecycleStatus,
    machineStatus,
  });
  return withPresence(agent, next, since);
}

export function applyActivityEvent(
  overview: AgentOverview,
  event: ActivityEvent,
  clockOffsetMs: number,
): AgentOverview {
  const observed = finiteMs(event.observedAtMs);
  const since = observed == null ? null : calibrateObservedAt(observed, clockOffsetMs);
  return {
    ...overview,
    machines: overview.machines.map((machine) => ({
      ...machine,
      agents: machine.agents.map((agent) => {
        if (agent.id !== event.agentId) return agent;
        const updated: AgentOverviewAgent = {
          ...agent,
          activity: event.activity,
          activityDetail: event.detail ?? agent.activityDetail,
        };
        return project(updated, machine.status, since);
      }),
    })),
    unassignedAgents: overview.unassignedAgents.map((agent) => {
      if (agent.id !== event.agentId) return agent;
      const updated: AgentOverviewAgent = {
        ...agent,
        activity: event.activity,
        activityDetail: event.detail ?? agent.activityDetail,
      };
      return project(updated, "online", since);
    }),
  };
}

export function applyLifecycleEvent(overview: AgentOverview, event: LifecycleEvent): AgentOverview {
  const since = finiteMs(event.since);
  return {
    ...overview,
    serverTime: event.serverTime,
    machines: overview.machines.map((machine) => ({
      ...machine,
      agents: machine.agents.map((agent) => {
        if (agent.id !== event.agentId) return agent;
        return project({
          ...agent,
          lifecycleStatus: event.lifecycleStatus,
          lifecycleStatusSince: since,
        }, machine.status, since);
      }),
    })),
    unassignedAgents: overview.unassignedAgents.map((agent) => {
      if (agent.id !== event.agentId) return agent;
      return project({
        ...agent,
        lifecycleStatus: event.lifecycleStatus,
        lifecycleStatusSince: since,
      }, "online", since);
    }),
  };
}

export function applyMachineStatusEvent(overview: AgentOverview, event: MachineStatusEvent): AgentOverview {
  const since = finiteMs(event.since);
  return {
    ...overview,
    machines: overview.machines.map((machine) => {
      if (machine.id !== event.machineId) return machine;
      return {
        ...machine,
        status: event.status,
        statusSince: since ?? machine.statusSince,
        agents: machine.agents.map((agent) => project(agent, event.status, since)),
      };
    }),
  };
}
