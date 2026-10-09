// Controls the standalone Computer ONLY through its CLI (`raft-computer status|start|stop --json`),
// never by linking the computer library: no version coupling between this app and the machine's Computer.
import { execFile } from "node:child_process";

export type ServiceState = "running" | "stopped" | "starting" | "failed";

export interface StandaloneStatus {
  home: string;
  service: { state: ServiceState; pid: number | null; version: string | null; lastError: string | null };
  /** The user's persisted intent (set by start/stop). "stopped" = the user stopped it on purpose. */
  desiredState: "running" | "stopped" | null;
  servers: Array<{ serverId: string; slug: string; serverUrl: string; daemonState: string; lastError: string | null; agentCount: number }>;
  agentCount: number;
  cursorSdk: { installed: boolean; version: string | null; path: string | null };
  hostLifecycleOwner: "cli" | "app" | null;
  migration: { state: "none" | "in-progress" | "done" | "failed"; resultFile: string | null } | null;
}

const SERVICE_STATES: readonly ServiceState[] = ["running", "stopped", "starting", "failed"];
const str = (value: unknown): string | null => (typeof value === "string" ? value : null);
const num = (value: unknown): number => (typeof value === "number" && Number.isFinite(value) ? value : 0);

/** Strict about what the UI depends on (home, service.state), tolerant of everything else (fields get added). */
export function parseStatusJson(text: string): StandaloneStatus {
  const line = text.trim().split("\n").filter(Boolean).at(-1) ?? "";
  let raw: unknown;
  try {
    raw = JSON.parse(line);
  } catch {
    throw new Error("raft-computer status: output is not JSON");
  }
  const root = raw as Record<string, unknown> | null;
  const service = root?.service as Record<string, unknown> | undefined;
  if (!root || typeof root.home !== "string" || !service || !SERVICE_STATES.includes(service.state as ServiceState)) {
    throw new Error("raft-computer status: unexpected JSON shape");
  }
  const servers = Array.isArray(root.servers) ? root.servers : [];
  const cursor = (root.cursorSdk ?? {}) as Record<string, unknown>;
  const migration = root.migration as Record<string, unknown> | undefined;
  return {
    home: root.home,
    service: {
      state: service.state as ServiceState,
      pid: typeof service.pid === "number" ? service.pid : null,
      version: str(service.version),
      lastError: str(service.lastError),
    },
    // v1 puts the user's intent under service; accept the top level too.
    desiredState: [service.desiredState, root.desiredState].find((value) => value === "running" || value === "stopped") as "running" | "stopped" | undefined ?? null,
    servers: servers.map((entry) => {
      const server = (entry ?? {}) as Record<string, unknown>;
      return {
        serverId: str(server.serverId) ?? "",
        slug: str(server.slug) ?? "",
        serverUrl: str(server.serverUrl) ?? "",
        daemonState: str(server.daemonState) ?? "offline",
        lastError: str(server.lastError),
        agentCount: num(server.agentCount),
      };
    }),
    agentCount: num(root.agentCount),
    cursorSdk: { installed: cursor.installed === true, version: str(cursor.version), path: str(cursor.path) },
    hostLifecycleOwner: root.hostLifecycleOwner === "cli" || root.hostLifecycleOwner === "app" ? root.hostLifecycleOwner : null,
    migration: migration && ["none", "in-progress", "done", "failed"].includes(String(migration.state))
      ? { state: migration.state as "none" | "in-progress" | "done" | "failed", resultFile: str(migration.resultFile) }
      : null,
  };
}

export interface CommandResult { ok: boolean; state: "running" | "stopped" | null; error: { code: string; message: string } | null }

export function parseCommandJson(text: string): CommandResult {
  try {
    const raw = JSON.parse(text.trim().split("\n").filter(Boolean).at(-1) ?? "") as Record<string, unknown>;
    const error = raw.error as Record<string, unknown> | null | undefined;
    return {
      ok: raw.ok === true,
      state: raw.state === "running" || raw.state === "stopped" ? raw.state : null,
      error: error ? { code: str(error.code) ?? "error", message: str(error.message) ?? "" } : null,
    };
  } catch {
    return { ok: false, state: null, error: { code: "bad_output", message: "raft-computer returned no JSON" } };
  }
}

export type RunCommand = (file: string, args: string[], options: { env: NodeJS.ProcessEnv; timeoutMs: number }) => Promise<{ stdout: string; stderr: string; code: number }>;

export const execRun: RunCommand = (file, args, { env, timeoutMs }) =>
  new Promise((resolve) => {
    execFile(file, args, { env, timeout: timeoutMs, maxBuffer: 4 * 1024 * 1024 }, (error, stdout, stderr) => {
      const code = error ? (typeof (error as { code?: unknown }).code === "number" ? (error as { code: number }).code : 1) : 0;
      resolve({ stdout: String(stdout), stderr: String(stderr), code });
    });
  });

export function createStandaloneCli(options: { binaryPath: string; home: string; run?: RunCommand; baseEnv?: NodeJS.ProcessEnv }) {
  const run = options.run ?? execRun;
  const env = { ...(options.baseEnv ?? process.env), RAFT_HOME: options.home, SLOCK_HOME: options.home };
  return {
    async status(timeoutMs = 8_000): Promise<StandaloneStatus> {
      const result = await run(options.binaryPath, ["status", "--json"], { env, timeoutMs });
      if (result.code !== 0) throw new Error(`raft-computer status failed (${result.code}): ${result.stderr.trim().slice(0, 300)}`);
      return parseStatusJson(result.stdout);
    },
    async start(timeoutMs = 60_000): Promise<CommandResult> {
      return parseCommandJson((await run(options.binaryPath, ["start", "--json"], { env, timeoutMs })).stdout);
    },
    async stop(timeoutMs = 60_000): Promise<CommandResult> {
      return parseCommandJson((await run(options.binaryPath, ["stop", "--json"], { env, timeoutMs })).stdout);
    },
    async version(timeoutMs = 8_000): Promise<string | null> {
      const result = await run(options.binaryPath, ["--version"], { env, timeoutMs });
      return result.code === 0 ? result.stdout.trim().split(/\s+/).at(-1) ?? null : null;
    },
  };
}

export type StandaloneCli = ReturnType<typeof createStandaloneCli>;
