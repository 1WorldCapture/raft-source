import { and, eq, inArray, isNotNull, isNull, ne, or, sql } from "drizzle-orm";
import { currentDate, type AgentMessage } from "@botiverse/raft-shared";
import { getDb } from "../db/index.js";
import { mentionDeliveryOccurrences } from "../db/schema.js";

export const MENTION_DELIVERY_TERMINAL_ERROR_CODES = [
  "IDENTITY_DRIFT",
  "QUOTA_LIMITED",
  "DELIVERY_REJECTED",
  "UNSUPPORTED_DELIVERY_PATH",
  "INSTRUMENT_FAILED",
  // Server-side verdict only — the ack-retry budget ran out. Never reported
  // by a daemon; written when the orchestrator exhausts re-sends so the
  // durable occurrence holds a queryable terminal state instead of a fresh
  // invisible budget on the next track/redrive (task #8).
  "RETRY_EXHAUSTED",
] as const;

/**
 * Legacy terminal code that no longer ends the delivery obligation (task #8
 * review): IDENTITY_UNKNOWN meant "this ATTEMPT could not confirm who it was
 * for", which stops an attempt — never the message's obligation. Rows
 * terminal-marked with it by pre-fix builds are read back as recoverable
 * (evaluate + the recoverable lists) without a data migration; the
 * terminal-mark write itself is gone from the orchestrator.
 */
export const LEGACY_RECOVERABLE_TERMINAL_CODES = ["IDENTITY_UNKNOWN"] as const;

export type MentionDeliveryTerminalErrorCode = typeof MENTION_DELIVERY_TERMINAL_ERROR_CODES[number];
export type MentionDeliveryTransitionStage = "daemon_received" | "daemon_pending" | "daemon_drained";
export type MentionDeliveryState = typeof mentionDeliveryOccurrences.$inferSelect.state;
export type MentionDeliveryOccurrenceRow = typeof mentionDeliveryOccurrences.$inferSelect;

export type MentionDeliveryIdentity = {
  machineId: string;
  launchId: string;
  sessionId: string;
};

export type MentionDeliveryBrokenHop =
  | "SERVER_DECISION"
  | "DAEMON_RECEIVE"
  | "DAEMON_PENDING"
  | "DAEMON_DRAIN"
  | "ACK"
  | "TERMINAL_ERROR";

export type MentionDeliveryLookupResult =
  | { status: "NOT_JOINABLE" }
  | { status: "INSTRUMENT_FAILED"; occurrenceId: string; missingReceipt: MentionDeliveryBrokenHop | "MENTION_RECORDED" | "UNRECOGNISED_STATE"; version: number }
  | { status: "BROKEN_HOP"; occurrenceId: string; hop: MentionDeliveryBrokenHop; version: number }
  | { status: "TERMINAL_ERROR"; occurrenceId: string; code: MentionDeliveryTerminalErrorCode; version: number }
  | { status: "ACKED"; occurrenceId: string; version: number };

const STATE_RANK: Record<MentionDeliveryState, number> = {
  recorded: 0,
  server_decided: 1,
  daemon_received: 2,
  daemon_pending: 3,
  daemon_drained: 4,
  acked: 5,
  terminal_error: 6,
};

