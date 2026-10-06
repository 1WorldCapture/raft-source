import { buildCliTransportSystemPrompt } from "./cliTransport.js";
import { firstExistingPath, readCommandVersion, resolveCommandOnPath, type ProbeDeps } from "./probe.js";
import type { AgentConfig, AxSurfaceText } from "@botiverse/raft-shared";
import type { ParsedEvent, RuntimeDriver, RuntimeProbeResult, SpawnContext, SpawnResult } from "./types.js";
import os from "node:os";
import path from "node:path";

// OMP (oh-my-pi) ships a Bun-only SDK, so the daemon drives it as a
// `omp --mode rpc` child process over stdio NDJSON (phase-1 task #2 wires the
// transport). Task #1 lands the registration surface and the availability
// probe; everything below the probe is the phase-1 target contract, not a
// working driver yet.
export const MIN_SUPPORTED_OMP_VERSION = "18.6.0";

const OMP_BINARY = "omp";

/**
 * Fallback lookup paths for non-interactive daemon environments whose PATH
 * misses the user install locations. Order matters: PATH wins (it may carry a
 * deliberately pinned install), then omp.sh's default install dir
 * ($HOME/.local/bin, PI_INSTALL_DIR-relocatable), then the bun installer's
 * $HOME/.bun/bin, then the Homebrew prefixes.
 */
export function ompCandidatePaths(deps: ProbeDeps = {}): string[] {
  const homeDir = deps.homeDir ?? deps.env?.HOME ?? process.env.HOME ?? "";
  return [
    path.join(homeDir, ".local", "bin", OMP_BINARY),
    path.join(homeDir, ".bun", "bin", OMP_BINARY),
    path.join("/opt", "homebrew", "bin", OMP_BINARY),
    path.join("/usr", "local", "bin", OMP_BINARY),
  ];
}

/**
 * Resolve the omp executable to an absolute path. Callers launch with this
 * resolved path (never a bare "omp") so the child does not depend on the
 * daemon's PATH.
 */
export function resolveOmpCommand(deps: ProbeDeps = {}): string | null {
  return resolveCommandOnPath(OMP_BINARY, deps) ?? firstExistingPath(ompCandidatePaths(deps), deps);
}

function parseSemver(version: string): [number, number, number] | null {
  const match = version.match(/(\d+)\.(\d+)\.(\d+)/);
  if (!match) return null;
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

export function isSupportedOmpVersion(version: string | null | undefined): boolean {
  if (!version) return true;
  const actual = parseSemver(version);
  const minimum = parseSemver(MIN_SUPPORTED_OMP_VERSION);
  if (!actual || !minimum) return true;
  for (let i = 0; i < 3; i += 1) {
    if (actual[i] > minimum[i]) return true;
    if (actual[i] < minimum[i]) return false;
  }
  return true;
}

export function unsupportedOmpVersionMessage(version: string | null | undefined): string | null {
  if (!version || isSupportedOmpVersion(version)) return null;
  return `OMP ${version} is unsupported; requires OMP >= ${MIN_SUPPORTED_OMP_VERSION}. Upgrade omp (curl -fsSL https://omp.sh/install | sh, or brew install can1357/tap/omp) before starting this runtime.`;
}

export interface OmpProbeDeps extends ProbeDeps {}

export class OmpDriver implements RuntimeDriver {
  readonly id = "omp";
  // Phase-1 target contract: `omp --mode rpc` is a long-lived stdio process
  // that accepts prompt/steer/abort, like the codex app-server shape. Tasks
  // #2/#3 own the transport and event mapping and confirm these constants.
  readonly lifecycle = {
    kind: "persistent",
    stdin: "direct",
    inFlightWake: "steer",
  } as const;
  readonly communication = {
    chat: "slock_cli",
    runtimeControl: "none",
  } as const;
  readonly stdoutChannel = "structured_protocol";
  readonly session = {
    recovery: "resume_or_fresh",
  } as const;
  readonly model = {
    detectedModelsVerifiedAs: "launchable" as const,
  };
  readonly supportsStdinNotification = true;
  readonly busyDeliveryMode = "direct" as const;
  readonly supportsNativeStandingPrompt = true;

  probe(deps: OmpProbeDeps = {}): RuntimeProbeResult {
    const command = resolveOmpCommand(deps);
    if (!command) return { available: false };
    const version = readCommandVersion(command, [], deps);
    const unsupportedMessage = unsupportedOmpVersionMessage(version);
    if (unsupportedMessage) {
      return {
        available: false,
        version: `${version ?? "unknown"} (requires >= ${MIN_SUPPORTED_OMP_VERSION})`,
        diagnostic: unsupportedMessage,
      };
    }
    return { available: true, version: version ?? undefined };
  }

  async spawn(_ctx: SpawnContext): Promise<SpawnResult> {
    throw new Error(
      "OMP runtime transport is not wired yet (phase-1 task #2 registers the `omp --mode rpc` driver); this registration stub cannot launch sessions.",
    );
  }

  parseLine(_line: string): ParsedEvent[] {
    return [];
  }

  encodeStdinMessage(
    _text: string,
    _sessionId: string | null,
    _opts?: { mode?: "idle" | "busy" },
  ): string | null {
    return null;
  }

  buildSystemPrompt(config: AgentConfig): AxSurfaceText {
    return buildCliTransportSystemPrompt(config, {
      extraCriticalRules: [],
    });
  }
}
