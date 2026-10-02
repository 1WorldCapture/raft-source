import { and, asc, eq, inArray, isNull } from "drizzle-orm";
import { z } from "zod";
import { claimDtoSchema, EXTERNAL_AGENT_CLAIM_MAX_RECEIPTS, inboxReceiptDtoSchema, type InboxAckDisposition } from "@botiverse/raft-shared";
import { getDb, type Database } from "../db/index.js";
import { channelAgents, channels, externalAgentClaims as claims, externalAgentConnections as connections, externalAgentInboxReceipts as receipts, inboxNotificationFacts as facts, messages, productEvents, serverAgentMembers, tasks } from "../db/schema.js";
import { assertAgentTransaction, databaseNow, DelegationError, readConnection, requireAgent, requireCurrentExecution, requireHumanManagement, withAgentTransaction, type AgentIdentity, type AgentTransaction, type ExecutionContext, type HumanIdentity } from "./agentTransactionAuthority.js";
import { ensureWakeForPending } from "./externalAgentDelegationState.js";

type ReceiptRow = typeof receipts.$inferSelect;
function receiptDto(row: ReceiptRow) {
  return inboxReceiptDtoSchema.parse({ ...row, admittedGeneration: row.admittedGeneration.toString(), createdAt: row.createdAt.toISOString(), ackedAt: row.ackedAt?.toISOString() ?? null });
}
function claimDto(row: typeof claims.$inferSelect) {
  return claimDtoSchema.parse({ ...row, connectionEpoch: row.connectionEpoch.toString(), fence: row.fence.toString(), expiresAt: row.expiresAt.toISOString(), createdAt: row.createdAt.toISOString() });
}

// The producer supplies an existing canonical notification fact, not arbitrary
// client IDs, model-generated eligibility, or reconstructed read cursors.
export async function admitNotificationFact(context: AgentTransaction, serverId: string, agentId: string, factId: string) {
  await requireAgent(context, { serverId, agentId });
  const connection = await readConnection(context, agentId);
  if (!connection || connection.consumptionMode !== "delegated") return null;
  const [fact] = await context.tx.select().from(facts).where(and(eq(facts.id, factId), eq(facts.receiverType, "agent"), eq(facts.receiverId, agentId), eq(facts.serverId, serverId), eq(facts.unreadEligible, true))).limit(1);
  if (!fact) throw new DelegationError("source_not_eligible", 400);
  const key = `notification:${fact.id}`;
  const [existing] = await context.tx.select().from(receipts).where(and(eq(receipts.agentId, agentId), eq(receipts.sourceEventKey, key))).limit(1);
  if (existing) return receiptDto(existing);
  const now = await databaseNow(context);
  const [connectionAfter] = await context.tx.update(connections).set({ pendingGeneration: connection.pendingGeneration + 1n, updatedAt: now }).where(eq(connections.id, connection.id)).returning();
  const [receipt] = await context.tx.insert(receipts).values({ serverId, agentId, source: { kind: "message", messageId: fact.messageId, occurrenceKey: fact.id }, sourceEventKey: key, admittedGeneration: connectionAfter.pendingGeneration, createdAt: now }).returning();
  await ensureWakeForPending(context, connectionAfter);
  return receiptDto(receipt);
}

async function sourceStillApplicable(context: AgentTransaction, receipt: ReceiptRow): Promise<string | null> {
  assertAgentTransaction(context, receipt.agentId);
  if (receipt.source.kind !== "message") return "source_unsupported";
  const [fact] = await context.tx.select().from(facts).where(and(eq(facts.id, receipt.source.occurrenceKey), eq(facts.messageId, receipt.source.messageId), eq(facts.receiverType, "agent"), eq(facts.receiverId, receipt.agentId), eq(facts.serverId, receipt.serverId), eq(facts.unreadEligible, true))).limit(1);
  if (!fact) return "source_removed";
  const [message] = await context.tx.select({ id: messages.id }).from(messages).where(eq(messages.id, fact.messageId)).limit(1);
  if (!message) return "source_removed";
  const [member] = await context.tx.select().from(serverAgentMembers).where(and(eq(serverAgentMembers.agentId, receipt.agentId), eq(serverAgentMembers.serverId, receipt.serverId))).limit(1);
  if (!member) return "permission_revoked";
  let channelId = fact.sourceChannelId;
  for (let depth = 0; depth < 8; depth++) {
    const [channel] = await context.tx.select().from(channels).where(and(eq(channels.id, channelId), eq(channels.serverId, receipt.serverId), isNull(channels.deletedAt))).limit(1);
    if (!channel) return "permission_revoked";
    // Joint projection authority must be wired to the canonical resolver,
    // never approximated using a local membership or a body-supplied parent.
    if (channel.type === "joint") return "source_unsupported";
    if (channel.type === "thread" && channel.parentMessageId) {
      const [parent] = await context.tx.select({ channelId: messages.channelId }).from(messages).where(eq(messages.id, channel.parentMessageId)).limit(1);
      if (!parent) return "source_removed";
      channelId = parent.channelId;
      continue;
    }
    const [membership] = await context.tx.select().from(channelAgents).where(and(eq(channelAgents.channelId, channel.id), eq(channelAgents.agentId, receipt.agentId))).limit(1);
    if (membership || (channel.type === "channel" && fact.personalMention)) return null;
    return "permission_revoked";
  }
  return "source_unsupported";
}

