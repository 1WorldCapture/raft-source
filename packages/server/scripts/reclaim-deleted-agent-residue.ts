#!/usr/bin/env tsx
// Task #9 one-shot reclaimer: purge the per-agent side tables deleteAgent
// historically left behind (see packages/server/src/services/agentService.ts
// — the in-transaction cleanup covers NEW deletes; this script reclaims the
// rows that predate it).
//
// Guards (PM ruling 2026-10-07):
//   • only rows belonging to SOFT-DELETED agents (agents.deleted_at NOT NULL)
//   • dry-run by default: prints current_database() + per-table counts
//   • --apply runs the same deletes in ONE transaction (idempotent — reruns
//     report 0 rows)
//   • credentials are REVOKED, never deleted (credential subsystem contract:
//     rows persist as audit; deletedAt already double-locks auth)
//   • provenance ledgers (agent_activity_events, attested_send_events,
//     agent-authored messages, task events) are intentionally untouched
//
// Production run (IT, after owner approval — run from the pm2 source checkout):
//   DATABASE_URL=... tsx scripts/reclaim-deleted-agent-residue.ts          # dry-run
//   DATABASE_URL=... tsx scripts/reclaim-deleted-agent-residue.ts --apply  # execute
//
// The plan/apply core lives in exported functions so the integration test
// (agentService.deleteAgentResidue.test.ts) exercises the exact same logic
// against the in-memory test database; the CLI wrapper below is the only
// thing that talks to DATABASE_URL.
import { pathToFileURL } from "node:url";

import { and, eq, inArray, isNotNull, isNull, sql } from "drizzle-orm";
import {
  closeDatabase,
  getDb,
  initDatabase,
  type Database,
} from "../src/db/index.js";
import {
  agentChannelReadCursors,
  agentCredentials,
  agentKnowledgeEvents,
  agentProviderConnections,
  agents,
  agentScopes,
  attestedSendPendingDrafts,
  managedMcpAssignments,
  mentionDeliveryOccurrences,
  oauthGrants,
  reminders,
} from "../src/db/schema.js";

export interface ReclaimPlanRow {
  table: string;
  action: string;
  count: number;
}

export type ReclaimMode = "dry-run" | "apply";

/** CLI contract: dry-run by default, --apply opts in, DATABASE_URL mandatory. */
export function parseReclaimArgs(argv: string[], env: NodeJS.ProcessEnv): { mode: ReclaimMode } {
  const mode: ReclaimMode = argv.includes("--apply") ? "apply" : "dry-run";
  if (!env.DATABASE_URL) throw new Error("DATABASE_URL is required");
  return { mode };
}

/** ids of SOFT-DELETED agents — the only rows this reclaimer may touch. */
export async function collectDeletedAgentIds(db: Database): Promise<string[]> {
  const rows = await db
    .select({ id: agents.id })
    .from(agents)
    .where(isNotNull(agents.deletedAt));
  return rows.map((row) => row.id);
}

export async function buildReclaimPlan(db: Database, ids: string[]): Promise<ReclaimPlanRow[]> {
  if (ids.length === 0) return [];
  const countVia = async (
    table: typeof agentScopes | typeof oauthGrants | typeof agentChannelReadCursors |
      typeof mentionDeliveryOccurrences | typeof agentKnowledgeEvents |
      typeof managedMcpAssignments | typeof agentProviderConnections |
      typeof attestedSendPendingDrafts,
  ): Promise<number> => {
    const [row] = await db
      .select({ n: sql<number>`count(*)::int` })
      .from(table)
      .where(inArray(table.agentId, ids));
    return row?.n ?? 0;
  };
  const [liveCredentials] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(agentCredentials)
    .where(and(inArray(agentCredentials.agentId, ids), isNull(agentCredentials.revokedAt)));
  const [pendingReminders] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(reminders)
    .where(and(inArray(reminders.ownerAgentId, ids), eq(reminders.status, "scheduled")));

  return [
    { table: "agent_credentials", action: "revoke (set revoked_at)", count: liveCredentials?.n ?? 0 },
    { table: "agent_scopes", action: "delete", count: await countVia(agentScopes) },
    { table: "oauth_grants", action: "delete", count: await countVia(oauthGrants) },
    { table: "agent_channel_read_cursors", action: "delete", count: await countVia(agentChannelReadCursors) },
    { table: "mention_delivery_occurrences", action: "delete", count: await countVia(mentionDeliveryOccurrences) },
    { table: "agent_knowledge_events", action: "delete", count: await countVia(agentKnowledgeEvents) },
    { table: "managed_mcp_assignments", action: "delete", count: await countVia(managedMcpAssignments) },
    { table: "agent_provider_connections", action: "delete", count: await countVia(agentProviderConnections) },
    { table: "attested_send_pending_drafts", action: "delete", count: await countVia(attestedSendPendingDrafts) },
    { table: "reminders (scheduled)", action: "cancel (set status=canceled)", count: pendingReminders?.n ?? 0 },
  ];
}

