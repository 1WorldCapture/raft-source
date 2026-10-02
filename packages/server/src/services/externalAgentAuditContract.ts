import { z } from "zod";
const uuid = z.string().uuid();
export const externalRecoveryEventSchema = z.object({
  connectionId: uuid, serverId: uuid, agentId: uuid, userId: uuid,
  operation: z.enum(["cutover", "pause", "unbind", "rollback", "resume", "redrive"]),
  requestKey: z.string().min(1).max(200), requestRevision: z.number().int().nonnegative(),
  revision: z.number().int().nonnegative(), epoch: z.string().regex(/^(0|[1-9][0-9]*)$/),
  previousWakeId: uuid.nullable(),
  cutoverManifest: z.object({
    version: z.literal(1), proof: z.enum(["same_transaction_new_agent", "durable_receipts"]),
    legacyCandidateIds: z.array(uuid).length(0),
  }).strict().nullable(),
}).strict();
export const externalHandoffEventSchema = z.object({
  receiptId: uuid, serverId: uuid, agentId: uuid, taskId: uuid, userId: uuid,
}).strict();
