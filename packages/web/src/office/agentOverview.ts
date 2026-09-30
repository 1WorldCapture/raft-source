/** Shape agreed for GET /api/servers/:id/agent-overview (#mgmt-dashboard:92092882). */

export type OfficePresence = "working" | "idle" | "offline";

export interface AgentOverviewAgent {
  id: string;
  name: string;
  activity: string;
  activityDetail: string;
  activitySince: number | null;
  lifecycleStatus: string;
  lifecycleStatusSince: number | null;
  presence: OfficePresence;
  /** ms epoch. Null means the duration is unknown. */
  presenceSince: number | null;
}

export interface AgentOverviewMachine {
  id: string;
  name: string;
  isComputer: boolean;
  status: "online" | "offline";
  statusSince: number | null;
  /** ISO timestamp. Null when the machine has never been seen. */
  lastHeartbeat: string | null;
  agents: AgentOverviewAgent[];
}

export interface AgentOverview {
  serverTime: number;
  machines: AgentOverviewMachine[];
  /** Agents with no machine. Count only — they are not drawn as a room. */
  unassignedAgents: number;
}
