import { createHash } from "node:crypto";
import { and, asc, count, eq, gte, isNull } from "drizzle-orm";
import { runDtoSchema, wakePayloadSchema, type RunFinishOutcome } from "@botiverse/raft-shared";
import { getDb, type Database } from "../db/index.js";
import { agentCredentials, externalAgentClaims as claims, externalAgentConnections as connections, externalAgentRuns as runs, externalAgentWakeAttempts as attempts, externalAgentWakes as wakes } from "../db/schema.js";
import { databaseNow, DelegationError, readConnection, requireAgent, requireCredential, requireCurrentExecution, requireOwnedRun, hashMatches, tokenHash, withAgentTransaction, type AgentIdentity, type ExecutionContext, type RunRow } from "./agentTransactionAuthority.js";
import { countRunStarts, currentWake, endRun, ensureWakeForPending, maxRunStarts, proxyPolicy, queueOrExhaust } from "./externalAgentDelegationState.js";

import { classifyDispatchResult, DISPATCH_LEASE_MS } from "./externalAgentDispatchPolicy.js";

export function runDto(row: RunRow) {
  return runDtoSchema.parse({ id: row.id, connectionId: row.connectionId, connectionEpoch: row.connectionEpoch.toString(), agentId: row.agentId,
    credentialId: row.credentialId, wakeId: row.wakeId, fence: row.fence.toString(), beginRequestKey: row.beginRequestKey, beginRequestDigest: row.beginRequestDigest,
    state: row.state, leaseExpiresAt: row.leaseExpiresAt.toISOString(), maxEndsAt: row.maxEndsAt.toISOString(), lastHeartbeatAt: row.lastHeartbeatAt.toISOString(),
    finishedAt: row.finishedAt?.toISOString() ?? null, finishOutcome: row.finishOutcome });
}
function requestKey(key: string) {
  if (!key || key.length > 200) throw new DelegationError("request_key_invalid", 400);
  return key;
}

export class ExternalAgentDelegationService {
  constructor(private readonly db: Database = getDb()) {}

  async beginRun(identity: AgentIdentity, input: { wakeId: string; attemptId: string; epoch: string; beginRequestKey: string; ownerToken: string }) {
    const hash = tokenHash(input.ownerToken);
    requestKey(input.beginRequestKey);
    const digest = createHash("sha256").update(JSON.stringify([identity.serverId, identity.agentId, identity.credentialId, input.wakeId, input.attemptId, input.epoch, input.beginRequestKey, hash])).digest("hex");
    return withAgentTransaction([identity.agentId], async (context) => {
      await requireAgent(context, identity);
      const connection = await readConnection(context, identity.agentId);
      if (!connection || !connection.enabled || connection.consumptionMode !== "delegated" || connection.boundCredentialId !== identity.credentialId || connection.epoch.toString() !== input.epoch) throw new DelegationError("binding_stale", 403);
      const [replay] = await context.tx.select().from(runs).where(and(eq(runs.connectionId, connection.id), eq(runs.connectionEpoch, connection.epoch), eq(runs.beginRequestKey, input.beginRequestKey))).for("update");
      await requireCredential(context, identity, "read");
      if (replay) {
        if (!hashMatches(replay.beginRequestDigest, digest) || !hashMatches(replay.ownerTokenHash, hash)) throw new DelegationError("begin_conflict");
        // Replay never renews or revives authority; expired/blocked rows stay so.
        const now = await databaseNow(context);
        if (replay.state === "active" && (replay.leaseExpiresAt <= now || replay.maxEndsAt <= now)) {
          await endRun(context, replay, "expired");
          const current = await currentWake(context, connection);
          if (current?.id === replay.wakeId && current.state === "active") await queueOrExhaust(context, connection, current);
          const [expired] = await context.tx.select().from(runs).where(eq(runs.id, replay.id));
          return { kind: "replayed" as const, run: runDto(expired) };
        }
        return { kind: "replayed" as const, run: runDto(replay) };
      }
      const wake = await currentWake(context, connection);
      const [attempt] = await context.tx.select().from(attempts).where(eq(attempts.id, input.attemptId)).limit(1);
      if (!wake || wake.id !== input.wakeId || ["blocked", "settled", "superseded", "exhausted"].includes(wake.state)
        || !attempt || attempt.wakeId !== wake.id || attempt.connectionEpoch !== connection.epoch) throw new DelegationError("wake_stale", 403);
      const now = await databaseNow(context);
      if (connection.currentRunId) {
        const [current] = await context.tx.select().from(runs).where(eq(runs.id, connection.currentRunId)).for("update");
        if (current?.state === "active" && current.leaseExpiresAt > now && current.maxEndsAt > now) throw new DelegationError("run_busy");
        if (current?.state === "active") await endRun(context, current, "expired");
      }
      if (await countRunStarts(context, wake.id) >= maxRunStarts(connection)) {
        await context.tx.update(wakes).set({ state: "exhausted", exhaustedReason: "run_budget_exhausted", dispatchOwner: null, dispatchLeaseUntil: null }).where(eq(wakes.id, wake.id));
        return { kind: "denied" as const, code: "run_budget_exhausted" };
      }
      const policy = proxyPolicy(connection);
      const maxEndsAt = new Date(now.getTime() + policy.maxRunDurationMs);
      const [run] = await context.tx.insert(runs).values({ connectionId: connection.id, connectionEpoch: connection.epoch, agentId: identity.agentId,
        credentialId: identity.credentialId, wakeId: wake.id, fence: connection.nextFence + 1n, beginRequestKey: input.beginRequestKey,
        beginRequestDigest: digest, ownerTokenHash: hash, maxEndsAt, leaseExpiresAt: new Date(Math.min(maxEndsAt.getTime(), now.getTime() + policy.leaseTtlMs)), lastHeartbeatAt: now }).returning();
      await context.tx.update(connections).set({ currentRunId: run.id, nextFence: run.fence, updatedAt: now }).where(eq(connections.id, connection.id));
      await context.tx.update(wakes).set({ state: "active" }).where(eq(wakes.id, wake.id));
      return { kind: "started" as const, run: runDto(run) };
    }, this.db);
  }

