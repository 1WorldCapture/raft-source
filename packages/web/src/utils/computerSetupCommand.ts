export const STAGING_COMPUTER_SERVER_URL = "https://api-aws-staging.botiverse.dev";
export const DEFAULT_COMPUTER_SERVER_URL = "https://api.raft.build";
export const LEGACY_DEFAULT_COMPUTER_SERVER_URL = "https://api.slock.ai";

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
  privateBase?: string,
): string {
  // Private deployments (task #5): bytes AND installer come from the
  // connected server's /downloads tree; INSTALL_BACKEND=server persists so
  // later upgrade checks resolve against the same origin.
  const base = privateBase
    ?? (deploymentEnv === "staging" ? COMPUTER_CDN_BASE_STAGING : COMPUTER_CDN_BASE_PROD);
  const versionPin = normalizeComputerVersionPin(version);
  const installEnv = [
    ...(privateBase
      ? [
          `RAFT_COMPUTER_RELEASE_BASE=${privateBase}`,
          "RAFT_COMPUTER_INSTALL_BACKEND=server",
        ]
      : deploymentEnv === "staging"
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
  privateBase?: string,
): string {
  const base = privateBase
    ?? (deploymentEnv === "staging" ? COMPUTER_CDN_BASE_STAGING : COMPUTER_CDN_BASE_PROD);
  const versionPin = normalizeComputerVersionPin(version);
  const installEnv = [
    ...(privateBase
      ? [
          `$env:RAFT_COMPUTER_RELEASE_BASE = "${privateBase}"`,
          '$env:RAFT_COMPUTER_INSTALL_BACKEND = "server"',
        ]
      : deploymentEnv === "staging"
        ? [
            `$env:RAFT_COMPUTER_RELEASE_BASE = "${base}"`,
            '$env:RAFT_COMPUTER_INSTALL_CHANNEL = "alpha"',
          ]
        : []),
    ...(versionPin ? [`$env:RAFT_COMPUTER_VERSION = "${versionPin}"`] : []),
  ];
  const installUrl = privateBase || deploymentEnv === "staging"
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
  // Runtime deployment mode (GET /api/deployment-info; see
  // utils/deploymentMode.ts). "private" generates install commands from the
  // connected server's own /downloads tree instead of the official CDN.
  // null / "unknown" (not yet resolved, or resolution failed) generate the
  // standard commands — the CALLER gates rendering: null renders no command
  // at all, "unknown" renders with a notice (PM review round 1: never
  // silently show official commands on a private server).
  deploymentMode?: "private" | "standard" | "unknown" | null;
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
  /** Private deployments (task #6): the daemon tarball URL from
   *  /api/deployment-info (server-rendered, SERVER_URL-based). When set,
   *  the command becomes a two-step `npm i -g <url>` + `raft-daemon …`
   *  instead of the public-registry npx form. The global install
   *  intentionally OVERRIDES any official @botiverse/raft-daemon copy on
   *  the machine — documented, expected behavior for private deployments. */
  installUrl?: string | null;
}

export function getDaemonConnectCommand({
  apiKey,
  serverName,
  serverUrl,
  distTag = "latest",
  platform = "mac-linux",
  installUrl,
}: DaemonConnectCommandOptions): string {
  if (installUrl) {
    // Two-step form (PM-approved): install the tarball once, then run the
    // bin directly — consistent with the CLI install command style.
    if (platform === "windows") {
      return `npm i -g ${installUrl}; raft-daemon --server-url ${serverUrl} --api-key ${apiKey}`;
    }
    const suffix = serverName ? ` # ${serverName}` : "";
    return `npm i -g ${installUrl} && raft-daemon --server-url ${serverUrl} --api-key ${apiKey}${suffix}`;
  }
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

export function getComputerCommands(
  serverSlug: string | undefined | null,
  deploymentEnv = import.meta.env?.VITE_DEPLOYMENT_ENV,
  serverUrl?: string,
  options: ComputerSetupCommandOptions = {},
): ComputerCommands | null {
  const slug = serverSlug?.trim().replace(/^\/+/, "");
  if (!slug) return null;

  const platform = options.platform ?? "mac-linux";

  // Private deployments: the install command must fetch the installer AND
  // the bytes from this server's /downloads tree (task #5). The runtime mode
  // outranks the baked deployment env — a private server never renders
  // staging commands, and an absent serverUrl falls back to the official
  // flow rather than emitting a malformed base.
  const privateBase = options.deploymentMode === "private" && serverUrl?.trim()
    ? `${serverUrl.trim().replace(/\/+$/, "")}/downloads/computer`
    : undefined;

  // Unknown deployment envs (self-hosted builds leave VITE_DEPLOYMENT_ENV
  // unset or custom) follow the production rule: carry --server-url whenever
  // the target is not an official default origin, so a self-hosted server
  // never falls back to the official one (task #1, phase-1 command bug:
  // previously any unrecognized env dropped the arg entirely).
  const commandServerUrl = deploymentEnv === "staging"
    ? STAGING_COMPUTER_SERVER_URL
    : deploymentEnv === "slockdev"
      ? serverUrl
      : isDefaultComputerServerUrl(serverUrl) ? null : serverUrl;
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
        install: `${environment} ${windowsComputerInstallCommand(deploymentEnv, options.version, privateBase)}`,
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
      install: `${environment} sh -c '${computerInstallCommand(deploymentEnv, options.version, privateBase)}'`,
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
      ? windowsComputerInstallCommand(deploymentEnv, options.version, privateBase)
      : computerInstallCommand(deploymentEnv, options.version, privateBase),
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

function isDefaultComputerServerUrl(serverUrl: string | undefined): boolean {
  const normalized = serverUrl?.trim().replace(/\/+$/, "");
  return normalized === DEFAULT_COMPUTER_SERVER_URL || normalized === LEGACY_DEFAULT_COMPUTER_SERVER_URL;
}
