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
import { closeSync, mkdtempSync, openSync, readFileSync, readSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { readFile } from "node:fs/promises";
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
  /** Why a rolled-back run ended that way, e.g. "cancelled" or "deadline" (reported by the Computer). */
  reason?: string | null;
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
    return { kind: "result", final: { result: obj.result, from: str(obj.from), to: str(obj.to), error: str(obj.error), serviceState: str(obj.serviceState), reason: str(obj.reason) } };
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
  /** The wait limit passed; the process was NOT killed (it may be mid-move and must finish or roll back itself). */
  timedOut?: boolean;
}

export interface MigrateRunInput {
  binaryPath: string;
  from: string;
  apply: boolean;
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
  onEvent?: (event: MigrationEvent) => void;
  /** Absolute epoch-ms time by which the command must be done; it rolls itself back at that moment (needs --deadline support). */
  deadlineMs?: number;
  /** The command's pid, once spawned (for cancel). */
  onSpawn?: (pid: number) => void;
}

export type MigrateRunner = (input: MigrateRunInput) => Promise<MigrateRun>;

/**
 * Run `raft-computer migrate-home` and fold its NDJSON stream into a MigrateRun. Never throws.
 *
 * The command's stdout/stderr go to FILES, not pipes, and it runs detached: a pipe whose reader (this app) was
 * killed makes the command's next write fail with EPIPE and die before it writes migrate-result.json. With a file
 * the command always reaches its end, whatever happens to the app; we just tail the file.
 */
export const runMigrateHome: MigrateRunner = (input) =>
  new Promise((resolve) => {
    const args = ["migrate-home", "--from", input.from, ...(input.apply ? ["--apply"] : []), ...(input.apply && input.deadlineMs ? ["--deadline", String(Math.round(input.deadlineMs))] : []), "--json"];
    const events: MigrationEvent[] = [];
    let final: MigrationFinal | null = null;
    let dry: "planned" | "blocked" | null = null;
    let settled = false;
    let offset = 0;
    let rest = "";
    let outFd = -1;
    let errFd = -1;
    const dir = mkdtempSync(path.join(tmpdir(), "raft-migrate-"));
    const outFile = path.join(dir, "out.ndjson");
    const errFile = path.join(dir, "err.log");
    const consume = (line: string) => {
      const parsed = parseMigrationLine(line.trim());
      if (parsed.kind === "event") {
        events.push(parsed.event);
        input.onEvent?.(parsed.event);
      } else if (parsed.kind === "result") final = parsed.final;
      else if (parsed.kind === "dry-run") dry = parsed.outcome;
    };
    const drain = () => {
      try {
        const size = statSync(outFile).size;
        if (size <= offset) return;
        const fd = openSync(outFile, "r");
        try {
          const buf = Buffer.alloc(size - offset);
          readSync(fd, buf, 0, buf.length, offset);
          offset = size;
          rest += buf.toString("utf8");
        } finally {
          closeSync(fd);
        }
        const lines = rest.split("\n");
        rest = lines.pop() ?? "";
        for (const line of lines) if (line.trim()) consume(line);
      } catch {
        /* file not there yet / being written: next poll */
      }
    };
    const tail = () => { try { return readFileSync(errFile, "utf8").slice(-2000); } catch { return ""; } };
    const cleanup = () => {
      for (const fd of [outFd, errFd]) { try { if (fd >= 0) closeSync(fd); } catch { /* already closed */ } }
      try { rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ }
    };
    const finish = (exitCode: number | null, spawnError?: string, timedOut = false) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearInterval(poll);
      drain();
      if (rest.trim()) consume(rest);
      const outcome: MigrationOutcome = final ? final.result : dry ?? "error";
      const detail = outcome === "error" ? spawnError ?? (tail().trim().split("\n").filter(Boolean).slice(-3).join(" ") || `raft-computer exited with ${exitCode} and no result`) : null;
      // A still-running command keeps its files (it owns them until it exits); only clean up when it is done.
      if (!timedOut) cleanup();
      resolve({ outcome, events, final, detail, exitCode, ...(timedOut ? { timedOut: true } : {}) });
    };
    let child: ReturnType<typeof spawn>;
    try {
      outFd = openSync(outFile, "a");
      errFd = openSync(errFile, "a");
      child = spawn(input.binaryPath, args, { env: input.env ?? process.env, stdio: ["ignore", outFd, errFd], detached: true });
    } catch (error) {
      cleanup();
      resolve({ outcome: "error", events, final: null, detail: String(error), exitCode: null });
      return;
    }
    if (child.pid) input.onSpawn?.(child.pid);
    const poll = setInterval(drain, 200);
    const timer = setTimeout(() => {
      // Stop waiting, never kill: a migration cut off between move and start could not roll itself back.
      finish(null, "migrate-home is still running", true);
    }, input.timeoutMs ?? 10 * 60_000);
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
  /** Apply is taking longer than expected; the result file is being watched. */
  slow: boolean;
  /** The Computer already lives at the target: nothing is moved, the app only hands it over. */
  inPlace: boolean;
  /** apply is running its command and Cancel can be sent. */
  cancellable: boolean;
  cancelRequested: boolean;
  /** Why the Computer rolled back ("cancelled", "deadline"…), when it said. */
  reason: string | null;
  /** The app found this migration already running at launch and is only watching it. */
  supervising?: boolean;
  /** After a move that did not complete: was the built-in Computer started again? null = not applicable / not tried. */
  restored?: "ok" | "failed" | null;
  restoreError?: string | null;
  /** When the Computer's hard time limit rolls it back (ISO), when known. */
  deadlineAt?: string | null;
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
  /** Reads <home>/computer/migrate-result.json (null when absent/unreadable). */
  readResult?: (home: string) => Promise<{ result: string; startedAt: string; from: string | null; to: string | null; error: string | null } | null>;
  sleep?: (ms: number) => Promise<void>;
  pollMs?: number;
  /**
   * Before the command is spawned: stop the built-in Computer's whole tree and verify it is gone. Throws when anything
   * is left (nothing has been changed by the migration yet).
   */
  handOver?: () => Promise<void>;
  /** After a failed hand-over: put the built-in Computer back as it was (best effort). */
  /**
   * The move did not complete (rolled back, failed, no result) or the hand-over was aborted: bring the built-in Computer
   * back to how it was (converge + start, with the orphan sweep). Never called after a success.
   */
  restoreBuiltIn?: () => Promise<{ ok: boolean; error?: string }>;
  /**
   * Whether this raft-computer treats SIGTERM as "cancel and roll back" (it reports a `--deadline` option when it
   * does). An older one would simply die mid-move, so the Cancel button is not offered for it.
   */
  supportsCancel?: (binaryPath: string) => Promise<boolean>;
  /** Sends SIGTERM (cancel) to the running command. */
  signal?: (pid: number, signal: NodeJS.Signals) => void;
}