function laterReceiptExists(row: MentionDeliveryOccurrenceRow, hop: MentionDeliveryBrokenHop): boolean {
  switch (hop) {
    case "SERVER_DECISION":
      return Boolean(row.daemonReceivedAt || row.daemonPendingAt || row.daemonDrainedAt || row.ackedAt || row.terminalErrorAt);
    case "DAEMON_RECEIVE":
      return Boolean(row.daemonPendingAt || row.daemonDrainedAt || row.ackedAt || row.terminalErrorAt);
    // terminalErrorAt on EVERY hop. I got this wrong twice and the second time is the useful one.
    // @Hipp flagged the asymmetry; I "checked" migration 0240's constraint —
    //   CHECK ((state = 'terminal_error') = (terminal_error_at IS NOT NULL AND code IS NOT NULL))
    // — read it as "terminalErrorAt non-null implies state = terminal_error", declared the case
    // unreachable, and reverted his fix. That reading is WRONG: it drops the AND. With the
    // timestamp set and the CODE NULL the right-hand side is FALSE, so any non-terminal state
    // satisfies the biconditional. He built the row; I reproduced it on pglite — the database
    // ACCEPTS state='daemon_pending' + terminalErrorAt=<t> + terminalErrorCode=null.
    // Such a row carries a terminal receipt while evaluate() reports it as an ordinary broken hop,
    // which contradicts this file's own creed that a claimed transition without its receipt is an
    // instrument failure. So the protection really is the writer convention (always write `at` and
    // `code` together), exactly as he said, and the convention is not enforced by the schema.
    case "DAEMON_PENDING":
      return Boolean(row.daemonDrainedAt || row.ackedAt || row.terminalErrorAt);
    case "DAEMON_DRAIN":
      return Boolean(row.ackedAt || row.terminalErrorAt);
    // FIXED 2026-08-20 (@Hipp finding 1, PR #6700 comment 5359756944). This returned `false`, so a
    // row at state='daemon_drained' with terminalErrorAt set and code NULL reached
    // missingReceiptIsInstrumentationFailure(row,"ACK",5), where 4 >= 5 is false ⇒ BROKEN_HOP was
    // reported on a row that CARRIES a terminal receipt. Everything needed to see this was already
    // in the comment above; I wrote that comment and still left the case returning false.
    case "ACK":
      return Boolean(row.terminalErrorAt);
    // TERMINAL_ERROR stays false and that is not an oversight: nothing is later than the terminal
    // receipt, so there is no subsequent receipt whose existence could excuse a missing one here.
    case "TERMINAL_ERROR":
      return false;
  }
}

function missingReceiptIsInstrumentationFailure(
  row: MentionDeliveryOccurrenceRow,
  hop: MentionDeliveryBrokenHop,
  requiredStateRank: number,
): boolean {
  return STATE_RANK[row.state] >= requiredStateRank || laterReceiptExists(row, hop);
}

/**
 * Closed diagnostic projection. A state that claims a transition without its
 * receipt is never reported as an ordinary missing hop: it is instrument
 * failure. This is intentionally pure so the suppression mutant can prove the
 * exact branch executed without depending on a database error shape.
 */
