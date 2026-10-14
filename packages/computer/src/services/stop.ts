// StopService — Computer domain service for `raft-computer stop`
// (RFC v0.8 contract v4 §6 line 80, root service stop). CLI and
// Electron main are both adapters over this surface; the service itself
// never touches process.stdout / process.stderr / process.exit.
//
// Shape (Hao msg=51a17400 + liuliu msg=7a1a2c3d / 35034229 / 240069cd /
// bb503633):
//   - typed StopInput + StopOptions (onEvent best-effort + AbortSignal)
//   - typed StopResult on success — carries `status`
//     ("not_running" | "stale_pidfile_cleared" | "stopped") so adapters
//     can render the three idempotent terminal lines without re-reading
//     the pidfile.
//   - typed `ComputerServiceError { code, message, cause? }` thrown on
//     failure; cause retained in-process only — adapters MUST NOT forward it.
//   - §6 closed-set codes preserved BYTE-IDENTICAL: STOP_SIGNAL_FAILED /
//     STOP_TIMEOUT (source-walked service.ts runStop before commit
//     per closed-set rule a — 2 codes confirmed via grep, NOT a forward-
//     frame estimate).
//   - StopService is the LEGITIMATE process.kill(SIGTERM) site —
//     the inverse of StartService's NEVER-SIGKILL invariant. Stop owns
//     the service termination path; everything else (terminal close,
//     UI close, Electron quit) MUST leave the service running.
//   - AbortSignal honored before the SIGTERM call; once the signal is
//     sent the service's lifecycle is committed and the wait-for-exit
//     loop respects abort by returning early (status="stopped" if dead,
//     re-throwing AbortError if still alive — abort never SIGKILLs).
import {
  clearPidfileAt,
  isProcessAlive,
  readPidfileAt,
} from "../internal/process-primitives.js";
import { findLiveServicePid } from "../internal/service-pid-fallback.js";
import type { ComputerApiEvent } from "../lib/events.js";
import { ComputerServiceError } from "./errors.js";
import { servicePidPath } from "../paths.js";
import { appendFile } from "node:fs/promises";
import { currentTimeMs } from "@botiverse/raft-shared";
import {
  convergeCliHostLifecycle,
  resolveStableDispatcherPath,
  type MacosHostLifecycleDeps,
} from "../macosLoginCarrier.js";
import { serviceLogPath } from "../paths.js";
import { listAttachedServerIds } from "../serverState.js";
import { info } from "../output.js";
import {
  detectLegacyOsSupervisorCarriers,
  retireLegacyOsSupervisor,
  type OwnedHistoricalLaunchdDefinition,
  type SupervisorCommandOptions,
  type SupervisorCommandRunner,
} from "../osSupervisorRuntime.js";

const STOP_POLL_INTERVAL_MS = 200;
const STOP_TIMEOUT_MS = 5000;
/**
 * Task #36. A fixed 5s budget is wrong for a root stop: the service has to
 * tear down EVERY attached server, so the work scales with the attached set.
 * The owner's Mac runs four and raftbuild alone overran 5s — the stop reported
 * STOP_TIMEOUT, never unloaded the LaunchAgent, and the service then exited on
 * its own and left a loaded-but-dead carrier behind. Budget per daemon so a
 * multi-server root is not declared dead while it is still legitimately
 * shutting down.
 */
const STOP_TIMEOUT_PER_SERVER_MS = 2000;
const STOP_TIMEOUT_MAX_MS = 30000;

/** Stop budget for `count` attached servers: one base plus per-server time,
 *  capped so a pathological attachment set cannot hang stop indefinitely. */
export function stopTimeoutMsFor(count: number): number {
  const n = Number.isFinite(count) && count > 1 ? count : 1;
  return Math.min(STOP_TIMEOUT_MS + STOP_TIMEOUT_PER_SERVER_MS * (n - 1), STOP_TIMEOUT_MAX_MS);
}

