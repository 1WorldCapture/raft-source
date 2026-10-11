/**
 * Upstream 1.21.2 port (packages/server/src/db/transientTransactionRetry.ts).
 *
 * SQLSTATEs where PostgreSQL aborted *this* transaction because a concurrent
 * one won a race: 40P01 deadlock_detected, 40001 serialization_failure. The
 * transaction rolled back wholesale, so re-running it from the start is safe
 * as long as the unit being retried has no side effects outside it.
 *
 * 取舍 (departure from upstream): upstream's nested-call guard reads an
 * ambient AsyncLocalStorage transaction scope that our db layer does not
 * have. `isNested` stays an injectable hook; the default assumes the caller
 * is NOT inside an outer transaction. Callers must only wrap a `run` that
 * fully owns one transaction (same invariant upstream documents).
 */
export type TransientTransactionSqlState = "40P01" | "40001";

/** Recover a transient-conflict SQLSTATE from an error or its cause chain. */
export function transientTransactionSqlState(error: unknown): TransientTransactionSqlState | null {
  const seen = new Set<unknown>();
  let current = error;
  while (current && typeof current === "object" && !seen.has(current)) {
    seen.add(current);
    const code = (current as { code?: unknown }).code;
    if (code === "40P01" || code === "40001") return code;
    current = (current as { cause?: unknown }).cause;
  }
  return null;
}

export const TRANSIENT_TRANSACTION_MAX_ATTEMPTS = 3;
export const TRANSIENT_TRANSACTION_BASE_DELAY_MS = 25;

export interface TransientTransactionRetryOptions {
  maxAttempts?: number;
  baseDelayMs?: number;
  /** Overridable so tests do not sleep for real. */
  sleep?: (ms: number) => Promise<void>;
  /** Called before each re-run with the attempt that just failed. */
  onRetry?: (info: { attempt: number; sqlState: TransientTransactionSqlState; delayMs: number }) => void;
  /**
   * True while the caller runs inside an ambient outer transaction: the
   * conflict aborted the outer transaction too, so only its owner may re-run
   * and nothing is retried. Our db layer has no ambient scope — callers that
   * nest must pass `() => true` explicitly.
   */
  isNested?: () => boolean;
}

function jitteredDelayMs(attempt: number, baseDelayMs: number): number {
  // Full jitter so two transactions that just deadlocked do not re-collide in lockstep.
  const ceiling = baseDelayMs * 2 ** (attempt - 1);
  return Math.floor(ceiling / 2) + Math.floor(Math.random() * ceiling);
}

/**
 * Run `run` (which must open, and fully own, one database transaction) and
 * re-run it on 40P01/40001, up to `maxAttempts` total attempts. Any other
 * error, and the last attempt's conflict, is rethrown unchanged so callers
 * can still classify it.
 */
export async function withTransientTransactionRetry<T>(
  run: (attempt: number) => Promise<T>,
  options: TransientTransactionRetryOptions = {},
): Promise<T> {
  const maxAttempts = options.maxAttempts ?? TRANSIENT_TRANSACTION_MAX_ATTEMPTS;
  const baseDelayMs = options.baseDelayMs ?? TRANSIENT_TRANSACTION_BASE_DELAY_MS;
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const isNested = options.isNested ?? (() => false);
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await run(attempt);
    } catch (error) {
      const sqlState = transientTransactionSqlState(error);
      if (!sqlState || attempt >= maxAttempts || isNested()) throw error;
      const delayMs = jitteredDelayMs(attempt, baseDelayMs);
      options.onRetry?.({ attempt, sqlState, delayMs });
      await sleep(delayMs);
    }
  }
}
