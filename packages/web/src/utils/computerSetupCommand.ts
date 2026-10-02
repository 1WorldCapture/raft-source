export const STAGING_COMPUTER_SERVER_URL = "https://api-aws-staging.botiverse.dev";
export const DEFAULT_COMPUTER_SERVER_URL = "https://api.raft.build";
export const LEGACY_DEFAULT_COMPUTER_SERVER_URL = "https://api.slock.ai";

import { powerShellQuote, shellQuote } from "./commandEscaping";
import type { DeploymentComputerSetupReady } from "./deploymentComputerSetup";

// The Computer ships as a self-contained SEA binary installed by the native
// shell script (`install.sh` on macOS/Linux, `install.ps1` on Windows), not
// npm — no Node/npm required. The installer resolves the latest version from
// the release base `manifest.json`. Prod uses the formal
// computer-v* channel; staging uses a branch snapshot channel isolated under
// /computer/staging. The installed binary is `raft-computer`.
export const COMPUTER_CDN_BASE_STAGING = "https://slock-cdn-staging.botiverse.dev/computer/staging";
export const COMPUTER_CDN_BASE_PROD = "https://cdn.raft.build/computer";

export type ComputerCommandPlatform = "mac-linux" | "windows";

function normalizeComputerVersionPin(version?: string | null): string | null {
  const normalized = version?.trim() ?? "";
  return /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(normalized)
    ? normalized
    : null;
}

export function computerInstallCommand(
  deploymentEnv?: string,
  version?: string | null,
): string {
  const base = deploymentEnv === "staging" ? COMPUTER_CDN_BASE_STAGING : COMPUTER_CDN_BASE_PROD;
  const versionPin = normalizeComputerVersionPin(version);
  const installEnv = [
    ...(deploymentEnv === "staging"
      ? [
          `RAFT_COMPUTER_RELEASE_BASE=${base}`,
          "RAFT_COMPUTER_INSTALL_CHANNEL=alpha",
        ]
      : []),
    ...(versionPin ? [`RAFT_COMPUTER_VERSION=${versionPin}`] : []),
  ];
  return `curl -fsSL ${base}/install.sh | ${installEnv.length > 0 ? `${installEnv.join(" ")} ` : ""}sh`;
}

export function windowsComputerInstallCommand(
  deploymentEnv?: string,
  version?: string | null,
): string {
  const base = deploymentEnv === "staging" ? COMPUTER_CDN_BASE_STAGING : COMPUTER_CDN_BASE_PROD;
  const versionPin = normalizeComputerVersionPin(version);
  const installEnv = [
    ...(deploymentEnv === "staging"
      ? [
          `$env:RAFT_COMPUTER_RELEASE_BASE = "${base}"`,
          '$env:RAFT_COMPUTER_INSTALL_CHANNEL = "alpha"',
        ]
      : []),
    ...(versionPin ? [`$env:RAFT_COMPUTER_VERSION = "${versionPin}"`] : []),
  ];
  const installUrl = deploymentEnv === "staging"
    ? '"$env:RAFT_COMPUTER_RELEASE_BASE/install.ps1"'
    : `${base}/install.ps1`;
  return `${installEnv.length > 0 ? `${installEnv.join("; ")}; ` : ""}irm ${installUrl} | iex`;
}

export interface ComputerSetupCommandOptions {
  // Retained as a no-op input so existing callsites (AddMachineDialog,
  // MachineDetailPanel) keep passing the daemon-side legacy key without
  // churn. The CLI removed `--adopt-legacy` / `--legacy-api-key` in
  // RFC v9 PR-impl-3 commit 3 — legacy-daemon adoption is now driven by
  // an interactive TTY prompt inside `raft-computer setup`, not flags.
  legacyApiKey?: string | null;
  // Identity-carried adoption (task #239 PR-D/PR-E): when the calling
  // surface knows WHICH machine row this computer is (machine detail
  // page), the command carries `--machine <id>` and `raft-computer setup`
  // adopts that row directly — no fingerprint matching, no local
  // evidence, works after key rotation. The id is an identifier, not a
  // secret.
  machineId?: string | null;
  platform?: ComputerCommandPlatform;
  // Optional deterministic installer target. Manual fresh-install recovery
  // uses the currently published Computer artifact instead of relying on a
  // CDN edge's potentially stale latest manifest.
  version?: string | null;
}

export interface ComputerCommands {
  install: string;
  setup: string;
  status: string;
  doctor: string;
  // Restart the whole Computer service and every attached server runner.
  restartService: string;
  // Restart while scoping lifecycle readback to one server.
  restart: string;
  stop: string;
  start: string;
}