export interface StopInput {
  /** Reserved for future per-server stop. Unused in v0; the root stop
   *  always targets the service pidfile. */
  serverId?: string | null;
  /** The Computer install root to stop. Required: env resolution lives at
   *  `createComputerApi` construction so mutations can't silently regress to
   *  ambient `~/.slock`. (#wg-raft-computer:f2a02081 BUG 3 sweep.) */
  slockHome: string;
  /** Explicit durable host-lifecycle owner. Internal callers use `none`; the
   * CLI and Electron adapters bind their actual owner. */
  hostLifecycleOwner?: "cli" | "app" | "none";
  /** Task #36 point 6: which entry point asked for this stop. Recorded in the
   *  service log so the next stuck carrier is traceable. Every real call site
   *  sets it; "unknown" is the honest default for anything that does not —
   *  deliberately not a guess. */
  stopCaller?: string;
}

export type StopStatus =
  | "not_running"            // pidfile missing — idempotent no-op
  | "stale_pidfile_cleared"  // pidfile present but pid dead — cleared
  | "stopped";               // SIGTERM sent + service exited within timeout

export interface StopResult {
  status: StopStatus;
  /** Pid the service observed in the pidfile when status !== "not_running".
   *  null on the not_running path (no pid was read). */
  pid: number | null;
  /** Path of the service pidfile (so adapters can render hints
   *  without re-resolving paths). */
  pidfilePath: string;
}

/**
 * Task #38. A legacy osSupervisor carrier is written with `KeepAlive <true/>`,
 * so while it is loaded launchd undoes the user's own Stop and the Computer
 * never goes idle — which means a converge-time "retire only when idle" rule
 * would wait forever.
 *
 * Stop is the one moment the user has asked for the service to go down, so it is
 * also the safest moment to unload that carrier: booting it out here is the stop
 * they asked for, not an extra outage. The next Start then comes up under the
 * login item with the safe KeepAlive. Never fatal — a failure to retire must not
 * fail the stop.
 */
async function retireLegacyOsSupervisorOnStop(
  slockHome: string,
  dispatcherPath: string,
  deps: StopOptions,
): Promise<void> {
  try {
    const run = deps.hostLifecycleDeps?.runCommand;
    const osDeps = {
      platform: deps.hostLifecycleDeps?.platform,
      userHome: deps.hostLifecycleDeps?.userHome,
      uid: deps.hostLifecycleDeps?.uid,
      runCommand: run
        ? ((command, args, _options?: SupervisorCommandOptions) =>
            run(command, args, deps.signal)) as SupervisorCommandRunner
        : undefined,
    };
    const carriers: OwnedHistoricalLaunchdDefinition[] =
      await detectLegacyOsSupervisorCarriers(slockHome, osDeps);
    if (carriers.length === 0) return;
    const result = await retireLegacyOsSupervisor(slockHome, dispatcherPath, osDeps);
    info(`[computer] retired legacy OS autostart (${result.status}) on stop.`);
  } catch (error) {
    info(`[computer] legacy OS autostart retire skipped: ${String(error)}`);
  }
}

export interface StopDeps {
  /** Test seams — pre-extraction `RunStopDeps` shape preserved so
   *  existing service.test.ts cases keep byte-identical imports
   *  through the adapter. */
  readPidfile?: typeof readPidfileAt;
  isProcessAlive?: typeof isProcessAlive;
  killService?: (pid: number) => void | Promise<void>;
  sleep?: (ms: number) => Promise<void>;
  pollIntervalMs?: number;
  timeoutMs?: number;
  /** Task #36 point 6: who asked for this stop. Recorded in the service log
   *  so the next stuck carrier is traceable. Every real call site sets this;
   *  "unknown" is the honest default for anything that does not, and is
   *  deliberately NOT a guess — the owner's stuck carrier logged "caller not
   *  logged", which is most of why it took a day to trace. */
  stopCaller?: string;
  now?: () => number;
  /** Abort the wait path if the caller loses its mutation lock. */
  signal?: AbortSignal;
  convergeHostLifecycle?: typeof convergeCliHostLifecycle;
  hostLifecycleDeps?: MacosHostLifecycleDeps;
}

