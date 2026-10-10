// `raft-computer migrate-home` — unattended one-shot migration of the
// Computer home into the default location (~/.slock), per the
// #computer-extract plan v1.3 §10–§11 (owner decisions 2026-10-09):
//
//   stop service → mv home → repoint the ~/.slock-raft alias → remove the
//   home-env LaunchAgent → start standalone at the new home → self-check →
//   automatic rollback on failure → result file.
//
// The whole move must be a single self-contained command because every agent
// living in the home goes offline during it — nobody can "watch it halfway".
// Safety posture:
//   - dry-run by default; `--apply` is explicit.
//   - preflight is read-only and fail-closed (target must be absent or empty,
//     same filesystem — mv only, never copy; source and target must differ).
//   - every mutation is journalled and rolled back in reverse on failure.
//   - a stopped-by-user service (desiredState "stopped") is preserved: the
//     migration converges the login item but does not start the service.
//
// `status --json`.migration reads the result file this command writes
// (<home>/computer/migrate-result.json, schema shared with statusJson.ts).

import { promises as fs, appendFileSync as fsAppendFileSync, mkdirSync as fsMkdirSync, statSync as fsStatSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { readDesiredState } from "./desiredState.js";
import { resolveRaftHome, servicePidPath, serviceSocketPath as serviceSocketPathOf } from "./paths.js";
import { isProcessAlive, readPidfileAt } from "./internal/process-primitives.js";
import { CliExit } from "./output.js";

export type MigrateStep =
  | "preflight"
  | "source-carrier"
  | "stop"
  | "move"
  | "alias"
  | "sessions"
  | "home-env"
  | "backup"
  | "start"
  | "self-check"
  | "rollback";

export type MigrateStepStatus =
  | "start"
  | "ok"
  | "fail"
  | "skipped"
  | "planned" // dry-run only: what --apply would do
  | "blocked"; // dry-run only: why --apply would refuse

export interface MigrateEvent {
  step: MigrateStep;
  status: MigrateStepStatus;
  detail?: Record<string, unknown>;
}

export type MigrateOutcome = "success" | "rolled_back" | "failed";

export interface MigrateBackupEntry {
  label: string;
  originalPath: string;
  backupPath: string;
}

export interface MigrateResultFile {
  schemaVersion: 1;
  result: MigrateOutcome;
  /** "move" = the home was renamed into place; "in-place" = from==to and the
   *  migration only took the lifecycle over (no data moved). */
  mode: "move" | "in-place";
  from: string;
  to: string;
  startedAt: string;
  finishedAt: string;
  /** End state of the Computer service after the command finished. */
  serviceState: "running" | "stopped-by-user" | "down";
  /** Why the run aborted, when a cancel/deadline flag preceded the step
   *  failure: "cancelled" (SIGTERM from the Desktop cancel button) or
   *  "deadline". null on success and on plain step failures. `error` keeps
   *  the failing step's original error as supplementary detail (PM #292). */
  reason: "cancelled" | "deadline" | null;
  error: string | null;
  rollback: { attempted: boolean; ok: boolean; detail?: string } | null;
  /** Every login-item plist this run deleted, and where the byte-for-byte
   *  copy landed (<home>/computer/migrate-backup/) — recoverable by hand
   *  even after a successful migration (PM review requirement). */
  backups: MigrateBackupEntry[];
  steps: Array<{ step: MigrateStep; status: MigrateStepStatus; detail?: Record<string, unknown> }>;
}

/** Label of the machine-local `launchctl setenv RAFT_HOME …` LaunchAgent
 *  (the D1-era workaround home-env.plist — plan §10 removes it). */
export const HOME_ENV_LABEL = "build.raft.desktop.home-env";

export function homeEnvPlistPath(homeDir: string): string {
  return path.join(homeDir, "Library", "LaunchAgents", `${HOME_ENV_LABEL}.plist`);
}

/** The D1 socket-path workaround alias; repointed, never deleted (plan §10). */
export function aliasPathFor(homeDir: string): string {
  return path.join(homeDir, ".slock-raft");
}

export function migrateResultPath(slockHome: string): string {
  return path.join(slockHome, "computer", "migrate-result.json");
}

/** In-progress marker written at apply start and removed by finish() (PM fix
 *  2026-10-10). The Desktop app reads it to tell "a migration is running"
 *  apart from "none ever happened" when the result file does not exist yet —
 *  e.g. the app was killed mid-apply and the CLI is still finishing alone.
 *  It rides the home (the move renames it to <to>). `deadlineAt` (startedAt
 *  + this budget) bounds the app's wait for a still-running CLI; `step` is
 *  the most recent step the run touched, for progress display. */
export const MIGRATE_IN_PROGRESS_DEADLINE_MS = 10 * 60_000;

export function migrateInProgressPath(slockHome: string): string {
  return path.join(slockHome, "computer", "migrate-in-progress.json");
}

/** Event-log fallback for the hardened stdout sink — the same file a
 *  redirected (stdout-to-file) Desktop spawn tails. */
export function migrateRunLogPath(slockHome: string): string {
  return path.join(slockHome, "computer", "migrate-run.ndjson");
}

/** POSIX AF_UNIX sun_path is 104 bytes INCLUDING the NUL terminator, so a
 *  socket path longer than 103 bytes cannot bind (macOS raises EINVAL, Linux
 *  truncates). The drill on a deep temp home hit exactly that: the migration
 *  ran stop+move and only then failed at start's listen EINVAL — a full
 *  rollback for a condition preflight can see statically (PM fix 2026-10-10). */
export const MAX_SERVICE_SOCKET_PATH_BYTES = 103;

export function serviceSocketPathTooLong(slockHome: string, platform: NodeJS.Platform = process.platform): boolean {
  if (platform === "win32") return false; // named pipes do not live on the fs
  return Buffer.byteLength(serviceSocketPathOf(slockHome), "utf8") > MAX_SERVICE_SOCKET_PATH_BYTES;
}

export interface MigrateHomeStatus {
  serviceRunning: boolean;
  serverCount: number;
  /** True when zero servers are attached, or every daemon is up + connected. */
  serversOnline: boolean;
}

/** A login item in ~/Library/LaunchAgents whose definition points at the
 *  source home (CLI carrier or the desktop app's embedded item). The
 *  migration must boot it out BEFORE stopping the service — KeepAlive would
 *  re-spawn the service at the source home mid-move — and remove the file so
 *  the next login does not resurrect a second home. */
export interface SourceCarrierInfo {
  label: string;
  plistPath: string;
  content: string;
}

/** Seams the core drives; the CLI adapter injects the real ComputerApi /
 *  launchctl implementations, tests inject fakes. The five action seams are
 *  REQUIRED — a missing one must fail loudly, never silently skip a stop. */
export interface MigrateHomeDeps {
  homeDir?: string;
  uid?: number;
  env?: { RAFT_HOME?: string; SLOCK_HOME?: string };
  now?: () => Date;
  sleep?: (ms: number) => Promise<void>;
  /** fs.Stats.dev, for the same-filesystem (mv-only) preflight. */
  deviceOf?: (p: string) => Promise<number>;
  stopServiceAt: (home: string) => Promise<void>;
  startServiceAt: (home: string) => Promise<void>;
  /** Converge the CLI login-item carrier for the home (enabled). */
  convergeCarrierAt: (home: string, desired: "enabled" | "disabled") => Promise<void>;
  statusAt: (home: string) => Promise<MigrateHomeStatus>;
  runLaunchctl: (args: string[]) => Promise<{ code: number; stderr: string }>;
  /** Read-only discovery of source-home login items (LaunchAgents scan). */
  listSourceCarriers?: (homeDir: string, matchPaths: string[]) => Promise<SourceCarrierInfo[]>;
  /** ~/.claude/projects location for the session-continuity step. */
  claudeProjectsDir?: (homeDir: string) => string;
  /** The REAL user home (getpwuid source — immune to a $HOME override).
   *  Guards fixed-label launchd operations to the real LaunchAgents dir. */
  realHomeDir?: () => string;
  /** Process sweep: every __service/__run process whose env or argv binds it
   *  to ANY of the home's path SPELLINGS (realpath, original argument, and
   *  the ~/.slock-raft alias — live processes carry whichever spelling their
   *  launcher used; PM review on #281). */
  scanHomeProcesses?: (homeSpellings: string[]) => Promise<HomeProcess[]>;
  killHomeProcess?: (pid: number, signal: "SIGTERM" | "SIGKILL") => void;
  /** Cancellation signal (SIGTERM from the Desktop app's cancel button, PM
   *  fix #288): aborted → forward steps fail into rollback. The rollback
   *  itself ignores it — a repeat signal must never interrupt the restore. */
  abortSignal?: AbortSignal;
  /** Upper bound for waiting out abandoned start/stop operations during a
   *  rollback (PM review on #292). Default 30s. */
  abandonedWaitTimeoutMs?: number;
  sweepTimeoutMs?: number;
  selfCheckTimeoutMs?: number;
  selfCheckPollMs?: number;
}

/** A path occurrence only counts when it ends at a boundary — the character
 *  right after it must be `<` (plist XML closing tag), `/` (subpath), or a
 *  quote. A bare substring match would let /Users/x/foo catch plists that
 *  mention /Users/x/foobar, and a successful migration would delete them
 *  for good (PM review requirement). */
const PATH_BOUNDARY_CHARS = new Set(["<", "/", '"', "'"]);

export function mentionsPathBounded(content: string, p: string): boolean {
  for (let idx = content.indexOf(p); idx !== -1; idx = content.indexOf(p, idx + 1)) {
    const next = content[idx + p.length];
    if (next !== undefined && PATH_BOUNDARY_CHARS.has(next)) return true;
  }
  return false;
}

/** Default LaunchAgents scan: any *.plist whose text mentions one of the
 *  home's path spellings at a boundary. The home-env LaunchAgent is
 *  excluded — it has its own dedicated step. */
export async function defaultListSourceCarriers(
  homeDir: string,
  matchPaths: string[],
): Promise<SourceCarrierInfo[]> {
  const dir = path.join(homeDir, "Library", "LaunchAgents");
  let entries: string[];
  try {
    entries = await fs.readdir(dir);
  } catch {
    return [];
  }
  const found: SourceCarrierInfo[] = [];
  for (const name of entries) {
    if (!name.endsWith(".plist")) continue;
    const label = name.slice(0, -".plist".length);
    if (label === HOME_ENV_LABEL) continue;
    const plistPath = path.join(dir, name);
    try {
      const content = await fs.readFile(plistPath, "utf8");
      if (matchPaths.some((p) => mentionsPathBounded(content, p))) {
        found.push({ label, plistPath, content });
      }
    } catch {
      /* unreadable — skip */
    }
  }
  return found;
}

// --- Claude Code session continuity (plan §10) -------------------------------
//
// Claude Code indexes sessions by the agent's cwd, encoded as a directory
// name under ~/.claude/projects where every character outside [A-Za-z0-9-]
// becomes "-" (verified against 125 real project dirs on this machine:
// "/"→"-", " "→"-", "@"→"-", "."→"-"). Encoding is per-character, so
// encode(a + "/" + b) === encode(a) + "-" + encode(b) — a prefix rename of
// the encoded names moves every project dir under the old home in one sweep.

export function encodeProjectDirName(p: string): string {
  return p.replace(/[^A-Za-z0-9-]/g, "-");
}

export function defaultClaudeProjectsDir(homeDir: string): string {
  return path.join(homeDir, ".claude", "projects");
}

/**
 * The invoking user's real home, from the password database — NOT $HOME,
 * which isolation drills override. The home-env LaunchAgent's label is
 * FIXED (no home hash), so its bootout/bootstrap target the user's real
 * gui domain no matter what $HOME says; a drill that overrode $HOME must
 * therefore never issue those launchctl calls (PM incident 2026-10-10:
 * a drill booted out the owner's live home-env job).
 */
export function defaultRealHomeDir(): string {
  try {
    const info = os.userInfo();
    if (info.homedir && info.homedir.length > 0) return info.homedir;
  } catch {
    /* fall through */
  }
  return os.homedir();
}

// --- whole-tree process sweep (PM blocking fix 2026-10-09) -------------------
//
// The embedded app can leave orphaned per-server runners behind: the desktop
// service's SIGTERM handler only reaps children it still owns, and a runner
// whose parent already died (ppid 1) survives api.stop untouched — seen live
// in the xai end-to-end. Every __service/__run child is spawned with explicit
// RAFT_HOME/SLOCK_HOME env (service.ts), so processes are attributed to a
// home by argv (--slock-home) or environment, independent of parentage.

export interface HomeProcess {
  pid: number;
  kind: "service" | "runner";
  /** For __run children: the serverId argument. */
  serverId: string | null;
}

/** Substring match with a boundary: the character after the candidate must
 *  be end-of-string or whitespace. Without it `--slock-home ~/.slock` would
 *  also hit `--slock-home ~/.slock-raft` and the sweep could kill unrelated
 *  live processes (PM review on #281). */
export function mentionsWithBoundary(text: string, candidate: string): boolean {
  for (let idx = text.indexOf(candidate); idx !== -1; idx = text.indexOf(candidate, idx + 1)) {
    const after = text[idx + candidate.length];
    if (after === undefined || after === " ") return true;
  }
  return false;
}

export function argvMentionsHome(command: string, spelling: string): boolean {
  for (const sep of ["--slock-home ", "--slock-home="]) {
    for (let idx = command.indexOf(sep); idx !== -1; idx = command.indexOf(sep, idx + 1)) {
      const valueStart = idx + sep.length;
      if (command.startsWith(spelling, valueStart)) {
        const after = command[valueStart + spelling.length];
        if (after === undefined || after === " ") return true;
      }
    }
  }
  return false;
}

export async function defaultScanHomeProcesses(homeSpellings: string[]): Promise<HomeProcess[]> {
  const spellings = [...new Set(homeSpellings.map((sp) => sp).filter((sp) => sp.length > 0))];
  if (spellings.length === 0) return [];
  const { execFile } = await import("node:child_process");
  const { promisify } = await import("node:util");
  const run = promisify(execFile) as (cmd: string, args: string[]) => Promise<{ stdout: string }>;
  let listing: string;
  try {
    listing = (await run("ps", ["-axo", "pid=,command="])).stdout;
  } catch {
    return [];
  }
  const found: HomeProcess[] = [];
  for (const line of listing.split("\n")) {
    const match = line.trim().match(/^(\d+)\s+([\s\S]+)$/);
    if (!match || !match[2]) continue;
    const pid = Number(match[1]);
    const command = match[2];
    const isService = /(^|\s)__service(\s|$)/.test(command);
    const runMatch = command.match(/(?:^|\s)__run\s+(\S+)/);
    if (!isService && !runMatch) continue;
    if (spellings.some((spelling) => argvMentionsHome(command, spelling))) {
      found.push({ pid, kind: isService ? "service" : "runner", serverId: runMatch?.[1] ?? null });
      continue;
    }
    // Environment attribution: same-user processes expose their env via ps.
    try {
      const envText = (await run("ps", ["eww", "-p", String(pid), "-o", "command="])).stdout;
      if (spellings.some((spelling) => mentionsWithBoundary(envText, spelling))) {
        found.push({ pid, kind: isService ? "service" : "runner", serverId: runMatch?.[1] ?? null });
      }
    } catch {
      /* process exited between listing and env read */
    }
  }
  return found;
}

export function defaultKillHomeProcess(pid: number, signal: "SIGTERM" | "SIGKILL"): void {
  try {
    process.kill(pid, signal);
  } catch {
    /* already gone */
  }
}

export interface MigrateHomeOptions {
  from?: string;
  to?: string;
  apply: boolean;
  /** Hard deadline (epoch ms); defaults to startedAt +
   *  MIGRATE_IN_PROGRESS_DEADLINE_MS so the enforced deadline always equals
   *  the marker's deadlineAt (PM review on #290). Forward steps and their
   *  polls abort into the normal fail→rollback path once it passes. The
   *  rollback itself is NEVER deadline-bound — it must always run to
   *  completion (PM fix #288). */
  deadlineAt?: number;
}

export interface MigrateHomeRun {
  /** apply: success | rolled_back | failed; dry-run: planned | blocked. */
  outcome: MigrateOutcome | "planned" | "blocked";
  blocked: boolean;
  /** "move" | "in-place" — present on dry-run lines too (Desktop contract). */
  mode: "move" | "in-place";
  result: MigrateResultFile | null;
}

function resolveTilde(input: string, homeDir: string): string {
  if (input === "~") return homeDir;
  if (input.startsWith("~/")) return path.join(homeDir, input.slice(2));
  return input;
}

/** Argument-level from/to resolution, shared by preflight and the CLI
 *  adapter (the adapter needs the paths up front to build its hardened
 *  event sink before any preflight work runs). Returns the ORIGINAL --from
 *  spelling resolved against homeDir — live processes may carry it verbatim. */
export function resolveMigrateHomeArgumentPaths(
  opts: Pick<MigrateHomeOptions, "from" | "to">,
  env: { RAFT_HOME?: string; SLOCK_HOME?: string },
  homeDir: string,
): { fromArg: string; to: string } {
  const fromRaw = opts.from ?? resolveRaftHome(env, homeDir);
  const fromArg = path.resolve(resolveTilde(fromRaw, homeDir));
  const to = path.resolve(resolveTilde(opts.to ?? path.join(homeDir, ".slock"), homeDir));
  return { fromArg, to };
}

async function defaultDeviceOf(p: string): Promise<number> {
  // fs.Stats.dev is the containing filesystem's id — same device means
  // rename(2) stays a move, never a copy.
  return (await fs.stat(p)).dev;
}

async function countDirs(p: string): Promise<number> {
  try {
    const entries = await fs.readdir(p, { withFileTypes: true });
    return entries.filter((e) => e.isDirectory()).length;
  } catch {
    return 0;
  }
}

async function pathExists(p: string): Promise<boolean> {
  try {
    await fs.lstat(p);
    return true;
  } catch {
    return false;
  }
}

async function readLinkOrNull(p: string): Promise<string | null> {
  try {
    return await fs.readlink(p);
  } catch {
    return null;
  }
}

/** Preflight facts — everything the apply phases (and the dry-run plan) need,
 *  gathered read-only. `blockers` non-empty means --apply would refuse. */
export interface MigratePreflight {
  from: string;
  /** The ORIGINAL --from spelling (pre-realpath): live processes may carry
   *  it in env/argv, so the sweep matches every spelling (PM #281 review). */
  fromArg: string;
  to: string;
  /** "in-place" when from and to resolve to the same directory (a fresh
   *  machine whose embedded home already IS ~/.slock) — takeover only. */
  mode: "move" | "in-place";
  blockers: string[];
  warnings: string[];
  serviceWasRunning: boolean;
  desiredState: "running" | "stopped";
  agentDirs: number;
  serverDirs: number;
  /** Real attachments — gates whether the start step can run the service. */
  attachments: string[];
  alias: { path: string; currentTarget: string } | null;
  homeEnv: { path: string; content: string } | null;
  sourceCarriers: SourceCarrierInfo[];
}

export async function preflightMigrateHome(
  opts: MigrateHomeOptions,
  deps: MigrateHomeDeps,
  emit: (event: MigrateEvent) => void,
): Promise<MigratePreflight> {
  const homeDir = deps.homeDir ?? os.homedir();
  const uid = deps.uid ?? (typeof process.getuid === "function" ? process.getuid() : -1);
  const env = deps.env ?? process.env;
  const deviceOf = deps.deviceOf ?? defaultDeviceOf;
  const blockers: string[] = [];
  const warnings: string[] = [];

  emit({ step: "preflight", status: "start" });

  const { fromArg, to } = resolveMigrateHomeArgumentPaths(opts, env, homeDir);
  const from = fromArg;

  // Source must be an existing directory (resolve through symlinks so the
  // mv operates on the real path — the alias is repointed separately).
  let fromReal = from;
  try {
    fromReal = await fs.realpath(from);
    const st = await fs.stat(fromReal);
    if (!st.isDirectory()) blockers.push(`source is not a directory: ${from}`);
  } catch {
    blockers.push(`source home not found: ${from}`);
  }

  // from == to is the IN-PLACE shape (PM decision 2026-10-09: a fresh
  // machine whose embedded home already IS ~/.slock needs a takeover, not a
  // move). Anything else must be distinct and non-nested — moving a
  // directory into itself is undefined across the rename.
  let toReal: string | null = null;
  try {
    toReal = await fs.realpath(to);
  } catch {
    /* target absent — move mode */
  }
  const inPlace = toReal !== null && toReal === fromReal;
  if (!inPlace) {
    if (to === path.dirname(fromReal) || fromReal.startsWith(`${to}${path.sep}`) || to.startsWith(`${fromReal}${path.sep}`)) {
      blockers.push(`source and target must be distinct, non-nested paths (from=${fromReal}, to=${to})`);
    }

    // Target must be absent or an EMPTY directory — never merge, never overwrite.
    let targetWasEmptyDir = false;
    try {
      const entries = await fs.readdir(to);
      if (entries.length > 0) {
        blockers.push(`target exists and is not empty: ${to}`);
      } else {
        targetWasEmptyDir = true;
      }
    } catch {
      /* absent — fine */
    }
    if (!targetWasEmptyDir && blockers.length === 0 && (await pathExists(to))) {
      blockers.push(`target exists and is not a directory: ${to}`);
    }

    // Same filesystem only: the move is a rename, never a 30GB copy.
    try {
      const [srcDev, dstDev] = await Promise.all([deviceOf(fromReal), deviceOf(path.dirname(to))]);
      if (srcDev !== dstDev) {
        blockers.push(`target is on a different filesystem (${fromReal} dev=${srcDev}, ${path.dirname(to)} dev=${dstDev}); mv-only migration refuses to copy`);
      }
    } catch (error) {
      blockers.push(`cannot compare filesystems: ${(error as Error).message}`);
    }

    // The start step binds <to>/computer/run/service.sock; a path over the
    // AF_UNIX limit can never bind (listen EINVAL) — block BEFORE anything
    // moves instead of discovering it mid-apply and rolling back.
    if (serviceSocketPathTooLong(to)) {
      blockers.push(
        `target socket path is ${Buffer.byteLength(serviceSocketPathOf(to), "utf8")} bytes, over the ${MAX_SERVICE_SOCKET_PATH_BYTES}-byte AF_UNIX limit (${serviceSocketPathOf(to)}); ` +
        "move the Computer to a home with a shorter path",
      );
    }
  }

  // The ~/.slock-raft alias: repoint only if it is a symlink into the source.
  const aliasP = aliasPathFor(homeDir);
  const aliasLink = await readLinkOrNull(aliasP);
  let alias: MigratePreflight["alias"] = null;
  if (aliasLink !== null) {
    const aliasResolves = path.resolve(path.dirname(aliasP), aliasLink);
    try {
      if ((await fs.realpath(aliasP)) === fromReal) {
        alias = { path: aliasP, currentTarget: aliasResolves };
      } else {
        warnings.push(`~/.slock-raft is a symlink but points at ${aliasResolves}, not the source home; it will be left untouched`);
      }
    } catch {
      warnings.push("~/.slock-raft is a dangling symlink; it will be left untouched");
    }
  }

  // home-env LaunchAgent: capture content for rollback before removing.
  const homeEnvP = homeEnvPlistPath(homeDir);
  let homeEnv: MigratePreflight["homeEnv"] = null;
  if (await pathExists(homeEnvP)) {
    try {
      homeEnv = { path: homeEnvP, content: await fs.readFile(homeEnvP, "utf8") };
    } catch (error) {
      warnings.push(`home-env plist exists but cannot be read (${(error as Error).message}); it will be left untouched`);
    }
  }

  const desiredState = await readDesiredState(fromReal);
  const pid = await readPidfileAt(servicePidPath(fromReal));
  const serviceWasRunning = pid !== null && isProcessAlive(pid);
  const agentDirs = await countDirs(path.join(fromReal, "agents"));
  const serverDirs = await countDirs(path.join(fromReal, "computer", "servers"));
  // Real attachments (parseable runner.state.json), not just directory
  // counts: `start` refuses to run a service with zero attachments
  // (NO_ATTACHMENT), so a fresh-install home must converge-only.
  const { listAttachedServerIds } = await import("./serverState.js");
  const attachments = await listAttachedServerIds(fromReal);

  // Login items pointing at the source home (CLI carrier or desktop item):
  // booting these out BEFORE the stop is what keeps launchd (KeepAlive /
  // RunAtLoad) from re-spawning a service at the old path mid-move or after
  // a successful migration.
  const listSourceCarriers = deps.listSourceCarriers ?? defaultListSourceCarriers;
  const matchPaths = [...new Set([fromReal, from, aliasLink !== null ? aliasPathFor(homeDir) : null].filter((v): v is string => v !== null))];
  const sourceCarriers = blockers.length === 0 ? await listSourceCarriers(homeDir, matchPaths) : [];

  const plan: Record<string, unknown> = {
    from: fromReal,
    to,
    mode: inPlace ? "in-place" : "move",
    serviceWasRunning,
    desiredState,
    agentDirs,
    serverDirs,
    attachments,
    aliasRepoint: alias !== null,
    homeEnvRemoval: homeEnv !== null,
    sourceCarriers: sourceCarriers.map((c) => c.label),
    uid,
  };

  emit({
    step: "preflight",
    status: blockers.length > 0 ? "blocked" : "ok",
    detail: { ...plan, blockers, warnings },
  });

  return {
    from: fromReal,
    fromArg,
    to,
    mode: inPlace ? "in-place" : "move",
    blockers,
    warnings,
    serviceWasRunning,
    desiredState,
    agentDirs,
    serverDirs,
    attachments,
    alias,
    homeEnv,
    sourceCarriers,
  };
}

/** Reverse-order undo journal. Pushed as mutations land; executed LIFO on
 *  failure, each entry best-effort (a failed undo is reported, not fatal). */
type UndoEntry = { label: string; undo: () => Promise<void> };

export async function migrateHome(
  opts: MigrateHomeOptions,
  deps: MigrateHomeDeps,
  emit: (event: MigrateEvent) => void,
): Promise<MigrateHomeRun> {
  const now = deps.now ?? (() => new Date());
  const startedAt = now().toISOString();

  const pre = await preflightMigrateHome(opts, deps, emit);
  const steps: MigrateResultFile["steps"] = [];

  const record = (event: MigrateEvent) => {
    steps.push(event);
    emit(event);
    if (markerTracked) writeInProgressMarker(event.step);
  };

  // In-progress marker machinery (PM fix 2026-10-10) — declared before
  // `record` is ever CALLED with tracking enabled (apply only; the dry-run
  // path below never sets markerTracked). The marker is the FIRST mutation
  // of the apply: the Desktop app polls it to tell "a migration is running"
  // apart from "none ever happened" while migrate-result.json does not
  // exist yet — exactly the state a killed app leaves when the CLI is still
  // finishing alone (drill 284-run3). It rides the home (the move renames
  // it to <to>); `record` refreshes `step` on every event so the app can
  // render progress and enforce `deadlineAt` (its bounded wait for the
  // still-running CLI). finish() removes it AFTER the result file is on
  // disk, so a crash between the two leaves both files and readers can
  // prefer the result.
  const markerBase = { schemaVersion: 1, pid: process.pid, mode: pre.mode, from: pre.from, to: pre.to, startedAt };
  // The EFFECTIVE hard deadline: an explicit --deadline wins; otherwise
  // startedAt + the marker budget, so the marker's deadlineAt and the
  // enforced deadline can never disagree (PM review on #290: without a
  // default, the UI's deadline is decorative and the run is unbounded).
  const effectiveDeadlineAt = opts.deadlineAt ?? Date.parse(startedAt) + MIGRATE_IN_PROGRESS_DEADLINE_MS;
  const deadlineAt = new Date(effectiveDeadlineAt).toISOString();
  let markerRetired = false;
  let markerTracked = false;
  let markerWrites: Promise<void> = Promise.resolve();
  const writeInProgressMarker = (step: MigrateStep): Promise<void> => {
    if (markerRetired) return markerWrites;
    markerWrites = markerWrites.then(async () => {
      if (markerRetired) return;
      // The marker rides the home: post-move it lives at <to>; pre-move at
      // <from> (same live-home resolution rule as the event-sink fallback).
      let home = pre.to;
      try {
        await fs.stat(path.join(pre.to, "computer"));
      } catch {
        home = pre.from;
      }
      try {
        await fs.mkdir(path.dirname(migrateInProgressPath(home)), { recursive: true });
        await fs.writeFile(
          migrateInProgressPath(home),
          `${JSON.stringify({ ...markerBase, deadlineAt, step }, null, 2)}\n`,
          "utf8",
        );
      } catch {
        /* advisory marker — a failed refresh is never fatal */
      }
    });
    return markerWrites;
  };

  // ---- dry-run: the preflight above IS the run; emit the plan as steps ----
  if (!opts.apply) {
    const inPlace = pre.mode === "in-place";
    const planned: Array<[MigrateStep, MigrateStepStatus, Record<string, unknown> | undefined]> = [
      [
        "source-carrier",
        pre.sourceCarriers.length > 0 ? "planned" : "skipped",
        pre.sourceCarriers.length > 0
          ? { carriers: pre.sourceCarriers.map((c) => ({ label: c.label, plistPath: c.plistPath })) }
          : { reason: "no login items point at the source home" },
      ],
      ["stop", pre.serviceWasRunning ? "planned" : "skipped", pre.serviceWasRunning ? undefined : { reason: "service not running" }],
      // In-place mode moves nothing: no move, no alias repoint, no session
      // renames — only the lifecycle takeover.
      ...(!inPlace
        ? ([
            ["move", "planned", { from: pre.from, to: pre.to }],
            ["alias", pre.alias ? "planned" : "skipped", pre.alias ? { path: pre.alias.path, currentTarget: pre.alias.currentTarget } : { reason: "no ~/.slock-raft symlink into the source home" }],
            ["sessions", "planned", { note: "rename ~/.claude/projects dirs whose encoded name starts with the old home" }],
          ] as Array<[MigrateStep, MigrateStepStatus, Record<string, unknown> | undefined]>)
        : []),
      ["home-env", pre.homeEnv ? "planned" : "skipped", pre.homeEnv ? { path: pre.homeEnv.path } : { reason: "no home-env LaunchAgent" }],
      ["backup", pre.sourceCarriers.length > 0 || pre.homeEnv ? "planned" : "skipped", { dir: "<to>/computer/migrate-backup" }],
      [
        "start",
        pre.desiredState === "running" && pre.attachments.length > 0 ? "planned" : "skipped",
        pre.desiredState !== "running"
          ? { reason: 'desiredState is "stopped"; the login item is converged but the service stays stopped' }
          : pre.attachments.length === 0
            ? { reason: "no server attachments — the login item is converged but there is nothing to start" }
            : undefined,
      ],
      [
        "self-check",
        pre.desiredState === "running" && pre.attachments.length > 0 ? "planned" : "skipped",
        pre.desiredState === "running" && pre.attachments.length > 0
          ? { agentDirs: pre.agentDirs, serverDirs: pre.serverDirs, attachments: pre.attachments.length }
          : undefined,
      ],
    ];
    for (const [step, status, detail] of planned) {
      record({ step, status, detail });
    }
    return { outcome: pre.blockers.length > 0 ? "blocked" : "planned", blocked: pre.blockers.length > 0, mode: pre.mode, result: null };
  }

  // ---- apply: blockers abort before ANY mutation (and write no result file) ----
  if (pre.blockers.length > 0) {
    return { outcome: "blocked", blocked: true, mode: pre.mode, result: null };
  }

  // The marker machinery lives above `record`; enabling tracking here makes
  // the initial write the FIRST mutation of the apply.
  markerTracked = true;
  await writeInProgressMarker("preflight");

  // ---- apply ----
  const homeDir = deps.homeDir ?? os.homedir();
  const uid = deps.uid ?? (typeof process.getuid === "function" ? process.getuid() : -1);
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const { stopServiceAt, startServiceAt, convergeCarrierAt, statusAt, runLaunchctl } = deps;

  const journal: UndoEntry[] = [];
  const backups: MigrateBackupEntry[] = [];
  const scanHomeProcesses = deps.scanHomeProcesses ?? defaultScanHomeProcesses;
  const killHomeProcess = deps.killHomeProcess ?? defaultKillHomeProcess;

  // Hard deadline + cancellation (PM fix #288): FORWARD steps and their
  // polls abort into the normal fail→rollback path. Once the rollback
  // starts both guards are off — the rollback is never deadline-bound and
  // never interrupted by a further signal; it must always reach the
  // original state. The CLI adapter's SIGTERM handler only ever sets the
  // signal, so a repeat signal is a no-op by construction.
  const hardDeadlineAt = effectiveDeadlineAt;
  const abortSignal = deps.abortSignal;
  const nowFn = deps.now ?? (() => new Date());
  let rollbackStarted = false;
  const abortReason = (): string | null => {
    if (rollbackStarted) return null;
    if (abortSignal?.aborted) return "cancelled by SIGTERM";
    if (hardDeadlineAt !== undefined && nowFn().getTime() >= hardDeadlineAt) {
      return `deadline exceeded (deadline ${new Date(hardDeadlineAt).toISOString()}, now ${nowFn().toISOString()})`;
    }
    return null;
  };
  const checkAbort = (): void => {
    const reason = abortReason();
    if (reason !== null) throw new Error(`migrate-home aborted: ${reason}`);
  };

  /** Race a long dependency wait against the abort flags. The underlying
   *  operation cannot be cancelled (runStart keeps converging), so on abort
   *  this rejects immediately with the cancel/deadline reason — the step
   *  fails into rollback, whose whole-tree sweep reaps whatever the
   *  half-finished start left behind (PM #292: cancel must interrupt the
   *  start step's daemon wait, not wait out its own timeout). */
  /** Long dependency waits abandoned by an abort. The underlying operation
   *  keeps running in-process (runStart keeps converging) and may spawn
   *  detached children AFTER the rollback's tree sweep — the rollback waits
   *  these out (bounded) and sweeps again before writing the result (PM
   *  review on #292). */
  const abandonedOps = new Set<Promise<unknown>>();
  const abortableWait = <T>(promise: Promise<T>, label: string): Promise<T> =>
    new Promise<T>((resolve, reject) => {
      const tick = () => {
        const reason = abortReason();
        if (reason !== null) {
          cleanup();
          abandonedOps.add(promise);
          reject(new Error(`${label} aborted: ${reason}`));
          return true;
        }
        return false;
      };
      const timer = setInterval(() => { tick(); }, 250);
      const onSignalAbort = () => { tick(); };
      abortSignal?.addEventListener("abort", onSignalAbort, { once: true });
      const cleanup = () => {
        clearInterval(timer);
        abortSignal?.removeEventListener("abort", onSignalAbort);
      };
      if (tick()) return;
      promise.then(
        (value) => { cleanup(); resolve(value); },
        (error) => { cleanup(); reject(error); },
      );
    });

  /** Every path spelling a live process could carry for this home: the
   *  realpath, the ORIGINAL argument, and the ~/.slock-raft alias (owner's
   *  running processes carry the alias spelling via launchctl setenv). */
  const spellingsFor = (primary: string, original: string | null, alias: string | null): string[] => {
    const out = new Set<string>([primary]);
    if (original !== null) out.add(original);
    if (alias !== null) out.add(alias);
    return [...out];
  };
  const fromSpellings = spellingsFor(pre.from, pre.fromArg, pre.alias?.path ?? null);
  // For the target home: the path itself, its realpath once it exists, and
  // the alias (repointed at it in move mode; already pointing at it in
  // in-place mode). Computed lazily — `to` only exists after the move.
  const toSpellings = (): string[] => {
    const out = new Set<string>([pre.to]);
    if (pre.alias) out.add(pre.alias.path);
    return [...out];
  };

  /** TERM -> grace -> KILL -> rescan; returns whatever is STILL alive. */
  const sweepHomeTree = async (homeSpellings: string[]): Promise<HomeProcess[]> => {
    const deadline = Date.now() + (deps.sweepTimeoutMs ?? 10_000);
    let procs = await scanHomeProcesses(homeSpellings);
    if (procs.length === 0) return procs;
    for (const proc of procs) killHomeProcess(proc.pid, "SIGTERM");
    while (procs.length > 0 && Date.now() < deadline) {
      await sleep(500);
      checkAbort();
      procs = await scanHomeProcesses(homeSpellings);
    }
    if (procs.length > 0) {
      for (const proc of procs) killHomeProcess(proc.pid, "SIGKILL");
      await sleep(500);
      procs = await scanHomeProcesses(homeSpellings);
    }
    return procs;
  };

  /** Graceful service stop + whole-tree sweep; THROWS when anything of this
   *  home survives (the step fails into rollback — PM blocking fix). */
  const stopHomeCompletely = async (home: string, homeSpellings: string[]): Promise<Record<string, unknown>> => {
    await abortableWait(stopServiceAt(home), "stop");
    const remaining = await sweepHomeTree(homeSpellings);
    if (remaining.length > 0) {
      throw new Error(
        `home process tree did not stop (${remaining.map((p) => `${p.kind}:${p.pid}`).join(", ")} remain for ${home})`,
      );
    }
    return { home, treeClean: true };
  };
  let failure: string | null = null;
  let failureStep: MigrateStep | null = null;

  const runStep = async (step: MigrateStep, fn: () => Promise<Record<string, unknown> | void>) => {
    record({ step, status: "start" });
    try {
      // Inside the try ON PURPOSE: an abort (deadline / SIGTERM) must fail
      // THIS step into the normal rollback path — never escape the run.
      checkAbort();
      const detail = await fn();
      record({ step, status: "ok", ...(detail ? { detail } : {}) });
      return true;
    } catch (error) {
      failure = (error as Error).message;
      failureStep = step;
      record({ step, status: "fail", detail: { error: failure } });
      return false;
    }
  };

  const finish = async (
    result: MigrateOutcome,
    serviceState: MigrateResultFile["serviceState"],
    rollback: MigrateResultFile["rollback"],
    reason: MigrateResultFile["reason"] = null,
  ): Promise<MigrateHomeRun> => {
    // Retire the in-progress marker's refresher FIRST (no rewrite may land
    // after the deletion below), then drain any in-flight refresh before
    // the result file is written and the marker is removed.
    markerRetired = true;
    await markerWrites.catch(() => {});
    const file: MigrateResultFile = {
      reason,
      schemaVersion: 1,
      result,
      mode: pre.mode,
      from: pre.from,
      to: pre.to,
      startedAt,
      finishedAt: now().toISOString(),
      serviceState,
      error: failure,
      rollback,
      backups,
      steps,
    };
    // Result file lives in whichever home is real on disk after the run:
    // success keeps it at the target; a rollback restores the source home,
    // so it must land there (never re-create directories under the target).
    const homeOrder = result === "success" ? [pre.to, pre.from] : [pre.from, pre.to];
    for (const home of homeOrder) {
      try {
        await fs.mkdir(path.dirname(migrateResultPath(home)), { recursive: true });
        await fs.writeFile(migrateResultPath(home), `${JSON.stringify(file, null, 2)}\n`, "utf8");
        break;
      } catch {
        /* try the other home; if both fail the summary still returns */
      }
    }
    // Retire the in-progress marker only after the result file landed (see
    // the marker write for the ordering rationale). Best-effort on both
    // candidate homes — exactly one of them holds it.
    for (const home of [pre.from, pre.to]) {
      try {
        await fs.rm(migrateInProgressPath(home), { force: true });
      } catch {
        /* best-effort: a stale marker is safe (readers prefer the result) */
      }
    }
    return { outcome: result, blocked: false, mode: pre.mode, result: file };
  };

  // Step 1 — retire the source home's login items (BEFORE the stop: a
  // KeepAlive/RunAtLoad item would re-spawn the service at the old path
  // mid-move, and would resurrect a second home at the next login).
  if (pre.sourceCarriers.length > 0) {
    if (
      !(await runStep("source-carrier", async () => {
        for (const carrier of pre.sourceCarriers) {
          try {
            await runLaunchctl(["bootout", `gui/${uid}/${carrier.label}`]);
          } catch {
            /* not loaded — nothing to boot out */
          }
          await fs.rm(carrier.plistPath, { force: true });
          journal.push({
            label: `restore login item ${carrier.label}`,
            undo: async () => {
              await fs.mkdir(path.dirname(carrier.plistPath), { recursive: true });
              await fs.writeFile(carrier.plistPath, carrier.content, "utf8");
              try {
                await runLaunchctl(["bootstrap", `gui/${uid}`, carrier.plistPath]);
              } catch {
                /* best-effort; the file is back, next login re-loads it */
              }
            },
          });
        }
        return { carriers: pre.sourceCarriers.map((c) => c.label) };
      }))
    ) {
      return rollbackAndFinish();
    }
  } else {
    record({ step: "source-carrier", status: "skipped", detail: { reason: "no login items point at the source home" } });
  }

  // Step 2 — stop the service at the source home (idempotent; migration is
  // NOT a user stop, so this path never writes desiredState). A failed stop
  // may leave the service half-stopped — run the rollback path so a service
  // that was up before gets started again.
  if (pre.serviceWasRunning) {
    if (!(await runStep("stop", () => stopHomeCompletely(pre.from, fromSpellings)))) {
      return rollbackAndFinish();
    }
  } else {
    // Even with no live pidfile, an orphaned runner tree may exist (the
    // embedded app can die without reaping) — sweep anyway; an empty tree is
    // a no-op.
    if (!(await runStep("stop", () => sweepHomeTree(fromSpellings).then((remaining) => {
      if (remaining.length > 0) {
        throw new Error(`home process tree did not stop (${remaining.map((p) => `${p.kind}:${p.pid}`).join(", ")} remain for ${pre.from})`);
      }
      return { home: pre.from, treeClean: true, serviceWasRunning: false };
    })))) {
      return rollbackAndFinish();
    }
  }

  // Step 3 — the move itself: rename (atomic on the same filesystem).
  // Skipped entirely in in-place mode: from==to means nothing moves.
  if (pre.mode !== "in-place" &&
    !(await runStep("move", async () => {
      // Drain marker refreshes first: a write that resolved its home as
      // <from> before this rename must land BEFORE it — afterwards it would
      // recreate the old home tree and break the rollback's move-back.
      await markerWrites.catch(() => {});
      await fs.mkdir(path.dirname(pre.to), { recursive: true });
      // Absent-and-empty target: POSIX rename(2) handles an empty dir target
      // on Linux but NOT reliably everywhere — clear it explicitly and record
      // how to restore that (empty) state on rollback.
      let removedEmptyTarget = false;
      if (await pathExists(pre.to)) {
        await fs.rmdir(pre.to);
        removedEmptyTarget = true;
      }
      await fs.rename(pre.from, pre.to);
      // The host-lifecycle owner record moved with the home but describes the
      // OLD home's launchd job (its label/definition carry the old home's
      // hash; the job itself was retired in the source-carrier step). Left in
      // place, converge at the new home fails closed with
      // HOST_LIFECYCLE_LAST_KNOWN_GOOD_UNVERIFIED (drill A1 finding). Clear
      // it — the start step converges a fresh carrier for the new home.
      // Record cleared ONLY after the rm actually succeeded, so a marker that
      // is still on disk is never treated as cleared.
      const markerPath = path.join(pre.to, "computer", "host-lifecycle-owner.json");
      let clearedMarkerContent: string | null = null;
      try {
        const content = await fs.readFile(markerPath, "utf8");
        await fs.rm(markerPath, { force: true });
        clearedMarkerContent = content;
      } catch {
        clearedMarkerContent = null;
      }
      journal.push({
        label: "move home back",
        undo: async () => {
          await fs.rename(pre.to, pre.from);
          if (removedEmptyTarget) await fs.mkdir(pre.to, { recursive: true });
          if (clearedMarkerContent !== null) {
            // The home is back at the SOURCE path by now — the marker
            // restores there, never at the target (which would re-create
            // <to>/computer and block the next migration's empty-target
            // preflight).
            const restorePath = path.join(pre.from, "computer", "host-lifecycle-owner.json");
            await fs.mkdir(path.dirname(restorePath), { recursive: true });
            await fs.writeFile(restorePath, clearedMarkerContent, "utf8");
          }
        },
      });
      return { from: pre.from, to: pre.to, staleLifecycleMarkerCleared: clearedMarkerContent !== null };
    }))
  ) {
    return rollbackAndFinish();
  }

  // Step 4 — repoint the ~/.slock-raft alias at the new home (move mode
  // only; in-place the alias already resolves to the right directory).
  if (pre.mode !== "in-place" && pre.alias) {
    if (
      !(await runStep("alias", async () => {
        await fs.unlink(pre.alias!.path);
        await fs.symlink(pre.to, pre.alias!.path, "dir");
        journal.push({
          label: "repoint alias back",
          undo: async () => {
            await fs.unlink(pre.alias!.path);
            await fs.symlink(pre.alias!.currentTarget, pre.alias!.path, "dir");
          },
        });
        return { path: pre.alias!.path, target: pre.to };
      }))
    ) {
      return rollbackAndFinish();
    }
  } else {
    record({ step: "alias", status: "skipped", detail: { reason: "no ~/.slock-raft symlink into the source home" } });
  }

  // Step 5 — session continuity (move mode only — in-place never changes
  // any path, so every project dir keeps matching): Claude Code keys ~/.claude/projects dirs by
  // the agent cwd's encoded name, so after the move every project dir under
  // the old home would stop matching and agents would lose their session
  // history. The encoding is per-character (see encodeProjectDirName), so a
  // prefix rename of the encoded names carries the whole subtree over.
  // Codex/Gemini session stores are NOT handled here (separate layouts).
  if (pre.mode !== "in-place") {
    const projectsDir = (deps.claudeProjectsDir ?? defaultClaudeProjectsDir)(homeDir);
    if (await pathExists(projectsDir)) {
      if (
        !(await runStep("sessions", async () => {
          // The encoding maps BOTH "/" and "-" to "-", so a loose
          // `${exact}-` prefix would also catch sibling projects like
          // <oldHome>-neighbor — renaming those breaks THEIR session
          // lookup (PM review). Only two shapes are safe to move:
          //   1. exactly encode(from)            — cwd was the home itself
          //   2. encode(from + "/agents/") …     — every agent cwd
          // Anything else that merely shares the prefix is listed as a
          // skipped sibling and left untouched.
          const exact = encodeProjectDirName(pre.from);
          const agentsPrefix = encodeProjectDirName(`${pre.from}${path.sep}agents${path.sep}`);
          const newPrefix = encodeProjectDirName(pre.to);
          const entries = await fs.readdir(projectsDir, { withFileTypes: true });
          let renamed = 0;
          const skippedExisting: string[] = [];
          const skippedSibling: string[] = [];
          for (const entry of entries) {
            if (!entry.isDirectory()) continue;
            const name = entry.name;
            const isAgentProject = name === exact || name.startsWith(agentsPrefix);
            if (!isAgentProject) {
              if (name.startsWith(`${exact}-`)) skippedSibling.push(name);
              continue;
            }
            const nextName = newPrefix + name.slice(exact.length);
            const fromDir = path.join(projectsDir, name);
            const toDir = path.join(projectsDir, nextName);
            // Never clobber: if the new name is already taken (e.g. an old
            // pre-migration run), leave the directory and report it.
            if (await pathExists(toDir)) {
              skippedExisting.push(name);
              continue;
            }
            await fs.rename(fromDir, toDir);
            journal.push({
              label: `restore session dir ${name}`,
              undo: async () => {
                await fs.rename(toDir, fromDir);
              },
            });
            renamed += 1;
          }
          return { renamed, skippedExisting, skippedSibling, projectsDir };
        }))
      ) {
        return rollbackAndFinish();
      }
    } else {
      record({ step: "sessions", status: "skipped", detail: { reason: "no ~/.claude/projects directory" } });
    }
  }

  // Step 6 — remove the home-env LaunchAgent (global setenv workaround).
  if (pre.homeEnv) {
    // The home-env label is FIXED per user, so bootout/bootstrap always act
    // on the REAL gui domain. Only issue them when the plist really lives in
    // the real user's LaunchAgents; a $HOME-overridden drill removes and
    // restores the file locally but never touches the domain.
    const realLaunchAgents = path.join((deps.realHomeDir ?? defaultRealHomeDir)(), "Library", "LaunchAgents");
    const launchctlAllowed = path.dirname(pre.homeEnv.path) === realLaunchAgents;
    if (
      !(await runStep("home-env", async () => {
        // bootout first so the setenv effect dies with the session; a job
        // that was never loaded is not an error.
        if (launchctlAllowed) {
          try {
            await runLaunchctl(["bootout", `gui/${uid}/${HOME_ENV_LABEL}`]);
          } catch {
            /* not loaded — nothing to boot out */
          }
        }
        await fs.rm(pre.homeEnv!.path, { force: true });
        journal.push({
          label: "restore home-env LaunchAgent",
          undo: async () => {
            await fs.mkdir(path.dirname(pre.homeEnv!.path), { recursive: true });
            await fs.writeFile(pre.homeEnv!.path, pre.homeEnv!.content, "utf8");
            if (launchctlAllowed) {
              try {
                await runLaunchctl(["bootstrap", `gui/${uid}`, pre.homeEnv!.path]);
              } catch {
                /* best-effort; the file is back, next load re-applies setenv */
              }
            }
          },
        });
        return { path: pre.homeEnv!.path, launchctl: launchctlAllowed ? "domain" : "skipped-isolated-home" };
      }))
    ) {
      return rollbackAndFinish();
    }
  } else {
    record({ step: "home-env", status: "skipped", detail: { reason: "no home-env LaunchAgent" } });
  }

  // Step 7 — durable backup of every plist this run deleted (source
  // carriers + home-env): byte-for-byte copies under the NEW home's
  // computer/migrate-backup/, recorded in the result file. Even after a
  // successful migration a mistakenly matched item stays recoverable by
  // hand (PM review requirement). Runs after the move so the backup never
  // creates directories at the target before the rename.
  {
    const removed = [
      ...pre.sourceCarriers.map((c) => ({ label: c.label, originalPath: c.plistPath, content: c.content })),
      ...(pre.homeEnv !== null ? [{ label: HOME_ENV_LABEL, originalPath: pre.homeEnv.path, content: pre.homeEnv.content }] : []),
    ];
    if (removed.length > 0) {
      if (
        !(await runStep("backup", async () => {
          const dir = path.join(pre.to, "computer", "migrate-backup");
          await fs.mkdir(dir, { recursive: true });
          for (const item of removed) {
            const backupPath = path.join(dir, `${item.label}.plist`);
            await fs.writeFile(backupPath, item.content, "utf8");
            backups.push({ label: item.label, originalPath: item.originalPath, backupPath });
          }
          return { dir, count: removed.length };
        }))
      ) {
        return rollbackAndFinish();
      }
    } else {
      record({ step: "backup", status: "skipped", detail: { reason: "nothing was deleted" } });
    }
  }

  // Step 8 — start standalone at the new home (or converge the login item
  // only, preserving a stopped-by-user service, or when the home has zero
  // attachments — `start` refuses to run a service with nothing attached, so
  // a fresh-install home converges the carrier and reports "down"). The undo
  // entry is journalled BEFORE the action: a start that fails halfway can
  // still leave a process at the target home, and the rollback must stop it
  // before the move back.
  const shouldStartService = pre.desiredState === "running" && pre.attachments.length > 0;
  // In-place takeover (PM decision 2026-10-09): from==to, so the CLI must
  // take the lifecycle over from the embedded app at the SAME home. A
  // lifecycle owner record still naming owner "app" makes the CLI converge
  // refuse to take over, so it is removed first (byte-captured; rollback
  // restores it verbatim — the old carrier's plist is restored by the
  // source-carrier undo, giving the byte-level rollback PM asked for).
  const takeOverLifecycle = async (): Promise<boolean> => {
    if (pre.mode !== "in-place") return false;
    const markerFile = path.join(pre.to, "computer", "host-lifecycle-owner.json");
    let content: string;
    try {
      content = await fs.readFile(markerFile, "utf8");
    } catch {
      return false; // no owner record — nothing to take over from
    }
    // A failed rm throws here, failing the start step into rollback — a
    // record still on disk is never treated as taken over.
    await fs.rm(markerFile, { force: true });
    const captured = content;
    journal.push({
      label: "restore in-place lifecycle owner record",
      undo: async () => {
        await fs.mkdir(path.dirname(markerFile), { recursive: true });
        await fs.writeFile(markerFile, captured, "utf8");
      },
    });
    return true;
  }
  if (shouldStartService) {
    if (
      !(await runStep("start", async () => {
        journal.push({
          label: "stop service at target",
          undo: async () => {
            await stopServiceAt(pre.to);
            await sweepHomeTree(toSpellings()).catch(() => [] as HomeProcess[]);
            try {
              await convergeCarrierAt(pre.to, "disabled");
            } catch {
              /* best-effort: job removal; the definition moves back anyway */
            }
          },
        });
        const tookOver = await takeOverLifecycle();
        await abortableWait(startServiceAt(pre.to), "start");
        return { home: pre.to, mode: pre.mode, lifecycleTakeover: tookOver };
      }))
    ) {
      return rollbackAndFinish();
    }
  } else {
    const reason =
      pre.desiredState !== "running"
        ? 'desiredState is "stopped"'
        : "no server attachments — nothing to start";
    if (
      !(await runStep("start", async () => {
        journal.push({
          label: "disable carrier at target",
          undo: async () => {
            try {
              await convergeCarrierAt(pre.to, "disabled");
            } catch {
              /* best-effort */
            }
          },
        });
        const tookOver = await takeOverLifecycle();
        await convergeCarrierAt(pre.to, "enabled");
        return { convergedOnly: true, reason, mode: pre.mode, lifecycleTakeover: tookOver };
      }))
    ) {
      return rollbackAndFinish();
    }
  }

  // Step 9 — self-check (only meaningful when the service should be running
  // and there is something to run).
  if (shouldStartService) {
    if (
      !(await runStep("self-check", async () => {
        const timeoutMs = deps.selfCheckTimeoutMs ?? 120_000;
        const pollMs = deps.selfCheckPollMs ?? 3_000;
        const deadline = Date.now() + timeoutMs;
        let last: MigrateHomeStatus = { serviceRunning: false, serverCount: pre.serverDirs, serversOnline: false };
        for (;;) {
          checkAbort();
          last = await statusAt(pre.to);
          if (last.serviceRunning && last.serversOnline) break;
          if (Date.now() >= deadline) {
            throw new Error(
              `self-check timed out after ${timeoutMs}ms: serviceRunning=${last.serviceRunning}, serversOnline=${last.serversOnline}, serverCount=${last.serverCount}`,
            );
          }
          await sleep(pollMs);
        }
        const agentDirs = await countDirs(path.join(pre.to, "agents"));
        if (agentDirs !== pre.agentDirs) {
          throw new Error(`agent directory count changed across the move (before=${pre.agentDirs}, after=${agentDirs})`);
        }
        // Exactly one runner tree per server (PM blocking fix): a surviving
        // OLD runner alongside the new home's runner means duplicate agents.
        // Scan every spelling of the target: live children may carry the
        // alias or literal spelling rather than the resolved path (#281).
        let toReal: string | null = null;
        try {
          toReal = await fs.realpath(pre.to);
        } catch {
          /* home must exist here — self-check already saw a live service */
        }
        const procs = await scanHomeProcesses([...toSpellings(), ...(toReal !== null ? [toReal] : [])]);
        const runnersByServer = new Map<string, number>();
        for (const proc of procs) {
          if (proc.kind !== "runner" || proc.serverId === null) continue;
          runnersByServer.set(proc.serverId, (runnersByServer.get(proc.serverId) ?? 0) + 1);
        }
        const duplicates = [...runnersByServer.entries()].filter(([, count]) => count > 1);
        if (duplicates.length > 0) {
          throw new Error(
            `duplicate runner trees after migration: ${duplicates.map(([id, n]) => `${id} x${n}`).join(", ")}`,
          );
        }
        return { serviceRunning: true, serversOnline: true, serverCount: last.serverCount, agentDirs, runnerTrees: [...runnersByServer.values()].reduce((a, b) => a + b, 0) };
      }))
    ) {
      return rollbackAndFinish();
    }
  } else {
    record({
      step: "self-check",
      status: "skipped",
      detail: {
        reason: pre.desiredState !== "running" ? 'desiredState is "stopped"' : "no server attachments",
      },
    });
  }

  const successServiceState: MigrateResultFile["serviceState"] = shouldStartService
    ? "running"
    : pre.desiredState === "stopped"
      ? "stopped-by-user"
      : "down";
  return finish("success", successServiceState, null);

  // Rolled into a function so every failure site shares one rollback path.
  async function rollbackAndFinish(): Promise<MigrateHomeRun> {
    // Which abort flag (if any) preceded the failure? Sampled BEFORE the
    // immunity flag goes up (afterwards abortReason() is null by design).
    const reason: MigrateResultFile["reason"] = abortSignal?.aborted
      ? "cancelled"
      : hardDeadlineAt !== undefined && nowFn().getTime() >= hardDeadlineAt
        ? "deadline"
        : null;
    // Rollback immunity (PM fix #288): from here on the deadline and the
    // cancel signal no longer abort anything — the undo journal must always
    // run to completion.
    rollbackStarted = true;
    record({ step: "rollback", status: "start", detail: { failedStep: failureStep } });
    const undoErrors: string[] = [];
    for (const entry of [...journal].reverse()) {
      try {
        await entry.undo();
      } catch (error) {
        undoErrors.push(`${entry.label}: ${(error as Error).message}`);
      }
    }
    // The abandoned start/stop keeps converging in-process and may spawn
    // detached children AFTER the journal ran (PM review on #292): wait it
    // out (bounded), sweep the affected home(s) once more, and verify the
    // target path is in the shape the rollback promises — absent or the
    // same empty directory it started as (move mode). Residue here is an
    // undo error, never a silent pass. Guarded on "an abandon actually
    // happened" — a PRE-EXISTING condition (e.g. an unkillable process the
    // stop step already failed on) must not be double-booked into the
    // rollback's verdict.
    if (abandonedOps.size > 0) {
      const abandonedDeadline = Date.now() + (deps.abandonedWaitTimeoutMs ?? 30_000);
      for (const op of [...abandonedOps]) {
        const remaining = abandonedDeadline - Date.now();
        if (remaining <= 0) break;
        // A real clock, deliberately NOT deps.sleep: the wait must hold even
        // under a faked instant-sleep test seam.
        await new Promise<void>((resolveWait) => {
          const cap = setTimeout(resolveWait, remaining);
          op.then(() => { clearTimeout(cap); resolveWait(); }, () => { clearTimeout(cap); resolveWait(); });
        });
      }
      abandonedOps.clear();
      const postRollbackSweepSpellings = pre.mode === "in-place" ? [...toSpellings(), pre.to] : toSpellings();
      const residue = await sweepHomeTree(postRollbackSweepSpellings);
      if (residue.length > 0) {
        undoErrors.push(`processes survived the post-rollback sweep (${residue.map((r) => `${r.kind}:${r.pid}`).join(", ")})`);
      }
      if (pre.mode !== "in-place") {
        let targetEntries: string[] | null = null;
        try {
          targetEntries = await fs.readdir(pre.to);
        } catch {
          targetEntries = null; // absent — the promised shape
        }
        if (targetEntries !== null && targetEntries.length > 0) {
          undoErrors.push(`target path left non-empty after rollback: ${pre.to} (${targetEntries.slice(0, 5).join(", ")}${targetEntries.length > 5 ? ", …" : ""})`);
        }
      }
    }
    // Bring the source service back only if it was actually up before we
    // stopped it — never "upgrade" a down machine during a rollback.
    let serviceState: MigrateResultFile["serviceState"] = pre.desiredState === "stopped" ? "stopped-by-user" : "down";
    if (pre.serviceWasRunning) {
      try {
        await startServiceAt(pre.from);
        serviceState = "running";
      } catch (error) {
        undoErrors.push(`restart source service: ${(error as Error).message}`);
        // A failed restart can still leave the service up — start times out
        // waiting for daemon readiness AFTER the process spawned (seen live
        // in drill 2). Trust the pidfile, not the exit code.
        try {
          const pid = await readPidfileAt(servicePidPath(pre.from));
          if (pid !== null && isProcessAlive(pid)) serviceState = "running";
        } catch {
          /* keep "down" */
        }
      }
    }
    const rollbackOk = undoErrors.length === 0;
    record({
      step: "rollback",
      status: undoErrors.length === 0 ? "ok" : "fail",
      detail: undoErrors.length > 0 ? { undoErrors } : undefined,
    });
    return finish(rollbackOk ? "rolled_back" : "failed", serviceState, {
      attempted: true,
      ok: rollbackOk,
      detail: undoErrors.length > 0 ? undoErrors.join("; ") : undefined,
    }, reason);
  }
}

// ---------- forced-quit stdout hardening (drill 284-run3, PM fix 2026-10-10) ----------

export function isEpipeError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const code = (error as NodeJS.ErrnoException).code;
  return code === "EPIPE" || /EPIPE/i.test(error.message);
}

