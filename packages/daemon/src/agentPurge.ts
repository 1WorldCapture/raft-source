// Local cleanup after an agent is deleted on the server (`agent:purge`).
//
// The agent's per-agent directories are MOVED into a quarantine area
// (<slockHome>/trash/<kind>/<agentId>-<timestamp>) instead of being deleted, and
// a sweeper removes quarantined entries after a retention period. Nothing here
// ever follows a symlink or touches a path that is not exactly
// <root>/<uuid>.
import { cp, lstat, mkdir, readdir, rename, rm } from "node:fs/promises";
import path from "node:path";
import { logger } from "./logger.js";

export const AGENT_PURGE_CAPABILITY = "agent:purge";
export const DEFAULT_AGENT_TRASH_RETENTION_DAYS = 14;
export const AGENT_TRASH_RETENTION_ENV = "RAFT_AGENT_TRASH_RETENTION_DAYS";
export const AGENT_TRASH_SWEEP_INTERVAL_MS = 24 * 60 * 60 * 1000;

/** Strict UUID (any RFC 4122 version) — the only agent id shape we will turn into a path. */
const AGENT_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function isPurgeableAgentId(value: unknown): value is string {
  return typeof value === "string" && AGENT_ID_PATTERN.test(value);
}

/** Per-agent roots, relative to the slock home (the agents root may be relocated, so it is passed in). */
export type AgentPurgeKind = "agents" | "cli-transport" | "cursor-sdk-host";

export interface AgentPurgeTarget {
  kind: AgentPurgeKind;
  /** Parent directory that must directly contain `<agentId>`. */
  root: string;
}

export function agentPurgeTargets(slockHome: string, agentsRoot: string): AgentPurgeTarget[] {
  return [
    { kind: "agents", root: agentsRoot },
    { kind: "cli-transport", root: path.join(slockHome, "cli-transport") },
    { kind: "cursor-sdk-host", root: path.join(slockHome, "cursor-sdk-host") },
  ];
}

export type MoveToTrashResult = "purged" | "nothing_to_purge";

function trashStamp(now: Date): string {
  return now.toISOString().replace(/:/g, "-");
}

async function moveDirectory(from: string, to: string): Promise<void> {
  await mkdir(path.dirname(to), { recursive: true, mode: 0o700 });
  try {
    await rename(from, to);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EXDEV") throw error;
    // Different filesystem: copy, then remove the source only after the copy succeeded.
    await cp(from, to, { recursive: true, errorOnExist: true, force: false, verbatimSymlinks: true });
    await rm(from, { recursive: true, force: true });
  }
}

/**
 * Move `<root>/<agentId>` of every target into the trash. Returns
 * `nothing_to_purge` when none of them exists (idempotent re-run). A target
 * that is a symlink, or not a directory, aborts with an error and moves
 * nothing further.
 */
export async function moveAgentDirectoriesToTrash(input: {
  agentId: string;
  slockHome: string;
  targets: AgentPurgeTarget[];
  now?: Date;
}): Promise<MoveToTrashResult> {
  const { agentId, slockHome, targets } = input;
  if (!isPurgeableAgentId(agentId)) throw new Error("agent id is not a UUID");
  const stamp = trashStamp(input.now ?? new Date());
  const trashRoot = path.join(slockHome, "trash");

  // Validate everything first so a bad target cannot leave a half-moved agent.
  const plan: Array<{ from: string; to: string }> = [];
  for (const target of targets) {
    const from = path.join(target.root, agentId);
    if (path.dirname(path.resolve(from)) !== path.resolve(target.root)) {
      throw new Error(`refusing path outside ${target.kind} root`);
    }
    let info;
    try {
      info = await lstat(from);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
      throw error;
    }
    if (info.isSymbolicLink() || !info.isDirectory()) {
      throw new Error(`refusing to move ${target.kind}/${agentId}: not a plain directory`);
    }
    plan.push({ from, to: path.join(trashRoot, target.kind, `${agentId}-${stamp}`) });
  }
  if (plan.length === 0) return "nothing_to_purge";
  for (const step of plan) await moveDirectory(step.from, step.to);
  return "purged";
}

