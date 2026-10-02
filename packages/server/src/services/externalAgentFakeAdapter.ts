import { wakePayloadSchema } from "@botiverse/raft-shared";
import { dispatchResultSchema, type DispatchResult } from "./externalAgentDispatchPolicy.js";
import type { WakeAdapter, WakePayload } from "./externalAgentDelegationWorker.js";

export type FakeWakeStep = { result: DispatchResult; barrier?: Promise<void>; onWake?: (payload: WakePayload, signal: AbortSignal) => Promise<void> };

// The script owns simulated Routine behavior; no URLs, secrets, HTTP or browsers.
export class DeterministicFakeWakeAdapter implements WakeAdapter {
  readonly mode = "fake" as const;
  readonly calls: WakePayload[] = [];
  private readonly steps: FakeWakeStep[];
  private inFlight = 0;
  constructor(steps: readonly FakeWakeStep[]) {
    this.steps = steps.map((step) => ({ ...step, result: dispatchResultSchema.parse(step.result) }));
  }
  get pendingCalls() { return this.inFlight; }
  async deliver(input: WakePayload, signal: AbortSignal): Promise<DispatchResult> {
    const payload = wakePayloadSchema.parse(input);
    if (signal.aborted) return { kind: "unknown", reason: "worker_cancelled" };
    const step = this.steps.shift();
    if (!step) throw new Error("fake script exhausted");
    this.calls.push(structuredClone(payload));
    this.inFlight++;
    let cancel!: () => void;
    const aborted = new Promise<void>((resolve) => { cancel = resolve; });
    signal.addEventListener("abort", cancel, { once: true });
    try {
      if (step.barrier) await Promise.race([step.barrier, aborted]);
      if (signal.aborted) return { kind: "unknown", reason: "worker_cancelled" };
      if (step.onWake) await step.onWake(structuredClone(payload), signal);
      if (signal.aborted) return { kind: "unknown", reason: "worker_cancelled" };
      return structuredClone(step.result);
    } finally { signal.removeEventListener("abort", cancel); this.inFlight--; }
  }
}
