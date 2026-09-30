import api from "../api/client";
import type { AgentOverview } from "./agentOverview";
import { fakeAgentOverview } from "./fakeAgentOverview";

/**
 * False calls GET /api/servers/:id/agent-overview. The fixture remains for
 * layout tests and for forcing the preview without a server.
 */
export const USE_FAKE_AGENT_OVERVIEW = false;

export async function loadAgentOverview(serverId: string): Promise<AgentOverview> {
  if (USE_FAKE_AGENT_OVERVIEW) return fakeAgentOverview();
  const { data } = await api.get<AgentOverview>(`/servers/${serverId}/agent-overview`);
  return data;
}