export function agentTrashRetentionMs(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env[AGENT_TRASH_RETENTION_ENV];
  if (raw !== undefined && raw.trim() !== "") {
    const days = Number(raw);
    if (Number.isFinite(days) && days >= 0) return days * 24 * 60 * 60 * 1000;
  }
  return DEFAULT_AGENT_TRASH_RETENTION_DAYS * 24 * 60 * 60 * 1000;
}

const TRASH_KINDS: AgentPurgeKind[] = ["agents", "cli-transport", "cursor-sdk-host"];
// <uuid>-<ISO timestamp with ':' replaced by '-'>, e.g. 0123...-2026-10-07T14-56-49.123Z
const TRASH_ENTRY_PATTERN = /^([0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})-(\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}\.\d{3}Z)$/i;

function parseTrashEntryTime(name: string): number | null {
  const match = TRASH_ENTRY_PATTERN.exec(name);
  if (!match) return null;
  const iso = match[2].replace(/T(\d{2})-(\d{2})-(\d{2})/, "T$1:$2:$3");
  const time = Date.parse(iso);
  return Number.isNaN(time) ? null : time;
}

async function directorySize(dir: string): Promise<number> {
  let total = 0;
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return 0;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      total += await directorySize(full);
    } else {
      try {
        total += (await lstat(full)).size;
      } catch {
        /* vanished while sweeping */
      }
    }
  }
  return total;
}

export interface TrashSweepResult {
  removed: number;
  remaining: number;
  remainingBytes: number;
}

/**
 * Delete quarantined entries older than the retention period. Only entries
 * named exactly `<uuid>-<timestamp>` directly under `trash/<kind>/` are ever
 * touched. Logs the remaining entry count and size on every run.
 */
export async function sweepAgentTrash(input: {
  slockHome: string;
  now?: Date;
  retentionMs?: number;
}): Promise<TrashSweepResult> {
  const now = (input.now ?? new Date()).getTime();
  const retentionMs = input.retentionMs ?? agentTrashRetentionMs();
  const trashRoot = path.join(input.slockHome, "trash");
  let removed = 0;
  let remaining = 0;
  let remainingBytes = 0;
  for (const kind of TRASH_KINDS) {
    const kindRoot = path.join(trashRoot, kind);
    let names: string[];
    try {
      names = await readdir(kindRoot);
    } catch {
      continue;
    }
    for (const name of names) {
      const time = parseTrashEntryTime(name);
      if (time === null) continue; // never touch anything we did not create
      const entry = path.join(kindRoot, name);
      if (now - time >= retentionMs) {
        try {
          const info = await lstat(entry);
          if (info.isSymbolicLink() || !info.isDirectory()) continue;
          await rm(entry, { recursive: true, force: true });
          removed += 1;
          continue;
        } catch (error) {
          logger.warn(`[AgentTrash] failed to remove ${entry}: ${error instanceof Error ? error.message : String(error)}`);
        }
      }
      remaining += 1;
      remainingBytes += await directorySize(entry);
    }
  }
  logger.info(`[AgentTrash] sweep: removed ${removed}, remaining ${remaining} entries, ${remainingBytes} bytes`);
  return { removed, remaining, remainingBytes };
}

export function startAgentTrashSweeper(slockHome: string): () => void {
  const run = () => {
    void sweepAgentTrash({ slockHome }).catch((error) => {
      logger.warn(`[AgentTrash] sweep failed: ${error instanceof Error ? error.message : String(error)}`);
    });
  };
  run();
  const timer = setInterval(run, AGENT_TRASH_SWEEP_INTERVAL_MS);
  timer.unref?.();
  return () => clearInterval(timer);
}
