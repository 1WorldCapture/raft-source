// Recycle the local Computer service: stop, confirm it is really gone, then
// start it again from THIS app. This is the remedy for a version-skewed
// resident (a service from another install that start() refuses to adopt) —
// the existing card "Restart" only clears degraded state (resetService) and
// never restarts the process.
//
// The sequence is factored into a pure orchestrator with injected effects so
// the ordering and every failure branch are unit-testable without electron or
// a live service. Failure codes are surfaced through the same ConvergeState
// channel as startup converge failures; a failed START leaves the machine
// stopped, so the renderer's retry for it must be start-only (never re-stop).

import { reduceConvergeFailure, type ConvergeState } from "./convergeState.js";

export const RECYCLE_STOP_FAILED = "RECYCLE_STOP_FAILED";
export const RECYCLE_START_FAILED = "RECYCLE_START_FAILED";

export interface RecycleDeps {
  stop(): Promise<void>;
  start(): Promise<void>;
  /** True once no live service remains (poll after stop resolves). */
  isCleared(): Promise<boolean>;
  delay(ms: number): Promise<void>;
  /** Abort pending waits; called when the overall budget is exhausted. */
  onTimeout?(): void;
  settle(state: ConvergeState): void;
}

export interface RecycleOptions {
  /** Per-poll wait after stop() resolves before re-checking isCleared. */
  clearPollMs?: number;
  /** Total budget for confirming the service is gone after stop() resolves. */
  clearTimeoutMs?: number;
}

export const DEFAULT_CLEAR_POLL_MS = 250;
export const DEFAULT_CLEAR_TIMEOUT_MS = 15_000;

class RecycleTimeoutError extends Error {}

/**
 * Run stop → wait-for-clear → start. Throws only {code, message} reduced
 * errors (also reported through deps.settle so the host's ConvergeState is
 * authoritative even if the caller merely logs the rejection).
 */
export async function runServiceRecycle(deps: RecycleDeps, options: RecycleOptions = {}): Promise<void> {
  const pollMs = options.clearPollMs ?? DEFAULT_CLEAR_POLL_MS;
  const timeoutMs = options.clearTimeoutMs ?? DEFAULT_CLEAR_TIMEOUT_MS;
  try {
    await deps.stop();
  } catch (error) {
    const failure = reduceConvergeFailure("Could not stop the local Computer service: ", error);
    deps.settle({ ok: false, code: RECYCLE_STOP_FAILED, message: `${failure.message} (the service was left as-is.)` });
    throw Object.assign(new Error(failure.message), { code: RECYCLE_STOP_FAILED });
  }
  // stop() resolving should mean "exited", but the detached tree converges
  // asynchronously — confirm no live service remains before spawning a
  // successor, with a bounded budget (never force-kill on timeout).
  const deadline = Date.now() + timeoutMs;
  while (!(await deps.isCleared())) {
    if (Date.now() >= deadline) {
      deps.onTimeout?.();
      const message = `Stopped the local Computer service, but it did not fully exit within ${Math.round(timeoutMs / 1000)}s. Nothing was force-killed; check Activity Monitor and retry.`;
      deps.settle({ ok: false, code: RECYCLE_STOP_FAILED, message });
      throw Object.assign(new RecycleTimeoutError(message), { code: RECYCLE_STOP_FAILED });
    }
    await deps.delay(pollMs);
  }
  try {
    await deps.start();
  } catch (error) {
    const failure = reduceConvergeFailure("Stopped the old service, but starting the new one failed: ", error);
    // The machine is STOPPED now — the renderer must offer start-only retry.
    deps.settle({ ok: false, code: RECYCLE_START_FAILED, message: `${failure.message} (Retry starts the service — no second stop.)` });
    throw Object.assign(new Error(failure.message), { code: RECYCLE_START_FAILED });
  }
  deps.settle({ ok: true });
}