/** Hard limit of one migration; the Computer rolls back on its own when it passes (same as its in-progress marker's deadlineAt). */
export const MIGRATION_DEADLINE_MS = 10 * 60_000;

const EMPTY: MigrationState = { phase: "idle", from: null, to: null, steps: [], blockers: [], warnings: [], error: null, resultFile: null, relaunching: false, slow: false, inPlace: false, cancellable: false, cancelRequested: false, reason: null, restored: null, restoreError: null };
const resultFileOf = (home: string | null) => (home ? path.join(home, "computer", "migrate-result.json") : null);
const strings = (value: unknown): string[] => (Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : []);

async function readResultFile(home: string): Promise<{ result: string; startedAt: string; from: string | null; to: string | null; error: string | null } | null> {
  try {
    const raw = JSON.parse(await readFile(resultFileOf(home) ?? "", "utf8")) as Record<string, unknown>;
    return { result: String(raw.result), startedAt: String(raw.startedAt ?? ""), from: str(raw.from), to: str(raw.to), error: str(raw.error) };
  } catch {
    return null;
  }
}

export class MigrationController {
  private state: MigrationState;
  private busy = false;
  private pid: number | null = null;

  constructor(private readonly deps: MigrationDeps) {
    this.state = { ...EMPTY, phase: deps.available ? "idle" : "unavailable" };
  }

  getState(): MigrationState {
    return this.state;
  }

  /** Dry run: what would move and whether anything blocks it. Changes nothing on the machine. */
  async plan(): Promise<MigrationState> {
    return this.guarded(() => this.planInner());
  }

  private async planInner(): Promise<MigrationState> {
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
    return this.guarded(() => this.applyInner());
  }

