import { createHash, timingSafeEqual } from "node:crypto";
import { and, eq, isNull, sql } from "drizzle-orm";
import { z } from "zod";
import { getDb, type Database, type DatabaseTransaction } from "../db/index.js";
import { agents, agentCredentials, externalAgentConnections, externalAgentRuns } from "../db/schema.js";
import { resolveActorContext, userCanActOnAgentResource } from "../lib/actorPermissions.js";

export class DelegationError extends Error {
  constructor(readonly code: string, readonly status = 409) {
    super(code);
    this.name = "DelegationError";
  }
}
export type AgentIdentity = { serverId: string; agentId: string; credentialId: string };
export type HumanIdentity = { serverId: string; userId: string };
export type ExecutionContext = { runId: string; epoch: string; fence: string; ownerToken: string };
export type ConnectionRow = typeof externalAgentConnections.$inferSelect;
export type RunRow = typeof externalAgentRuns.$inferSelect;

// Capabilities are transaction-local and cannot be manufactured by a caller.
export interface AgentTransaction {
  readonly tx: DatabaseTransaction;
  readonly agentIds: ReadonlySet<string>;
}
const liveTransactions = new WeakSet<AgentTransaction>();
const uuid = z.string().uuid();

export function assertAgentTransaction(context: AgentTransaction, agentId: string): void {
  if (!liveTransactions.has(context) || !context.agentIds.has(agentId.toLowerCase())) {
    throw new DelegationError("agent_transaction_required", 500);
  }
}

export function agentAuthorityLockKey(agentId: string): bigint {
  uuid.parse(agentId);
  return createHash("sha256").update(`raft.agent-transaction-authority.v1:${agentId.toLowerCase()}`).digest().readBigInt64BE();
}

export async function withAgentTransaction<T>(
  agentIds: readonly string[],
  work: (context: AgentTransaction) => Promise<T>,
  db: Database = getDb(),
): Promise<T> {
  const ordered = [...new Set(agentIds.map((id) => uuid.parse(id).toLowerCase()))].sort();
  if (!ordered.length) throw new DelegationError("agent_transaction_required", 500);
  return db.transaction(async (tx) => {
    await tx.execute(sql`SELECT set_config('lock_timeout', '5s', true), set_config('statement_timeout', '10s', true)`);
    // Acquire every stable Agent gate before any connection or business row.
    for (const id of ordered) await tx.execute(sql`SELECT pg_advisory_xact_lock(${agentAuthorityLockKey(id)})`);
    const context: AgentTransaction = Object.freeze({ tx, agentIds: new Set(ordered) });
    liveTransactions.add(context);
    try { return await work(context); } finally { liveTransactions.delete(context); }
  });
}

export async function databaseNow(context: AgentTransaction): Promise<Date> {
  if (!liveTransactions.has(context)) throw new DelegationError("agent_transaction_required", 500);
  const result = await context.tx.execute(sql`SELECT clock_timestamp() AS now`);
  const now = new Date(result.rows[0]?.now instanceof Date ? result.rows[0].now.getTime() : String(result.rows[0]?.now));
  if (!Number.isFinite(now.getTime())) throw new DelegationError("database_clock_invalid", 500);
  return now;
}

export async function requireAgent(context: AgentTransaction, identity: { serverId: string; agentId: string }) {
  assertAgentTransaction(context, identity.agentId);
  const [agent] = await context.tx.select().from(agents).where(and(
    eq(agents.id, identity.agentId), eq(agents.serverId, identity.serverId), isNull(agents.deletedAt),
  )).limit(1);
  if (!agent) throw new DelegationError("agent_missing", 404);
  return agent;
}

export async function readConnection(context: AgentTransaction, agentId: string) {
  assertAgentTransaction(context, agentId);
  const [connection] = await context.tx.select().from(externalAgentConnections)
    .where(eq(externalAgentConnections.agentId, agentId)).for("update");
  return connection;
}

export async function requireCredential(context: AgentTransaction, identity: AgentIdentity, capability: string) {
  await requireAgent(context, identity);
  const [credential] = await context.tx.select().from(agentCredentials).where(and(
    eq(agentCredentials.id, identity.credentialId), eq(agentCredentials.agentId, identity.agentId),
    isNull(agentCredentials.revokedAt),
  )).for("update");
  if (!credential || !credential.scopes.includes(capability)) throw new DelegationError("credential_denied", 403);
  return credential;
}

export async function requireHumanManagement(context: AgentTransaction, identity: HumanIdentity, agentId: string, capability: "editAgents" | "issueAgentCredentials" = "editAgents") {
  const agent = await requireAgent(context, { serverId: identity.serverId, agentId });
  const actor = await resolveActorContext(identity.serverId, "user", identity.userId, context.tx);
  if (!actor.serverRole || !userCanActOnAgentResource(actor.serverRole, identity.userId, agent, capability)) {
    throw new DelegationError("management_denied", 403);
  }
  return agent;
}

export function tokenHash(token: string): string {
  // Accept only canonical 256-bit encodings; short model-selected tokens fail.
  const isHex = /^[0-9a-f]{64}$/.test(token);
  const isBase64 = /^[A-Za-z0-9_-]{43}$/.test(token)
    && Buffer.from(token, "base64url").toString("base64url") === token;
  if (!isHex && !isBase64) throw new DelegationError("owner_token_invalid", 400);
  return createHash("sha256").update(token).digest("hex");
}
function hashMatches(stored: string, supplied: string): boolean {
  if (!/^[a-f0-9]{64}$/.test(stored)) return false;
  return timingSafeEqual(Buffer.from(stored, "hex"), Buffer.from(supplied, "hex"));
}

export async function requireCurrentExecution(context: AgentTransaction, identity: AgentIdentity, execution: ExecutionContext, capability: string) {
  await requireAgent(context, identity);
  const connection = await readConnection(context, identity.agentId);
  if (!connection || connection.serverId !== identity.serverId || connection.consumptionMode !== "delegated"
    || !connection.enabled || connection.boundCredentialId !== identity.credentialId
    || connection.epoch.toString() !== execution.epoch || connection.currentRunId !== execution.runId) {
    throw new DelegationError("execution_stale", 403);
  }
  const [run] = await context.tx.select().from(externalAgentRuns).where(eq(externalAgentRuns.id, execution.runId)).for("update");
  await requireCredential(context, identity, capability);
  const now = await databaseNow(context);
  if (!run || run.connectionId !== connection.id || run.agentId !== identity.agentId || run.credentialId !== identity.credentialId
    || run.connectionEpoch !== connection.epoch || run.fence.toString() !== execution.fence || run.state !== "active"
    || run.leaseExpiresAt <= now || run.maxEndsAt <= now || !hashMatches(run.ownerTokenHash, tokenHash(execution.ownerToken))) {
    throw new DelegationError("execution_stale", 403);
  }
  return { connection, run, now };
}

// Legacy business writers must use this in their actual commit transaction.
// Bootstrap has separate read-only methods, never a caller-supplied bypass.
export async function requireAgentBusinessAuthority(context: AgentTransaction, identity: AgentIdentity, capability: string, execution?: ExecutionContext) {
  await requireAgent(context, identity);
  const connection = await readConnection(context, identity.agentId);
  if (connection?.consumptionMode === "delegated") {
    if (!execution) throw new DelegationError("execution_required", 403);
    return requireCurrentExecution(context, identity, execution, capability);
  }
  await requireCredential(context, identity, capability);
  return { connection, run: null, now: await databaseNow(context) };
}