export interface MigrationEventSinkDeps {
  writeStdout?: (line: string) => void;
  onStdoutError?: (handler: (error: Error) => void) => void;
  ignoreSignals?: () => void;
  appendFileSync?: (file: string, line: string) => void;
  homeComputerExists?: (home: string) => boolean;
}

/**
 * NDJSON line sink that survives the spawning app dying. The Desktop app
 * spawns `migrate-home --json` with stdout as a PIPE and folds the stream;
 * SIGKILL the app mid-apply and the pipe's reader is gone — the next stdout
 * write raises EPIPE and the CLI would die BEFORE finish() writes
 * migrate-result.json (drill 284-run3: the launchd-spawned service happily
 * completed at the new home while the app's launch recovery had nothing to
 * read). The sink swallows EPIPE — whether it surfaces as a synchronous
 * throw or the stream's async 'error' event — and from then on appends
 * every line to <home>/computer/migrate-run.ndjson (the same file a
 * redirected Desktop spawn tails), so the run still reaches finish().
 *
 * The fallback home is re-resolved per line: before the move the log rides
 * the SOURCE home (the rename carries it to the target — by path it IS the
 * target's file afterwards); after the move the target wins. A home only
 * qualifies when its computer/ dir exists, so a rolled-back run (which can
 * restore an EMPTY target dir) never makes the sink resurrect the old path.
 */