export function evaluateMentionDeliveryOccurrence(row: MentionDeliveryOccurrenceRow): MentionDeliveryLookupResult {
  // @Hipp finding 3 (PR #6700 comment 5359756944). `state` carried no value constraint — he measured
  // 'banana' and '' both accepted on pglite, and @Kabi derived the same from source (Drizzle's
  // `enum:` is a TypeScript union and emits no database constraint; two independent derivations).
  // The consequence is in the arithmetic, not the storage: STATE_RANK[unknown] is `undefined`, and
  // `undefined >= n` is ALWAYS false, so an unrecognised state silently sinks BELOW every rank and
  // gets diagnosed by timestamps alone. ⇒ the instrument is least trustworthy exactly when the thing
  // it instruments has malfunctioned, which is the one moment it exists for.
  // Guarding here rather than only at the schema: a CHECK cannot help rows that already exist or a
  // writer that reaches the table by another path, and `undefined >= n` stays a trap regardless.
  if (!Object.prototype.hasOwnProperty.call(STATE_RANK, row.state)) {
    // A DISTINCT discriminator, not a borrowed one. Reusing "MENTION_RECORDED" here would tell an
    // operator a receipt is missing when none is — the same "one word answering two questions"
    // defect this file already records about INSTRUMENT_FAILED being both a status and a code.
    return { status: "INSTRUMENT_FAILED", occurrenceId: row.occurrenceId, missingReceipt: "UNRECOGNISED_STATE", version: row.version };
  }
  if (!row.mentionRecordedAt) {
    return { status: "INSTRUMENT_FAILED", occurrenceId: row.occurrenceId, missingReceipt: "MENTION_RECORDED", version: row.version };
  }
  if (!row.serverDecidedAt) {
    return missingReceiptIsInstrumentationFailure(row, "SERVER_DECISION", 1)
      ? { status: "INSTRUMENT_FAILED", occurrenceId: row.occurrenceId, missingReceipt: "SERVER_DECISION", version: row.version }
      : { status: "BROKEN_HOP", occurrenceId: row.occurrenceId, hop: "SERVER_DECISION", version: row.version };
  }
  if (row.state === "terminal_error") {
    // Legacy IDENTITY_UNKNOWN rows (pre-fix builds) attempted-failed an
    // ATTEMPT, not the obligation: read them back on the ordinary hop chain
    // so they stay diagnosable and recoverable — no data migration.
    if ((LEGACY_RECOVERABLE_TERMINAL_CODES as readonly string[]).includes(row.terminalErrorCode ?? "")) {
      // fall through to the hop-chain projection below, as if not terminal.
    } else if (!row.terminalErrorAt || !MENTION_DELIVERY_TERMINAL_ERROR_CODES.includes(row.terminalErrorCode as MentionDeliveryTerminalErrorCode)) {
      return { status: "INSTRUMENT_FAILED", occurrenceId: row.occurrenceId, missingReceipt: "TERMINAL_ERROR", version: row.version };
    } else {
      const code = row.terminalErrorCode as MentionDeliveryTerminalErrorCode;
      return { status: "TERMINAL_ERROR", occurrenceId: row.occurrenceId, code, version: row.version };
    }
  }
  if (!row.daemonReceivedAt) {
    return missingReceiptIsInstrumentationFailure(row, "DAEMON_RECEIVE", 2)
      ? { status: "INSTRUMENT_FAILED", occurrenceId: row.occurrenceId, missingReceipt: "DAEMON_RECEIVE", version: row.version }
      : { status: "BROKEN_HOP", occurrenceId: row.occurrenceId, hop: "DAEMON_RECEIVE", version: row.version };
  }
  if (row.deliveryPath === "busy" && !row.daemonPendingAt) {
    return missingReceiptIsInstrumentationFailure(row, "DAEMON_PENDING", 3)
      ? { status: "INSTRUMENT_FAILED", occurrenceId: row.occurrenceId, missingReceipt: "DAEMON_PENDING", version: row.version }
      : { status: "BROKEN_HOP", occurrenceId: row.occurrenceId, hop: "DAEMON_PENDING", version: row.version };
  }
  if (!row.daemonDrainedAt) {
    return missingReceiptIsInstrumentationFailure(row, "DAEMON_DRAIN", 4)
      ? { status: "INSTRUMENT_FAILED", occurrenceId: row.occurrenceId, missingReceipt: "DAEMON_DRAIN", version: row.version }
      : { status: "BROKEN_HOP", occurrenceId: row.occurrenceId, hop: "DAEMON_DRAIN", version: row.version };
  }
  if (!row.ackedAt) {
    return missingReceiptIsInstrumentationFailure(row, "ACK", 5)
      ? { status: "INSTRUMENT_FAILED", occurrenceId: row.occurrenceId, missingReceipt: "ACK", version: row.version }
      : { status: "BROKEN_HOP", occurrenceId: row.occurrenceId, hop: "ACK", version: row.version };
  }
  return { status: "ACKED", occurrenceId: row.occurrenceId, version: row.version };
}

export async function ensureMentionDeliveryOccurrences(
  rows: Array<{ occurrenceId: string; messageId: string; serverId: string; agentId: string; deliveryPayload: AgentMessage }>,
): Promise<void> {
  if (rows.length === 0) return;
  await getDb().insert(mentionDeliveryOccurrences).values(rows).onConflictDoUpdate({
    target: mentionDeliveryOccurrences.occurrenceId,
    set: {
      deliveryPayload: sql`coalesce(${mentionDeliveryOccurrences.deliveryPayload}, excluded.delivery_payload)`,
      updatedAt: currentDate(),
    },
  });
}