export interface DaemonConnectCommandOptions {
  apiKey: string;
  serverName?: string | null;
  serverUrl: string;
  distTag?: string;
  platform?: ComputerCommandPlatform;
}

export function getDaemonConnectCommand({
  apiKey,
  serverName,
  serverUrl,
  distTag = "latest",
  platform = "mac-linux",
}: DaemonConnectCommandOptions): string {
  const packageSpec = `@botiverse/raft-daemon@${distTag}`;
  if (platform === "windows") {
    return `npx.cmd ${packageSpec} --server-url ${serverUrl} --api-key ${apiKey}`;
  }
  const suffix = serverName ? ` # ${serverName}` : "";
  return `npx ${packageSpec} --server-url ${serverUrl} --api-key ${apiKey}${suffix}`;
}

// Non-production deployments (staging / slockdev) are internal test surfaces.
// A tester frequently runs the connect command on a machine that already runs
// a real prod Computer; without isolation the command would install over
// ~/.local/bin/raft-computer and write state into ~/.slock, clobbering their
// prod Computer (binary + channel + state). For these envs every command
// carries the same per-server home/bin, while remaining a separate copy step:
// install only installs, setup only runs the installed binary, and terminal
// actions address that same isolated Computer. Production stays default — real
// users legitimately want a single Computer at the default location.
const ISOLATED_DEPLOYMENT_ENVS = new Set(["staging", "slockdev"]);

/**
 * Internal test surfaces (staging/slockdev QA builds) scope the Computer's
 * state and binary to a per-slug home. This decides ISOLATION ONLY — never
 * command sources, which contract v1 keeps in the runtime deployment config.
 */
export function isIsolatedDeploymentEnv(deploymentEnv?: string | null): boolean {
  return Boolean(deploymentEnv && ISOLATED_DEPLOYMENT_ENVS.has(deploymentEnv));
}

export function getComputerCommands(
  serverSlug: string | undefined | null,
  deploymentEnv = import.meta.env?.VITE_DEPLOYMENT_ENV,
  serverUrl?: string,
  options: ComputerSetupCommandOptions = {},
): ComputerCommands | null {
  const slug = serverSlug?.trim().replace(/^\/+/, "");
  if (!slug) return null;

  const platform = options.platform ?? "mac-linux";

  const commandServerUrl = deploymentEnv === "production"
    ? isDefaultComputerServerUrl(serverUrl) ? null : serverUrl
    : deploymentEnv === "staging"
    ? STAGING_COMPUTER_SERVER_URL
    : deploymentEnv === "slockdev"
      ? serverUrl
      : null;
  const serverUrlArg = commandServerUrl ? ` --server-url ${commandServerUrl}` : "";
  const machineArg = options.machineId ? ` --machine ${options.machineId}` : "";
  const setupArgs = `${serverUrlArg}${machineArg}`;
  if (deploymentEnv && ISOLATED_DEPLOYMENT_ENVS.has(deploymentEnv)) {
    // `slug` is the canonical setup slug (same one used in `setup /${slug}`),
    // so the isolated home matches across web-generated command, #105 harness,
    // and manual QA. Every independent command carries the same env and invokes
    // the isolated binary by full path because it is intentionally not installed
    // on the tester's default PATH. `paths.ts` reads
    // `RAFT_HOME || SLOCK_HOME`, so RAFT_HOME alone carries the state root.
    if (platform === "windows") {
      const home = `$env:USERPROFILE\\.raft-computer-${slug}`;
      const environment = `$env:RAFT_HOME = "${home}"; $env:RAFT_COMPUTER_INSTALL_DIR = "$env:RAFT_HOME\\bin";`;
      const binary = `& "$env:RAFT_COMPUTER_INSTALL_DIR\\raft-computer.exe"`;
      return {
        install: `${environment} ${windowsComputerInstallCommand(deploymentEnv, options.version)}`,
        setup: `${environment} ${binary} setup /${slug}${setupArgs}`,
        status: `${environment} ${binary} status`,
        doctor: `${environment} ${binary} doctor`,
        restartService: `${environment} ${binary} restart`,
        restart: `${environment} ${binary} restart /${slug}`,
        stop: `${environment} ${binary} stop`,
        start: `${environment} ${binary} start`,
      };
    }

    const home = `$HOME/.raft-computer-${slug}`;
    const environment = `RAFT_HOME="${home}" RAFT_COMPUTER_INSTALL_DIR="${home}/bin"`;
    const binary = `"${home}/bin/raft-computer"`;
    return {
      install: `${environment} sh -c '${computerInstallCommand(deploymentEnv, options.version)}'`,
      setup: `${environment} ${binary} setup /${slug}${setupArgs}`,
      status: `${environment} ${binary} status`,
      doctor: `${environment} ${binary} doctor`,
      restartService: `${environment} ${binary} restart`,
      restart: `${environment} ${binary} restart /${slug}`,
      stop: `${environment} ${binary} stop`,
      start: `${environment} ${binary} start`,
    };
  }

  return {
    install: platform === "windows"
      ? windowsComputerInstallCommand(deploymentEnv, options.version)
      : computerInstallCommand(deploymentEnv, options.version),
    setup: `raft-computer setup /${slug}${setupArgs}`,
    status: "raft-computer status",
    doctor: "raft-computer doctor",
    restartService: "raft-computer restart",
    restart: `raft-computer restart /${slug}`,
    stop: "raft-computer stop",
    start: "raft-computer start",
  };
}

