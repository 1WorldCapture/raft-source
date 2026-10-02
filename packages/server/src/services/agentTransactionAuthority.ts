import { isExternalAgentRuntime } from "@botiverse/raft-shared";
import { createHash, timingSafeEqual } from "node:crypto";
import { and, eq, isNull, sql } from "drizzle-orm";
import { z } from "zod";
import { getDb, type Database, type DatabaseTransaction } from "../db/index.js";
import { agents, agentCredentials, externalAgentConnections, externalAgentRuns, serverAgentMembers, serverMembers } from "../db/schema.js";
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
const liveTransactions = new WeakMap<AgentTransaction, ReadonlySet<string>>();
const transactionContexts = new WeakMap<object, AgentTransaction>();
// Database UUIDs may predate RFC version/variant validation; canonical text still uniquely identifies each gate.
const uuid = z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);

export function assertAgentTransaction(context: AgentTransaction, agentId: string): void {
  if (!liveTransactions.has(context) || !liveTransactions.get(context)!.has(agentId.toLowerCase())) {
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
  return db.transaction(async (tx) => {
    await tx.execute(sql`SELECT set_config('lock_timeout', '5s', true), set_config('statement_timeout', '10s', true)`);
    // Acquire every stable Agent gate before any connection or business row.
    for (const id of ordered) await tx.execute(sql`SELECT pg_advisory_xact_lock(${agentAuthorityLockKey(id)})`);
    const context: AgentTransaction = Object.freeze({ tx, agentIds: new Set(ordered) });
    liveTransactions.set(context, new Set(ordered));
    transactionContexts.set(tx, context);
    try { return await work(context); } finally {
      liveTransactions.delete(context);
      transactionContexts.delete(tx);
    }
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
  )).limit(1).for("share");
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
  const [membership] = await context.tx.select({ id: serverAgentMembers.agentId }).from(serverAgentMembers)
    .where(and(eq(serverAgentMembers.serverId, identity.serverId), eq(serverAgentMembers.agentId, identity.agentId))).limit(1).for("share");
  if (!membership) throw new DelegationError("credential_denied", 403);
  const [credential] = await context.tx.select().from(agentCredentials).where(and(
    eq(agentCredentials.id, identity.credentialId), eq(agentCredentials.agentId, identity.agentId),
    isNull(agentCredentials.revokedAt),
  )).for("update");
  if (!credential || !credential.scopes.includes(capability)) throw new DelegationError("credential_denied", 403);
  return credential;
}

export async function requireHumanManagement(context: AgentTransaction, identity: HumanIdentity, agentId: string, capability: "editAgents" | "issueAgentCredentials" = "editAgents") {
  const agent = await requireAgent(context, { serverId: identity.serverId, agentId });
  await context.tx.select({ role: serverMembers.role }).from(serverMembers)
    .where(and(eq(serverMembers.serverId, identity.serverId), eq(serverMembers.userId, identity.userId))).for("share");
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
export function hashMatches(stored: string, supplied: string): boolean {
  if (!/^[a-f0-9]{64}$/.test(stored)) return false;
  return timingSafeEqual(Buffer.from(stored, "hex"), Buffer.from(supplied, "hex"));
}

export async function requireOwnedRun(context: AgentTransaction, identity: AgentIdentity, execution: ExecutionContext, capability: string) {
  const agent = await requireAgent(context, identity);
  if (!isExternalAgentRuntime(agent.runtime) || agent.machineId) throw new DelegationError("execution_stale", 403);
  const connection = await readConnection(context, identity.agentId);
  if (!connection || connection.serverId !== identity.serverId || connection.consumptionMode !== "delegated"
    || !connection.enabled || connection.boundCredentialId !== identity.credentialId
    || connection.epoch.toString() !== execution.epoch) {
    throw new DelegationError("execution_stale", 403);
  }
  const [run] = await context.tx.select().from(externalAgentRuns).where(eq(externalAgentRuns.id, execution.runId)).for("update");
  await requireCredential(context, identity, capability);
  const now = await databaseNow(context);
  if (!run || run.connectionId !== connection.id || run.agentId !== identity.agentId || run.credentialId !== identity.credentialId
    || run.connectionEpoch !== connection.epoch || run.fence.toString() !== execution.fence || !hashMatches(run.ownerTokenHash, tokenHash(execution.ownerToken))) {
    throw new DelegationError("execution_stale", 403);
  }
  return { connection, run, now };
}

export async function requireCurrentExecution(context: AgentTransaction, identity: AgentIdentity, execution: ExecutionContext, capability: string) {
  const owned = await requireOwnedRun(context, identity, execution, capability);
  if (owned.connection.currentRunId !== owned.run.id || owned.run.state !== "active"
    || owned.run.leaseExpiresAt <= owned.now || owned.run.maxEndsAt <= owned.now) {
    throw new DelegationError("execution_stale", 403);
  }
  return owned;
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

export async function requireLegacyAgentActor(context: AgentTransaction, agentId: string) {
  assertAgentTransaction(context, agentId);
  if ((await readConnection(context, agentId))?.consumptionMode === "delegated") {
    throw new DelegationError("delegated_legacy_writer_unsupported", 403);
  }
}

export function agentTransactionForExecutor(executor: object): AgentTransaction | undefined {
  const context = transactionContexts.get(executor);
  return context && liveTransactions.has(context) ? context : undefined;
}

export class AgentGatePlanConflict extends Error {
  readonly agentIds: readonly string[];
  constructor(ids: readonly string[]) {
    super("agent_source_plan_changed");
    this.name = "AgentGatePlanConflict";
    this.agentIds = ids.map((id) => uuid.parse(id).toLowerCase());
  }
}
export function requireSourceAgentPlan(executor: object, agentIds: readonly string[]): AgentTransaction {
  const context = agentTransactionForExecutor(executor);
  if (!context) throw new DelegationError("source_transaction_required", 500);
  const gates = liveTransactions.get(context)!;
  const missing = agentIds.filter((id) => !gates.has(id.toLowerCase()));
  if (missing.length) throw new AgentGatePlanConflict(missing);
  return context;
}

// A changed audience aborts the entire source transaction. Replanning never
// acquires an additional gate while holding business rows from the old plan.
export async function withExpandingAgentTransaction<T>(initialAgentIds: readonly string[], work: (context: AgentTransaction) => Promise<T>, db: Database = getDb()): Promise<T> {
  const plan = new Set(initialAgentIds);
  for (let attempt = 0; attempt < 3; attempt++) {
    try { return await withAgentTransaction([...plan], work, db); }
    catch (error) {
      if (!(error instanceof AgentGatePlanConflict)) throw error;
      for (const id of error.agentIds) plan.add(id);
    }
  }
  throw new DelegationError("source_audience_conflict", 409);
}

export type AgentOperationAuthority = { identity: AgentIdentity; execution: ExecutionContext; permissionChannelId?: string };
export async function requireAgentOperation(context: AgentTransaction, agentId: string, capability: string, authority?: AgentOperationAuthority) {
  if (!authority) return requireLegacyAgentActor(context, agentId);
  if (authority.identity.agentId !== agentId) throw new DelegationError("acting_agent_mismatch", 403);
  return requireAgentBusinessAuthority(context, authority.identity, capability, authority.execution);
}


export async function requireAgentMessageTarget(context: AgentTransaction, storageChannelId: string, permissionChannelId: string, authority: AgentOperationAuthority) {
  assertAgentTransaction(context, authority.identity.agentId);
  const { getChannel, getJointThreadProjectionByLocalThread, resolveChannelAccess, canAgentPostToChannel, isChannelArchived } = await import("./channelService.js");
  const local = await getChannel(permissionChannelId, { executor: context.tx });
  if (!local || local.serverId !== authority.identity.serverId) throw new DelegationError("message_target_denied", 403);
  const resolution = await resolveChannelAccess({ serverId: authority.identity.serverId, channelId: permissionChannelId, executor: context.tx });
  const threadProjection = local.type === "thread" ? await getJointThreadProjectionByLocalThread(permissionChannelId, authority.identity.serverId, context.tx) : null;
  const canonicalId = threadProjection?.canonicalThreadChannelId ?? resolution?.canonicalChannelId;
  if (canonicalId !== storageChannelId || await isChannelArchived(permissionChannelId, context.tx)
    || !await canAgentPostToChannel(permissionChannelId, authority.identity.agentId, context.tx)) throw new DelegationError("message_target_denied", 403);
}