export async function recordMentionDeliveryServerDecision(input: {
  occurrenceId: string;
  payload: AgentMessage;
  identity: MentionDeliveryIdentity;
}): Promise<MentionDeliveryOccurrenceRow | null> {
  const db = getDb();
  const [existing] = await db.select().from(mentionDeliveryOccurrences)
    .where(eq(mentionDeliveryOccurrences.occurrenceId, input.occurrenceId)).limit(1);
  if (!existing) return null;
  // TERMINAL STATES RETURN null, NOT THE ROW. Found by @Hipp reviewing #6700 and verified by me at
  // both call sites: this used to `return existing ?? null`, handing back a TRUTHY row for `acked`
  // and `terminal_error`. Both callers in agentOrchestrator do:
  //     if (!decided) continue;  current = decided;
  //     if (current.state === "daemon_drained") continue;   ← only skips daemon_drained
  //     …enqueue + sendAgentDeliveryWithAckRetry
  // so an ACKed occurrence passed the first guard (truthy), missed the second (state is "acked",
  // not "daemon_drained"), and was RE-DELIVERED — the exact double-delivery this spine exists to
  // prevent. Reachable by a reconnect race: recovery lists rows → the previous connection's ACK
  // lands → the decision write runs against an already-acked row.
  // ⚠️ It does not reproduce today only because a daemon-side in-memory map swallows the duplicate,
  // and that map never evicts — an unbounded leak. So the invariant was load-bearing on a memory
  // leak, and whoever fixes the leak would have opened this hole while having no reason to read
  // this file. Fixing it here removes that coupling.
  if (existing.state === "acked" || existing.state === "terminal_error") return null;
  if (existing.serverDecidedAt) {
    const same = existing.machineIdSnapshot === input.identity.machineId
      && existing.launchIdSnapshot === input.identity.launchId
      && existing.sessionIdSnapshot === input.identity.sessionId
      && existing.deliveryPayload?.message_id === input.payload.message_id;
    return same ? existing : null;
  }
  const [updated] = await db.update(mentionDeliveryOccurrences).set({
    deliveryPayload: input.payload,
    state: "server_decided",
    machineIdSnapshot: input.identity.machineId,
    launchIdSnapshot: input.identity.launchId,
    sessionIdSnapshot: input.identity.sessionId,
    serverDecidedAt: currentDate(),
    version: sql`${mentionDeliveryOccurrences.version} + 1`,
    updatedAt: currentDate(),
  }).where(and(
    eq(mentionDeliveryOccurrences.occurrenceId, input.occurrenceId),
    eq(mentionDeliveryOccurrences.state, "recorded"),
    isNull(mentionDeliveryOccurrences.serverDecidedAt),
  )).returning();
  return updated ?? null;
}

function identityWhere(occurrenceId: string, agentId: string, identity: MentionDeliveryIdentity) {
  return and(
    eq(mentionDeliveryOccurrences.occurrenceId, occurrenceId),
    eq(mentionDeliveryOccurrences.agentId, agentId),
    eq(mentionDeliveryOccurrences.machineIdSnapshot, identity.machineId),
    eq(mentionDeliveryOccurrences.launchIdSnapshot, identity.launchId),
    eq(mentionDeliveryOccurrences.sessionIdSnapshot, identity.sessionId),
    isNull(mentionDeliveryOccurrences.ackedAt),
    isNull(mentionDeliveryOccurrences.terminalErrorAt),
  );
}

export async function recordMentionDeliveryDaemonTransition(input: {
  occurrenceId: string;
  agentId: string;
  messageId: string;
  identity: MentionDeliveryIdentity;
  stage: MentionDeliveryTransitionStage;
  outcome?: "accepted" | "coalesced";
}): Promise<MentionDeliveryOccurrenceRow | null> {
  const now = currentDate();
  const stageSet = input.stage === "daemon_received"
    ? {
        daemonReceivedAt: sql`coalesce(${mentionDeliveryOccurrences.daemonReceivedAt}, ${now})`,
        state: sql`case when ${mentionDeliveryOccurrences.state} = 'server_decided' then 'daemon_received' else ${mentionDeliveryOccurrences.state} end`,
      }
    : input.stage === "daemon_pending"
      ? {
          daemonPendingAt: sql`coalesce(${mentionDeliveryOccurrences.daemonPendingAt}, ${now})`,
          deliveryPath: "busy" as const,
          state: sql`case when ${mentionDeliveryOccurrences.state} in ('server_decided', 'daemon_received') then 'daemon_pending' else ${mentionDeliveryOccurrences.state} end`,
          ...(input.outcome === "coalesced" ? { pendingCoalescedCount: sql`${mentionDeliveryOccurrences.pendingCoalescedCount} + 1` } : {}),
        }
      : {
          daemonDrainedAt: sql`coalesce(${mentionDeliveryOccurrences.daemonDrainedAt}, ${now})`,
          deliveryPath: sql`case when ${mentionDeliveryOccurrences.deliveryPath} = 'busy' then 'busy' else 'immediate' end`,
          state: "daemon_drained" as const,
        };
  const [updated] = await getDb().update(mentionDeliveryOccurrences).set({
    ...stageSet,
    version: sql`${mentionDeliveryOccurrences.version} + 1`,
    updatedAt: now,
  }).where(and(
    identityWhere(input.occurrenceId, input.agentId, input.identity),
    eq(mentionDeliveryOccurrences.messageId, input.messageId),
  )).returning();
  return updated ?? null;
}

