import { spawn } from "node:child_process";
import { execFileSync } from "node:child_process";
import {
  hydrateRuntimeConfig,
  runtimeConfigToLaunchFields,
  runtimeModelSourceOutcomeFromSet,
  type AgentConfig,
  type RuntimeModelInfo,
  type RuntimeModelSourceOutcome,
  type AxSurfaceText,
} from "@botiverse/raft-shared";
import { buildCliTransportSystemPrompt, prepareCliTransport } from "./cliTransport.js";
import { AntigravityStreamEventNormalizer } from "./antigravityStreamEventNormalizer.js";
import { readCommandVersion, resolveCommandOnPath, type ProbeDeps } from "./probe.js";
import { ChildProcessRuntimeSession } from "./runtimeSession.js";
import type { ParsedEvent, RuntimeDriver, RuntimeProbeResult, RuntimeSession, SpawnContext, SpawnResult } from "./types.js";

export const ANTIGRAVITY_STREAM_DEFAULT_MODEL = "gemini-3.8-flash-medium";
export const ANTIGRAVITY_STREAM_TESTED_GOOD_VERSION = "1.3.2";
/** stream-json was added in agy 1.1.8. */
export const ANTIGRAVITY_STREAM_MIN_VERSION = "1.1.8";
/** `agy models` reached the network and took about 12s on the 1.3.2 probe. */
export const ANTIGRAVITY_STREAM_MODEL_PROBE_TIMEOUT_MS = 20_000;

const SSH_ENV_KEYS = ["SSH_CLIENT", "SSH_CONNECTION", "SSH_TTY"] as const;
const FORBIDDEN_LAUNCH_FLAGS = ["--print", "--effort", "--print-timeout", "--mode", "--sandbox"] as const;

type VersionParts = readonly [number, number, number];

function parseVersion(value: string | null | undefined): { normalized: string; parts: VersionParts } | null {
  const match = value?.match(/(\d+)\.(\d+)\.(\d+)/);
  if (!match) return null;
  const parts = [Number(match[1]), Number(match[2]), Number(match[3])] as const;
  return { normalized: parts.join("."), parts };
}

function compareVersions(left: VersionParts, right: VersionParts): number {
  for (let index = 0; index < 3; index += 1) {
    if (left[index] < right[index]) return -1;
    if (left[index] > right[index]) return 1;
  }
  return 0;
}

export class AntigravityStreamVersionError extends Error {
  readonly actualVersion: string;

  constructor(actualVersion: string) {
    super(
      `Antigravity CLI ${actualVersion} does not support stream-json (added in ${ANTIGRAVITY_STREAM_MIN_VERSION}). `
      + `Update agy; ${ANTIGRAVITY_STREAM_TESTED_GOOD_VERSION} is the version this Raft runtime was tested with.`,
    );
    this.name = "AntigravityStreamVersionError";
    this.actualVersion = actualVersion;
  }
}

/**
 * Refuse versions that predate stream-json. Unparseable or missing versions
 * are left to the launch-version warning path and are not blocked here.
 */
export function assertAntigravityStreamLaunchVersion(version: string | null | undefined): void {
  const actual = parseVersion(version);
  const minimum = parseVersion(ANTIGRAVITY_STREAM_MIN_VERSION);
  if (!actual || !minimum) return;
  if (compareVersions(actual.parts, minimum.parts) < 0) {
    throw new AntigravityStreamVersionError(actual.normalized);
  }
}

export function resolveAntigravityStreamModel(config: AgentConfig): string {
  const launched = runtimeConfigToLaunchFields(hydrateRuntimeConfig(config)).model?.trim();
  if (!launched || launched === "default") return ANTIGRAVITY_STREAM_DEFAULT_MODEL;
  return launched;
}

export function buildAntigravityStreamArgs(config: AgentConfig): string[] {
  const args = [
    "--input-format", "stream-json",
    "--output-format", "stream-json",
    "--model", resolveAntigravityStreamModel(config),
    "--dangerously-skip-permissions",
  ];
  if (config.sessionId) {
    args.push("--conversation", config.sessionId);
  }
  for (const flag of FORBIDDEN_LAUNCH_FLAGS) {
    if (args.includes(flag)) {
      throw new Error(`antigravity-stream must not pass ${flag}`);
    }
  }
  return args;
}

export function encodeAntigravityStreamUserMessage(text: string): string {
  return JSON.stringify({ event: "user", message: { content: text } });
}

export function probeAntigravityStream(deps: ProbeDeps = {}): RuntimeProbeResult {
  const command = resolveCommandOnPath("agy", deps);
  if (!command) return { available: false };
  return {
    available: true,
    version: readCommandVersion(command, [], deps) ?? undefined,
  };
}

export function parseAntigravityModelList(output: string): RuntimeModelInfo[] {
  const models: RuntimeModelInfo[] = [];
  for (const rawLine of output.split(/\r?\n/)) {
    const line = rawLine.trim();
    const tab = line.indexOf("\t");
    if (tab <= 0) continue;
    const id = line.slice(0, tab).trim();
    const label = line.slice(tab + 1).trim();
    if (!id || !label || id.toLowerCase().startsWith("fetching")) continue;
    models.push({ id, label, verified: "launchable" });
  }
  return models;
}