  async heartbeatRun(identity: AgentIdentity, execution: ExecutionContext) {
    return withAgentTransaction([identity.agentId], async (context) => {
      const { connection, run, now } = await requireCurrentExecution(context, identity, execution, "read");
      const leaseExpiresAt = new Date(Math.min(run.maxEndsAt.getTime(), now.getTime() + proxyPolicy(connection).leaseTtlMs));
      await requireCurrentExecution(context, identity, execution, "read");
      const [updated] = await context.tx.update(runs).set({ leaseExpiresAt, lastHeartbeatAt: now }).where(eq(runs.id, run.id)).returning();
      await context.tx.update(claims).set({ expiresAt: leaseExpiresAt }).where(and(eq(claims.runId, run.id), eq(claims.state, "open")));
      return runDto(updated);
    }, this.db);
  }

  async blockRun(identity: AgentIdentity, execution: ExecutionContext, reasonCode: string) {
    if (!/^[a-z][a-z0-9_]{0,79}$/.test(reasonCode)) throw new DelegationError("block_reason_invalid", 400);
    return withAgentTransaction([identity.agentId], async (context) => {
      const owned = await requireOwnedRun(context, identity, execution, "read");
      if (owned.run.state === "blocked") {
        const wake = await currentWake(context, owned.connection);
        if (wake?.id !== owned.run.wakeId || wake.state !== "blocked" || wake.blockReason !== reasonCode) throw new DelegationError("finish_conflict");
        return runDto(owned.run);
      }
      const { connection, run } = await requireCurrentExecution(context, identity, execution, "read");
      await requireCurrentExecution(context, identity, execution, "read");
      await endRun(context, run, "blocked", "waiting_user");
      await context.tx.update(wakes).set({ state: "blocked", blockReason: reasonCode, dispatchOwner: null, dispatchLeaseUntil: null }).where(and(eq(wakes.id, run.wakeId), eq(wakes.connectionEpoch, connection.epoch)));
      await context.tx.update(connections).set({ pauseReason: reasonCode }).where(eq(connections.id, connection.id));
      const [updated] = await context.tx.select().from(runs).where(eq(runs.id, run.id));
      return runDto(updated);
    }, this.db);
  }

  async finishRun(identity: AgentIdentity, execution: ExecutionContext, outcome: RunFinishOutcome) {
    if (outcome === "waiting_user") return this.blockRun(identity, execution, "waiting_user");
    if (!["drained", "yielded", "failed"].includes(outcome)) throw new DelegationError("finish_outcome_invalid", 400);
    return withAgentTransaction([identity.agentId], async (context) => {
      const owned = await requireOwnedRun(context, identity, execution, "read");
      if (owned.run.state === "finished") {
        if (owned.run.finishOutcome !== outcome) throw new DelegationError("finish_conflict");
        return runDto(owned.run);
      }
      const { connection, run } = await requireCurrentExecution(context, identity, execution, "read");
      const wake = await currentWake(context, connection);
      if (!wake || wake.id !== run.wakeId) throw new DelegationError("wake_stale", 403);
      await requireCurrentExecution(context, identity, execution, "read");
      await endRun(context, run, "finished", outcome);
      await queueOrExhaust(context, connection, wake);
      const [updated] = await context.tx.select().from(runs).where(eq(runs.id, run.id));
      return runDto(updated);
    }, this.db);
  }

