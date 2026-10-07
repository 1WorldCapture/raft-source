// Durable "purge this deleted agent's local directories" intents (task #4).
// The daemon moves the per-agent directories into its quarantine; the server
// only remembers which machine still has to be told, and retries across
// offline periods and server restarts. See machine_pending_agent_purges.
import { and, asc, eq, sql } from "drizzle-orm";
import { getDb, type DatabaseExecutor } from "../db/index.js";
import { machinePendingAgentPurges } from "../db/schema.js";

/** `refused_running` / `error` results stop being retried automatically after this many attempts. */
export const MAX_AGENT_PURGE_ATTEMPTS = 10;

export type AgentPurgeDaemonOutcome =
  | "purged" | "nothing_to_purge" | "refused_running" | "invalid_agent_id" | "error";

/** Record the intent. Call inside deleteAgent's transaction so the soft delete and the intent commit together. */
export async function recordPendingAgentPurge(db: DatabaseExecutor, machineId: string, agentId: string): Promise<void> {
  await db.insert(machinePendingAgentPurges)
    .values({ machineId, agentId })
    .onConflictDoNothing();
}

export interface PendingAgentPurge {
  agentId: string;
  attempts: number;
}

/** Purges still owed to a machine that are under the retry cap, oldest first. */
export async function listRetryablePendingPurges(machineId: string): Promise<PendingAgentPurge[]> {
  const rows = await getDb().select({
    agentId: machinePendingAgentPurges.agentId,
    attempts: machinePendingAgentPurges.attempts,
  })
    .from(machinePendingAgentPurges)
    .where(and(
      eq(machinePendingAgentPurges.machineId, machineId),
      sql`${machinePendingAgentPurges.attempts} < ${MAX_AGENT_PURGE_ATTEMPTS}`,
    ))
    .orderBy(asc(machinePendingAgentPurges.createdAt));
  return rows;
}

export async function isPurgePending(machineId: string, agentId: string): Promise<boolean> {
  const rows = await getDb().select({ agentId: machinePendingAgentPurges.agentId })
    .from(machinePendingAgentPurges)
    .where(and(
      eq(machinePendingAgentPurges.machineId, machineId),
      eq(machinePendingAgentPurges.agentId, agentId),
    ))
    .limit(1);
  return rows.length > 0;
}

export type AgentPurgeResultDisposition = "cleared" | "kept" | "gave_up" | "unknown";

/**
 * Apply the daemon's answer. Terminal outcomes clear the intent; a refusal or
 * error keeps it, counts the attempt, and reports `gave_up` once the cap is hit
 * (the row stays so an operator can see it).
 */
export async function applyAgentPurgeResult(
  machineId: string,
  agentId: string,
  outcome: AgentPurgeDaemonOutcome,
): Promise<AgentPurgeResultDisposition> {
  const db = getDb();
  if (outcome === "purged" || outcome === "nothing_to_purge" || outcome === "invalid_agent_id") {
    const removed = await db.delete(machinePendingAgentPurges)
      .where(and(
        eq(machinePendingAgentPurges.machineId, machineId),
        eq(machinePendingAgentPurges.agentId, agentId),
      ))
      .returning({ agentId: machinePendingAgentPurges.agentId });
    return removed.length > 0 ? "cleared" : "unknown";
  }
  const updated = await db.update(machinePendingAgentPurges)
    .set({
      attempts: sql`${machinePendingAgentPurges.attempts} + 1`,
      lastAttemptAt: new Date(),
      lastOutcome: outcome,
    })
    .where(and(
      eq(machinePendingAgentPurges.machineId, machineId),
      eq(machinePendingAgentPurges.agentId, agentId),
    ))
    .returning({ attempts: machinePendingAgentPurges.attempts });
  if (updated.length === 0) return "unknown";
  return updated[0].attempts >= MAX_AGENT_PURGE_ATTEMPTS ? "gave_up" : "kept";
}
