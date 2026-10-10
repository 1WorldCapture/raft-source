// A migration that was already running when the app (re)started: the app took no part in starting it (it died
// mid-move, or was restarted), but it must not leave the user with a window that cannot open or a built-in host that
// converges underneath it. The window opens at once with the migration's progress and a Cancel button; this watches
// the Computer's in-progress marker, and when the command ends it finishes the switch (success) or reports the
// outcome, then restarts the app so the normal launch decision picks the right mode.
import type { InProgressMarker, MigrationResultSummary } from "./migrationRecovery.js";
import type { MigrationState } from "./migration.js";

export interface SupervisorDeps {
  marker: InProgressMarker;
  /** Re-read the marker (step / deadline move on). */
  readMarker: (home: string) => Promise<InProgressMarker | null>;
  readResult: (home: string) => Promise<(MigrationResultSummary & { error?: string | null; reason?: string | null; startedAt?: string | null }) | null>;
  isAlive: (pid: number) => boolean;
  signal: (pid: number, signal: NodeJS.Signals) => void;
  /** Success: copy the Cursor SDK, write the standalone marker. */
  finish: (to: string) => Promise<{ warnings: string[] }>;
  relaunch: () => void;
  publish: (state: MigrationState) => void;
  sleep?: (ms: number) => Promise<void>;
  pollMs?: number;
}

export class MigrationSupervisor {
  private state: MigrationState;
  private current: InProgressMarker;
  private restartOnReset = false;

  constructor(private readonly deps: SupervisorDeps) {
    this.current = deps.marker;
    this.state = {
      phase: "applying", from: deps.marker.from, to: deps.marker.to,
      steps: deps.marker.step ? [{ step: deps.marker.step, status: "start" }] : [],
      blockers: [], warnings: [], error: null, resultFile: null, relaunching: false, slow: false,
      inPlace: deps.marker.from !== null && deps.marker.from === deps.marker.to,
      cancellable: Boolean(deps.marker.deadlineAt), cancelRequested: false, reason: null, supervising: true, deadlineAt: deps.marker.deadlineAt ?? null,
    };
  }

  getState(): MigrationState { return this.state; }
  async plan(): Promise<MigrationState> { return this.state; }
  async apply(): Promise<MigrationState> { return this.state; }

  cancel(): MigrationState {
    if (this.state.phase !== "applying" || !this.state.cancellable || this.state.cancelRequested) return this.state;
    try { this.deps.signal(this.current.pid, "SIGTERM"); } catch { /* already gone */ }
    return this.set({ ...this.state, cancelRequested: true });
  }

  /** Closing the result: restart so the normal launch decision (built-in or standalone) runs. */
  reset(): MigrationState {
    if (this.restartOnReset) this.deps.relaunch();
    return this.state;
  }

  /** Watch until the command is gone, then settle. Never throws. */
  async run(): Promise<void> {
    const sleep = this.deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
    try {
      while (this.deps.isAlive(this.current.pid)) {
        const fresh = await this.deps.readMarker(this.current.home);
        if (fresh) {
          this.current = fresh;
          this.set({ ...this.state, cancellable: Boolean(fresh.deadlineAt) && !this.state.cancelRequested, to: fresh.to ?? this.state.to, deadlineAt: fresh.deadlineAt ?? this.state.deadlineAt ?? null,
            steps: fresh.step ? [{ step: fresh.step, status: "start" }] : this.state.steps });
        }
        await sleep(this.deps.pollMs ?? 1000);
      }
      await this.settle();
    } catch (error) {
      this.restartOnReset = true;
      this.set({ ...this.state, phase: "error", cancellable: false, error: error instanceof Error ? error.message : String(error) });
    }
  }

  private async settle(): Promise<void> {
    const homes = [...new Set([this.state.to, this.state.from, this.current.home].filter((h): h is string => !!h))];
    let result: Awaited<ReturnType<SupervisorDeps["readResult"]>> = null;
    for (const home of homes) {
      const r = await this.deps.readResult(home);
      if (r && (!this.current.startedAt || !r.startedAt || r.startedAt >= this.current.startedAt)) { result = r; break; }
    }
    const base = { ...this.state, cancellable: false };
    if (!result) {
      this.restartOnReset = true;
      this.set({ ...base, phase: "error", error: "The migration ended without reporting a result. The app will restart and check the Computer's state." });
      return;
    }
    if (result.result === "success" && result.to) {
      try {
        const { warnings } = await this.deps.finish(result.to);
        this.set({ ...base, phase: "success", to: result.to, warnings, relaunching: true });
        setTimeout(() => this.deps.relaunch(), 4_000);
      } catch (error) {
        this.restartOnReset = true;
        this.set({ ...base, phase: "error", to: result.to, error: `The Computer was moved to ${result.to}, but this app could not switch to it: ${error instanceof Error ? error.message : String(error)}.` });
      }
      return;
    }
    this.restartOnReset = true;
    this.set({ ...base, phase: result.result === "rolled_back" ? "rolled_back" : "failed", error: result.error ?? null, reason: result.reason ?? null });
  }

  private set(next: MigrationState): MigrationState {
    this.state = next;
    this.deps.publish(next);
    return next;
  }
}