export class ExternalAgentInboxReceiptService {
  constructor(private readonly db: Database = getDb()) {}

  async claimBatch(identity: AgentIdentity, execution: ExecutionContext, requestKey: string, limit = EXTERNAL_AGENT_CLAIM_MAX_RECEIPTS) {
    if (!requestKey || requestKey.length > 200 || !Number.isInteger(limit) || limit < 1 || limit > EXTERNAL_AGENT_CLAIM_MAX_RECEIPTS) throw new DelegationError("claim_request_invalid", 400);
    return withAgentTransaction([identity.agentId], async (context) => {
      const { connection, run } = await requireCurrentExecution(context, identity, execution, "read");
      const [replay] = await context.tx.select().from(claims).where(and(eq(claims.runId, run.id), eq(claims.requestKey, requestKey))).for("update");
      if (replay) return this.batch(context, replay);
      const [open] = await context.tx.select().from(claims).where(and(eq(claims.runId, run.id), eq(claims.state, "open"))).for("update");
      if (open) throw new DelegationError("claim_busy");
      const pending = await context.tx.select().from(receipts).where(and(eq(receipts.agentId, identity.agentId), eq(receipts.state, "pending"))).orderBy(asc(receipts.createdAt), asc(receipts.id)).limit(limit).for("update");
      const eligible: ReceiptRow[] = [];
      for (const receipt of pending) {
        const reason = await sourceStillApplicable(context, receipt);
        if (reason) await context.tx.update(receipts).set({ state: "suppressed", suppressReason: reason, currentClaimId: null }).where(and(eq(receipts.id, receipt.id), eq(receipts.state, "pending")));
        else eligible.push(receipt);
      }
      const { now } = await requireCurrentExecution(context, identity, execution, "read");
      const [claim] = await context.tx.insert(claims).values({ serverId: identity.serverId, agentId: identity.agentId, connectionEpoch: connection.epoch, runId: run.id, fence: run.fence,
        requestKey, receiptIds: eligible.map((r) => r.id), state: eligible.length ? "open" : "acked", expiresAt: new Date(Math.min(run.leaseExpiresAt.getTime(), run.maxEndsAt.getTime())), createdAt: now }).returning();
      if (eligible.length) await context.tx.update(receipts).set({ state: "claimed", currentClaimId: claim.id }).where(and(inArray(receipts.id, eligible.map((r) => r.id)), eq(receipts.state, "pending")));
      return this.batch(context, claim);
    }, this.db);
  }

  private async batch(context: AgentTransaction, claim: typeof claims.$inferSelect) {
    const rows = claim.receiptIds.length ? await context.tx.select().from(receipts).where(and(eq(receipts.agentId, claim.agentId), inArray(receipts.id, claim.receiptIds))) : [];
    const byId = new Map(rows.map((row) => [row.id, row]));
    return { claim: claimDto(claim), receipts: claim.receiptIds.flatMap((id) => byId.has(id) ? [receiptDto(byId.get(id)!)] : []) };
  }

