import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import { and, count, eq, gte, isNull, sql } from "drizzle-orm";
import { encryptedSecretSchema, externalActivationConfigSchema, externalAgentConnectionDtoSchema, isExternalAgentRuntime, type EncryptedSecret, type ExternalActivationConfig } from "@botiverse/raft-shared";
import { getDb, type Database } from "../db/index.js";
import { agentCredentials, externalAgentConnections as connections, externalAgentWakes as wakes, productEvents } from "../db/schema.js";
import { databaseNow, DelegationError, readConnection, requireCredential, requireHumanManagement, withAgentTransaction, type ConnectionRow, type HumanIdentity } from "./agentTransactionAuthority.js";
import { currentWake, ensureWakeForPending, hasPending, maxRunStarts, recordRecovery, revokeConnectionExecution } from "./externalAgentDelegationState.js";

// The key ring is supplied by protected server configuration, never a body.
export class WebhookSecretBox {
  private readonly keys: ReadonlyMap<string, Buffer>;
  constructor(private readonly activeKeyId: string, keys: ReadonlyMap<string, Buffer>) {
    this.keys = new Map([...keys].map(([id, key]) => {
      if (!id || key.byteLength !== 32) throw new DelegationError("secret_key_invalid", 500);
      return [id, Buffer.from(key)];
    }));
    if (!this.keys.has(activeKeyId)) throw new DelegationError("secret_key_missing", 500);
  }
  private aad(connection: Pick<ConnectionRow, "serverId" | "agentId" | "id">) {
    return Buffer.from(JSON.stringify(["raft.external-agent.webhook.v1", connection.serverId, connection.agentId, connection.id]));
  }
  seal(connection: Pick<ConnectionRow, "serverId" | "agentId" | "id">, plaintext: string): EncryptedSecret {
    if (!plaintext || Buffer.byteLength(plaintext) > 4096) throw new DelegationError("webhook_secret_invalid", 400);
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", this.keys.get(this.activeKeyId)!, iv);
    cipher.setAAD(this.aad(connection));
    const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
    return { keyId: this.activeKeyId, ciphertext: ciphertext.toString("base64url"), iv: iv.toString("base64url"), authTag: cipher.getAuthTag().toString("base64url") };
  }
  open(connection: Pick<ConnectionRow, "serverId" | "agentId" | "id">, input: EncryptedSecret): string {
    try {
      const envelope = encryptedSecretSchema.parse(input);
      const key = this.keys.get(envelope.keyId);
      if (!key) throw new Error("unavailable");
      const iv = Buffer.from(envelope.iv, "base64url");
      const tag = Buffer.from(envelope.authTag, "base64url");
      if (iv.length !== 12 || tag.length !== 16) throw new Error("invalid");
      const decipher = createDecipheriv("aes-256-gcm", key, iv);
      decipher.setAAD(this.aad(connection));
      decipher.setAuthTag(tag);
      return Buffer.concat([decipher.update(Buffer.from(envelope.ciphertext, "base64url")), decipher.final()]).toString("utf8");
    } catch { throw new DelegationError("webhook_secret_unavailable", 503); }
  }
}

export function connectionDto(row: ConnectionRow) {
  return externalAgentConnectionDtoSchema.parse({
    id: row.id, serverId: row.serverId, agentId: row.agentId, schemaVersion: row.schemaVersion,
    activation: row.activation, enabled: row.enabled, consumptionMode: row.consumptionMode, pauseReason: row.pauseReason,
    revision: row.revision, epoch: row.epoch.toString(), boundCredentialId: row.boundCredentialId,
    secretConfigured: !!row.webhookSecret,
    secretFingerprint: row.webhookSecret ? createHash("sha256").update(row.webhookSecret.ciphertext).digest("hex").slice(0, 12) : null,
    pendingGeneration: row.pendingGeneration.toString(), currentRunId: row.currentRunId,
    createdAt: row.createdAt.toISOString(), updatedAt: row.updatedAt.toISOString(),
  });
}
function checkRevision(row: ConnectionRow | undefined, expected: number) {
  if (!row) throw new DelegationError("connection_missing", 404);
  if (row.revision !== expected) throw new DelegationError("revision_conflict");
  return row;
}

export class ExternalAgentConnectionService {
  constructor(private readonly secrets: WebhookSecretBox, private readonly db: Database = getDb()) {}

