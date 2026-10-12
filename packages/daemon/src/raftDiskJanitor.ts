import { lstat, readdir, realpath, rm } from "node:fs/promises";
import path from "node:path";
import { currentDate, currentTimeMs } from "@botiverse/raft-shared";
import {
  AGENT_MIGRATION_WORKSPACE_BACKUP_DIRECTORY,
  AGENT_MIGRATION_WORKSPACE_BACKUP_MAX_PER_AGENT,
  pruneAgentMigrationWorkspaceBackups,
} from "./agentMigrationWorkspaceArchive.js";

/**
 * Raft Computer's own disk use under SLOCK_HOME: migration transfer copies,
 * archived workspaces and per-launch CLI transport. Agent workspaces are never
 * walked or touched here.
 *
 * Every walk and every sweep is bounded by an entry budget and a deadline so a
 * single pass cannot saturate disk IO; a bounded result says so explicitly
 * (`truncated` / `timeout`) instead of reporting a misleadingly small number.
 */

export const RAFT_MIGRATIONS_DIRECTORY = "migrations";
export const RAFT_CLI_TRANSPORT_DIRECTORY = "cli-transport";
export const RAFT_AGENT_PROXY_TOKENS_DIRECTORY = "agent-proxy-tokens";

/**
 * Migration deadlines are minutes to hours, so a transport generation with no
 * activity for a week belongs to a migration that has ended either way.
 */
export const RAFT_MIGRATION_GENERATION_IDLE_MS = 7 * 24 * 60 * 60 * 1_000;
/** Bulk transfer data inside a generation; the JSON reports stay. */
const MIGRATION_GENERATION_BULK_ENTRY = /^(chunks|source-spool|extracting-.+)$/u;

const OBJECT_STORE_STAGING_WORKSPACE = "workspace";
export const RAFT_DISK_JANITOR_MAX_BACKUPS_PER_AGENT = 1_000;

/** The backup root must be a real directory (not a symlink) and sit outside the agent data dir. */
async function isSafeBackupRoot(backupRoot: string, dataDir?: string): Promise<boolean> {
  const info = await lstat(backupRoot).catch(() => null);
  if (!info || !info.isDirectory() || info.isSymbolicLink()) return false;
  if (!dataDir) return true;
  const [realBackup, realData] = await Promise.all([
    realpath(backupRoot).catch(() => null),
    realpath(dataDir).catch(() => path.resolve(dataDir)),
  ]);
  if (!realBackup) return false;
  const relative = path.relative(realData, realBackup);
  return !(relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative)));
}

export const RAFT_DISK_WALK_MAX_ENTRIES = 200_000;
export const RAFT_DISK_WALK_DEADLINE_MS = 30_000;
/** Yield to the event loop (and the disk) between lstat batches. */
const WALK_BATCH_SIZE = 64;

export type RaftDiskMeasureOutcome = "complete" | "truncated" | "timeout";

export interface RaftDiskWalkBudget {
  entriesLeft: number;
  deadlineMs: number;
  outcome: RaftDiskMeasureOutcome;
}

export function createRaftDiskWalkBudget(input?: { maxEntries?: number; deadlineMs?: number; nowMs?: number }): RaftDiskWalkBudget {
  return {
    entriesLeft: input?.maxEntries ?? RAFT_DISK_WALK_MAX_ENTRIES,
    deadlineMs: (input?.nowMs ?? currentTimeMs()) + (input?.deadlineMs ?? RAFT_DISK_WALK_DEADLINE_MS),
    outcome: "complete",
  };
}

function budgetExhausted(budget: RaftDiskWalkBudget): boolean {
  if (budget.outcome !== "complete") return true;
  if (budget.entriesLeft <= 0) {
    budget.outcome = "truncated";
    return true;
  }
  if (currentTimeMs() >= budget.deadlineMs) {
    budget.outcome = "timeout";
    return true;
  }
  return false;
}

/** Apparent bytes of regular files under `root`; symlinks are not followed. */
export async function measureDirectoryBytes(root: string, budget: RaftDiskWalkBudget): Promise<number> {
  let bytes = 0;
  const pending = [root];
  while (pending.length > 0) {
    if (budgetExhausted(budget)) return bytes;
    const dir = pending.pop()!;
    let names: string[];
    try {
      names = await readdir(dir);
    } catch {
      continue;
    }
    for (let index = 0; index < names.length; index += WALK_BATCH_SIZE) {
      if (budgetExhausted(budget)) return bytes;
      const batch = names.slice(index, index + WALK_BATCH_SIZE);
      budget.entriesLeft -= batch.length;
      const infos = await Promise.all(batch.map((name) =>
        lstat(path.join(dir, name)).then((info) => ({ name, info }), () => null)));
      for (const entry of infos) {
        if (!entry) continue;
        if (entry.info.isDirectory()) pending.push(path.join(dir, entry.name));
        else if (entry.info.isFile()) bytes += entry.info.size;
      }
    }
  }
  return bytes;
}

async function listDirectories(dir: string): Promise<string[]> {
  try {
    const entries = await readdir(dir, { withFileTypes: true });
    return entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name);
  } catch {
    return [];
  }
}