  // Server-only recovery entry point. Never exposed as an Agent bypass flag.
  async reconcileConnection(serverId: string, agentId: string) {
    return withAgentTransaction([agentId], async (context) => {
      await requireAgent(context, { serverId, agentId });
      const connection = await readConnection(context, agentId);
      if (!connection) return null;
      const now = await databaseNow(context);
      const wake = await currentWake(context, connection);
      if (connection.currentRunId) {
        const [run] = await context.tx.select().from(runs).where(eq(runs.id, connection.currentRunId)).for("update");
        const [credential] = connection.boundCredentialId ? await context.tx.select().from(agentCredentials).where(eq(agentCredentials.id, connection.boundCredentialId)).for("update") : [];
        if (run?.state === "active") {
          if (connection.enabled && credential && !credential.revokedAt && run.credentialId === credential.id && run.leaseExpiresAt > now && run.maxEndsAt > now) return wake ?? null;
          await endRun(context, run, credential?.revokedAt || !connection.enabled ? "revoked" : "expired");
          if (wake?.id === run.wakeId && connection.enabled) return queueOrExhaust(context, connection, wake);
        }
      }
      if (!connection.enabled || connection.consumptionMode !== "delegated" || !wake || ["blocked", "exhausted", "settled", "superseded"].includes(wake.state)) return wake ?? null;
      if (wake.state === "active" && !connection.currentRunId) return queueOrExhaust(context, connection, wake);
      if (wake.state === "dispatching" && wake.dispatchLeaseUntil && wake.dispatchLeaseUntil <= now) {
        await context.tx.update(attempts).set({ outcome: "unknown", errorCode: "dispatch_lease_expired", finishedAt: now }).where(and(eq(attempts.wakeId, wake.id), eq(attempts.dispatchFence, wake.dispatchFence), isNull(attempts.finishedAt)));
        const [updated] = await context.tx.update(wakes).set({ state: "awaiting_agent", dispatchOwner: null, dispatchLeaseUntil: null }).where(eq(wakes.id, wake.id)).returning();
        return updated;
      }
      if (wake.state === "awaiting_agent" && wake.startupDeadline && wake.startupDeadline <= now && wake.nextAttemptAt <= now) return queueOrExhaust(context, connection, wake);
      return wake;
    }, this.db);
  }

  async reserveDispatch(serverId: string, agentId: string, dispatchOwner: string) {
    if (!/^[a-zA-Z0-9_-]{1,100}$/.test(dispatchOwner)) throw new DelegationError("dispatch_owner_invalid", 400);
    return withAgentTransaction([agentId], async (context) => {
      await requireAgent(context, { serverId, agentId });
      const connection = await readConnection(context, agentId);
      if (!connection || !connection.enabled || connection.consumptionMode !== "delegated" || !connection.boundCredentialId) return null;
      await requireCredential(context, { serverId, agentId, credentialId: connection.boundCredentialId }, "read");
      const wake = await ensureWakeForPending(context, connection);
      const now = await databaseNow(context);
      if (!wake || wake.state !== "queued" || wake.nextAttemptAt > now || connection.currentRunId) return null;
      if (wake.attemptCount >= proxyPolicy(connection).maxDeliveryAttempts || await countRunStarts(context, wake.id) >= maxRunStarts(connection)) {
        await context.tx.update(wakes).set({ state: "exhausted", exhaustedReason: "retry_budget_exhausted" }).where(eq(wakes.id, wake.id));
        return null;
      }
      const [rate] = await context.tx.select({ total: count() }).from(attempts).innerJoin(wakes, eq(wakes.id, attempts.wakeId))
        .where(and(eq(wakes.connectionId, connection.id), gte(attempts.startedAt, new Date(now.getTime() - 3600000))));
      if (rate.total >= proxyPolicy(connection).maxWakesPerHour) {
        const [oldest] = await context.tx.select({ startedAt: attempts.startedAt }).from(attempts).innerJoin(wakes, eq(wakes.id, attempts.wakeId))
          .where(and(eq(wakes.connectionId, connection.id), gte(attempts.startedAt, new Date(now.getTime() - 3600000)))).orderBy(asc(attempts.startedAt)).limit(1);
        await context.tx.update(wakes).set({ nextAttemptAt: new Date(oldest.startedAt.getTime() + 3600001) }).where(eq(wakes.id, wake.id));
        return null;
      }
      const [attempt] = await context.tx.insert(attempts).values({ wakeId: wake.id, attemptNumber: wake.attemptCount + 1,
        connectionRevision: connection.revision, connectionEpoch: connection.epoch, dispatchFence: wake.dispatchFence + 1n,
        requestDigest: "reserved", startedAt: now }).returning();
      const payload = wakePayloadSchema.parse({ schema: "raft.external-agent.wake.v1", kind: "wake", wakeId: wake.id, attemptId: attempt.id, connectionEpoch: connection.epoch.toString(), occurredAt: now.toISOString() });
      const requestDigest = createHash("sha256").update(JSON.stringify(payload)).digest("hex");
      await context.tx.update(attempts).set({ requestDigest }).where(eq(attempts.id, attempt.id));
      await context.tx.update(wakes).set({ state: "dispatching", attemptCount: attempt.attemptNumber, dispatchOwner,
        dispatchFence: attempt.dispatchFence, dispatchLeaseUntil: new Date(now.getTime() + DISPATCH_LEASE_MS), startupDeadline: new Date(now.getTime() + proxyPolicy(connection).startupTimeoutMs) }).where(eq(wakes.id, wake.id));
      return { payload, attemptId: attempt.id, dispatchFence: attempt.dispatchFence.toString(), dispatchOwner, attemptNumber: attempt.attemptNumber };
    }, this.db);
  }

