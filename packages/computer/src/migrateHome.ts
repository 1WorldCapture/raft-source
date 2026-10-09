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

import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { readDesiredState } from "./desiredState.js";
import { servicePidPath } from "./paths.js";
import { isProcessAlive, readPidfileAt } from "./internal/process-primitives.js";
import { CliExit, info } from "./output.js";

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
  from: string;
  to: string;
  startedAt: string;
  finishedAt: string;
  /** End state of the Computer service after the command finished. */
  serviceState: "running" | "stopped-by-user" | "down";
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

export interface MigrateHomeOptions {
  from?: string;
  to?: string;
  apply: boolean;
}

export interface MigrateHomeRun {
  /** apply: success | rolled_back | failed; dry-run: planned | blocked. */
  outcome: MigrateOutcome | "planned" | "blocked";
  blocked: boolean;
  result: MigrateResultFile | null;
}

function resolveTilde(input: string, homeDir: string): string {
  if (input === "~") return homeDir;
  if (input.startsWith("~/")) return path.join(homeDir, input.slice(2));
  return input;
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
  to: string;
  blockers: string[];
  warnings: string[];
  serviceWasRunning: boolean;
  desiredState: "running" | "stopped";
  agentDirs: number;
  serverDirs: number;
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

  const { resolveRaftHome } = await import("./paths.js");
  const fromRaw = opts.from ?? resolveRaftHome(env, homeDir);
  const from = path.resolve(resolveTilde(fromRaw, homeDir));
  const to = path.resolve(resolveTilde(opts.to ?? path.join(homeDir, ".slock"), homeDir));

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

  // Source and target must be distinct (and neither nested in the other —
  // moving a directory into itself is undefined across the rename).
  if (fromReal === to || to === path.dirname(fromReal) || fromReal.startsWith(`${to}${path.sep}`) || to.startsWith(`${fromReal}${path.sep}`)) {
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
    serviceWasRunning,
    desiredState,
    agentDirs,
    serverDirs,
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
    to,
    blockers,
    warnings,
    serviceWasRunning,
    desiredState,
    agentDirs,
    serverDirs,
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
  };

  // ---- dry-run: the preflight above IS the run; emit the plan as steps ----
  if (!opts.apply) {
    const planned: Array<[MigrateStep, MigrateStepStatus, Record<string, unknown> | undefined]> = [
      [
        "source-carrier",
        pre.sourceCarriers.length > 0 ? "planned" : "skipped",
        pre.sourceCarriers.length > 0
          ? { carriers: pre.sourceCarriers.map((c) => ({ label: c.label, plistPath: c.plistPath })) }
          : { reason: "no login items point at the source home" },
      ],
      ["stop", pre.serviceWasRunning ? "planned" : "skipped", pre.serviceWasRunning ? undefined : { reason: "service not running" }],
      ["move", "planned", { from: pre.from, to: pre.to }],
      ["alias", pre.alias ? "planned" : "skipped", pre.alias ? { path: pre.alias.path, currentTarget: pre.alias.currentTarget } : { reason: "no ~/.slock-raft symlink into the source home" }],
      ["sessions", "planned", { note: "rename ~/.claude/projects dirs whose encoded name starts with the old home" }],
      ["home-env", pre.homeEnv ? "planned" : "skipped", pre.homeEnv ? { path: pre.homeEnv.path } : { reason: "no home-env LaunchAgent" }],
      ["backup", pre.sourceCarriers.length > 0 || pre.homeEnv ? "planned" : "skipped", { dir: "<to>/computer/migrate-backup" }],
      ["start", pre.desiredState === "running" ? "planned" : "skipped", pre.desiredState === "running" ? undefined : { reason: 'desiredState is "stopped"; the login item is converged but the service stays stopped' }],
      ["self-check", pre.desiredState === "running" ? "planned" : "skipped", pre.desiredState === "running" ? { agentDirs: pre.agentDirs, serverDirs: pre.serverDirs } : undefined],
    ];
    for (const [step, status, detail] of planned) {
      record({ step, status, detail });
    }
    return { outcome: pre.blockers.length > 0 ? "blocked" : "planned", blocked: pre.blockers.length > 0, result: null };
  }

  // ---- apply: blockers abort before ANY mutation (and write no result file) ----
  if (pre.blockers.length > 0) {
    return { outcome: "blocked", blocked: true, result: null };
  }

  // ---- apply ----
  const homeDir = deps.homeDir ?? os.homedir();
  const uid = deps.uid ?? (typeof process.getuid === "function" ? process.getuid() : -1);
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const { stopServiceAt, startServiceAt, convergeCarrierAt, statusAt, runLaunchctl } = deps;

  const journal: UndoEntry[] = [];
  const backups: MigrateBackupEntry[] = [];
  let failure: string | null = null;
  let failureStep: MigrateStep | null = null;

  const runStep = async (step: MigrateStep, fn: () => Promise<Record<string, unknown> | void>) => {
    record({ step, status: "start" });
    try {
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

  const finish = async (result: MigrateOutcome, serviceState: MigrateResultFile["serviceState"], rollback: MigrateResultFile["rollback"]): Promise<MigrateHomeRun> => {
    const file: MigrateResultFile = {
      schemaVersion: 1,
      result,
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
    return { outcome: result, blocked: false, result: file };
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
    if (!(await runStep("stop", () => stopServiceAt(pre.from)))) {
      return rollbackAndFinish();
    }
  } else {
    record({ step: "stop", status: "skipped", detail: { reason: "service not running" } });
  }

  // Step 3 — the move itself: rename (atomic on the same filesystem).
  if (
    !(await runStep("move", async () => {
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
      journal.push({
        label: "move home back",
        undo: async () => {
          await fs.rename(pre.to, pre.from);
          if (removedEmptyTarget) await fs.mkdir(pre.to, { recursive: true });
        },
      });
      return { from: pre.from, to: pre.to };
    }))
  ) {
    return rollbackAndFinish();
  }

  // Step 4 — repoint the ~/.slock-raft alias at the new home.
  if (pre.alias) {
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

  // Step 5 — session continuity: Claude Code keys ~/.claude/projects dirs by
  // the agent cwd's encoded name, so after the move every project dir under
  // the old home would stop matching and agents would lose their session
  // history. The encoding is per-character (see encodeProjectDirName), so a
  // prefix rename of the encoded names carries the whole subtree over.
  // Codex/Gemini session stores are NOT handled here (separate layouts).
  {
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
    if (
      !(await runStep("home-env", async () => {
        // bootout first so the setenv effect dies with the session; a job
        // that was never loaded is not an error.
        try {
          await runLaunchctl(["bootout", `gui/${uid}/${HOME_ENV_LABEL}`]);
        } catch {
          /* not loaded — nothing to boot out */
        }
        await fs.rm(pre.homeEnv!.path, { force: true });
        journal.push({
          label: "restore home-env LaunchAgent",
          undo: async () => {
            await fs.mkdir(path.dirname(pre.homeEnv!.path), { recursive: true });
            await fs.writeFile(pre.homeEnv!.path, pre.homeEnv!.content, "utf8");
            try {
              await runLaunchctl(["bootstrap", `gui/${uid}`, pre.homeEnv!.path]);
            } catch {
              /* best-effort; the file is back, next load re-applies setenv */
            }
          },
        });
        return { path: pre.homeEnv!.path };
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
  // only, preserving a stopped-by-user service). The undo entry is journalled
  // BEFORE the action: a start that fails halfway can still leave a process
  // at the target home, and the rollback must stop it before the move back.
  if (pre.desiredState === "running") {
    if (
      !(await runStep("start", async () => {
        journal.push({
          label: "stop service at target",
          undo: async () => {
            await stopServiceAt(pre.to);
            try {
              await convergeCarrierAt(pre.to, "disabled");
            } catch {
              /* best-effort: job removal; the definition moves back anyway */
            }
          },
        });
        await startServiceAt(pre.to);
        return { home: pre.to };
      }))
    ) {
      return rollbackAndFinish();
    }
  } else {
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
        await convergeCarrierAt(pre.to, "enabled");
        return { convergedOnly: true, reason: 'desiredState is "stopped"' };
      }))
    ) {
      return rollbackAndFinish();
    }
  }

  // Step 9 — self-check (only meaningful when the service should be running).
  if (pre.desiredState === "running") {
    if (
      !(await runStep("self-check", async () => {
        const timeoutMs = deps.selfCheckTimeoutMs ?? 120_000;
        const pollMs = deps.selfCheckPollMs ?? 3_000;
        const deadline = Date.now() + timeoutMs;
        let last: MigrateHomeStatus = { serviceRunning: false, serverCount: pre.serverDirs, serversOnline: false };
        for (;;) {
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
        return { serviceRunning: true, serversOnline: true, serverCount: last.serverCount, agentDirs };
      }))
    ) {
      return rollbackAndFinish();
    }
  } else {
    record({ step: "self-check", status: "skipped", detail: { reason: 'desiredState is "stopped"' } });
  }

  return finish("success", pre.desiredState === "running" ? "running" : "stopped-by-user", null);

  // Rolled into a function so every failure site shares one rollback path.
  async function rollbackAndFinish(): Promise<MigrateHomeRun> {
    record({ step: "rollback", status: "start", detail: { failedStep: failureStep } });
    const undoErrors: string[] = [];
    for (const entry of [...journal].reverse()) {
      try {
        await entry.undo();
      } catch (error) {
        undoErrors.push(`${entry.label}: ${(error as Error).message}`);
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
    });
  }
}

// ---------- CLI adapter (`raft-computer migrate-home`) ----------

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
 *  human mode prints one line per event. Non-zero exit on blocked/failed. */
export async function runMigrateHomeCommand(
  opts: { from?: string; to?: string; apply?: boolean; json?: boolean },
): Promise<void> {
  const emit = (event: MigrateEvent) => {
    if (opts.json) {
      process.stdout.write(`${JSON.stringify(event)}\n`);
    } else {
      const detail = event.detail ? ` — ${summarizeDetail(event.detail)}` : "";
      info(`migrate-home: [${event.step}] ${event.status}${detail}`);
    }
  };

  const deps: MigrateHomeDeps = {
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
      try {
        await runStart({ hostLifecycleOwner: "cli" });
      } finally {
        if (savedRaft === undefined) delete process.env.RAFT_HOME;
        else process.env.RAFT_HOME = savedRaft;
        if (savedSlock === undefined) delete process.env.SLOCK_HOME;
        else process.env.SLOCK_HOME = savedSlock;
      }
    },
    convergeCarrierAt: async (home, desired) => {
      const { convergeCliHostLifecycle } = await import("./macosLoginCarrier.js");
      await convergeCliHostLifecycle(home, desired);
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

  const run = await migrateHome({ from: opts.from, to: opts.to, apply: !!opts.apply }, deps, emit);

  if (opts.json) {
    const finalLine = run.result ?? { dryRun: true, outcome: run.outcome, blocked: run.blocked };
    process.stdout.write(`${JSON.stringify(finalLine)}\n`);
  } else if (run.outcome === "planned") {
    info("Dry-run OK — re-run with --apply to perform the migration.");
  } else if (run.outcome === "blocked") {
    info("Dry-run found blockers — nothing was changed. Fix the blockers above and re-run.");
  }

  if (run.outcome === "blocked" || run.outcome === "failed") {
    throw new CliExit(1, `MIGRATE_${run.outcome.toUpperCase()}`);
  }
  if (run.outcome === "rolled_back") {
    throw new CliExit(1, "MIGRATE_ROLLED_BACK");
  }
}
