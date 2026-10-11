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
  /** True when the new service is up and answering. Used to turn a start() "timeout" into success. */
  isRunning?(): Promise<boolean>;
  /** Abort pending waits; called when the overall budget is exhausted. */
  onTimeout?(): void;
  settle(state: ConvergeState): void;
  /** Ask the status monitor to re-read and push now (the state the card shows just changed). */
  notify?(): void;
}

export interface RecycleOptions {
  /** Per-poll wait after stop() resolves before re-checking isCleared. */
  clearPollMs?: number;
  /** Total budget for confirming the service is gone after stop() resolves. */
  clearTimeoutMs?: number;
  /** After start() throws, how long to keep checking whether the service came up anyway. */
  startRecoveryMs?: number;
}

export const DEFAULT_CLEAR_POLL_MS = 250;
export const DEFAULT_CLEAR_TIMEOUT_MS = 15_000;
// `start` gives up waiting for readiness after a fixed time, but "old service stopped + new one up + reconnected to
// every server" can take longer; the service then comes up right after the failure was reported (0.2.0 upgrade retest).
export const DEFAULT_START_RECOVERY_MS = 30_000;

class RecycleTimeoutError extends Error {}

async function waitUntilRunning(deps: RecycleDeps, budgetMs: number, pollMs: number): Promise<boolean> {
  const deadline = Date.now() + budgetMs;
  for (;;) {
    try {
      if (await deps.isRunning!()) return true;
    } catch {
      // not readable yet: keep waiting
    }
    if (Date.now() >= deadline) return false;
    await deps.delay(Math.max(pollMs, 1_000));
  }
}

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
  // The old service is gone: whatever it left in the converge state (typically SERVICE_VERSION_SKEW, the very reason
  // the user pressed Replace) is no longer true. Clearing it only after start() finished left the stale message and the
  // old version on the card for the whole stop + start + readiness wait (~20s, longer on a slow reconnect).
  deps.settle({ ok: true });
  deps.notify?.();
  try {
    await deps.start();
  } catch (error) {
    if (deps.isRunning && (await waitUntilRunning(deps, options.startRecoveryMs ?? DEFAULT_START_RECOVERY_MS, pollMs))) {
      deps.settle({ ok: true });
      return;
    }
    const failure = reduceConvergeFailure("Stopped the old service, but starting the new one failed: ", error);
    // The machine is STOPPED now — the renderer must offer start-only retry.
    deps.settle({ ok: false, code: RECYCLE_START_FAILED, message: `${failure.message} (Retry starts the service — no second stop.)` });
    throw Object.assign(new Error(failure.message), { code: RECYCLE_START_FAILED });
  }
  deps.settle({ ok: true });
  deps.notify?.();
}
