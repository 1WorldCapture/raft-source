// Proxy Delegation activation contracts for External Agents (design v1.1,
// #grokbot-integration task #4 / Phase A1). Closed schemas: unknown fields
// are rejected (every object is .strict()), bigint travels as decimal
// strings in JSON, and no DTO ever carries secrets — ciphertext/iv/authTag/
// key live only in the server's private columns and are exposed as
// `secretConfigured` + fingerprint facts.
//
// Six domain records (design §3): connection, inbox receipt, wake, attempt,
// run, claim. They record configuration, input consumption, wake intent,
// transport attempts, run ownership, and batch receipts — they never
// duplicate agent ownership, message bodies, or task state.

import { z } from "zod";

export const EXTERNAL_AGENT_ACTIVATION_SCHEMA_VERSION = 1 as const;
export const EXTERNAL_AGENT_WAKE_PAYLOAD_SCHEMA = "raft.external-agent.wake.v1" as const;
export const GROKBOT_WEBHOOK_PROTOCOL_VERSION = 1 as const;
export const EXTERNAL_AGENT_CLAIM_MAX_RECEIPTS = 200 as const;

// --- shared primitives -------------------------------------------------------

/** bigint as an exact decimal string in JSON (never a JS number). */
const int64StringSchema = z.string().regex(/^\d+$/, "must be a non-negative decimal integer string");

const uuidSchema = z.string().uuid();
const isoTimestampSchema = z.string().refine((value) => !Number.isNaN(Date.parse(value)), {
  message: "must be a parseable timestamp",
});
const nonEmptyStringSchema = z.string().min(1);

export type Int64String = string;

/** AES-GCM material for the delivery secret. Server-private storage only;
 * bound by AAD to purpose/server/agent/connection (design §3.1). Never part
 * of any public DTO. */
export const encryptedSecretSchema = z.strictObject({
  keyId: nonEmptyStringSchema,
  ciphertext: nonEmptyStringSchema,
  iv: nonEmptyStringSchema,
  authTag: nonEmptyStringSchema,
});
export type EncryptedSecret = z.infer<typeof encryptedSecretSchema>;

// --- activation config (discriminated, closed) -------------------------------

export const externalAgentActivationStrategyValues = ["local_bridge", "proxy_delegation"] as const;
export type ExternalAgentActivationStrategy = typeof externalAgentActivationStrategyValues[number];

export const localBridgeAdapterValues = ["raft-channel", "hermes-in-process", "other"] as const;
export type LocalBridgeAdapter = typeof localBridgeAdapterValues[number];

export const deliveryAdapterValues = ["grokbot_webhook"] as const;
export type DeliveryAdapterKind = typeof deliveryAdapterValues[number];

export const localBridgeActivationSchema = z.strictObject({
  strategy: z.literal("local_bridge"),
  adapter: z.enum(localBridgeAdapterValues),
  manifestVersion: z.literal("slock-external-runtime-integration.v1").optional(),
});

export const proxyDeliveryPolicySchema = z.strictObject({
  debounceMs: z.number().int().nonnegative(),
  startupTimeoutMs: z.number().int().nonnegative(),
  leaseTtlMs: z.number().int().positive(),
  maxRunDurationMs: z.number().int().positive(),
  maxDeliveryAttempts: z.number().int().positive(),
  /** v1.1 §6.3: run-start budget per retry cycle — covers "HTTP deliveries
   * succeeded but every run failed"; NOT interchangeable with delivery
   * attempts. Counted from the current wake's runs under the agent gate. */
  maxRunStartsPerCycle: z.number().int().positive(),
  maxWakesPerHour: z.number().int().positive(),
});

export const proxyDelegationActivationSchema = z.strictObject({
  strategy: z.literal("proxy_delegation"),
  delivery: z.strictObject({
    adapter: z.enum(deliveryAdapterValues),
    protocolVersion: z.literal(GROKBOT_WEBHOOK_PROTOCOL_VERSION),
    endpointUrl: z.string().url(),
  }),
  policy: proxyDeliveryPolicySchema,
});

export const externalActivationConfigSchema = z.discriminatedUnion("strategy", [
  localBridgeActivationSchema,
  proxyDelegationActivationSchema,
]);
export type ExternalActivationConfig = z.infer<typeof externalActivationConfigSchema>;

// --- record state machines (values frozen; transitions live in services) ------

export const inboxReceiptStateValues = ["pending", "claimed", "acked", "suppressed"] as const;
export type InboxReceiptState = typeof inboxReceiptStateValues[number];

