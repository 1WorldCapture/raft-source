// Root-scoped process identity shared by takeover and quit. Never signal a
// process group: Finder, another Computer, and the GUI can share a PGID.
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { parsePsTable, readPidFile, type PsRow } from "./shutdown.js";

const execFileAsync = promisify(execFile);
export interface ComputerProcess extends PsRow {
  home: string | null;
  agent: boolean;
  root: boolean;
}
export interface ComputerProcessSnapshot {
  rootPids: number[];
  rows: ComputerProcess[];
}

/** ps appends environment entries without shell quoting. Ambiguous evidence
 * is rejected; only an absolute root with consistent markers is accepted. */
export function parseComputerProcesses(output: string): ComputerProcess[] {
  return parsePsTable(output).map((row) => {
    const environment = row.command.match(/\s[A-Za-z_][A-Za-z_0-9]*=/);
    const command = environment ? row.command.slice(0, environment.index) : row.command;
    const env = environment ? row.command.slice(environment.index) : "";
    const values = [...env.matchAll(/(?:^|\s)(RAFT_HOME|SLOCK_HOME)=(.*?)(?=\s[A-Za-z_][A-Za-z_0-9]*=|$)/g)]
      .map((match) => match[2].trim());
    // A --slock-home argument is useful for legacy carriers without env roots.
    const argument = command.match(/(?:^|\s)--slock-home(?:=|\s+)(\/.*?)(?=\s--[\w-]+(?:\s|=)|$)/)?.[1]?.trim();
    if (argument) values.push(argument);
    const roots = values.filter((value) => path.isAbsolute(value));
    const home = roots.length > 0 && roots.length === values.length && roots.every((value) => value === roots[0])
      ? path.resolve(roots[0]) : null;
    return {
      ...row, command, home,
      agent: /(?:^|\s)SLOCK_AGENT_ID=\S+/.test(env),
      root: /(?:^|\s)__(?:service|run)(?:\s|$)/.test(command),
    };
  });
}

export async function readComputerProcesses(home: string): Promise<ComputerProcessSnapshot> {
  const rootPids: number[] = [];
  const service = await readPidFile({ readFile }, path.join(home, "computer", "run", "service.pid"));
  if (service) rootPids.push(service);
  try {
    for (const entry of await readdir(path.join(home, "computer", "servers"), { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const pid = await readPidFile({ readFile }, path.join(home, "computer", "servers", entry.name, "runner.pid"));
      if (pid) rootPids.push(pid);
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  // Never turn a failed scan into an empty/all-clear result. The timeout also
  // bounds a stuck ps invocation. Raw environment output never leaves here.
  const { stdout } = await execFileAsync("ps", ["eww", "-axo", "pid=,ppid=,pgid=,lstart=,command="], {
    timeout: 2_000, killSignal: "SIGKILL", maxBuffer: 16 * 1024 * 1024,
  });
  const rows = parseComputerProcesses(stdout);
  if (rows.length === 0) throw new Error("无法核实本机进程归属，请重试；未发送停止信号。");
  return { rootPids, rows };
}

export class ComputerProcessScope {
  private readonly identities = new Map<number, ComputerProcess>();
  readonly home: string;
  constructor(home: string, private readonly guiPid: number = process.pid) {
    this.home = path.resolve(home);
  }
  /** Pin before stop, retain detached descendants after pidfiles disappear. */
  observe(snapshot: ComputerProcessSnapshot): ComputerProcess[] {
    const owned = new Set<number>();
    const roots = new Set(snapshot.rootPids);
    const excluded = new Set<number>([this.guiPid]);
    let excludedGrew = true;
    while (excludedGrew) {
      excludedGrew = false;
      for (const row of snapshot.rows) {
        const pinned = this.identities.get(row.pid);
        const serviceBoundary = row.root && row.home === this.home &&
          (roots.has(row.pid) || (pinned?.lstart === row.lstart && pinned.command === row.command));
        if (!excluded.has(row.pid) && excluded.has(row.ppid) && !serviceBoundary) {
          excluded.add(row.pid); excludedGrew = true;
        }
      }
    }
    for (const row of snapshot.rows) {
      if (excluded.has(row.pid) || row.home !== this.home) continue;
      const pinned = this.identities.get(row.pid);
      if (pinned && (pinned.lstart !== row.lstart || pinned.command !== row.command)) continue;
      if (pinned || (roots.has(row.pid) && row.root) || row.agent) owned.add(row.pid);
    }
    let changed = true;
    while (changed) {
      changed = false;
      for (const row of snapshot.rows) {
        if (excluded.has(row.pid) || owned.has(row.pid) || row.home !== this.home) continue;
        const pinned = this.identities.get(row.pid);
        if (pinned && (pinned.lstart !== row.lstart || pinned.command !== row.command)) continue;
        if (owned.has(row.ppid)) { owned.add(row.pid); changed = true; }
      }
    }
    const result = snapshot.rows.filter((row) => owned.has(row.pid));
    for (const row of result) if (!this.identities.has(row.pid)) this.identities.set(row.pid, row);
    // Remember descendants whose root evidence cannot be read. Their parent
    // relationship is enough to report unfinished cleanup, never to signal.
    const suspected = new Set(owned);
    let suspectGrew = true;
    while (suspectGrew) {
      suspectGrew = false;
      for (const row of snapshot.rows) {
        if (excluded.has(row.pid) || suspected.has(row.pid) || row.home !== null || !suspected.has(row.ppid)) continue;
        suspected.add(row.pid); suspectGrew = true;
        if (!this.identities.has(row.pid)) this.identities.set(row.pid, row);
      }
    }
    return result;
  }
  unverified(snapshot: ComputerProcessSnapshot): number[] {
    return snapshot.rows.filter((row) => {
      const pinned = this.identities.get(row.pid);
      return pinned && pinned.lstart === row.lstart && (row.home === null || row.command !== pinned.command);
    }).map((row) => row.pid);
  }
  assertRoots(snapshot: ComputerProcessSnapshot): void {
    for (const pid of snapshot.rootPids) {
      const row = snapshot.rows.find((candidate) => candidate.pid === pid);
      if (!row) continue; // Dead pidfile is safe for the normal stale cleanup.
      const pinned = this.identities.get(pid);
      if (row.pid === this.guiPid || row.home !== this.home || !row.root || (pinned && (pinned.lstart !== row.lstart || pinned.command !== row.command))) {
        throw Object.assign(new Error(`无法确认进程 ${pid} 属于这套 Computer（${this.home}）；当前归属 ${row.home ?? "未知"}，未接管或停止。`), {
          code: "COMPUTER_PROCESS_IDENTITY_MISMATCH",
        });
      }
    }
    this.observe(snapshot);
  }
  /** Called immediately before each positive-PID signal. No group fallback. */
  matches(expected: ComputerProcess, current: ComputerProcess | undefined): boolean {
    return Boolean(current && current.pid !== this.guiPid && current.pid === expected.pid &&
      current.home === this.home && current.lstart === expected.lstart && current.command === expected.command);
  }
}