export type RaftDiskFootprint = {
  raft_migration_chunks_bytes: number;
  raft_workspace_backups_bytes: number;
  raft_launch_dirs_bytes: number;
  measure_outcome: RaftDiskMeasureOutcome;
};

export async function measureRaftDiskFootprint(
  slockHome: string,
  budget: RaftDiskWalkBudget = createRaftDiskWalkBudget(),
): Promise<RaftDiskFootprint> {
  const migrations = await measureDirectoryBytes(path.join(slockHome, RAFT_MIGRATIONS_DIRECTORY), budget);
  const backups = await measureDirectoryBytes(path.join(slockHome, AGENT_MIGRATION_WORKSPACE_BACKUP_DIRECTORY), budget);
  const launches = await measureDirectoryBytes(path.join(slockHome, RAFT_CLI_TRANSPORT_DIRECTORY), budget)
    + await measureDirectoryBytes(path.join(slockHome, RAFT_AGENT_PROXY_TOKENS_DIRECTORY), budget);
  return {
    raft_migration_chunks_bytes: migrations,
    raft_workspace_backups_bytes: backups,
    raft_launch_dirs_bytes: launches,
    measure_outcome: budget.outcome,
  };
}

export interface RaftDiskJanitorHooks {
  /** Called once per path actually removed. */
  onRemoved?: (removedPath: string, freedBytes: number) => void;
  /** Called for data deliberately left in place that a human may want to know about. */
  onKept?: (keptPath: string, reason: string) => void;
}

/**
 * Removes the bulk transfer data of one migration transport generation and
 * keeps its JSON reports. Returns the bytes freed (bounded measurement).
 *
 * An `extracting-*` root that holds a `workspace` directory is the full,
 * un-adopted workspace copy from a failed final rename: it is kept and
 * reported, never deleted. Nothing is removed once the budget is exhausted.
 */
export async function removeMigrationGenerationBulk(
  generationRoot: string,
  budget: RaftDiskWalkBudget,
  hooks: RaftDiskJanitorHooks = {},
): Promise<number> {
  let freed = 0;
  let names: string[];
  try {
    names = await readdir(generationRoot);
  } catch {
    return 0;
  }
  for (const name of names) {
    if (!MIGRATION_GENERATION_BULK_ENTRY.test(name)) continue;
    if (budgetExhausted(budget)) break;
    const target = path.join(generationRoot, name);
    const info = await lstat(target).catch(() => null);
    if (!info || !info.isDirectory()) continue;
    if (name.startsWith("extracting-")) {
      const holdsWorkspace = await lstat(path.join(target, "workspace")).then(() => true, () => false);
      if (holdsWorkspace) {
        hooks.onKept?.(target, "un-adopted extracted workspace");
        continue;
      }
    }
    const bytes = await measureDirectoryBytes(target, budget);
    // A truncated measurement means the directory is bigger than what we are
    // allowed to walk in one pass; leave it for a pass with a fresh budget
    // rather than deleting something we could not even size.
    if (budget.outcome !== "complete") break;
    await rm(target, { recursive: true, force: true });
    freed += bytes;
    hooks.onRemoved?.(target, bytes);
  }
  return freed;
}

/** Newest mtime of the generation root and its direct children. */
async function generationLastActivityMs(generationRoot: string): Promise<number | null> {
  try {
    let newest = (await lstat(generationRoot)).mtimeMs;
    for (const name of await readdir(generationRoot)) {
      const info = await lstat(path.join(generationRoot, name)).catch(() => null);
      if (info && info.mtimeMs > newest) newest = info.mtimeMs;
    }
    return newest;
  } catch {
    return null;
  }
}

export interface RaftDiskJanitorBackupRemoval {
  ownerAgentId: string;
  backupKind: "migration" | "preexisting";
  ageDays: number;
  freedBytes: number;
}

export interface RaftDiskJanitorResult {
  /** Every path removed (generation bulk entries and backup directories). */
  removedPaths: string[];
  /** Data left in place on purpose that deserves a human look. */
  keptPaths: Array<{ path: string; reason: string }>;
  migrationGenerationsCleaned: number;
  migrationFreedBytes: number;
  backupsRemoved: RaftDiskJanitorBackupRemoval[];
  backupsFreedBytes: number;
  sweepOutcome: RaftDiskMeasureOutcome;
}

/**
 * One bounded janitor pass:
 * - idle (>7d) migration transport generations lose their bulk data;
 * - workspace backups get the existing keep-3 / 30-day rule, which until now
 *   only ran when the same agent migrated again.
 */
