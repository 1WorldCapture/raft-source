import api from "../api/client";
import type { AgentOverview } from "./agentOverview";
import { fakeAgentOverview } from "./fakeAgentOverview";

/**
 * Task #4 owns the real route. Until that PR merges, the office page reads
 * this fixture, which uses the agreed response shape. Flip the flag to call
 * GET /api/servers/:id/agent-overview.
 */
export const USE_FAKE_AGENT_OVERVIEW = true;

export async function loadAgentOverview(serverId: string): Promise<AgentOverview> {
  if (USE_FAKE_AGENT_OVERVIEW) return fakeAgentOverview();
  const { data } = await api.get<AgentOverview>(`/servers/${serverId}/agent-overview`);
  return data;
}
