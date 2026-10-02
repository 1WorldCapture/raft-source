import { and, count, desc, eq, inArray, isNull, sql } from "drizzle-orm";
import { wakeLiveStateValues } from "@botiverse/raft-shared";
import { externalAgentClaims as claims, externalAgentConnections as connections, externalAgentInboxReceipts as receipts, externalAgentRuns as runs, externalAgentWakes as wakes, productEvents } from "../db/schema.js";
import { assertAgentTransaction, databaseNow, DelegationError, type AgentTransaction, type ConnectionRow, type HumanIdentity, type RunRow } from "./agentTransactionAuthority.js";

import { recordExternalAgentRecoveryEvent, type ExternalAgentRecoveryOperation } from "./productEventsService.js";

export type WakeRow = typeof wakes.$inferSelect;
export function proxyPolicy(connection: ConnectionRow) {
  if (connection.activation.strategy !== "proxy_delegation") throw new DelegationError("strategy_unsupported", 400);
  return connection.activation.policy;
}
export function maxRunStarts(connection: ConnectionRow): number {
  const policy = proxyPolicy(connection);
  const maximum = "maxRunStartsPerCycle" in policy ? policy.maxRunStartsPerCycle : undefined;
  if (typeof maximum !== "number" || !Number.isSafeInteger(maximum) || maximum < 1) {
    throw new DelegationError("run_budget_missing", 400);
  }
  return maximum;
}
export async function currentWake(context: AgentTransaction, connection: ConnectionRow) {
  assertAgentTransaction(context, connection.agentId);
  const [wake] = await context.tx.select().from(wakes).where(and(eq(wakes.connectionId, connection.id), eq(wakes.connectionEpoch, connection.epoch)))
    .orderBy(desc(wakes.cycle)).limit(1).for("update");
  return wake;
}
export async function hasPending(context: AgentTransaction, agentId: string): Promise<boolean> {
  assertAgentTransaction(context, agentId);
  const [pending] = await context.tx.select({ id: receipts.id }).from(receipts)
    .where(and(eq(receipts.agentId, agentId), inArray(receipts.state, ["pending", "claimed"]))).limit(1);
  return !!pending;
}

export async function ensureWakeForPending(context: AgentTransaction, connection: ConnectionRow) {
  assertAgentTransaction(context, connection.agentId);
  if (!connection.enabled || connection.consumptionMode !== "delegated" || !await hasPending(context, connection.agentId)) return null;
  const existing = await currentWake(context, connection);
  // Terminal exhausted remains the authoritative cycle and blocks new input.
  if (existing && existing.state !== "settled" && existing.state !== "superseded") return existing;
  const now = await databaseNow(context);
  const [previous] = existing ? [existing] : await context.tx.select().from(wakes)
    .where(eq(wakes.connectionId, connection.id)).orderBy(desc(wakes.cycle), desc(wakes.connectionEpoch)).limit(1);
  const carryBudget = !!previous && previous.state !== "settled";
  const state = carryBudget && previous.exhaustedReason ? "exhausted" : carryBudget && previous.blockReason ? "blocked" : "queued";
  const [wake] = await context.tx.insert(wakes).values({
    connectionId: connection.id, connectionEpoch: connection.epoch, generationAtCreation: connection.pendingGeneration,
    cycle: previous ? previous.cycle + (carryBudget ? 0n : 1n) : 0n,
    attemptCount: carryBudget ? previous.attemptCount : 0,
    state, blockReason: state === "blocked" ? previous?.blockReason : null,
    exhaustedReason: state === "exhausted" ? previous?.exhaustedReason : null,
    nextAttemptAt: new Date(now.getTime() + proxyPolicy(connection).debounceMs),
  }).returning();
  return wake;
}