export interface StopOptions extends StopDeps {
  onEvent?: (event: ComputerApiEvent) => void;
}

function emit(opts: StopOptions | undefined, event: ComputerApiEvent): void {
  const cb = opts?.onEvent;
  if (!cb) return;
  try {
    cb(event);
  } catch {
    // onEvent is best-effort — never let a renderer/listener fault
    // break the stop flow.
  }
}

export async function stop(
  input: StopInput,
  options: StopOptions = {},
): Promise<StopResult> {
  options.signal?.throwIfAborted?.();

  const { slockHome } = input;
  const disableHostLifecycle = async (): Promise<void> => {
    if ((input.hostLifecycleOwner ?? "none") === "none") return;
    const hostDeps = { ...(options.hostLifecycleDeps ?? {}) };
    if (hostDeps.platform === undefined) hostDeps.platform = process.platform;
    if (hostDeps.platform === "darwin" && hostDeps.dispatcherPath === undefined) {
      hostDeps.dispatcherPath = resolveStableDispatcherPath(slockHome);
    }
    await (options.convergeHostLifecycle ?? convergeCliHostLifecycle)(
      slockHome,
      "disabled",
      hostDeps,
    );
  };
  const readPidfile = options.readPidfile ?? readPidfileAt;
  const isAlive = options.isProcessAlive ?? isProcessAlive;
  const killer =
    options.killService ??
    ((pid: number) => {
      // The ONLY legitimate process.kill(SIGTERM) site in the service
      // layer. StopService owns service termination; StartService is
      // explicitly forbidden from killing (Hao msg=7a1a2c3d invariant).
      process.kill(pid, "SIGTERM");
    });
  const sleep =
    options.sleep ??
    ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const pollIntervalMs = options.pollIntervalMs ?? STOP_POLL_INTERVAL_MS;
  // Task #36: scale the wait with the attached set rather than a flat 5s.
  const attachedCount = (await listAttachedServerIds(slockHome).catch(() => [])).length;
  const timeoutMs = options.timeoutMs ?? stopTimeoutMsFor(attachedCount);

  // Task #36 point 6: record WHO asked for the stop. The owner's report had
  // "caller not logged", which is most of why it took a day to work out where a
  // stuck carrier had come from.
  {
    const caller = options.stopCaller ?? input.stopCaller ?? "unknown";
    try {
      await appendFile(
        serviceLogPath(slockHome),
        `${JSON.stringify({ kind: "stop.requested", caller, attachedServers: attachedCount, timeoutMs })}\n`,
      );
    } catch {
      // Log-only; never let an unwritable log change stop semantics.
    }
  }
  const now = options.now ?? currentTimeMs;

  // OS manager definitions are legacy optional state and never participate in
  // stop. The Computer-owned pidfile/TERM path is canonical on every OS.
  // Pidfile fallback chain — walk by liveness through the on-disk
  // layout migration window (current `run/service.pid` → legacy
  // `service.pid` → legacy `supervisor.pid`) so a user on an older
  // layout can still `raft-computer stop` the running service after
  // upgrading the CLI binary. The helper clears stale candidates in
  // place so they do not haunt later reads. Picking by readability
  // alone (instead of by liveness) would let a stale current pidfile
  // mask a still-live legacy service — see
  // `internal/service-pid-fallback.ts` doc-comment.
  const { pid, pidfilePath, firstStalePidfile, firstStalePid } =
    await findLiveServicePid(slockHome, {
      readPidfile,
      isProcessAlive: isAlive,
    });
  options.signal?.throwIfAborted?.();

  emit(options, { kind: "stop.stopping", pid });

  // 1. No live service found anywhere.
  if (pid === null) {
    if (firstStalePidfile !== null && firstStalePid !== null) {
      // We cleared at least one stale pidfile during the walk; report
      // `stale_pidfile_cleared` so the canonical idempotent-cleanup line
      // is rendered (preserves the pre-fallback-chain behavior for the
      // single-candidate case).
      await disableHostLifecycle();
      // Task #38: a dead service under a legacy carrier's KeepAlive <true/> is
      // exactly what launchd restarts behind the user's back, so this path
      // needs the same retirement as the normal stop.
      await retireLegacyOsSupervisorOnStop(
        slockHome,
        resolveStableDispatcherPath(slockHome),
        options,
      );
      emit(options, { kind: "stop.stale_pidfile_cleared", pid: firstStalePid });
      return {
        status: "stale_pidfile_cleared",
        pid: firstStalePid,
        pidfilePath: firstStalePidfile,
      };
    }
    await disableHostLifecycle();
    emit(options, { kind: "stop.not_running" });
    return { status: "not_running", pid: null, pidfilePath };
  }

  // 3. Pre-signal AbortSignal check (last opportunity before we commit
  //    to terminating the service). Once SIGTERM is sent the
  //    service's lifecycle is committed and an in-flight abort can
  //    only race with the natural exit.
  options.signal?.throwIfAborted?.();

  // 4. Send SIGTERM. The service's signal handler clears its own
  //    pidfile + process.exit(0). We poll for liveness rather than
  //    pidfile-absence because pidfile clear is best-effort during
  //    emergency shutdown.
  try {
    await killer(pid);
  } catch (err) {
    const cause = err instanceof Error ? err : new Error(String(err));
    throw new ComputerServiceError(
      "STOP_SIGNAL_FAILED",
      `Failed to send SIGTERM to service (pid ${pid}): ${cause.message}. Check process permissions or run: kill ${pid}`,
      err,
    );
  }
  emit(options, { kind: "stop.signaled", pid });

  // 5. Wait for the service to exit. AbortSignal aborts the wait
  //    early but does NOT escalate to SIGKILL — the kill is already
  //    in flight, and StopService's contract is "ask politely with
  //    SIGTERM then time out", not "force-kill".
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    options.signal?.throwIfAborted?.();
    if (!isAlive(pid)) {
      // Defensive pidfile cleanup if the service crashed before its
      // signal handler ran. Best-effort; the path may already be gone.
      options.signal?.throwIfAborted?.();
      await clearPidfileAt(pidfilePath);
      options.signal?.throwIfAborted?.();
      await disableHostLifecycle();
      // Task #38: the service is down — the one moment a legacy osSupervisor
      // carrier can be unloaded without costing anything. Without this, its
      // KeepAlive <true/> would undo this very stop and the Computer would
      // never stay stopped.
      await retireLegacyOsSupervisorOnStop(
        slockHome,
        resolveStableDispatcherPath(slockHome),
        options,
      );
      emit(options, { kind: "stop.stopped", pid });
      return { status: "stopped", pid, pidfilePath };
    }
    const remaining = deadline - Date.now();
    if (remaining <= 0) break;
    await sleep(Math.min(pollIntervalMs, remaining));
  }

  // Task #36: the stop did NOT complete. Say so where it can be seen — a caller
  // that only reads "stopped" would otherwise believe the carrier was unloaded,
  // while it may still be loaded with no process behind it.
  try {
    await appendFile(
      serviceLogPath(slockHome),
      `${JSON.stringify({
        kind: "stop.timed_out",
        pid,
        timeoutMs,
        attachedServers: attachedCount,
        caller: options.stopCaller ?? input.stopCaller ?? "unknown",
        carrierStillLoaded: true,
      })}\n`,
    );
  } catch {
    // Log-only; the throw below is the authoritative signal.
  }
  throw new ComputerServiceError(
    "STOP_TIMEOUT",
    `Service (pid ${pid}) did not exit within ${timeoutMs}ms after SIGTERM ` +
      `(budget for ${attachedCount} attached server${attachedCount === 1 ? "" : "s"}). ` +
      `The stop did NOT complete: on macOS the login carrier may still be loaded with no process behind it. ` +
      `Run \`raft-computer start\` to recover it, or force-kill with: kill -9 ${pid}`,
  );
}
