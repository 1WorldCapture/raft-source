// Whole-home process sweep (PM blocking fix 2026-10-09, #281 review
// 2026-10-10): every __service/__run process whose env or argv binds it to
// ANY of the home's path SPELLINGS (realpath, original argument, the
// ~/.slock-raft alias) is found and stopped with the TERM → grace → KILL →
// rescan ladder. Extracted from migrateHome.ts so the Desktop host can run
// the exact same sweep before converging a home (drill 290-anna-②a: an
// orphaned __run left by a handover-phase app death must not block the
// relaunch, and must not survive next to a freshly started service).
import { promises as fs } from "node:fs";

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

export interface HomeSweepDeps {
  scanHomeProcesses?: (homeSpellings: string[]) => Promise<HomeProcess[]>;
  killHomeProcess?: (pid: number, signal: "SIGTERM" | "SIGKILL") => void;
  sleep?: (ms: number) => Promise<void>;
  sweepTimeoutMs?: number;
}

/** TERM → grace → KILL → rescan; returns whatever is STILL alive. */
export async function sweepHomeProcesses(
  homeSpellings: string[],
  deps: HomeSweepDeps = {},
): Promise<HomeProcess[]> {
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const scanHomeProcesses = deps.scanHomeProcesses ?? defaultScanHomeProcesses;
  const killHomeProcess = deps.killHomeProcess ?? defaultKillHomeProcess;
  const deadline = Date.now() + (deps.sweepTimeoutMs ?? 10_000);
  let procs = await scanHomeProcesses(homeSpellings);
  if (procs.length === 0) return procs;
  for (const proc of procs) killHomeProcess(proc.pid, "SIGTERM");
  while (procs.length > 0 && Date.now() < deadline) {
    await sleep(500);
    procs = await scanHomeProcesses(homeSpellings);
  }
  if (procs.length > 0) {
    for (const proc of procs) killHomeProcess(proc.pid, "SIGKILL");
    await sleep(500);
    procs = await scanHomeProcesses(homeSpellings);
  }
  return procs;
}

/** Every path spelling a live process could carry for a home: the realpath,
 *  the ORIGINAL argument, and the ~/.slock-raft alias (live children may
 *  carry whichever spelling their launcher used). Deduplicated. */
export function homeProcessSpellings(primary: string, original: string | null, alias: string | null): string[] {
  const out = new Set<string>([primary]);
  if (original !== null) out.add(original);
  if (alias !== null) out.add(alias);
  return [...out];
}

// fs import retained for future helpers' symmetry with migrateHome; not used yet.
void fs;