  async completeDispatch(serverId: string, agentId: string, reservation: { attemptId: string; dispatchOwner: string; dispatchFence: string; attemptNumber: number }, result: unknown, jitterUnit = Math.random()) {
    const decision = classifyDispatchResult(result, reservation.attemptNumber, jitterUnit);
    return this.finishDispatchAttempt(serverId, agentId, { ...reservation, ...decision });
  }

  async finishDispatchAttempt(serverId: string, agentId: string, input: { attemptId: string; dispatchOwner: string; dispatchFence: string; outcome: "accepted" | "rejected" | "unknown"; httpStatus?: number; errorCode?: string; retryDelayMs?: number; blockReason?: string }) {
    if (input.retryDelayMs !== undefined && (!Number.isSafeInteger(input.retryDelayMs) || input.retryDelayMs < 0 || input.retryDelayMs > 300000)) throw new DelegationError("dispatch_delay_invalid", 400);
    if (input.blockReason && !["provider_auth_rejected", "provider_endpoint_unavailable"].includes(input.blockReason)) throw new DelegationError("dispatch_block_invalid", 400);
    if (input.errorCode && !/^[a-z][a-z0-9_]{0,79}$/.test(input.errorCode)) throw new DelegationError("dispatch_error_invalid", 400);
    if (!["accepted", "rejected", "unknown"].includes(input.outcome) || (input.httpStatus !== undefined && (!Number.isInteger(input.httpStatus) || input.httpStatus < 100 || input.httpStatus > 599))) throw new DelegationError("dispatch_result_invalid", 400);
    return withAgentTransaction([agentId], async (context) => {
      await requireAgent(context, { serverId, agentId });
      const connection = await readConnection(context, agentId);
      if (!connection) throw new DelegationError("connection_missing", 404);
      const [attempt] = await context.tx.select().from(attempts).where(eq(attempts.id, input.attemptId)).for("update");
      const [wake] = attempt ? await context.tx.select().from(wakes).where(eq(wakes.id, attempt.wakeId)).for("update") : [];
      if (!attempt || !wake || wake.connectionId !== connection.id || attempt.dispatchFence.toString() !== input.dispatchFence) throw new DelegationError("attempt_stale", 403);
      if (attempt.finishedAt) return { recorded: false };
      const now = await databaseNow(context);
      await context.tx.update(attempts).set({ outcome: input.outcome, finishedAt: now, httpStatus: input.httpStatus ?? null, errorCode: input.errorCode ?? null, providerRunId: null }).where(eq(attempts.id, attempt.id));
      // Record late transport facts without downgrading an already active run.
      if (wake.connectionEpoch === connection.epoch && wake.state === "dispatching" && wake.dispatchFence === attempt.dispatchFence && wake.dispatchOwner === input.dispatchOwner && wake.dispatchLeaseUntil && wake.dispatchLeaseUntil > now) {
        if (input.blockReason) {
          await context.tx.update(wakes).set({ state: "blocked", blockReason: input.blockReason, dispatchOwner: null, dispatchLeaseUntil: null }).where(eq(wakes.id, wake.id));
          await context.tx.update(connections).set({ pauseReason: input.blockReason, updatedAt: now }).where(eq(connections.id, connection.id));
        } else if (input.outcome === "rejected") {
          const updated = await queueOrExhaust(context, connection, wake);
          if (updated.state === "queued") await context.tx.update(wakes).set({ nextAttemptAt: new Date(now.getTime() + Math.max(proxyPolicy(connection).debounceMs, input.retryDelayMs ?? 0)) }).where(eq(wakes.id, wake.id));
        } else await context.tx.update(wakes).set({ state: "awaiting_agent", dispatchOwner: null, dispatchLeaseUntil: null,
          nextAttemptAt: new Date(now.getTime() + (input.retryDelayMs ?? 0)) }).where(eq(wakes.id, wake.id));
      }
      return { recorded: true };
    }, this.db);
  }
}