  private async applyInner(): Promise<MigrationState> {
    if (this.state.phase !== "ready" || this.busy) return this.state;
    this.busy = true;
    try {
      const planned = this.state;
      this.set({ ...EMPTY, phase: "applying", from: planned.from, to: planned.to, inPlace: planned.inPlace });
      const prepared = await this.prepare(planned.from);
      if (!prepared) return this.state;
      // Hand-over: the app stops its own built-in Computer (service, runners) and verifies it is gone BEFORE the
      // command starts. If anything is left, nothing has been migrated: abort and put the built-in one back.
      if (this.deps.handOver) {
        this.addStep({ step: "handover", status: "start" });
        try {
          await this.deps.handOver();
          this.addStep({ step: "handover", status: "ok" });
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          this.addStep({ step: "handover", status: "fail", detail: { error: message } });
          this.set({ ...this.state, phase: "error", error: `The built-in Computer could not be stopped cleanly, so nothing was changed. ${message}` });
          return this.restoreBuiltIn();
        }
      }
      const startedAt = new Date().toISOString();
      const cancelSupported = (await this.deps.supportsCancel?.(prepared.binaryPath).catch(() => false)) ?? false;
      let run = await (this.deps.run ?? runMigrateHome)({
        binaryPath: prepared.binaryPath, from: prepared.from, apply: true, onEvent: (e) => this.addStep(e),
        // A Computer that supports cancel also takes a hard time limit: past it the command rolls itself back.
        ...(cancelSupported ? { deadlineMs: Date.now() + MIGRATION_DEADLINE_MS } : {}),
        onSpawn: (pid) => { this.pid = pid; this.set({ ...this.state, cancellable: cancelSupported }); },
      });
      this.pid = null;
      this.set({ ...this.state, cancellable: false });
      if (run.timedOut) run = await this.waitForResultFile(prepared.from, planned.to, startedAt, run);
      if (run.outcome === "success") {
        const to = run.final?.to ?? planned.to;
        try {
          const { warnings } = await this.deps.afterSuccess(to ?? "");
          return this.set({ ...this.state, phase: "success", to, warnings, resultFile: resultFileOf(to), relaunching: true });
        } catch (error) {
          return this.set({ ...this.state, phase: "error", to, resultFile: resultFileOf(to), error: `The Computer was moved to ${to}, but this app could not switch to it: ${error instanceof Error ? error.message : String(error)}. Do not quit the app; ask for help.` });
        }
      }
      this.settle(run, prepared.from);
      return this.restoreBuiltIn();
    } finally {
      this.busy = false;
    }
  }

  /** Put the built-in Computer back after a move that did not complete, and say how that went. */
  private async restoreBuiltIn(): Promise<MigrationState> {
    if (!this.deps.restoreBuiltIn) return this.state;
    let outcome: { ok: boolean; error?: string };
    try {
      outcome = await this.deps.restoreBuiltIn();
    } catch (error) {
      outcome = { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
    return this.set({ ...this.state, restored: outcome.ok ? "ok" : "failed", restoreError: outcome.ok ? null : outcome.error ?? "unknown error" });
  }

  /** Cancel = SIGTERM to the running command; it stops at a safe point, rolls back and writes the result file. */
  cancel(): MigrationState {
    if (this.state.phase !== "applying" || this.pid === null || !this.state.cancellable || this.state.cancelRequested) return this.state;
    try { (this.deps.signal ?? process.kill)(this.pid, "SIGTERM"); } catch { /* already gone */ }
    return this.set({ ...this.state, cancelRequested: true });
  }

  /** Any unexpected exception becomes an error state the dialog shows; nothing may leave the dialog stuck on a pending phase. */
  private async guarded(run: () => Promise<MigrationState>): Promise<MigrationState> {
    try {
      return await run();
    } catch (error) {
      return this.set({ ...this.state, phase: "error", error: error instanceof Error ? error.message : String(error) });
    }
  }

  /** Back to the start after a blocked / failed / rolled-back / error result (or a cancelled plan). */
  reset(): MigrationState {
    if (this.busy || this.state.phase === "unavailable" || this.state.phase === "applying" || this.state.phase === "success") return this.state;
    return this.set({ ...EMPTY });
  }

  /** The process outlived our wait: watch both homes' result file (the move may have landed in either) until it reports. */
  private async waitForResultFile(from: string, to: string | null, since: string, run: MigrateRun): Promise<MigrateRun> {
    this.set({ ...this.state, slow: true, resultFile: resultFileOf(to ?? from) });
    const read = this.deps.readResult ?? readResultFile;
    const sleep = this.deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
    for (;;) {
      for (const home of [to, from]) {
        if (!home) continue;
        const file = await read(home);
        if (file && file.startedAt >= since && (file.result === "success" || file.result === "rolled_back" || file.result === "failed")) {
          return { ...run, timedOut: false, outcome: file.result, final: { result: file.result, from: file.from, to: file.to, error: file.error, serviceState: null }, detail: null };
        }
      }
      await sleep(this.deps.pollMs ?? 5_000);
    }
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
    const detail = preflight?.detail;
    const inPlace = detail?.mode === "in-place" || (typeof detail?.from === "string" && detail.from === detail.to) || this.state.inPlace;
    const common = { ...this.state, from: run.final?.from ?? from, to, inPlace, warnings: strings(detail?.warnings) };
    switch (run.outcome) {
      case "planned":
        return this.set({ ...common, phase: "ready" });
      case "blocked":
        return this.set({ ...common, phase: "blocked", blockers: strings(preflight?.detail?.blockers) });
      case "success":
        return this.set({ ...common, phase: "success" });
      case "rolled_back":
        return this.set({ ...common, phase: "rolled_back", error: run.final?.error ?? null, reason: run.final?.reason ?? null, resultFile: resultFileOf(from) });
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