export const inboxAckDispositionValues = ["processed", "durable_handoff"] as const;
export type InboxAckDisposition = typeof inboxAckDispositionValues[number];

/** Wake states: the first five are the live set (partial-unique-indexed per
 * connection); the last three are terminal. */
export const wakeLiveStateValues = [
  "queued",
  "dispatching",
  "awaiting_agent",
  "active",
  "blocked",
] as const;
export const wakeTerminalStateValues = ["settled", "superseded", "exhausted"] as const;
export const wakeStateValues = [...wakeLiveStateValues, ...wakeTerminalStateValues] as const;
export type WakeState = typeof wakeStateValues[number];

export const attemptOutcomeValues = ["accepted", "rejected", "unknown"] as const;
export type AttemptOutcome = typeof attemptOutcomeValues[number];

export const runStateValues = ["active", "blocked", "finished", "expired", "revoked"] as const;
export type RunState = typeof runStateValues[number];

export const runFinishOutcomeValues = ["drained", "waiting_user", "yielded", "failed"] as const;
export type RunFinishOutcome = typeof runFinishOutcomeValues[number];

export const externalAgentConsumptionModeValues = ["legacy", "delegated"] as const;
export type ExternalAgentConsumptionMode = typeof externalAgentConsumptionModeValues[number];

export const claimStateValues = ["open", "acked", "released"] as const;
export type ClaimState = typeof claimStateValues[number];

// --- wake payload (what the delivery adapter POSTs — no secrets, no bodies) ---

export const wakePayloadSchema = z.strictObject({
  schema: z.literal(EXTERNAL_AGENT_WAKE_PAYLOAD_SCHEMA),
  kind: z.literal("wake"),
  wakeId: nonEmptyStringSchema,
  attemptId: nonEmptyStringSchema,
  connectionEpoch: int64StringSchema,
  occurredAt: isoTimestampSchema,
});
export type WakePayload = z.infer<typeof wakePayloadSchema>;

// --- DTOs (public, sanitized) --------------------------------------------------

export const externalAgentConnectionDtoSchema = z.strictObject({
  id: uuidSchema,
  serverId: uuidSchema,
  agentId: uuidSchema,
  schemaVersion: z.literal(EXTERNAL_AGENT_ACTIVATION_SCHEMA_VERSION),
  activation: externalActivationConfigSchema,
  enabled: z.boolean(),
  /** v1.1 §12: stored consumer mode — never derived from `enabled`. Pause/
   * unbind keep `delegated` constraints; only explicit rollback restores
   * `legacy`. Draft connections are `legacy` until cutover. */
  consumptionMode: z.enum(externalAgentConsumptionModeValues),
  /** v1.1: explicit pause/waiting reason — never implied by `enabled`, and
   * never presented as "the external process is alive". */
  pauseReason: z.string().nullable(),
  revision: z.number().int().nonnegative(),
  epoch: int64StringSchema,
  boundCredentialId: uuidSchema.nullable(),
  /** Sanitized secret facts only: configured + fingerprint hint. The
   * ciphertext material never leaves the server. */
  secretConfigured: z.boolean(),
  secretFingerprint: z.string().nullable(),
  pendingGeneration: int64StringSchema,
  currentRunId: uuidSchema.nullable(),
  createdAt: isoTimestampSchema,
  updatedAt: isoTimestampSchema,
});
export type ExternalAgentConnectionDto = z.infer<typeof externalAgentConnectionDtoSchema>;

export const inboxReceiptSourceSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("message"), messageId: uuidSchema, occurrenceKey: nonEmptyStringSchema }),
  z.strictObject({ kind: z.literal("third_party_event"), eventId: uuidSchema, occurrenceKey: nonEmptyStringSchema }),
]);
export type InboxReceiptSource = z.infer<typeof inboxReceiptSourceSchema>;

export const inboxReceiptDtoSchema = z.strictObject({
  id: uuidSchema,
  serverId: uuidSchema,
  agentId: uuidSchema,
  source: inboxReceiptSourceSchema,
  /** Stable event identity defined by the producer — never derived from seq
   * or guessed by the adapter. */
  sourceEventKey: nonEmptyStringSchema,
  admittedGeneration: int64StringSchema,
  state: z.enum(inboxReceiptStateValues),
  currentClaimId: uuidSchema.nullable(),
  ackDisposition: z.enum(inboxAckDispositionValues).nullable(),
  suppressReason: z.string().nullable(),
  resultRefs: z.array(nonEmptyStringSchema),
  createdAt: isoTimestampSchema,
  ackedAt: isoTimestampSchema.nullable(),
});
export type ExternalAgentInboxReceiptDto = z.infer<typeof inboxReceiptDtoSchema>;