export async function recordMentionDeliveryAck(input: {
  occurrenceId: string;
  agentId: string;
  messageId: string;
  identity: MentionDeliveryIdentity;
}): Promise<MentionDeliveryOccurrenceRow | null> {
  const now = currentDate();
  const [updated] = await getDb().update(mentionDeliveryOccurrences).set({
    state: "acked",
    ackedAt: now,
    version: sql`${mentionDeliveryOccurrences.version} + 1`,
    updatedAt: now,
  }).where(and(
    identityWhere(input.occurrenceId, input.agentId, input.identity),
    eq(mentionDeliveryOccurrences.messageId, input.messageId),
    isNotNull(mentionDeliveryOccurrences.daemonDrainedAt),
  )).returning();
  return updated ?? null;
}

/**
 * Hotfix (mention-push incident 2026-08-27): abandon a tracked mention whose
 * delivery cannot be instrumented because the target's session identity
 * (launchId/sessionId) was never established — e.g. older daemons. Marks the
 * occurrence terminal (INSTRUMENT_FAILED) so recovery/redrive listings cannot
 * pin or loop on it, while the message itself continues through the ordinary
 * untracked delivery path (durable replayable inbox + plain ws frame +
 * embedded wake content).
 *
 * CAS ownership: only the caller that atomically terminalizes the row from its
 * original pre-decision fanout state (`recorded`, no server decision, no ack,
 * no terminal) owns the untracked delivery and receives the updated row. A
 * null return means some other path already owns this occurrence — it was
 * already terminalized (e.g. a previous fallback call that delivered), a
 * session/recovery path already recorded a server decision, or the row does
 * not exist — and the caller MUST NOT emit a second copy.
 */
export async function abandonMentionDeliveryWithoutInstrumentation(input: {
  occurrenceId: string;
}): Promise<MentionDeliveryOccurrenceRow | null> {
  const now = currentDate();
  const [updated] = await getDb().update(mentionDeliveryOccurrences).set({
    state: "terminal_error" as const,
    terminalErrorAt: now,
    terminalErrorCode: "INSTRUMENT_FAILED" satisfies MentionDeliveryTerminalErrorCode,
    version: sql`${mentionDeliveryOccurrences.version} + 1`,
    updatedAt: now,
  }).where(and(
    eq(mentionDeliveryOccurrences.occurrenceId, input.occurrenceId),
    eq(mentionDeliveryOccurrences.state, "recorded"),
    isNull(mentionDeliveryOccurrences.serverDecidedAt),
    isNull(mentionDeliveryOccurrences.ackedAt),
    isNull(mentionDeliveryOccurrences.terminalErrorAt),
  )).returning();
  return updated ?? null;
}

export async function recordMentionDeliveryTerminalError(input: {
  occurrenceId: string;
  agentId: string;
  messageId: string;
  identity: MentionDeliveryIdentity;
  code: MentionDeliveryTerminalErrorCode;
}): Promise<MentionDeliveryOccurrenceRow | null> {
  const now = currentDate();
  const [updated] = await getDb().update(mentionDeliveryOccurrences).set({
    state: "terminal_error",
    terminalErrorAt: now,
    terminalErrorCode: input.code,
    version: sql`${mentionDeliveryOccurrences.version} + 1`,
    updatedAt: now,
  }).where(and(
    identityWhere(input.occurrenceId, input.agentId, input.identity),
    eq(mentionDeliveryOccurrences.messageId, input.messageId),
  )).returning();
  return updated ?? null;
}