  async acknowledgeSubset(identity: AgentIdentity, execution: ExecutionContext, claimId: string, items: { receiptId: string; disposition: InboxAckDisposition; resultRefs: string[] }[]) {
    if (items.length > EXTERNAL_AGENT_CLAIM_MAX_RECEIPTS || new Set(items.map((i) => i.receiptId)).size !== items.length) throw new DelegationError("ack_request_invalid", 400);
    return withAgentTransaction([identity.agentId], async (context) => {
      const { run, now } = await requireCurrentExecution(context, identity, execution, "read");
      const [claim] = await context.tx.select().from(claims).where(eq(claims.id, claimId)).for("update");
      if (!claim || claim.agentId !== identity.agentId || claim.serverId !== identity.serverId || claim.runId !== run.id || claim.fence !== run.fence || claim.connectionEpoch !== run.connectionEpoch || claim.state === "released" || claim.expiresAt <= now) throw new DelegationError("claim_stale", 403);
      for (const item of items) {
        if (!claim.receiptIds.includes(item.receiptId) || !["processed", "durable_handoff"].includes(item.disposition) || item.resultRefs.length > 20 || new Set(item.resultRefs).size !== item.resultRefs.length) throw new DelegationError("ack_request_invalid", 400);
        const [receipt] = await context.tx.select().from(receipts).where(and(eq(receipts.id, item.receiptId), eq(receipts.agentId, identity.agentId))).for("update");
        if (!receipt) throw new DelegationError("receipt_missing", 404);
        if (receipt.state === "acked") {
          if (receipt.ackDisposition !== item.disposition || JSON.stringify([...receipt.resultRefs].sort()) !== JSON.stringify([...item.resultRefs].sort())) throw new DelegationError("ack_conflict");
          continue;
        }
        if (receipt.state !== "claimed" || receipt.currentClaimId !== claim.id) throw new DelegationError("claim_stale", 403);
        let handoffVerified = false;
        for (const ref of item.resultRefs) {
          const match = /^(message|handoff):([0-9a-f-]{36})$/.exec(ref);
          if (!match || !z.string().uuid().safeParse(match[2]).success) throw new DelegationError("result_reference_invalid", 400);
          if (match[1] === "message") {
            const [result] = await context.tx.select({ id: messages.id }).from(messages).innerJoin(channels, eq(channels.id, messages.channelId)).where(and(eq(messages.id, match[2]), eq(messages.senderType, "agent"), eq(messages.senderId, identity.agentId), eq(channels.serverId, identity.serverId))).limit(1);
            if (!result) throw new DelegationError("result_reference_invalid", 400);
          } else {
            const [result] = await context.tx.select().from(productEvents).where(and(eq(productEvents.id, match[2]), eq(productEvents.subjectType, "external_agent_receipt"), eq(productEvents.subjectId, receipt.id), eq(productEvents.eventType, "external_agent.durable_handoff"), eq(productEvents.actorType, "user"))).limit(1);
            const metadata = result?.metadata as { taskId?: unknown; responsibleUserId?: unknown } | undefined;
            if (!result || typeof metadata?.taskId !== "string" || typeof metadata.responsibleUserId !== "string") throw new DelegationError("handoff_unverified", 400);
            const [task] = await context.tx.select().from(tasks).innerJoin(channels, eq(channels.id, tasks.channelId)).where(and(eq(tasks.id, metadata.taskId), eq(channels.serverId, identity.serverId), eq(tasks.claimedByType, "user"), eq(tasks.claimedById, metadata.responsibleUserId), inArray(tasks.status, ["in_progress", "in_review", "done"]))).limit(1);
            if (!task) throw new DelegationError("handoff_unverified", 400);
            handoffVerified = true;
          }
        }
        if (item.disposition === "durable_handoff" && !handoffVerified) throw new DelegationError("handoff_unverified", 400);
        const reason = await sourceStillApplicable(context, receipt);
        if (reason) await context.tx.update(receipts).set({ state: "suppressed", suppressReason: reason, currentClaimId: null }).where(eq(receipts.id, receipt.id));
        else await context.tx.update(receipts).set({ state: "acked", ackDisposition: item.disposition, resultRefs: [...item.resultRefs].sort(), ackedAt: await databaseNow(context) }).where(and(eq(receipts.id, receipt.id), eq(receipts.currentClaimId, claim.id), eq(receipts.state, "claimed")));
      }
      await requireCurrentExecution(context, identity, execution, "read");
      const remaining = claim.receiptIds.length ? await context.tx.select({ id: receipts.id }).from(receipts).where(and(inArray(receipts.id, claim.receiptIds), eq(receipts.state, "claimed"), eq(receipts.currentClaimId, claim.id))).limit(1) : [];
      if (!remaining.length) await context.tx.update(claims).set({ state: "acked" }).where(eq(claims.id, claim.id));
      const [updated] = await context.tx.select().from(claims).where(eq(claims.id, claim.id));
      return this.batch(context, updated);
    }, this.db);
  }

  async acceptDurableHandoff(identity: HumanIdentity, agentId: string, receiptId: string, taskId: string) {
    return withAgentTransaction([agentId], async (context) => {
      await requireHumanManagement(context, identity, agentId);
      const [receipt] = await context.tx.select().from(receipts).where(and(eq(receipts.id, receiptId), eq(receipts.agentId, agentId), eq(receipts.serverId, identity.serverId))).for("update");
      const [task] = await context.tx.select().from(tasks).innerJoin(channels, eq(channels.id, tasks.channelId)).where(and(eq(tasks.id, taskId), eq(channels.serverId, identity.serverId), eq(tasks.claimedByType, "user"), eq(tasks.claimedById, identity.userId), inArray(tasks.status, ["in_progress", "in_review"]))).for("update");
      if (!receipt || !task) throw new DelegationError("handoff_unverified", 400);
      const [event] = await context.tx.insert(productEvents).values({ subjectType: "external_agent_receipt", subjectId: receipt.id, eventType: "external_agent.durable_handoff", actorType: "user", actorId: identity.userId, source: "server", idempotencyKey: taskId, metadata: { taskId, responsibleUserId: identity.userId, agentId, serverId: identity.serverId } }).onConflictDoNothing().returning();
      if (event) return { resultRef: `handoff:${event.id}` };
      const [existing] = await context.tx.select().from(productEvents).where(and(eq(productEvents.subjectId, receipt.id), eq(productEvents.eventType, "external_agent.durable_handoff"), eq(productEvents.idempotencyKey, taskId))).limit(1);
      if (!existing) throw new DelegationError("handoff_unverified", 400);
      return { resultRef: `handoff:${existing.id}` };
    }, this.db);
  }
}
