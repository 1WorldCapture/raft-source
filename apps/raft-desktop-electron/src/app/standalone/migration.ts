// One-click migration of the app-hosted ("embedded") Computer to an independent `raft-computer`
// (#computer-extract PR 5). The move itself is the Computer's own `migrate-home` command (stop → move the home to
// ~/.slock → start standalone → self-check → automatic rollback); the desktop only drives it and shows what it says:
//
//   plan()   -> `migrate-home --from <home> --json`            (dry run: plan or blockers, changes nothing)
//   apply()  -> `migrate-home --from <home> --apply --json`    (only after a plan came back ready)
//   success  -> write computer-host.json {standalone, to}, copy the Cursor SDK next to the moved home, relaunch the app
//   anything else leaves the app in embedded mode.
//
// `migrate-home --json` prints one event per line ({step, status, detail?}); the last line is either the result
// file ({result: success|rolled_back|failed, from, to, error, rollback, serviceState, steps}) or, for a dry run,
// {dryRun: true, outcome: planned|blocked, blocked}.
import { spawn } from "node:child_process";
import path from "node:path";

export interface MigrationEvent {
  step: string;
  status: string;
  detail?: Record<string, unknown>;
}

export type MigrationOutcome = "planned" | "blocked" | "success" | "rolled_back" | "failed" | "error";

export interface MigrationFinal {
  result: "success" | "rolled_back" | "failed";
  from: string | null;
  to: string | null;
  error: string | null;
  serviceState: string | null;
}

export type MigrationLine =
  | { kind: "event"; event: MigrationEvent }
  | { kind: "result"; final: MigrationFinal }
  | { kind: "dry-run"; outcome: "planned" | "blocked" }
  | { kind: "other" };

const str = (value: unknown): string | null => (typeof value === "string" ? value : null);

export function parseMigrationLine(line: string): MigrationLine {
  let raw: unknown;
  try {
    raw = JSON.parse(line);
  } catch {
    return { kind: "other" };
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { kind: "other" };
  const obj = raw as Record<string, unknown>;
  if (obj.result === "success" || obj.result === "rolled_back" || obj.result === "failed") {
    return { kind: "result", final: { result: obj.result, from: str(obj.from), to: str(obj.to), error: str(obj.error), serviceState: str(obj.serviceState) } };
  }
  if (obj.dryRun === true) return { kind: "dry-run", outcome: obj.outcome === "blocked" || obj.blocked === true ? "blocked" : "planned" };
  if (typeof obj.step === "string" && typeof obj.status === "string") {
    const detail = obj.detail && typeof obj.detail === "object" && !Array.isArray(obj.detail) ? (obj.detail as Record<string, unknown>) : undefined;
    return { kind: "event", event: { step: obj.step, status: obj.status, ...(detail ? { detail } : {}) } };
  }
  return { kind: "other" };
}

export interface MigrateRun {
  outcome: MigrationOutcome;
  events: MigrationEvent[];
  final: MigrationFinal | null;
  /** Last lines of stderr, for the "error" outcome (no usable final line: crash, unknown command, missing binary). */
  detail: string | null;
  exitCode: number | null;
}

export interface MigrateRunInput {
  binaryPath: string;
  from: string;
  apply: boolean;
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
  onEvent?: (event: MigrationEvent) => void;
}

export type MigrateRunner = (input: MigrateRunInput) => Promise<MigrateRun>;

/** Run `raft-computer migrate-home` and fold its NDJSON stream into a MigrateRun. Never throws. */
export const runMigrateHome: MigrateRunner = (input) =>
  new Promise((resolve) => {
    const args = ["migrate-home", "--from", input.from, ...(input.apply ? ["--apply"] : []), "--json"];
    const events: MigrationEvent[] = [];
    let final: MigrationFinal | null = null;
    let dry: "planned" | "blocked" | null = null;
    let stdoutRest = "";
    let stderrTail = "";
    let settled = false;
    const finish = (exitCode: number | null, spawnError?: string) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (stdoutRest.trim()) consume(stdoutRest);
      const outcome: MigrationOutcome = final ? final.result : dry ?? "error";
      const detail = outcome === "error" ? spawnError ?? (stderrTail.trim().split("\n").filter(Boolean).slice(-3).join(" ") || `raft-computer exited with ${exitCode} and no result`) : null;
      resolve({ outcome, events, final, detail, exitCode });
    };
    const consume = (line: string) => {
      const parsed = parseMigrationLine(line.trim());
      if (parsed.kind === "event") {
        events.push(parsed.event);
        input.onEvent?.(parsed.event);
      } else if (parsed.kind === "result") final = parsed.final;
      else if (parsed.kind === "dry-run") dry = parsed.outcome;
    };
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(input.binaryPath, args, { env: input.env ?? process.env, stdio: ["ignore", "pipe", "pipe"] });
    } catch (error) {
      resolve({ outcome: "error", events, final: null, detail: String(error), exitCode: null });
      return;
    }
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      finish(null, "migrate-home timed out");
    }, input.timeoutMs ?? 10 * 60_000);
    child.stdout?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => {
      stdoutRest += chunk;
      const lines = stdoutRest.split("\n");
      stdoutRest = lines.pop() ?? "";
      for (const line of lines) if (line.trim()) consume(line);
    });
    child.stderr?.setEncoding("utf8");
    child.stderr?.on("data", (chunk: string) => { stderrTail = (stderrTail + chunk).slice(-2000); });
    child.on("error", (error) => finish(null, String(error.message || error)));
    child.on("close", (code) => finish(code));
  });

// --- controller --------------------------------------------------------------------------------------------

export type MigrationPhase = "unavailable" | "idle" | "checking" | "ready" | "blocked" | "applying" | "success" | "rolled_back" | "failed" | "error";

