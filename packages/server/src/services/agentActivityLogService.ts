import { desc, eq } from "drizzle-orm";
import {
  isAgentActivity,
  normalizeActivityDetailKind,
  type AgentActivity,
  type AgentActivityDetailKind,
  type AgentPresence,
  type TrajectoryEntry,
} from "@botiverse/raft-shared";
import { getDb } from "../db/index.js";
import { agentActivityEvents } from "../db/schema.js";

export interface PersistedTrajectoryLogEntry {
  timestamp: number;
  entry: TrajectoryEntry;
}

export interface PersistedAgentActivityHint {
  activity: AgentActivity;
  detail: string;
  detailKind: AgentActivityDetailKind;
  updatedAt: number;
}

export function projectAgentActivityHintFromPersistedEvent(row: {
  activity: AgentActivity;
  detail: string;
  entries?: TrajectoryEntry[] | null;
  createdAt: Date;
}): PersistedAgentActivityHint {
  const latestStatus = (row.entries || [])
    .filter((entry): entry is Extract<TrajectoryEntry, { kind: "status" }> => entry.kind === "status")
    .at(-1);

  return {
    activity: row.activity,
    detail: row.detail,
    detailKind: normalizeActivityDetailKind(latestStatus?.detailKind),
    updatedAt: new Date(row.createdAt).getTime(),
  };
}

const DEFAULT_ACTIVITY_LOG_LIMIT = 50;
const MAX_ENTRIES_PER_EVENT = 100;

export async function appendAgentActivityEvent(
  agentId: string,
  activity: string,
  detail: string,
  entries: TrajectoryEntry[],
  createdAt: Date,
  dedupeKey?: string,
): Promise<boolean> {
  if (entries.length === 0) return false;
  const persistedActivity: AgentActivity = isAgentActivity(activity) ? activity : "working";
  if (persistedActivity !== activity) {
    console.warn(`[ActivityLog ${agentId}] Invalid activity "${activity}" — coercing to "${persistedActivity}" for persistence`);
  }
  const persistedEntries = entries.length > MAX_ENTRIES_PER_EVENT
    ? entries.slice(0, MAX_ENTRIES_PER_EVENT)
    : entries;
  if (persistedEntries.length !== entries.length) {
    console.warn(`[ActivityLog ${agentId}] Truncating oversized event from ${entries.length} entries to ${persistedEntries.length}`);
  }
  const db = getDb();
  const inserted = await db.insert(agentActivityEvents).values({
    agentId,
    activity: persistedActivity,
    detail,
    entries: persistedEntries,
    dedupeKey,
    createdAt,
  }).onConflictDoNothing().returning({ id: agentActivityEvents.id });
  return inserted.length > 0;
}

export async function listRecentAgentTrajectory(
  agentId: string,
  limit = DEFAULT_ACTIVITY_LOG_LIMIT,
): Promise<PersistedTrajectoryLogEntry[]> {
  const db = getDb();
  const rows = await db.select({
    createdAt: agentActivityEvents.createdAt,
    entries: agentActivityEvents.entries,
  })
    .from(agentActivityEvents)
    .where(eq(agentActivityEvents.agentId, agentId))
    .orderBy(desc(agentActivityEvents.createdAt))
    .limit(limit);

  return rows
    .reverse()
    .flatMap((row) => {
      const timestamp = new Date(row.createdAt).getTime();
      return (row.entries || []).map((entry) => ({ timestamp, entry }));
    });
}

export async function getLatestAgentActivityHint(
  agentId: string,
): Promise<PersistedAgentActivityHint | null> {
  const db = getDb();
  const [row] = await db.select({
    activity: agentActivityEvents.activity,
    detail: agentActivityEvents.detail,
    entries: agentActivityEvents.entries,
    createdAt: agentActivityEvents.createdAt,
  })
    .from(agentActivityEvents)
    .where(eq(agentActivityEvents.agentId, agentId))
    .orderBy(desc(agentActivityEvents.createdAt))
    .limit(1);

  if (!row) return null;
  return projectAgentActivityHintFromPersistedEvent(row);
}

// --- Presence/activity "since" recovery from the durable activity log ---
//
// The Redis activity hash carries a 600s TTL and process memory dies with the
// replica, so activitySince/presenceSince must survive from `agent_activity_events`.
// The write side guarantees every activity-value or presence-value change lands
// one row (either a normal entries-bearing row or a synthesized anchor row), so
// the boundary of the newest run of equal-value rows is the true transition
// time. Scan budget is capped: when a run reaches the cap the real start lies
// beyond it and the honest answer is null, never the oldest scanned row.

export const AGENT_PRESENCE_RECOVERY_SCAN_LIMIT = 500;

export interface RecoveredAgentPresenceAnchor {
  activity: AgentActivity;
  detail: string;
  detailKind: AgentActivityDetailKind;
  /** Epoch ms of the newest activity-value change; null when beyond the cap. */
  activitySinceMs: number | null;
  presence: AgentPresence;
  /** Epoch ms of the newest presence-value change; null when beyond the cap. */
  presenceSinceMs: number | null;
  /** Epoch ms of the newest durable row — the observation time of the served value. */
  newestAtMs: number;
}

/**
 * Rebuild the presence/activity anchors for one agent from the durable log.
 * `presenceOf` projects a persisted raw activity onto the current presence
 * space so machine/lifecycle facts stay owned by the caller. Returns null when
 * the agent has no rows at all — callers must surface null, never fabricate a
 * timestamp from the read time.
 */
export async function recoverAgentPresenceAnchor(
  agentId: string,
  presenceOf: (activity: AgentActivity) => AgentPresence,
  scanLimit: number = AGENT_PRESENCE_RECOVERY_SCAN_LIMIT,
): Promise<RecoveredAgentPresenceAnchor | null> {
  const db = getDb();
  const rows = await db.select({
    activity: agentActivityEvents.activity,
    detail: agentActivityEvents.detail,
    entries: agentActivityEvents.entries,
    createdAt: agentActivityEvents.createdAt,
  })
    .from(agentActivityEvents)
    .where(eq(agentActivityEvents.agentId, agentId))
    .orderBy(desc(agentActivityEvents.createdAt))
    .limit(scanLimit);

  if (rows.length === 0) return null;

  const newest = rows[0];
  const times = rows.map((row) => new Date(row.createdAt).getTime());
  // A run that reaches the last scanned row is only conclusive when the scan
  // window covered the agent's whole history (fewer rows than the cap).
  const runReachesScanEdge = rows.length >= scanLimit;

  const resolveRunStartMs = (matches: (index: number) => boolean): number | null => {
    let boundary = -1;
    for (let i = 0; i < rows.length; i += 1) {
      if (!matches(i)) break;
      boundary = i;
    }
    if (boundary < 0) return null;
    if (boundary === rows.length - 1 && runReachesScanEdge) return null;
    return times[boundary];
  };

  const currentActivity = newest.activity;
  const currentPresence = presenceOf(currentActivity);

  return {
    activity: currentActivity,
    detail: newest.detail,
    detailKind: normalizeActivityDetailKind(
      (newest.entries || [])
        .filter((entry): entry is Extract<TrajectoryEntry, { kind: "status" }> => entry.kind === "status")
        .at(-1)?.detailKind,
    ),
    activitySinceMs: resolveRunStartMs((i) => rows[i].activity === currentActivity),
    presence: currentPresence,
    presenceSinceMs: resolveRunStartMs((i) => presenceOf(rows[i].activity) === currentPresence),
    newestAtMs: times[0],
  };
}