export function createMigrationEventSink(
  from: string,
  to: string,
  deps: MigrationEventSinkDeps = {},
): { emitLine: (line: string) => void; stdoutBroken: () => boolean } {
  const writeStdout = deps.writeStdout ?? ((line: string) => {
    process.stdout.write(line);
  });
  const onStdoutError = deps.onStdoutError ?? ((handler) => {
    process.stdout.on("error", handler);
  });
  const appendLine = deps.appendFileSync ?? ((file, line) => {
    fsMkdirSync(path.dirname(file), { recursive: true });
    fsAppendFileSync(file, line);
  });
  const homeComputerExists = deps.homeComputerExists ?? ((home) => {
    try {
      return fsStatSync(path.join(home, "computer")).isDirectory();
    } catch {
      return false;
    }
  });
  let broken = false;
  onStdoutError((error) => {
    if (isEpipeError(error)) broken = true;
    else throw error;
  });
  (deps.ignoreSignals ?? (() => {
    // The CLI must not die of its launcher's terminal signals mid-move: a
    // killed app ends the session, which can SIGHUP the surviving child.
    process.on("SIGPIPE", () => {});
    process.on("SIGHUP", () => {});
  }))();
  const toFile = (line: string) => {
    const home = homeComputerExists(to) ? to : from;
    appendLine(migrateRunLogPath(home), line);
  };
  return {
    emitLine(line: string) {
      if (!broken) {
        try {
          writeStdout(line);
          return;
        } catch (error) {
          if (!isEpipeError(error)) throw error;
          broken = true;
        }
      }
      toFile(line);
    },
    stdoutBroken: () => broken,
  };
}