export interface MigrationState {
  phase: MigrationPhase;
  from: string | null;
  to: string | null;
  /** Latest status of each step, in order of first appearance. */
  steps: MigrationEvent[];
  blockers: string[];
  warnings: string[];
  error: string | null;
  resultFile: string | null;
  /** The app restarts itself shortly after a successful move. */
  relaunching: boolean;
}

export interface MigrationDeps {
  /** Embedded mode with a Computer bundled in the app. Otherwise the whole feature is hidden. */
  available: boolean;
  getFromHome: () => Promise<string>;
  /** Make sure a raft-computer with migrate-home is installed; returns its path. Throws with a readable message. */
  ensureBinary: () => Promise<string>;
  run?: MigrateRunner;
  /** After a successful move: switch the app to standalone mode and prepare the restart. Throws if that fails. */
  afterSuccess: (to: string) => Promise<{ warnings: string[] }>;
  publish: (state: MigrationState) => void;
}

const EMPTY: MigrationState = { phase: "idle", from: null, to: null, steps: [], blockers: [], warnings: [], error: null, resultFile: null, relaunching: false };
const resultFileOf = (home: string | null) => (home ? path.join(home, "computer", "migrate-result.json") : null);
const strings = (value: unknown): string[] => (Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : []);

export class MigrationController {
  private state: MigrationState;
  private busy = false;

  constructor(private readonly deps: MigrationDeps) {
    this.state = { ...EMPTY, phase: deps.available ? "idle" : "unavailable" };
  }

  getState(): MigrationState {
    return this.state;
  }

  /** Dry run: what would move and whether anything blocks it. Changes nothing on the machine. */
  async plan(): Promise<MigrationState> {
    if (this.state.phase === "unavailable" || this.busy || this.state.phase === "applying" || this.state.phase === "success") return this.state;
    this.busy = true;
    try {
      this.set({ ...EMPTY, phase: "checking" });
      const prepared = await this.prepare();
      if (!prepared) return this.state;
      const run = await (this.deps.run ?? runMigrateHome)({ binaryPath: prepared.binaryPath, from: prepared.from, apply: false, onEvent: (e) => this.addStep(e) });
      return this.settle(run, prepared.from);
    } finally {
      this.busy = false;
    }
  }

  /** Do the move. Only after a plan came back ready in this session. */
  async apply(): Promise<MigrationState> {
    if (this.state.phase !== "ready" || this.busy) return this.state;
    this.busy = true;
    try {
      const planned = this.state;
      this.set({ ...EMPTY, phase: "applying", from: planned.from, to: planned.to });
      const prepared = await this.prepare(planned.from);
      if (!prepared) return this.state;
      const run = await (this.deps.run ?? runMigrateHome)({ binaryPath: prepared.binaryPath, from: prepared.from, apply: true, onEvent: (e) => this.addStep(e) });
      if (run.outcome === "success") {
        const to = run.final?.to ?? planned.to;
        try {
          const { warnings } = await this.deps.afterSuccess(to ?? "");
          return this.set({ ...this.state, phase: "success", to, warnings, resultFile: resultFileOf(to), relaunching: true });
        } catch (error) {
          return this.set({ ...this.state, phase: "error", to, resultFile: resultFileOf(to), error: `The Computer was moved to ${to}, but this app could not switch to it: ${error instanceof Error ? error.message : String(error)}. Do not quit the app; ask for help.` });
        }
      }
      return this.settle(run, prepared.from);
    } finally {
      this.busy = false;
    }
  }

  /** Back to the start after a blocked / failed / rolled-back / error result (or a cancelled plan). */
  reset(): MigrationState {
    if (this.busy || this.state.phase === "unavailable" || this.state.phase === "applying" || this.state.phase === "success") return this.state;
    return this.set({ ...EMPTY });
  }

  private async prepare(knownFrom?: string | null): Promise<{ binaryPath: string; from: string } | null> {
    try {
      const from = knownFrom ?? (await this.deps.getFromHome());
      const binaryPath = await this.deps.ensureBinary();
      this.set({ ...this.state, from });
      return { binaryPath, from };
    } catch (error) {
      this.set({ ...this.state, phase: "error", error: error instanceof Error ? error.message : String(error) });
      return null;
    }
  }

  private settle(run: MigrateRun, from: string): MigrationState {
    const preflight = run.events.find((e) => e.step === "preflight" && (e.status === "ok" || e.status === "blocked"));
    const to = run.final?.to ?? str(preflight?.detail?.to) ?? this.state.to;
    const common = { ...this.state, from: run.final?.from ?? from, to, warnings: strings(preflight?.detail?.warnings) };
    switch (run.outcome) {
      case "planned":
        return this.set({ ...common, phase: "ready" });
      case "blocked":
        return this.set({ ...common, phase: "blocked", blockers: strings(preflight?.detail?.blockers) });
      case "success":
        return this.set({ ...common, phase: "success" });
      case "rolled_back":
        return this.set({ ...common, phase: "rolled_back", error: run.final?.error ?? null, resultFile: resultFileOf(from) });
      case "failed":
        return this.set({ ...common, phase: "failed", error: run.final?.error ?? null, resultFile: resultFileOf(from) });
      case "error":
        return this.set({ ...common, phase: "error", error: run.detail ?? "The migration command did not report a result.", resultFile: resultFileOf(from) });
    }
  }

  private addStep(event: MigrationEvent): void {
    const steps = [...this.state.steps];
    const at = steps.findIndex((s) => s.step === event.step);
    if (at >= 0) steps[at] = event;
    else steps.push(event);
    this.set({ ...this.state, steps });
  }

  private set(next: MigrationState): MigrationState {
    this.state = next;
    this.deps.publish(next);
    return next;
  }
}