export async function runRaftDiskJanitor(input: {
  slockHome: string;
  now?: Date;
  budget?: RaftDiskWalkBudget;
  /** Path segments of migrations the daemon currently holds a transfer lease for; never touched. */
  activeMigrationSegments?: ReadonlySet<string>;
  /** Agent data root; a backup root resolving inside it is refused. */
  dataDir?: string;
}): Promise<RaftDiskJanitorResult> {
  const now = input.now ?? currentDate();
  const budget = input.budget ?? createRaftDiskWalkBudget();
  const result: RaftDiskJanitorResult = {
    removedPaths: [],
    keptPaths: [],
    migrationGenerationsCleaned: 0,
    migrationFreedBytes: 0,
    backupsRemoved: [],
    backupsFreedBytes: 0,
    sweepOutcome: "complete",
  };

  const hooks: RaftDiskJanitorHooks = {
    onRemoved: (removedPath) => result.removedPaths.push(removedPath),
    onKept: (keptPath, reason) => result.keptPaths.push({ path: keptPath, reason }),
  };
  const migrationsRoot = path.join(input.slockHome, RAFT_MIGRATIONS_DIRECTORY);
  const idleBeforeMs = now.getTime() - RAFT_MIGRATION_GENERATION_IDLE_MS;
  for (const migration of await listDirectories(migrationsRoot)) {
    if (input.activeMigrationSegments?.has(migration)) continue;
    const generations = await listDirectories(path.join(migrationsRoot, migration));
    // `migrations/<session>/workspace` is the object-store staging area for an
    // agent's workspace, not a transport generation. Its contents are user
    // data (a workspace may well contain a `chunks` directory), so a migration
    // directory shaped like that is skipped whole.
    if (generations.includes(OBJECT_STORE_STAGING_WORKSPACE)) continue;
    for (const generation of generations) {
      if (budgetExhausted(budget)) break;
      const generationRoot = path.join(migrationsRoot, migration, generation);
      const names = await readdir(generationRoot).catch(() => [] as string[]);
      if (!names.some((name) => MIGRATION_GENERATION_BULK_ENTRY.test(name))) continue;
      const lastActivityMs = await generationLastActivityMs(generationRoot);
      if (lastActivityMs === null || lastActivityMs >= idleBeforeMs) continue;
      const freed = await removeMigrationGenerationBulk(generationRoot, budget, hooks);
      result.migrationFreedBytes += freed;
      if (freed > 0) result.migrationGenerationsCleaned += 1;
    }
  }

  const backupRoot = path.join(input.slockHome, AGENT_MIGRATION_WORKSPACE_BACKUP_DIRECTORY);
  if (await isSafeBackupRoot(backupRoot, input.dataDir)) {
    for (const ownerAgentId of await listDirectories(backupRoot)) {
      if (budgetExhausted(budget)) break;
      const agentBackupRoot = path.join(backupRoot, ownerAgentId);
      await pruneAgentMigrationWorkspaceBackups({
        agentBackupRoot,
        now,
        keepNewestRegardlessOfAge: AGENT_MIGRATION_WORKSPACE_BACKUP_MAX_PER_AGENT,
        maxEntries: RAFT_DISK_JANITOR_MAX_BACKUPS_PER_AGENT,
        shouldStop: () => budgetExhausted(budget),
        beforeRemove: async (entry) => {
          const removedPath = path.join(agentBackupRoot, entry.name);
          const freedBytes = await measureDirectoryBytes(removedPath, budget);
          result.backupsFreedBytes += freedBytes;
          result.removedPaths.push(removedPath);
          result.backupsRemoved.push({
            ownerAgentId,
            backupKind: entry.name.startsWith("preexisting-") ? "preexisting" : "migration",
            ageDays: Math.floor((now.getTime() - entry.modifiedAtMs) / (24 * 60 * 60 * 1_000)),
            freedBytes,
          });
        },
      }).catch(() => {
        // One unreadable agent directory must not abort the rest of the pass.
      });
    }
  }
  result.sweepOutcome = budget.outcome;
  return result;
}

/** First pass well after startup, then daily. */
export const RAFT_DISK_JANITOR_INITIAL_DELAY_MS = 10 * 60 * 1_000;
export const RAFT_DISK_JANITOR_INTERVAL_MS = 24 * 60 * 60 * 1_000;

export interface RaftDiskJanitorTimers {
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(timer: unknown): void;
}

const defaultTimers: RaftDiskJanitorTimers = {
  setTimeout: (fn, ms) => {
    const timer = setTimeout(fn, ms);
    timer.unref?.();
    return timer;
  },
  clearTimeout: (timer) => clearTimeout(timer as ReturnType<typeof setTimeout>),
};

/** Runs `pass` after the initial delay and then every interval; never overlapping. */
export function scheduleRaftDiskJanitor(input: {
  pass: () => Promise<void>;
  timers?: RaftDiskJanitorTimers;
  initialDelayMs?: number;
  intervalMs?: number;
}): { stop(): void } {
  const timers = input.timers ?? defaultTimers;
  let timer: unknown = null;
  let stopped = false;
  const arm = (delayMs: number) => {
    timer = timers.setTimeout(() => {
      timer = null;
      void input.pass().catch(() => {}).finally(() => {
        if (!stopped) arm(input.intervalMs ?? RAFT_DISK_JANITOR_INTERVAL_MS);
      });
    }, delayMs);
  };
  arm(input.initialDelayMs ?? RAFT_DISK_JANITOR_INITIAL_DELAY_MS);
  return {
    stop() {
      stopped = true;
      if (timer !== null) timers.clearTimeout(timer);
      timer = null;
    },
  };
}