export function detectAntigravityStreamModels(deps: ProbeDeps = {}): RuntimeModelSourceOutcome {
  const command = resolveCommandOnPath("agy", deps);
  if (!command) return { kind: "error", retryable: true };
  const execFileSyncFn = deps.execFileSyncFn ?? execFileSync;
  try {
    const output = execFileSyncFn(command, ["models"], {
      stdio: ["ignore", "pipe", "pipe"],
      timeout: ANTIGRAVITY_STREAM_MODEL_PROBE_TIMEOUT_MS,
      encoding: "utf8",
      ...(deps.env ? { env: deps.env } : {}),
      ...(deps.cwd ? { cwd: deps.cwd } : {}),
    });
    const text = Buffer.isBuffer(output) ? output.toString("utf8") : String(output ?? "");
    return runtimeModelSourceOutcomeFromSet({ models: parseAntigravityModelList(text) });
  } catch {
    return { kind: "error", retryable: true };
  }
}

/** SIGINT the child's process group. SIGKILL stays SIGKILL for the force path. */
export function antigravityStreamStopSignal(requested?: NodeJS.Signals): NodeJS.Signals {
  return requested === "SIGKILL" ? "SIGKILL" : "SIGINT";
}

export function signalAntigravityStreamProcessGroup(pid: number, signal: NodeJS.Signals): void {
  if (process.platform === "win32") return;
  try {
    process.kill(-pid, signal);
  } catch {
    // The process already exited, or it is not a group leader.
  }
}

export class AntigravityStreamRuntimeSession extends ChildProcessRuntimeSession {
  override async stop(opts?: {
    signal?: NodeJS.Signals;
    forceAfterMs?: number;
    reason?: string;
  }): Promise<void> {
    const signal = antigravityStreamStopSignal(opts?.signal);
    const pid = this.pid;
    if (typeof pid === "number") signalAntigravityStreamProcessGroup(pid, signal);
    await super.stop({ ...opts, signal });
  }
}

export class AntigravityStreamDriver implements RuntimeDriver {
  readonly id = "antigravity-stream";
  readonly lifecycle = {
    kind: "persistent",
    stdin: "direct",
    inFlightWake: "queue",
  } as const;
  readonly communication = {
    chat: "slock_cli",
    runtimeControl: "none",
  } as const;
  readonly stdoutChannel = "structured_protocol" as const;
  readonly session = {
    recovery: "resume_or_fresh",
  } as const;
  readonly model = {
    detectedModelsVerifiedAs: "launchable" as const,
    toLaunchSpec: (modelId: string) => ({ args: ["--model", modelId] }),
  };
  readonly supportsStdinNotification = true;
  readonly busyDeliveryMode = "direct" as const;
  readonly consumesSpawnPrompt = true;
  /** `--conversation` is only a resume target until this process emits init. */
  readonly requiresSessionInitForDelivery = true;
  readonly launchVersionPolicy = {
    displayName: "Antigravity CLI",
    knownBadVersions: [] as const,
    testedGoodVersion: ANTIGRAVITY_STREAM_TESTED_GOOD_VERSION,
    probe: (_config: AgentConfig) => probeAntigravityStream(),
  };
  private readonly normalizer = new AntigravityStreamEventNormalizer();
  private eventSink: ((events: ParsedEvent[]) => void) | null = null;
  private child: ReturnType<typeof spawn> | null = null;
  private stderrTail = "";

  get currentSessionId(): string | null {
    return this.normalizer.currentSessionId;
  }

  probe(): RuntimeProbeResult {
    return probeAntigravityStream();
  }

  createSession(ctx: SpawnContext): RuntimeSession {
    return new AntigravityStreamRuntimeSession(this, ctx);
  }

  setEventSink(sink: ((events: ParsedEvent[]) => void) | null): void {
    this.eventSink = sink;
  }

  async spawn(ctx: SpawnContext): Promise<SpawnResult> {
    const probed = probeAntigravityStream();
    if (!probed.available) {
      throw new Error("Antigravity CLI (agy) was not found on PATH.");
    }
    assertAntigravityStreamLaunchVersion(probed.version);

    const { spawnEnv } = await prepareCliTransport(ctx, {
      NO_COLOR: "1",
      SSH_CLIENT: undefined,
      SSH_CONNECTION: undefined,
      SSH_TTY: undefined,
    });
    for (const key of SSH_ENV_KEYS) delete spawnEnv[key];

    const command = resolveCommandOnPath("agy") ?? "agy";
    const args = buildAntigravityStreamArgs(ctx.config);
    const proc = spawn(command, args, {
      cwd: ctx.workingDirectory,
      stdio: ["pipe", "pipe", "pipe"],
      env: spawnEnv,
      detached: process.platform !== "win32",
    });
    this.child = proc;
    proc.stderr?.on("data", (chunk: Buffer) => {
      this.noteStderr(chunk.toString("utf8"), proc.pid);
    });
    if (ctx.prompt) {
      proc.stdin?.write(encodeAntigravityStreamUserMessage(ctx.prompt) + "\n");
    }
    return { process: proc };
  }

  parseLine(line: string): ParsedEvent[] {
    return this.normalizer.normalizeLine(line);
  }

  encodeStdinMessage(
    text: string,
    _sessionId: string | null,
    _opts?: { mode?: "idle" | "busy" },
  ): string | null {
    return encodeAntigravityStreamUserMessage(text);
  }

  buildSystemPrompt(config: AgentConfig, _agentId: string): AxSurfaceText {
    return buildCliTransportSystemPrompt(config, {
      extraCriticalRules: [],
    });
  }

  async detectModels(): Promise<RuntimeModelSourceOutcome> {
    return detectAntigravityStreamModels();
  }

  private noteStderr(text: string, pid: number | undefined): void {
    this.stderrTail = (this.stderrTail + text).slice(-4096);
    const events = this.normalizer.noteStderr(this.stderrTail);
    if (events.length === 0) return;
    this.eventSink?.(events);
    if (typeof pid === "number") signalAntigravityStreamProcessGroup(pid, "SIGINT");
    this.child?.kill("SIGINT");
  }
}