export const wakeDtoSchema = z.strictObject({
  id: uuidSchema,
  connectionId: uuidSchema,
  connectionEpoch: int64StringSchema,
  generationAtCreation: int64StringSchema,
  /** v1.1 §12: authoritative retry-cycle locator, unique per
   * (connection, epoch, cycle). */
  cycle: int64StringSchema,
  state: z.enum(wakeStateValues),
  nextAttemptAt: isoTimestampSchema,
  attemptCount: z.number().int().nonnegative(),
  dispatchOwner: z.string().nullable(),
  dispatchFence: int64StringSchema,
  dispatchLeaseUntil: isoTimestampSchema.nullable(),
  startupDeadline: isoTimestampSchema.nullable(),
  blockReason: z.string().nullable(),
  exhaustedReason: z.string().nullable(),
  recoveryAuditRef: z.string().nullable(),
  createdAt: isoTimestampSchema,
});
export type ExternalAgentWakeDto = z.infer<typeof wakeDtoSchema>;

export const wakeAttemptDtoSchema = z.strictObject({
  id: uuidSchema,
  wakeId: uuidSchema,
  attemptNumber: z.number().int().positive(),
  connectionRevision: z.number().int().nonnegative(),
  connectionEpoch: int64StringSchema,
  dispatchFence: int64StringSchema,
  startedAt: isoTimestampSchema,
  finishedAt: isoTimestampSchema.nullable(),
  outcome: z.enum(attemptOutcomeValues).nullable(),
  httpStatus: z.number().int().nullable(),
  errorCode: z.string().nullable(),
  /** Grok v1 provides none — null is mandatory, never fabricated. */
  providerRunId: z.string().nullable(),
  requestDigest: nonEmptyStringSchema,
});
export type ExternalAgentWakeAttemptDto = z.infer<typeof wakeAttemptDtoSchema>;

export const runDtoSchema = z.strictObject({
  id: uuidSchema,
  connectionId: uuidSchema,
  connectionEpoch: int64StringSchema,
  agentId: uuidSchema,
  credentialId: uuidSchema,
  wakeId: uuidSchema,
  fence: int64StringSchema,
  /** v1.1 begin idempotency: replay of the same binding/epoch/key returns the
   * original run. Unique per (connectionId, connectionEpoch, beginRequestKey). */
  beginRequestKey: nonEmptyStringSchema,
  beginRequestDigest: nonEmptyStringSchema,
  state: z.enum(runStateValues),
  leaseExpiresAt: isoTimestampSchema,
  maxEndsAt: isoTimestampSchema,
  lastHeartbeatAt: isoTimestampSchema,
  finishedAt: isoTimestampSchema.nullable(),
  finishOutcome: z.enum(runFinishOutcomeValues).nullable(),
});
export type ExternalAgentRunDto = z.infer<typeof runDtoSchema>;
// NOTE: the owner token itself never appears in any DTO — only its hash is
// stored server-side and nothing about it is exported.

export const claimDtoSchema = z.strictObject({
  id: uuidSchema,
  serverId: uuidSchema,
  agentId: uuidSchema,
  connectionEpoch: int64StringSchema,
  runId: uuidSchema,
  fence: int64StringSchema,
  requestKey: nonEmptyStringSchema,
  receiptIds: z.array(uuidSchema).max(EXTERNAL_AGENT_CLAIM_MAX_RECEIPTS),
  state: z.enum(claimStateValues),
  expiresAt: isoTimestampSchema,
  createdAt: isoTimestampSchema,
});
export type ExternalAgentClaimDto = z.infer<typeof claimDtoSchema>;

// --- capability declaration (negotiated via agent-api contract in A2) ---------

export const externalAgentActivationCapabilityValues = [
  "activation.begin",
  "activation.heartbeat",
  "activation.block",
  "activation.finish",
  "activation.claim-v2",
  "activation.ack-v2",
] as const;
export type ExternalAgentActivationCapability = typeof externalAgentActivationCapabilityValues[number];

export const EXTERNAL_AGENT_ACTIVATION_CAPABILITIES: readonly ExternalAgentActivationCapability[] =
  externalAgentActivationCapabilityValues;