export async function lookupMentionDeliveryOccurrence(messageId: string, agentId: string): Promise<MentionDeliveryLookupResult> {
  const [row] = await getDb().select().from(mentionDeliveryOccurrences).where(and(
    eq(mentionDeliveryOccurrences.messageId, messageId),
    eq(mentionDeliveryOccurrences.agentId, agentId),
  )).limit(1);
  return row ? evaluateMentionDeliveryOccurrence(row) : { status: "NOT_JOINABLE" };
}

export async function listRecoverableMentionDeliveries(machineId: string): Promise<MentionDeliveryOccurrenceRow[]> {
  return getDb().select().from(mentionDeliveryOccurrences).where(and(
    eq(mentionDeliveryOccurrences.machineIdSnapshot, machineId),
    isNotNull(mentionDeliveryOccurrences.serverDecidedAt),
    isNotNull(mentionDeliveryOccurrences.deliveryPayload),
    isNull(mentionDeliveryOccurrences.ackedAt),
    // Legacy IDENTITY_UNKNOWN rows are attempt-failures, not obligation
    // endings (task #8 review): they stay recoverable alongside non-terminal.
    or(
      isNull(mentionDeliveryOccurrences.terminalErrorAt),
      inArray(mentionDeliveryOccurrences.terminalErrorCode, [...LEGACY_RECOVERABLE_TERMINAL_CODES]),
    ),
    or(
      inArray(mentionDeliveryOccurrences.state, ["server_decided", "daemon_received", "daemon_pending"]),
      and(
        eq(mentionDeliveryOccurrences.state, "terminal_error"),
        inArray(mentionDeliveryOccurrences.terminalErrorCode, [...LEGACY_RECOVERABLE_TERMINAL_CODES]),
      ),
    ),
  ));
}

export async function listRecoverableMentionDeliveriesForAgent(
  machineId: string,
  agentId: string,
): Promise<MentionDeliveryOccurrenceRow[]> {
  return getDb().select().from(mentionDeliveryOccurrences).where(and(
    eq(mentionDeliveryOccurrences.agentId, agentId),
    isNotNull(mentionDeliveryOccurrences.deliveryPayload),
    isNull(mentionDeliveryOccurrences.ackedAt),
    // Legacy IDENTITY_UNKNOWN rows stay recoverable (see machineId variant).
    or(
      isNull(mentionDeliveryOccurrences.terminalErrorAt),
      inArray(mentionDeliveryOccurrences.terminalErrorCode, [...LEGACY_RECOVERABLE_TERMINAL_CODES]),
    ),
    or(
      inArray(mentionDeliveryOccurrences.state, ["recorded", "server_decided", "daemon_received", "daemon_pending"]),
      and(
        eq(mentionDeliveryOccurrences.state, "terminal_error"),
        inArray(mentionDeliveryOccurrences.terminalErrorCode, [...LEGACY_RECOVERABLE_TERMINAL_CODES]),
      ),
    ),
    sql`(${mentionDeliveryOccurrences.machineIdSnapshot} is null or ${mentionDeliveryOccurrences.machineIdSnapshot} = ${machineId})`,
  ));
}

export async function recordMentionDeliveryIdentityDrift(
  occurrenceId: string,
): Promise<MentionDeliveryOccurrenceRow | null> {
  const now = currentDate();
  const [updated] = await getDb().update(mentionDeliveryOccurrences).set({
    state: "terminal_error",
    terminalErrorAt: now,
    terminalErrorCode: "IDENTITY_DRIFT",
    version: sql`${mentionDeliveryOccurrences.version} + 1`,
    updatedAt: now,
  }).where(and(
    eq(mentionDeliveryOccurrences.occurrenceId, occurrenceId),
    isNull(mentionDeliveryOccurrences.ackedAt),
    isNull(mentionDeliveryOccurrences.terminalErrorAt),
  )).returning();
  return updated ?? null;
}

/**
 * Terminalize a daemon receipt only when its frozen occurrence identity still
 * matches the durable row. This lets a stale launch/session report the typed
 * IDENTITY_DRIFT terminal without allowing that stale socket to name and
 * terminalize some unrelated occurrence.
 */