// ---------- CLI adapter (`raft-computer migrate-home`) ----------

/** Parse `--deadline`: an absolute instant, either epoch milliseconds or an
 *  ISO 8601 timestamp (the Desktop app passes Date.now() + its wait budget
 *  — an absolute instant survives spawn latency; a duration would not). */
export function parseMigrateDeadline(raw: string): number {
  if (/^-?\d+$/.test(raw.trim())) {
    const epochMs = Number(raw.trim());
    if (epochMs > 0) return epochMs;
    throw new CliExit(1, "MIGRATE_DEADLINE_INVALID"); // a non-positive epoch is never a deadline
  }
  const parsed = Date.parse(raw);
  if (!Number.isNaN(parsed) && parsed > 0) return parsed;
  throw new CliExit(1, "MIGRATE_DEADLINE_INVALID");
}

function summarizeDetail(detail: Record<string, unknown>): string {
  const parts: string[] = [];
  for (const [key, value] of Object.entries(detail)) {
    const text = typeof value === "object" && value !== null ? JSON.stringify(value) : String(value);
    parts.push(`${key}=${text}`);
  }
  return parts.join(", ");
}

/** Real-deps wiring + output shaping. `--json` emits one event per line
 *  (interface v1 NDJSON) with the result summary as the final line; the
 *  human mode prints one line per event. Non-zero exit on blocked/failed.
 *  SIGTERM cancels into the rollback path (never a bare death); repeat
 *  signals are no-ops and the rollback itself ignores the signal. */