/**
 * One transaction, mirroring deleteAgent's cleanup block exactly:
 * revoke remaining live credentials (rows stay for audit), delete the
 * per-agent side tables, cancel still-scheduled reminders (the audit
 * terminal state — fired/canceled rows are history and stay). Idempotent
 * by construction — reruns touch 0 rows.
 */
export async function applyReclaim(
  db: Database,
  ids: string[],
): Promise<{ revokedCredentials: number }> {
  if (ids.length === 0) return { revokedCredentials: 0 };
  return db.transaction(async (tx) => {
    const revoked = await tx.update(agentCredentials)
      .set({ revokedAt: new Date(), revokedReason: "deleted_agent_residue_reclaim" })
      .where(and(inArray(agentCredentials.agentId, ids), isNull(agentCredentials.revokedAt)))
      .returning({ id: agentCredentials.id });
    await tx.delete(agentScopes).where(inArray(agentScopes.agentId, ids));
    await tx.delete(oauthGrants).where(inArray(oauthGrants.agentId, ids));
    await tx.delete(agentChannelReadCursors).where(inArray(agentChannelReadCursors.agentId, ids));
    await tx.delete(mentionDeliveryOccurrences).where(inArray(mentionDeliveryOccurrences.agentId, ids));
    await tx.delete(agentKnowledgeEvents).where(inArray(agentKnowledgeEvents.agentId, ids));
    await tx.delete(managedMcpAssignments).where(inArray(managedMcpAssignments.agentId, ids));
    await tx.delete(agentProviderConnections).where(inArray(agentProviderConnections.agentId, ids));
    await tx.delete(attestedSendPendingDrafts).where(inArray(attestedSendPendingDrafts.agentId, ids));
    await tx.update(reminders)
      .set({ status: "canceled", canceledAt: new Date(), updatedAt: new Date() })
      .where(and(
        inArray(reminders.ownerAgentId, ids),
        eq(reminders.status, "scheduled"),
      ));
    return { revokedCredentials: revoked.length };
  });
}

async function main(): Promise<void> {
  const { mode } = parseReclaimArgs(process.argv.slice(2), process.env);
  // initDatabase (real-postgres path) only opens the pool — it never runs
  // migrations, so pointing this at the production checkout is side-effect
  // free until --apply.
  await initDatabase(process.env.DATABASE_URL!);
  const db = getDb();
  try {
    const dbName = (await db.execute<{ db: string }>(sql`SELECT current_database() AS db`)).rows[0]?.db;
    console.log(`[reclaim] mode=${mode} database=${dbName}`);
    const ids = await collectDeletedAgentIds(db);
    console.log(`[reclaim] soft-deleted agents: ${ids.length}`);
    if (ids.length === 0) {
      console.log("[reclaim] nothing to do");
      return;
    }
    const plan = await buildReclaimPlan(db, ids);
    console.log("[reclaim] plan:");
    for (const row of plan) {
      console.log(`  ${row.table.padEnd(30)} ${String(row.count).padStart(6)}  ${row.action}`);
    }
    if (mode === "dry-run") {
      console.log("[reclaim] dry-run complete — rerun with --apply to execute");
      return;
    }
    const { revokedCredentials } = await applyReclaim(db, ids);
    console.log(`[reclaim] applied: credentials revoked=${revokedCredentials}, side tables purged`);
    console.log("[reclaim] idempotency check:");
    for (const row of await buildReclaimPlan(db, ids)) {
      console.log(`  ${row.table.padEnd(30)} ${String(row.count).padStart(6)}  (expected 0)`);
    }
  } finally {
    await closeDatabase();
  }
}

// Only run the CLI body when executed directly; vitest imports the exported
// functions against the in-memory test database instead.
const invokedDirectly = process.argv[1] !== undefined
  && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) {
  await main();
}