export function getComputerSetupCommand(
  serverSlug: string | undefined | null,
  deploymentEnv = import.meta.env?.VITE_DEPLOYMENT_ENV,
  serverUrl?: string,
  options: ComputerSetupCommandOptions = {},
): string | null {
  return getComputerCommands(serverSlug, deploymentEnv, serverUrl, options)?.setup ?? null;
}

// ---------------------------------------------------------------------------
// Contract-v1 deployment-driven command generation (私有部署配置契约 v1).
//
// Every URL, version and identifier below comes from the runtime deployment
// config (`GET /api/deployment/computer-setup`); the official constants above
// are legacy debug/build-scoped paths only and are never used to fill a
// missing runtime value. `setup` ALWAYS carries an explicit `--server-url`;
// install env vars are placed on the `sh` side of the POSIX pipe (not on the
// curl side) so they reach the installer process; and every dynamic value is
// escaped for the target interpreter — plain concatenation is not escaping.
// ---------------------------------------------------------------------------

/** Extract the version from a `pinned:<semver>` channel, else null. */
export function pinnedChannelVersion(installChannel: DeploymentComputerSetupReady["installChannel"]): string | null {
  if (!installChannel.startsWith("pinned:")) return null;
  return normalizeComputerVersionPin(installChannel.slice("pinned:".length));
}

export interface DeploymentComputerCommandInput {
  /** Ready payload of GET /api/deployment/computer-setup. */
  deployment: DeploymentComputerSetupReady;
  serverSlug: string | undefined | null;
  platform?: ComputerCommandPlatform;
  /** Adopt a known machine row directly (`--machine <id>`); id, not secret. */
  machineId?: string | null;
  /**
   * Manual fresh-install pin from the server's own release strategy
   * (latestComputerVersion). Overrides the deployment channel to
   * `pinned:<version>` so restarts keep the same target.
   */
  version?: string | null;
  /**
   * Internal test-surface isolation (staging/slockdev QA builds, keyed by
   * VITE_DEPLOYMENT_ENV — this decides tester isolation ONLY, never the
   * command sources, which always come from `deployment`). Scopes RAFT_HOME,
   * the install dir and the binary path to a per-slug home so a test Computer
   * cannot clobber the tester's production one.
   */
  isolatedHomeSlug?: string | null;
}

