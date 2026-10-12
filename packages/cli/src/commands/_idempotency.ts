import { randomUUID } from "node:crypto";

import { cliError } from "../core/errors.js";

export const IDEMPOTENCY_KEY_OPTION = {
  flags: "--idempotency-key <key>",
  description:
    "Retry key (1-256 chars). Defaults to a fresh random key per invocation; repeat the same key to retry safely: the server replays the first result instead of writing again.",
} as const;

/** One key per invocation: explicit `--idempotency-key` wins, otherwise a random one. */
export function resolveIdempotencyKey(explicit: string | undefined): string {
  if (explicit === undefined) return randomUUID();
  const key = explicit.trim();
  if (key.length === 0 || key.length > 256) {
    throw cliError("INVALID_ARG", "--idempotency-key must be 1-256 characters");
  }
  return key;
}

/**
 * A failed write whose outcome is unknown (no HTTP answer, or a 5xx) may have
 * been applied. Tell the caller which key makes a rerun safe.
 */
export function withIdempotencyRetryHint(message: string, status: number, key: string): string {
  if (status !== 0 && status < 500) return message;
  return `${message} (the request may have been applied; to retry safely rerun with --idempotency-key ${key})`;
}
