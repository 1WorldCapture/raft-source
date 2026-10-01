// Fork patch (ZCode integration): process-then-ack inbox.
//
// `raft message claim` prints a batch without acknowledging it and ends with a
// single `Claim-Ack: <token>` line. The token is base64url JSON of the batch's
// ack ids (no secrets); `raft message ack` replays it to /events/ack after the
// caller has durably recorded the batch.

import type { AgentApiEventsAckBatch } from "@botiverse/raft-shared";

export const CLAIM_ACK_LINE_PREFIX = "Claim-Ack: ";

const TOKEN_VERSION = 1;

interface ClaimAckTokenPayload {
  v: number;
  s: number[];
  m: string[];
  t: string[];
}

export function encodeClaimAckToken(batch: AgentApiEventsAckBatch): string {
  const payload: ClaimAckTokenPayload = {
    v: TOKEN_VERSION,
    s: batch.seqs,
    m: batch.message_ids,
    t: batch.third_party_event_ids,
  };
  return Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
}

export function decodeClaimAckToken(token: string): AgentApiEventsAckBatch | null {
  const trimmed = token.trim().startsWith(CLAIM_ACK_LINE_PREFIX)
    ? token.trim().slice(CLAIM_ACK_LINE_PREFIX.length).trim()
    : token.trim();
  if (!/^[A-Za-z0-9_-]+$/.test(trimmed)) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(trimmed, "base64url").toString("utf8"));
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object") return null;
  const p = parsed as Partial<ClaimAckTokenPayload>;
  if (p.v !== TOKEN_VERSION) return null;
  const isIntArray = (value: unknown): value is number[] =>
    Array.isArray(value) && value.every((n) => Number.isInteger(n) && n > 0);
  const isStringArray = (value: unknown): value is string[] =>
    Array.isArray(value) && value.every((s) => typeof s === "string" && s.length > 0);
  if (!isIntArray(p.s) || !isStringArray(p.m) || !isStringArray(p.t)) return null;
  return { seqs: p.s, message_ids: p.m, third_party_event_ids: p.t };
}

export function isEmptyAckBatch(batch: AgentApiEventsAckBatch): boolean {
  return batch.seqs.length === 0 && batch.message_ids.length === 0 && batch.third_party_event_ids.length === 0;
}