export function getComputerCommandsFromDeployment({
  deployment,
  serverSlug,
  platform = "mac-linux",
  machineId,
  version,
  isolatedHomeSlug,
}: DeploymentComputerCommandInput): ComputerCommands | null {
  const slug = serverSlug?.trim().replace(/^\/+/, "");
  if (!slug) return null;

  const { serverUrl, releaseSource, installChannel } = deployment;
  const { backend, releaseBase } = releaseSource;

  // A manual pin wins over the deployment channel; both collapse to
  // `pinned:<version>` + an explicit RAFT_COMPUTER_VERSION.
  const pinnedVersion = normalizeComputerVersionPin(version) ?? pinnedChannelVersion(installChannel);
  const effectiveChannel: string = pinnedVersion ? `pinned:${pinnedVersion}` : installChannel;

  const machineIdValue = machineId?.trim() ?? "";
  const machineArg = machineIdValue
    ? platform === "windows"
      ? ` --machine ${powerShellQuote(machineIdValue)}`
      : ` --machine ${shellQuote(machineIdValue)}`
    : "";

  // Isolated-home plumbing (test surfaces only). `slug` is the canonical setup
  // slug, so the isolated home matches across web-generated commands and
  // manual QA. paths.ts reads RAFT_HOME || SLOCK_HOME.
  const isolationSlug = isolatedHomeSlug?.trim().replace(/^\/+/, "") || null;
  const home = platform === "windows"
    ? `$env:USERPROFILE\\.raft-computer-${isolationSlug}`
    : `$HOME/.raft-computer-${isolationSlug}`;

  if (platform === "windows") {
    const envLines = [
      `$env:RAFT_COMPUTER_RELEASE_BACKEND = ${powerShellQuote(backend)}`,
      `$env:RAFT_COMPUTER_RELEASE_BASE = ${powerShellQuote(releaseBase)}`,
      ...(releaseSource.handsOrigin
        ? [`$env:RAFT_COMPUTER_HANDS_ORIGIN = ${powerShellQuote(releaseSource.handsOrigin)}`]
        : []),
      `$env:RAFT_COMPUTER_INSTALL_CHANNEL = ${powerShellQuote(effectiveChannel)}`,
      ...(pinnedVersion ? [`$env:RAFT_COMPUTER_VERSION = ${powerShellQuote(pinnedVersion)}`] : []),
    ];
    const installUrl = `${releaseBase}/install.ps1`;
    const installBase = `${envLines.join("; ")}; irm ${powerShellQuote(installUrl)} | iex`;
    const isolated = Boolean(isolationSlug);
    const isolationEnvLines = isolated
      ? [
        `$env:RAFT_HOME = ${powerShellQuote(home)}`,
        `$env:RAFT_COMPUTER_INSTALL_DIR = ${powerShellQuote(`${home}\\bin`)}`,
      ]
      : [];
    const binary = isolated
      ? `& "$env:RAFT_COMPUTER_INSTALL_DIR\\raft-computer.exe"`
      : "raft-computer";
    return {
      install: isolated ? `${isolationEnvLines.join("; ")}; ${installBase}` : installBase,
      setup: `${binary} setup ${powerShellQuote(`/${slug}`)} --server-url ${powerShellQuote(serverUrl)}${machineArg}`,
      status: `${binary} status`,
      doctor: `${binary} doctor`,
      restartService: `${binary} restart`,
      restart: `${binary} restart ${powerShellQuote(`/${slug}`)}`,
      stop: `${binary} stop`,
      start: `${binary} start`,
    };
  }

  // POSIX: env assignments must sit on the `sh` side of the pipe so the
  // installer process itself sees them (contract: not on the curl side).
  // Isolation pairs ride the same side — `VAR=1 a | b` would scope VAR to `a`
  // only, so RAFT_HOME has to share the installer's prefix.
  const isolated = Boolean(isolationSlug);
  const envPairs = [
    ...(isolated
      ? [
          `RAFT_HOME=${shellQuote(home)}`,
          `RAFT_COMPUTER_INSTALL_DIR=${shellQuote(`${home}/bin`)}`,
        ]
      : []),
    `RAFT_COMPUTER_RELEASE_BACKEND=${shellQuote(backend)}`,
    `RAFT_COMPUTER_RELEASE_BASE=${shellQuote(releaseBase)}`,
    ...(releaseSource.handsOrigin ? [`RAFT_COMPUTER_HANDS_ORIGIN=${shellQuote(releaseSource.handsOrigin)}`] : []),
    `RAFT_COMPUTER_INSTALL_CHANNEL=${shellQuote(effectiveChannel)}`,
    ...(pinnedVersion ? [`RAFT_COMPUTER_VERSION=${shellQuote(pinnedVersion)}`] : []),
  ];
  const installUrl = `${releaseBase}/install.sh`;
  // Every command that runs the installed binary needs the same state root.
  const binaryEnvPrefix = isolated
    ? `RAFT_HOME=${shellQuote(home)} RAFT_COMPUTER_INSTALL_DIR=${shellQuote(`${home}/bin`)} `
    : "";
  const binary = isolated ? shellQuote(`${home}/bin/raft-computer`) : "raft-computer";
  return {
    install: `curl -fsSL ${shellQuote(installUrl)} | ${envPairs.join(" ")} sh`,
    setup: `${binaryEnvPrefix}${binary} setup ${shellQuote(`/${slug}`)} --server-url ${shellQuote(serverUrl)}${machineArg}`,
    status: `${binaryEnvPrefix}${binary} status`,
    doctor: `${binaryEnvPrefix}${binary} doctor`,
    restartService: `${binaryEnvPrefix}${binary} restart`,
    restart: `${binaryEnvPrefix}${binary} restart ${shellQuote(`/${slug}`)}`,
    stop: `${binaryEnvPrefix}${binary} stop`,
    start: `${binaryEnvPrefix}${binary} start`,
  };
}

function isDefaultComputerServerUrl(serverUrl: string | undefined): boolean {
  const normalized = serverUrl?.trim().replace(/\/+$/, "");
  return normalized === DEFAULT_COMPUTER_SERVER_URL || normalized === LEGACY_DEFAULT_COMPUTER_SERVER_URL;
}