  async saveDraft(identity: HumanIdentity, agentId: string, activation: ExternalActivationConfig, expectedRevision: number | null) {
    const parsed = externalActivationConfigSchema.parse(activation);
    return withAgentTransaction([agentId], async (context) => {
      const agent = await requireHumanManagement(context, identity, agentId);
      if (!isExternalAgentRuntime(agent.runtime)) throw new DelegationError("external_agent_required", 400);
      const existing = await readConnection(context, agentId);
      const now = await databaseNow(context);
      if (!existing) {
        if (expectedRevision !== null) throw new DelegationError("revision_conflict");
        const [row] = await context.tx.insert(connections).values({ serverId: identity.serverId, agentId, activation: parsed, createdAt: now, updatedAt: now }).returning();
        return connectionDto(row);
      }
      checkRevision(existing, expectedRevision!);
      await revokeConnectionExecution(context, existing);
      const [row] = await context.tx.update(connections).set({ activation: parsed, enabled: false, pauseReason: "configuration_changed", epoch: existing.epoch + 1n, revision: existing.revision + 1, currentRunId: null, updatedAt: now })
        .where(eq(connections.id, existing.id)).returning();
      return connectionDto(row);
    }, this.db);
  }

  async bindCredential(identity: HumanIdentity, agentId: string, credentialId: string, expectedRevision: number) {
    return withAgentTransaction([agentId], async (context) => {
      await requireHumanManagement(context, identity, agentId, "issueAgentCredentials");
      const connection = checkRevision(await readConnection(context, agentId), expectedRevision);
      await revokeConnectionExecution(context, connection);
      await requireCredential(context, { serverId: identity.serverId, agentId, credentialId }, "read");
      const [row] = await context.tx.update(connections).set({ boundCredentialId: credentialId, enabled: false, pauseReason: "credential_changed", epoch: connection.epoch + 1n, revision: connection.revision + 1, currentRunId: null, updatedAt: await databaseNow(context) })
        .where(eq(connections.id, connection.id)).returning();
      return connectionDto(row);
    }, this.db);
  }

  async replaceWebhookSecret(identity: HumanIdentity, agentId: string, secret: string, expectedRevision: number) {
    return withAgentTransaction([agentId], async (context) => {
      await requireHumanManagement(context, identity, agentId);
      const connection = checkRevision(await readConnection(context, agentId), expectedRevision);
      await revokeConnectionExecution(context, connection);
      const [row] = await context.tx.update(connections).set({ webhookSecret: this.secrets.seal(connection, secret), enabled: false, pauseReason: "secret_changed", epoch: connection.epoch + 1n, revision: connection.revision + 1, currentRunId: null, updatedAt: await databaseNow(context) })
        .where(eq(connections.id, connection.id)).returning();
      return connectionDto(row);
    }, this.db);
  }

  async enableWithCutover(identity: HumanIdentity, agentId: string, expectedRevision: number, requestKey: string) {
    return withAgentTransaction([agentId], async (context) => {
      const agent = await requireHumanManagement(context, identity, agentId);
      const connection = checkRevision(await readConnection(context, agentId), expectedRevision);
      if (!isExternalAgentRuntime(agent.runtime) || agent.machineId || !connection.boundCredentialId || !connection.webhookSecret) throw new DelegationError("cutover_not_ready", 400);
      maxRunStarts(connection);
      await revokeConnectionExecution(context, connection);
      await requireCredential(context, { serverId: identity.serverId, agentId, credentialId: connection.boundCredentialId }, "read");
      // Converge other credentials rather than leaving an old CLI consumer live.
      await context.tx.update(agentCredentials).set({ revokedAt: await databaseNow(context), revokedReason: "delegation_cutover", revokedByUserId: identity.userId })
        .where(and(eq(agentCredentials.agentId, agentId), isNull(agentCredentials.revokedAt), sql`${agentCredentials.id} <> ${connection.boundCredentialId}`));
      const [row] = await context.tx.update(connections).set({ enabled: true, consumptionMode: "delegated", pauseReason: null, epoch: connection.epoch + 1n, revision: connection.revision + 1, currentRunId: null, updatedAt: await databaseNow(context) })
        .where(eq(connections.id, connection.id)).returning();
      await recordRecovery(context, row, identity, "cutover", requestKey);
      await ensureWakeForPending(context, row);
      return connectionDto(row);
    }, this.db);
  }