export async function recordMentionDeliveryIdentityDriftForIdentity(input: {
  occurrenceId: string;
  agentId: string;
  messageId: string;
  identity: MentionDeliveryIdentity;
}): Promise<MentionDeliveryOccurrenceRow | null> {
  const now = currentDate();
  const [updated] = await getDb().update(mentionDeliveryOccurrences).set({
    state: "terminal_error",
    terminalErrorAt: now,
    terminalErrorCode: "IDENTITY_DRIFT",
    version: sql`${mentionDeliveryOccurrences.version} + 1`,
    updatedAt: now,
  }).where(and(
    identityWhere(input.occurrenceId, input.agentId, input.identity),
    eq(mentionDeliveryOccurrences.messageId, input.messageId),
  )).returning();
  return updated ?? null;
}

/**
 * ONE-SHOT CLAIM, DESPITE THE NAME. The where-clause below pins `redriveCount = 0`, so the column
 * can only ever hold 0 or 1 — it is a latch, not a counter (@Hipp, review of #6700). Anyone who
 * sums it, averages it, or plots its distribution will get a bounded number and no warning.
 * NOT renamed to something honest (`redrive_claimed`) on purpose: the column ships in migration
 * 0240, whose DDL was just verified byte-identical to the retired 0237 and whose journal-tag
 * windows were separately checked. Renaming means regenerating the migration and voiding both of
 * those readings, to buy a better name for a value only this file writes. Documented instead, and
 * flagged for whoever next opens this migration lane while the table is still empty in production.
 */
export async function claimMentionDeliveryRedrive(input: {
  occurrenceId: string;
  expectedVersion: number;
  identity: MentionDeliveryIdentity;
}): Promise<MentionDeliveryOccurrenceRow | null> {
  const now = currentDate();
  const [claimed] = await getDb().update(mentionDeliveryOccurrences).set({
    redriveCount: sql`${mentionDeliveryOccurrences.redriveCount} + 1`,
    lastRedriveAt: now,
    version: sql`${mentionDeliveryOccurrences.version} + 1`,
    updatedAt: now,
  }).where(and(
    eq(mentionDeliveryOccurrences.occurrenceId, input.occurrenceId),
    eq(mentionDeliveryOccurrences.version, input.expectedVersion),
    eq(mentionDeliveryOccurrences.machineIdSnapshot, input.identity.machineId),
    eq(mentionDeliveryOccurrences.launchIdSnapshot, input.identity.launchId),
    eq(mentionDeliveryOccurrences.sessionIdSnapshot, input.identity.sessionId),
    eq(mentionDeliveryOccurrences.redriveCount, 0),
    isNull(mentionDeliveryOccurrences.ackedAt),
    isNull(mentionDeliveryOccurrences.terminalErrorAt),
    ne(mentionDeliveryOccurrences.state, "acked"),
    ne(mentionDeliveryOccurrences.state, "terminal_error"),
  )).returning();
  return claimed ?? null;
}

export type MentionDeliverySendBudgetClaim =
  | { decision: "send"; attempts: number; nextAllowedAt: Date }
  | { decision: "wait"; attempts: number; nextAllowedAt: Date }
  | { decision: "exhausted"; attempts: number }
  | { decision: "missing" };

/**
 * Atomically claim one send from the occurrence's PERSISTENT budget (task #8
 * review): attempts counts real sends across tracker lifetimes, redrives and
 * process restarts. Every real send entry point must route through this — a
 * send that does not claim is a budget bypass. The claim increments BEFORE
 * the send (a claimed-but-unsent attempt is spent: under dark conditions we
 * err on the side of NOT resending). `backoffMsForAttempts` maps the
 * post-increment attempt count to the wait before the NEXT send.
 */