export async function releaseRunClaims(context: AgentTransaction, agentId: string, runId: string) {
  assertAgentTransaction(context, agentId);
  const open = await context.tx.select().from(claims).where(and(eq(claims.agentId, agentId), eq(claims.runId, runId), eq(claims.state, "open"))).for("update");
  for (const claim of open) {
    await context.tx.update(receipts).set({ state: "pending", currentClaimId: null })
      .where(and(eq(receipts.agentId, agentId), eq(receipts.currentClaimId, claim.id), eq(receipts.state, "claimed")));
    await context.tx.update(claims).set({ state: "released" }).where(and(eq(claims.id, claim.id), eq(claims.state, "open")));
  }
}
export async function endRun(context: AgentTransaction, run: RunRow, state: "blocked" | "finished" | "expired" | "revoked", outcome?: RunRow["finishOutcome"]) {
  assertAgentTransaction(context, run.agentId);
  const now = await databaseNow(context);
  await context.tx.update(runs).set({ state, finishedAt: now, finishOutcome: outcome ?? null }).where(and(eq(runs.id, run.id), eq(runs.state, "active")));
  await releaseRunClaims(context, run.agentId, run.id);
  await context.tx.update(connections).set({ currentRunId: null, updatedAt: now })
    .where(and(eq(connections.id, run.connectionId), eq(connections.currentRunId, run.id)));
}
export async function revokeConnectionExecution(context: AgentTransaction, connection: ConnectionRow) {
  assertAgentTransaction(context, connection.agentId);
  const active = await context.tx.select().from(runs).where(and(eq(runs.connectionId, connection.id), eq(runs.state, "active"))).for("update");
  for (const run of active) await endRun(context, run, "revoked");
  await context.tx.update(wakes).set({ state: "superseded", dispatchOwner: null, dispatchLeaseUntil: null })
    .where(and(eq(wakes.connectionId, connection.id), inArray(wakes.state, [...wakeLiveStateValues])));
}
export async function countRunStarts(context: AgentTransaction, wakeId: string): Promise<number> {
  const [wake] = await context.tx.select().from(wakes).where(eq(wakes.id, wakeId)).limit(1);
  if (!wake) throw new DelegationError("wake_missing", 404);
  // A pause/configuration epoch does not implicitly reset a retry cycle.
  const [row] = await context.tx.select({ total: count() }).from(runs).innerJoin(wakes, eq(wakes.id, runs.wakeId))
    .where(and(eq(wakes.connectionId, wake.connectionId), eq(wakes.cycle, wake.cycle)));
  return Number(row.total);
}
export async function queueOrExhaust(context: AgentTransaction, connection: ConnectionRow, wake: WakeRow) {
  assertAgentTransaction(context, connection.agentId);
  const now = await databaseNow(context);
  const pending = await hasPending(context, connection.agentId);
  const exhausted = pending && (wake.attemptCount >= proxyPolicy(connection).maxDeliveryAttempts || await countRunStarts(context, wake.id) >= maxRunStarts(connection));
  const state = !pending ? "settled" : exhausted ? "exhausted" : "queued";
  const [updated] = await context.tx.update(wakes).set({
    state, exhaustedReason: exhausted ? "retry_budget_exhausted" : null,
    dispatchOwner: null, dispatchLeaseUntil: null, startupDeadline: null,
    nextAttemptAt: new Date(now.getTime() + proxyPolicy(connection).debounceMs),
  }).where(and(eq(wakes.id, wake.id), eq(wakes.connectionEpoch, connection.epoch))).returning();
  return updated;
}

export async function recoveryReplay(context: AgentTransaction, connection: ConnectionRow, identity: HumanIdentity, operation: ExternalAgentRecoveryOperation, requestKey: string, requestRevision: number) {
  assertAgentTransaction(context, connection.agentId);
  if (!requestKey || requestKey.length > 200) throw new DelegationError("request_key_invalid", 400);
  const [event] = await context.tx.select().from(productEvents).where(and(
    eq(productEvents.subjectType, "external_agent_connection"), eq(productEvents.subjectId, connection.id),
    eq(productEvents.eventType, `external_agent.${operation}`), eq(productEvents.idempotencyKey, requestKey),
  )).limit(1);
  if (!event) return null;
  const metadata = event.metadata as { serverId?: unknown; agentId?: unknown; requestRevision?: unknown };
  if (event.actorType !== "human" || event.actorId !== identity.userId || metadata.serverId !== identity.serverId
    || metadata.agentId !== connection.agentId || metadata.requestRevision !== requestRevision) throw new DelegationError("recovery_conflict");
  return event;
}
export async function recordRecovery(context: AgentTransaction, connection: ConnectionRow, identity: HumanIdentity, operation: ExternalAgentRecoveryOperation, requestKey: string, requestRevision: number, previousWakeId?: string, cutoverProof?: "same_transaction_new_agent" | "durable_receipts") {
  const replay = await recoveryReplay(context, connection, identity, operation, requestKey, requestRevision);
  if (replay) return replay;
  return recordExternalAgentRecoveryEvent(context.tx, {
    connectionId: connection.id, serverId: connection.serverId, agentId: connection.agentId,
    userId: identity.userId, operation, requestKey, requestRevision,
    epoch: connection.epoch.toString(), revision: connection.revision, previousWakeId: previousWakeId ?? null,
    cutoverManifest: cutoverProof ? { version: 1, proof: cutoverProof, legacyCandidateIds: [] } : null,
  });
}
