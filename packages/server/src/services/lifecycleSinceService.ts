import { and, eq, inArray, isNull } from "drizzle-orm";
import { getDb } from "../db/index.js";
import { agents, computerOutageOccurrences, machines } from "../db/schema.js";

// Read side of the "since" timestamps behind the agent overview: when an
// agent's lifecycle status (agents.status) and a machine's connection status
// began. Everything is ms epoch; null means unknown and must render as
// "duration unknown", never as a guessed start.

/** agentId -> when its current agents.status began, for agents of one server. Missing, deleted or foreign agents are absent. */
export async function getAgentLifecycleSince(
  serverId: string,
  agentIds: readonly string[],
): Promise<Map<string, number | null>> {
  const result = new Map<string, number | null>();
  if (agentIds.length === 0) return result;
  const rows = await getDb().select({ id: agents.id, statusChangedAt: agents.statusChangedAt })
    .from(agents)
    .where(and(eq(agents.serverId, serverId), inArray(agents.id, [...agentIds]), isNull(agents.deletedAt)));
  for (const row of rows) result.set(row.id, row.statusChangedAt?.getTime() ?? null);
  return result;
}

export type MachineStatusSinceFacts = {
  lastStatus: "online" | "offline" | null;
  statusChangedAt: Date | null;
  lastHeartbeat: Date | null;
  createdAt: Date;
  // first_offline_at of the machine's open (pending/notified) outage; only
  // managed Computers have outage rows.
  openOutageStartedAt: Date | null;
};

/**
 * Pick the start of the machine's current live status. The persisted
 * last_status/status_changed_at pair is exact when it agrees with the live
 * status. When it does not (e.g. the machine vanished while the server was
 * down, so no offline projection ran), offline falls back to the open outage,
 * then the last heartbeat (off by up to one ping interval; managed Computers
 * without an open outage row use it too, as an approximation), and a machine
 * that never connected has been offline since it was created. A disagreeing online
 * status has no trustworthy start.
 */
export function deriveMachineStatusSince(
  liveStatus: "online" | "offline",
  facts: MachineStatusSinceFacts,
): number | null {
  if (facts.lastStatus === liveStatus && facts.statusChangedAt) return facts.statusChangedAt.getTime();
  if (liveStatus === "online") return null;
  if (facts.openOutageStartedAt) return facts.openOutageStartedAt.getTime();
  if (facts.lastHeartbeat) return facts.lastHeartbeat.getTime();
  if (facts.lastStatus === null) return facts.createdAt.getTime();
  return null;
}

/** machineId -> when its live status began, for machines of one server. */
export async function getMachineStatusSince(
  serverId: string,
  liveStatuses: ReadonlyArray<{ id: string; status: "online" | "offline" }>,
): Promise<Map<string, number | null>> {
  const result = new Map<string, number | null>();
  if (liveStatuses.length === 0) return result;
  const machineIds = liveStatuses.map((machine) => machine.id);
  const db = getDb();
  const [rows, outages] = await Promise.all([
    db.select({
      id: machines.id,
      lastStatus: machines.lastStatus,
      statusChangedAt: machines.statusChangedAt,
      lastHeartbeat: machines.lastHeartbeat,
      createdAt: machines.createdAt,
    }).from(machines)
      .where(and(eq(machines.serverId, serverId), inArray(machines.id, machineIds))),
    db.select({
      machineId: computerOutageOccurrences.machineId,
      firstOfflineAt: computerOutageOccurrences.firstOfflineAt,
    }).from(computerOutageOccurrences)
      .where(and(
        eq(computerOutageOccurrences.serverId, serverId),
        inArray(computerOutageOccurrences.machineId, machineIds),
        inArray(computerOutageOccurrences.state, ["pending", "notified"]),
      )),
  ]);
  const outageStarts = new Map(outages.map((outage) => [outage.machineId, outage.firstOfflineAt]));
  const factsById = new Map(rows.map((row) => [row.id, row]));
  for (const { id, status } of liveStatuses) {
    const facts = factsById.get(id);
    if (!facts) continue;
    result.set(id, deriveMachineStatusSince(status, {
      ...facts,
      openOutageStartedAt: outageStarts.get(id) ?? null,
    }));
  }
  return result;
}
