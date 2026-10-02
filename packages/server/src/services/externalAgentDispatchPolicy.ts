import { z } from "zod";

// Transport adapters return facts, never provider-controlled diagnostic text.
export const dispatchResultSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("http"), status: z.number().int().min(100).max(599), retryAfterMs: z.number().finite().nonnegative().optional() }).strict(),
  z.object({ kind: z.literal("unknown"), reason: z.enum(["network_failure", "deadline_exceeded", "worker_cancelled", "adapter_failure"]) }).strict(),
]);
export type DispatchResult = z.infer<typeof dispatchResultSchema>;
export type DispatchDecision = {
  outcome: "accepted" | "rejected" | "unknown";
  httpStatus?: number;
  errorCode?: string;
  blockReason?: string;
  retryDelayMs: number;
};
export const DISPATCH_DEADLINE_MS = 10000;
export const DISPATCH_LEASE_MS = 15000;
export const MAX_DISPATCH_BACKOFF_MS = 300000;

export function classifyDispatchResult(input: unknown, attemptNumber: number, jitterUnit: number): DispatchDecision {
  const parsed = dispatchResultSchema.safeParse(input);
  const result: DispatchResult = parsed.success ? parsed.data : { kind: "unknown", reason: "adapter_failure" };
  if (!Number.isSafeInteger(attemptNumber) || attemptNumber < 1 || !Number.isFinite(jitterUnit) || jitterUnit < 0 || jitterUnit > 1) throw new Error("invalid dispatch policy input");
  const backoff = Math.min(MAX_DISPATCH_BACKOFF_MS, Math.ceil(1000 * 2 ** Math.min(attemptNumber - 1, 12) * (0.5 + jitterUnit)));
  if (result.kind === "unknown") return { outcome: "unknown", errorCode: result.reason, retryDelayMs: backoff };
  const httpStatus = result.status;
  if (httpStatus === 200) return { outcome: "accepted", httpStatus, retryDelayMs: 0 };
  if ([401, 403, 404, 410].includes(httpStatus)) return { outcome: "rejected", httpStatus,
    errorCode: httpStatus === 401 || httpStatus === 403 ? "provider_auth_rejected" : "provider_endpoint_unavailable",
    blockReason: httpStatus === 401 || httpStatus === 403 ? "provider_auth_rejected" : "provider_endpoint_unavailable", retryDelayMs: 0 };
  if (httpStatus === 429) return { outcome: "rejected", httpStatus, errorCode: "provider_rate_limited",
    retryDelayMs: Math.ceil(Math.min(MAX_DISPATCH_BACKOFF_MS, Math.max(backoff, result.retryAfterMs ?? 0))) };
  return { outcome: "rejected", httpStatus, errorCode: httpStatus >= 500 ? "provider_transient_failure" : "provider_protocol_mismatch", retryDelayMs: backoff };
}