export async function claimMentionDeliverySendBudget(input: {
  occurrenceId: string;
  nowMs: number;
  maxAttempts: number;
  backoffMsForAttempts: (attemptsAfterThisSend: number) => number;
}): Promise<MentionDeliverySendBudgetClaim> {
  const now = new Date(input.nowMs);
  const [row] = await getDb().select().from(mentionDeliveryOccurrences)
    .where(eq(mentionDeliveryOccurrences.occurrenceId, input.occurrenceId)).limit(1);
  if (!row) return { decision: "missing" };
  // Terminal (other than legacy-recoverable) and acked rows never send.
  if (row.ackedAt) return { decision: "missing" };
  const legacyRecoverable = row.state === "terminal_error"
    && (LEGACY_RECOVERABLE_TERMINAL_CODES as readonly string[]).includes(row.terminalErrorCode ?? "");
  if (row.state === "terminal_error" && !legacyRecoverable) return { decision: "missing" };

  if (row.deliveryRetryAttempts >= input.maxAttempts) {
    return { decision: "exhausted", attempts: row.deliveryRetryAttempts };
  }
  if (row.deliveryRetryNextAllowedAt && row.deliveryRetryNextAllowedAt.getTime() > input.nowMs) {
    return { decision: "wait", attempts: row.deliveryRetryAttempts, nextAllowedAt: row.deliveryRetryNextAllowedAt };
  }
  const attemptsAfter = row.deliveryRetryAttempts + 1;
  const nextAllowedAt = new Date(input.nowMs + input.backoffMsForAttempts(attemptsAfter));
  // CAS on version so a concurrent claim/redrive cannot double-spend.
  const [updated] = await getDb().update(mentionDeliveryOccurrences).set({
    deliveryRetryAttempts: attemptsAfter,
    deliveryRetryNextAllowedAt: nextAllowedAt,
    version: sql`${mentionDeliveryOccurrences.version} + 1`,
    updatedAt: now,
  }).where(and(
    eq(mentionDeliveryOccurrences.occurrenceId, input.occurrenceId),
    eq(mentionDeliveryOccurrences.version, row.version),
  )).returning();
  if (!updated) {
    // Lost the CAS race: another claim won this slot. Treat as wait with a
    // short retry horizon — the winner's nextAllowedAt is now authoritative.
    const [fresh] = await getDb().select().from(mentionDeliveryOccurrences)
      .where(eq(mentionDeliveryOccurrences.occurrenceId, input.occurrenceId)).limit(1);
    if (!fresh) return { decision: "missing" };
    if (fresh.deliveryRetryAttempts >= input.maxAttempts) {
      return { decision: "exhausted", attempts: fresh.deliveryRetryAttempts };
    }
    return { decision: "wait", attempts: fresh.deliveryRetryAttempts, nextAllowedAt: fresh.deliveryRetryNextAllowedAt ?? new Date(input.nowMs) };
  }
  return { decision: "send", attempts: attemptsAfter, nextAllowedAt };
}

/**
 * Controlled recovery for a RETRY_EXHAUSTED occurrence (task #8 review): an
 * explicit operation — never implicit — that clears the terminal verdict AND
 * the send budget so the message obligation becomes deliverable again.
 * Returns the recovered row, or null when the occurrence does not exist or
 * is not in the exhausted terminal state (no blanket un-terminal here).
 */
export async function recoverMentionDeliveryFromRetryExhaustion(occurrenceId: string): Promise<MentionDeliveryOccurrenceRow | null> {
  const now = currentDate();
  const [recovered] = await getDb().update(mentionDeliveryOccurrences).set({
    state: "server_decided",
    terminalErrorAt: null,
    terminalErrorCode: null,
    deliveryRetryAttempts: 0,
    deliveryRetryNextAllowedAt: null,
    version: sql`${mentionDeliveryOccurrences.version} + 1`,
    updatedAt: now,
  }).where(and(
    eq(mentionDeliveryOccurrences.occurrenceId, occurrenceId),
    eq(mentionDeliveryOccurrences.state, "terminal_error"),
    eq(mentionDeliveryOccurrences.terminalErrorCode, "RETRY_EXHAUSTED"),
    isNull(mentionDeliveryOccurrences.ackedAt),
  )).returning();
  return recovered ?? null;
}

export async function getMentionDeliveryOccurrenceById(occurrenceId: string): Promise<MentionDeliveryOccurrenceRow | null> {
  const [row] = await getDb().select().from(mentionDeliveryOccurrences)
    .where(eq(mentionDeliveryOccurrences.occurrenceId, occurrenceId)).limit(1);
  return row ?? null;
}

export async function getMentionDeliveryOccurrence(
  messageId: string,
  agentId: string,
): Promise<MentionDeliveryOccurrenceRow | null> {
  const [row] = await getDb().select().from(mentionDeliveryOccurrences).where(and(
    eq(mentionDeliveryOccurrences.messageId, messageId),
    eq(mentionDeliveryOccurrences.agentId, agentId),
  )).limit(1);
  return row ?? null;
}