export async function runMigrateHomeCommand(
  opts: { from?: string; to?: string; apply?: boolean; json?: boolean; deadline?: string },
): Promise<void> {
  const cancel = new AbortController();
  const onSigterm = (): void => cancel.abort();
  process.on("SIGTERM", onSigterm);
  try {
    await runMigrateHomeCommandInner(opts, cancel.signal);
  } finally {
    process.removeListener("SIGTERM", onSigterm);
  }
}

async function runMigrateHomeCommandInner(
  opts: { from?: string; to?: string; apply?: boolean; json?: boolean; deadline?: string },
  abortSignal: AbortSignal,
): Promise<void> {
  // Hardened sink (drill 284-run3 fix): stdout may be a PIPE whose reader —
  // the Desktop app — can be SIGKILLed mid-apply. EPIPE must never kill the
  // CLI before finish() writes the result file.
  const { fromArg, to } = resolveMigrateHomeArgumentPaths(
    { from: opts.from, to: opts.to },
    process.env as { RAFT_HOME?: string; SLOCK_HOME?: string },
    os.homedir(),
  );
  const sink = createMigrationEventSink(fromArg, to);
  const emit = (event: MigrateEvent) => {
    if (opts.json) {
      sink.emitLine(`${JSON.stringify(event)}\n`);
    } else {
      const detail = event.detail ? ` — ${summarizeDetail(event.detail)}` : "";
      sink.emitLine(`migrate-home: [${event.step}] ${event.status}${detail}\n`);
    }
  };

  const deadlineAt = opts.deadline !== undefined ? parseMigrateDeadline(opts.deadline) : undefined;
  const deps: MigrateHomeDeps = {
    abortSignal,
    // Plain graceful stop: no desiredState write (a migration is not a user
    // stop) and no lifecycle convergence (the old carrier is the desktop
    // app's business; rollback restores the process, not the app's marker).
    stopServiceAt: async (home) => {
      const { createComputerApi } = await import("./lib/api.js");
      const api = createComputerApi(home);
      await api.stop(() => {}, {}, { hostLifecycleOwner: "none" });
    },
    // runStart resolves the home from the environment at call time, so pin
    // it for the duration of the call. Its own desiredState write records
    // "running" — exactly the intent that is being carried across the move.
    startServiceAt: async (home) => {
      const { runStart } = await import("./startStop.js");
      const savedRaft = process.env.RAFT_HOME;
      const savedSlock = process.env.SLOCK_HOME;
      process.env.RAFT_HOME = home;
      process.env.SLOCK_HOME = home;
      // NDJSON purity: runStart's human info() lines go to stdout, which in
      // --json mode must carry events only. Route stdout to stderr for the
      // duration of the start (no event is emitted inside this window) so
      // Desktop's line parser never sees a non-JSON line.
      const origWrite = process.stdout.write.bind(process.stdout);
      if (opts.json) {
        process.stdout.write = ((chunk: string | Uint8Array) =>
          process.stderr.write(chunk)) as typeof process.stdout.write;
      }
      try {
        await runStart({ hostLifecycleOwner: "cli" });
      } finally {
        if (opts.json) process.stdout.write = origWrite;
        if (savedRaft === undefined) delete process.env.RAFT_HOME;
        else process.env.RAFT_HOME = savedRaft;
        if (savedSlock === undefined) delete process.env.SLOCK_HOME;
        else process.env.SLOCK_HOME = savedSlock;
      }
    },
    convergeCarrierAt: async (home, desired) => {
      const { convergeCliHostLifecycle, resolveStableDispatcherPath } = await import("./macosLoginCarrier.js");
      // resolveMacosContext refuses an unbound dispatcher on darwin; fill it
      // the same way refreshCliLoginCarrierIfOwned does (honors the explicit
      // RAFT_COMPUTER_DISPATCHER_PATH override, else the current binary).
      const hostDeps: import("./macosLoginCarrier.js").MacosHostLifecycleDeps = {};
      if (process.platform === "darwin" && hostDeps.dispatcherPath === undefined) {
        hostDeps.dispatcherPath = resolveStableDispatcherPath(home);
      }
      await convergeCliHostLifecycle(home, desired, hostDeps);
    },
    statusAt: async (home) => {
      const { createComputerApi } = await import("./lib/api.js");
      const report = await createComputerApi(home).getStatus();
      const servers = report.servers;
      return {
        serviceRunning: report.service.running,
        serverCount: servers.length,
        serversOnline:
          servers.length === 0 || servers.every((row) => row.daemon.running && row.serverConnected),
      };
    },
    runLaunchctl: (args) =>
      new Promise((resolve) => {
        import("node:child_process").then(({ execFile }) => {
          execFile("launchctl", args, (error, _stdout, stderr) => {
            // Non-zero exit is surfaced, not thrown: the home-env step
            // treats "not loaded" as success, the result file keeps the rest.
            resolve({ code: error ? ((error as { code?: number }).code ?? 1) : 0, stderr: String(stderr ?? "") });
          });
        });
      }),
  };

  const run = await migrateHome({ from: opts.from, to: opts.to, apply: !!opts.apply, deadlineAt }, deps, emit);

  if (opts.json) {
    const finalLine = run.result ?? { dryRun: true, outcome: run.outcome, blocked: run.blocked, mode: run.mode };
    sink.emitLine(`${JSON.stringify(finalLine)}\n`);
  } else if (run.outcome === "planned") {
    sink.emitLine("Dry-run OK — re-run with --apply to perform the migration.\n");
  } else if (run.outcome === "blocked") {
    sink.emitLine("Dry-run found blockers — nothing was changed. Fix the blockers above and re-run.\n");
  }

  if (run.outcome === "blocked" || run.outcome === "failed") {
    throw new CliExit(1, `MIGRATE_${run.outcome.toUpperCase()}`);
  }
  if (run.outcome === "rolled_back") {
    throw new CliExit(1, "MIGRATE_ROLLED_BACK");
  }
}