  async pause(identity: HumanIdentity, agentId: string, expectedRevision: number, requestKey: string, unbind = false) {
    return withAgentTransaction([agentId], async (context) => {
      await requireHumanManagement(context, identity, agentId);
      const connection = checkRevision(await readConnection(context, agentId), expectedRevision);
      await revokeConnectionExecution(context, connection);
      const [row] = await context.tx.update(connections).set({ enabled: false, pauseReason: unbind ? "unbound" : "paused", ...(unbind ? { boundCredentialId: null } : {}), epoch: connection.epoch + 1n, revision: connection.revision + 1, currentRunId: null, updatedAt: await databaseNow(context) })
        .where(eq(connections.id, connection.id)).returning();
      await recordRecovery(context, row, identity, unbind ? "unbind" : "pause", requestKey);
      return connectionDto(row);
    }, this.db);
  }

  async rollbackToLegacy(identity: HumanIdentity, agentId: string, expectedRevision: number, requestKey: string) {
    return withAgentTransaction([agentId], async (context) => {
      await requireHumanManagement(context, identity, agentId);
      const connection = checkRevision(await readConnection(context, agentId), expectedRevision);
      await revokeConnectionExecution(context, connection);
      // This dedicated authenticated-human action is the explicit confirmation;
      // an Agent context or boolean bypass cannot authorize rollback.
      const [row] = await context.tx.update(connections).set({ enabled: false, consumptionMode: "legacy", pauseReason: "rolled_back", epoch: connection.epoch + 1n, revision: connection.revision + 1, currentRunId: null, updatedAt: await databaseNow(context) })
        .where(eq(connections.id, connection.id)).returning();
      await recordRecovery(context, row, identity, "rollback", requestKey);
      return connectionDto(row);
    }, this.db);
  }

  async resumeBlocked(identity: HumanIdentity, agentId: string, expectedRevision: number, requestKey: string) {
    return withAgentTransaction([agentId], async (context) => {
      await requireHumanManagement(context, identity, agentId);
      const connection = checkRevision(await readConnection(context, agentId), expectedRevision);
      const wake = await currentWake(context, connection);
      if (!connection.enabled || connection.consumptionMode !== "delegated" || wake?.state !== "blocked") throw new DelegationError("not_blocked");
      const event = await recordRecovery(context, connection, identity, "resume", requestKey, wake.id);
      await context.tx.update(wakes).set({ state: "queued", blockReason: null, recoveryAuditRef: event.id, nextAttemptAt: await databaseNow(context) }).where(eq(wakes.id, wake.id));
      const [row] = await context.tx.update(connections).set({ pauseReason: null, revision: connection.revision + 1, updatedAt: await databaseNow(context) }).where(eq(connections.id, connection.id)).returning();
      return connectionDto(row);
    }, this.db);
  }

  async redriveExhausted(identity: HumanIdentity, agentId: string, expectedRevision: number, requestKey: string) {
    return withAgentTransaction([agentId], async (context) => {
      await requireHumanManagement(context, identity, agentId);
      const connection = await readConnection(context, agentId);
      if (!connection) throw new DelegationError("connection_missing", 404);
      const [replay] = await context.tx.select().from(productEvents).where(and(eq(productEvents.subjectId, connection.id), eq(productEvents.eventType, "external_agent.redrive"), eq(productEvents.idempotencyKey, requestKey))).limit(1);
      if (replay) return connectionDto(connection);
      checkRevision(connection, expectedRevision);
      const wake = await currentWake(context, connection);
      if (!connection.enabled || connection.consumptionMode !== "delegated" || wake?.state !== "exhausted") throw new DelegationError("not_exhausted");
      const now = await databaseNow(context);
      const [rate] = await context.tx.select({ total: count() }).from(productEvents).where(and(eq(productEvents.subjectId, connection.id), eq(productEvents.eventType, "external_agent.redrive"), gte(productEvents.occurredAt, new Date(now.getTime() - 3600000))));
      if (rate.total >= 5) throw new DelegationError("redrive_rate_limited", 429);
      const event = await recordRecovery(context, connection, identity, "redrive", requestKey, wake.id);
      await context.tx.insert(wakes).values({ connectionId: connection.id, connectionEpoch: connection.epoch, generationAtCreation: connection.pendingGeneration, cycle: wake.cycle + 1n, recoveryAuditRef: event.id, nextAttemptAt: now });
      const [row] = await context.tx.update(connections).set({ pauseReason: null, revision: connection.revision + 1, updatedAt: now }).where(eq(connections.id, connection.id)).returning();
      return connectionDto(row);
    }, this.db);
  }
}
