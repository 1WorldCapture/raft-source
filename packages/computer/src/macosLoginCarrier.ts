import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import { access, lstat, mkdir, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import {
  clearClockTimeout,
  currentTimeMs,
  setClockTimeout,
} from "@botiverse/raft-shared";

import { writeDurableTextFile } from "./durableFile.js";
import { ComputerServiceError } from "./services/errors.js";

const execFileAsync = promisify(execFile);
const HOST_LIFECYCLE_FORMAT_VERSION = 1 as const;
const HOST_LIFECYCLE_PENDING_REPLACE_FORMAT_VERSION = 1 as const;
const COMMAND_TIMEOUT_MS = 5_000;
const REPLACE_MINIMUM_BUDGET_MS = 2_000;
const ROLLBACK_RESERVED_BUDGET_MS = 10_000;

/** The supported install identity of the legacy Electron Desktop carrier.
 * Its released DMG exposes only the `/Applications` drag target. Presence is
 * an ambiguity signal, never proof that the App owns host lifecycle. */
export const LEGACY_DESKTOP_BUNDLE_ID = "build.raft.computer-app";
export const LEGACY_DESKTOP_BUNDLE_PATH = "/Applications/Raft Computer.app";

export const RAFT_COMPUTER_DISPATCHER_PATH_ENV_VAR =
  "RAFT_COMPUTER_DISPATCHER_PATH";

export type HostLifecycleOwner = "app" | "cli";

export interface HostLifecycleMarker {
  formatVersion: typeof HOST_LIFECYCLE_FORMAT_VERSION;
  owner: HostLifecycleOwner;
  enabled: boolean;
  dispatcherPath: string | null;
  label: string | null;
  definitionPath: string | null;
}

export interface MacosLoginCarrierSpec {
  label: string;
  domain: string;
  slockHome: string;
  dispatcherPath: string;
  definitionPath: string;
  definition: string;
  args: string[];
}

export interface BuildMacosLoginCarrierSpecInput {
  slockHome: string;
  dispatcherPath: string;
  userHome: string;
  uid: number;
}

export interface HostLifecycleCommandResult {
  stdout: string;
  stderr: string;
}

export type HostLifecycleCommandRunner = (
  command: string,
  args: string[],
  signal?: AbortSignal,
) => Promise<HostLifecycleCommandResult>;

export interface MacosHostLifecycleDeps {
  platform?: NodeJS.Platform;
  userHome?: string;
  uid?: number | null;
  dispatcherPath?: string;
  legacyDesktopBundlePath?: string;
  signal?: AbortSignal;
  deadlineAtMs?: number;
  now?: () => number;
  setTimeoutFn?: typeof setClockTimeout;
  clearTimeoutFn?: typeof clearClockTimeout;
  runCommand?: HostLifecycleCommandRunner;
  /**
   * "converge" (default): the healthy-carrier deferral may skip a swap whose
   * only difference is the resolved dispatcher path. "refresh": an explicit
   * carrier refresh (post-upgrade) MUST land the new dispatcher — deferral
   * would report success while the job still runs the old entry.
   */
  carrierMode?: "converge" | "refresh";
}

interface HostLifecyclePendingReplace {
  formatVersion: typeof HOST_LIFECYCLE_PENDING_REPLACE_FORMAT_VERSION;
  phase: "prepared" | "rollback-failed";
  previousMarker: HostLifecycleMarker;
  previousDefinition: string;
  previousDefinitionSha256: string;
  targetDefinitionSha256: string;
  errorCode: string | null;
}

export interface HostLifecycleRecoveryStatus {
  status: "pending-replace" | "degraded";
  errorCode: string | null;
  owner: "cli";
  dispatcherPath: string;
  definitionPath: string;
  previousDefinitionSha256: string;
  targetDefinitionSha256: string;
}

export interface AppHostLifecycleDeps extends MacosHostLifecycleDeps {
  setOpenAtLogin: (enabled: boolean) => void | Promise<void>;
  getOpenAtLogin: () => boolean | Promise<boolean>;
}

export interface HostLifecycleRemovalDeps extends MacosHostLifecycleDeps {
  setOpenAtLogin?: (enabled: boolean) => void | Promise<void>;
  getOpenAtLogin?: () => boolean | Promise<boolean>;
}

export interface HostLifecycleConvergenceResult {
  owner: HostLifecycleOwner;
  enabled: boolean;
  status: "converged" | "not-applicable";
  label: string | null;
  definitionPath: string | null;
  definition: string | null;
  /**
   * Set when the live carrier is healthy but points at a different (still
   * valid) dispatcher than this invocation resolved: the swap was deferred
   * instead of booting out a running service for zero benefit. The marker
   * intentionally keeps describing the installed carrier.
   */
  deferredRefresh?: { liveDispatcher: string; wantedDispatcher: string };
}

export interface HostLifecycleRemovalResult {
  status: "removed" | "not-applicable";
  label: string | null;
  definitionPath: string | null;
}

/**
 * Resolve the stable PATH dispatcher that survives K slot swaps. The bootstrap
 * entry records the pre-dispatch executable in the environment before it
 * execs a K resident. A resident reached without that evidence must not write
 * its ephemeral slot path into a persistent LaunchAgent.
 */
export function resolveStableDispatcherPath(
  slockHome: string,
  env: NodeJS.ProcessEnv = process.env,
  currentBinary: string = process.execPath,
): string {
  const explicit = env[RAFT_COMPUTER_DISPATCHER_PATH_ENV_VAR]?.trim();
  if (explicit) {
    if (!path.isAbsolute(explicit)) {
      throw new ComputerServiceError(
        "HOST_LIFECYCLE_DISPATCHER_UNBOUND",
        "Raft Computer received a non-absolute stable dispatcher path and refused to persist it.",
      );
    }
    return path.resolve(explicit);
  }
  const resolvedCurrent = path.resolve(currentBinary);
  const kRoot = `${path.resolve(slockHome, "computer", "k")}${path.sep}`;
  if (resolvedCurrent.startsWith(kRoot)) {
    throw new ComputerServiceError(
      "HOST_LIFECYCLE_DISPATCHER_UNBOUND",
      "Raft Computer is running from a K slot without stable dispatcher evidence. Reinstall the current Computer build, then run `raft-computer start` again.",
    );
  }
  return resolvedCurrent;
}

function xmlEscape(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

function loginCarrierHash(slockHome: string): string {
  return createHash("sha256")
    .update(path.resolve(slockHome))
    .digest("hex")
    .slice(0, 16);
}

function launchdPath(userHome: string): string {
  return [
    path.join(path.resolve(userHome), ".local", "bin"),
    "/opt/homebrew/bin",
    "/usr/local/bin",
    "/usr/bin",
    "/bin",
    "/usr/sbin",
    "/sbin",
  ]
    .filter((entry, index, all) => all.indexOf(entry) === index)
    .join(":");
}

export function buildMacosLoginCarrierSpec(
  input: BuildMacosLoginCarrierSpecInput,
): MacosLoginCarrierSpec {
  if (!Number.isSafeInteger(input.uid) || input.uid < 0) {
    throw new ComputerServiceError(
      "HOST_LIFECYCLE_UID_REQUIRED",
      "Cannot configure post-login recovery because the current macOS user id is unavailable.",
    );
  }
  const slockHome = path.resolve(input.slockHome);
  const dispatcherPath = path.resolve(input.dispatcherPath);
  const userHome = path.resolve(input.userHome);
  const label = `build.raft.computer.login.${loginCarrierHash(slockHome)}`;
  const definitionPath = path.join(
    userHome,
    "Library",
    "LaunchAgents",
    `${label}.plist`,
  );
  const args = ["__service", "--slock-home", slockHome];
  const argv = [dispatcherPath, ...args]
    .map((arg) => `      <string>${xmlEscape(arg)}</string>`)
    .join("\n");
  const serviceLogPath = path.join(slockHome, "computer", "run", "service.log");
  const definition = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
    '<plist version="1.0">',
    "  <dict>",
    "    <key>Label</key>",
    `    <string>${xmlEscape(label)}</string>`,
    "    <key>ProgramArguments</key>",
    "    <array>",
    argv,
    "    </array>",
    "    <key>EnvironmentVariables</key>",
    "    <dict>",
    "      <key>PATH</key>",
    `      <string>${xmlEscape(launchdPath(userHome))}</string>`,
    "    </dict>",
    "    <key>RunAtLoad</key>",
    "    <true/>",
    "    <key>ProcessType</key>",
    "    <string>Background</string>",
    "    <key>StandardOutPath</key>",
    `    <string>${xmlEscape(serviceLogPath)}</string>`,
    "    <key>StandardErrorPath</key>",
    `    <string>${xmlEscape(serviceLogPath)}</string>`,
    "  </dict>",
    "</plist>",
    "",
  ].join("\n");
  return {
    label,
    domain: `gui/${input.uid}`,
    slockHome,
    dispatcherPath,
    definitionPath,
    definition,
    args,
  };
}

function markerPath(slockHome: string): string {
  return path.join(
    path.resolve(slockHome),
    "computer",
    "host-lifecycle-owner.json",
  );
}

function pendingReplacePath(slockHome: string): string {
  return path.join(
    path.resolve(slockHome),
    "computer",
    "host-lifecycle-pending-replace.json",
  );
}

function definitionSha256(definition: string): string {
  return createHash("sha256").update(definition).digest("hex");
}

async function writePendingReplace(
  slockHome: string,
  pending: HostLifecyclePendingReplace,
): Promise<void> {
  await writeDurableTextFile(
    pendingReplacePath(slockHome),
    `${JSON.stringify(pending)}\n`,
  );
}

async function readPendingReplace(
  slockHome: string,
): Promise<HostLifecyclePendingReplace | null> {
  try {
    const parsed = JSON.parse(
      await readFile(pendingReplacePath(slockHome), "utf8"),
    ) as Partial<HostLifecyclePendingReplace>;
    if (
      parsed.formatVersion !== HOST_LIFECYCLE_PENDING_REPLACE_FORMAT_VERSION
      || (parsed.phase !== "prepared" && parsed.phase !== "rollback-failed")
      || parsed.previousMarker?.owner !== "cli"
      || typeof parsed.previousMarker.dispatcherPath !== "string"
      || typeof parsed.previousMarker.definitionPath !== "string"
      || typeof parsed.previousDefinition !== "string"
      || typeof parsed.previousDefinitionSha256 !== "string"
      || typeof parsed.targetDefinitionSha256 !== "string"
      || !(parsed.errorCode === null || typeof parsed.errorCode === "string")
      || definitionSha256(parsed.previousDefinition) !== parsed.previousDefinitionSha256
    ) {
      throw new Error("invalid pending replacement record");
    }
    return parsed as HostLifecyclePendingReplace;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw new ComputerServiceError(
      "HOST_LIFECYCLE_RECOVERY_UNREADABLE",
      "Raft Computer found an unreadable macOS login-carrier recovery record. Run `raft-computer doctor` before changing startup behavior.",
      error,
    );
  }
}

export async function readHostLifecycleRecoveryStatus(
  slockHome: string,
): Promise<HostLifecycleRecoveryStatus | null> {
  const pending = await readPendingReplace(slockHome);
  if (pending === null) return null;
  return {
    status: pending.phase === "rollback-failed" ? "degraded" : "pending-replace",
    errorCode: pending.errorCode,
    owner: "cli",
    dispatcherPath: pending.previousMarker.dispatcherPath!,
    definitionPath: pending.previousMarker.definitionPath!,
    previousDefinitionSha256: pending.previousDefinitionSha256,
    targetDefinitionSha256: pending.targetDefinitionSha256,
  };
}

function parseMarker(raw: string): HostLifecycleMarker | null {
  try {
    const value = JSON.parse(raw) as Partial<HostLifecycleMarker>;
    if (
      value.formatVersion !== HOST_LIFECYCLE_FORMAT_VERSION ||
      (value.owner !== "app" && value.owner !== "cli") ||
      typeof value.enabled !== "boolean" ||
      !(typeof value.dispatcherPath === "string" || value.dispatcherPath === null) ||
      !(typeof value.label === "string" || value.label === null) ||
      !(typeof value.definitionPath === "string" || value.definitionPath === null)
    ) {
      return null;
    }
    return value as HostLifecycleMarker;
  } catch {
    return null;
  }
}

export async function readHostLifecycleMarker(
  slockHome: string,
): Promise<HostLifecycleMarker | null> {
  try {
    const raw = await readFile(markerPath(slockHome), "utf8");
    const marker = parseMarker(raw);
    if (marker === null) {
      throw new ComputerServiceError(
        "HOST_LIFECYCLE_OWNER_UNREADABLE",
        "Raft Computer found an unreadable host-lifecycle owner record. Repair or remove it before changing startup behavior.",
      );
    }
    return marker;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

async function writeMarker(
  slockHome: string,
  marker: HostLifecycleMarker,
): Promise<void> {
  const serialized = `${JSON.stringify(marker)}\n`;
  await writeDurableTextFile(markerPath(slockHome), serialized);
  const readback = await readHostLifecycleMarker(slockHome);
  if (JSON.stringify(readback) !== JSON.stringify(marker)) {
    throw new ComputerServiceError(
      "HOST_LIFECYCLE_OWNER_READBACK_FAILED",
      "Raft Computer could not verify the host-lifecycle owner record after writing it.",
    );
  }
}

async function defaultRunCommand(
  command: string,
  args: string[],
  signal?: AbortSignal,
): Promise<HostLifecycleCommandResult> {
  const { stdout, stderr } = await execFileAsync(command, args, {
    encoding: "utf8",
    timeout: COMMAND_TIMEOUT_MS,
    maxBuffer: 1024 * 1024,
    signal,
  });
  return { stdout, stderr };
}

function bindCommandSignal(
  runCommand: HostLifecycleCommandRunner,
  signal?: AbortSignal,
): HostLifecycleCommandRunner {
  return (command, args) => runCommand(command, args, signal);
}

function deadlineSignal(
  deadlineAtMs: number,
  deps: MacosHostLifecycleDeps,
): { signal: AbortSignal; dispose: () => void } {
  const controller = new AbortController();
  const now = deps.now ?? currentTimeMs;
  const setTimeoutFn = deps.setTimeoutFn ?? setClockTimeout;
  const clearTimeoutFn = deps.clearTimeoutFn ?? clearClockTimeout;
  const parent = deps.signal;
  const abortFromParent = (): void => controller.abort();
  if (parent?.aborted) controller.abort();
  else parent?.addEventListener("abort", abortFromParent, { once: true });
  const timeout = setTimeoutFn(
    () => controller.abort(),
    Math.max(0, deadlineAtMs - now()),
  );
  return {
    signal: controller.signal,
    dispose: () => {
      clearTimeoutFn(timeout);
      parent?.removeEventListener("abort", abortFromParent);
    },
  };
}

/**
 * A pre-marker Electron install may already have `openAtLogin=true`, but the
 * CLI cannot read that App-owned setting. Exact supported bundle presence is
 * therefore only an ownership-ambiguity detector: it never infers App owner.
 * This check runs before any launchctl read or mutation.
 */
async function assertNoMarkerlessLegacyDesktop(
  deps: MacosHostLifecycleDeps,
  runCommand: HostLifecycleCommandRunner,
): Promise<void> {
  const bundlePath = deps.legacyDesktopBundlePath ?? LEGACY_DESKTOP_BUNDLE_PATH;
  if (!path.isAbsolute(bundlePath)) {
    throw new ComputerServiceError(
      "HOST_LIFECYCLE_DESKTOP_IDENTITY_UNVERIFIED",
      "Raft Computer cannot verify the supported Raft Desktop install location. Nothing was changed.",
    );
  }
  let bundleStat: Awaited<ReturnType<typeof lstat>>;
  try {
    bundleStat = await lstat(bundlePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw new ComputerServiceError(
      "HOST_LIFECYCLE_DESKTOP_IDENTITY_UNVERIFIED",
      `Raft Computer cannot verify whether Raft Desktop is installed at ${bundlePath}. Nothing was changed.`,
      error,
    );
  }
  if (bundleStat.isSymbolicLink() || !bundleStat.isDirectory()) {
    throw new ComputerServiceError(
      "HOST_LIFECYCLE_DESKTOP_IDENTITY_UNVERIFIED",
      `Raft Computer found an unsupported item at ${bundlePath} and cannot safely choose a startup owner. Move or remove that item, then retry. Nothing was changed.`,
    );
  }
  const contentsPath = path.join(bundlePath, "Contents");
  const infoPlistPath = path.join(contentsPath, "Info.plist");
  try {
    const contentsStat = await lstat(contentsPath);
    const plistStat = await lstat(infoPlistPath);
    if (
      contentsStat.isSymbolicLink()
      || !contentsStat.isDirectory()
      || plistStat.isSymbolicLink()
      || !plistStat.isFile()
    ) {
      throw new Error("unsupported bundle shape");
    }
  } catch (error) {
    throw new ComputerServiceError(
      "HOST_LIFECYCLE_DESKTOP_IDENTITY_UNVERIFIED",
      `Raft Computer found an incomplete or unsupported app shape at ${bundlePath} and cannot safely choose a startup owner. Repair or remove that app, then retry. Nothing was changed.`,
      error,
    );
  }
  let bundleId: string;
  try {
    bundleId = (
      await runCommand("/usr/bin/plutil", [
        "-extract",
        "CFBundleIdentifier",
        "raw",
        "-o",
        "-",
        infoPlistPath,
      ])
    ).stdout.trim();
  } catch (error) {
    throw new ComputerServiceError(
      "HOST_LIFECYCLE_DESKTOP_IDENTITY_UNVERIFIED",
      `Raft Computer found an app at ${bundlePath} but could not verify its bundle identity. Open or upgrade Raft Desktop once, then retry. Nothing was changed.`,
      error,
    );
  }
  if (bundleId !== LEGACY_DESKTOP_BUNDLE_ID) {
    throw new ComputerServiceError(
      "HOST_LIFECYCLE_DESKTOP_IDENTITY_UNVERIFIED",
      `Raft Computer found an app at ${bundlePath} with an unexpected bundle identity and cannot safely choose a startup owner. Move or remove that app, then retry. Nothing was changed.`,
    );
  }
  throw new ComputerServiceError(
    "HOST_LIFECYCLE_OWNER_AMBIGUOUS",
    `Raft Computer found the legacy Raft Desktop at ${bundlePath}, but no host-lifecycle owner record exists. Open or upgrade Raft Desktop once so it can establish that record, then retry. Nothing was changed.`,
  );
}

function resolveMacosContext(
  slockHome: string,
  deps: MacosHostLifecycleDeps,
): {
  platform: NodeJS.Platform;
  spec: MacosLoginCarrierSpec | null;
  runCommand: HostLifecycleCommandRunner;
} {
  const platform = deps.platform ?? process.platform;
  if (platform !== "darwin") {
    return { platform, spec: null, runCommand: deps.runCommand ?? defaultRunCommand };
  }
  const uid = deps.uid ?? process.getuid?.() ?? null;
  if (uid === null) {
    throw new ComputerServiceError(
      "HOST_LIFECYCLE_UID_REQUIRED",
      "Cannot configure post-login recovery because the current macOS user id is unavailable.",
    );
  }
  const dispatcherPath = deps.dispatcherPath?.trim();
  if (!dispatcherPath || !path.isAbsolute(dispatcherPath)) {
    throw new ComputerServiceError(
      "HOST_LIFECYCLE_DISPATCHER_UNBOUND",
      "Raft Computer cannot prove the stable CLI dispatcher path. Reinstall the current Computer build, then run `raft-computer start` again.",
    );
  }
  return {
    platform,
    spec: buildMacosLoginCarrierSpec({
      slockHome,
      dispatcherPath,
      userHome: deps.userHome ?? os.homedir(),
      uid,
    }),
    runCommand: deps.runCommand ?? defaultRunCommand,
  };
}

async function assertGuiDomain(
  spec: MacosLoginCarrierSpec,
  runCommand: HostLifecycleCommandRunner,
): Promise<void> {
  try {
    await runCommand("/bin/launchctl", ["print", spec.domain]);
  } catch (error) {
    throw new ComputerServiceError(
      "HOST_LIFECYCLE_GUI_DOMAIN_UNAVAILABLE",
      `Raft Computer cannot access the macOS login domain ${spec.domain}. Log in to the target user session and retry.`,
      error,
    );
  }
}

async function printJob(
  spec: MacosLoginCarrierSpec,
  runCommand: HostLifecycleCommandRunner,
): Promise<string | null> {
  try {
    return (
      await runCommand("/bin/launchctl", [
        "print",
        `${spec.domain}/${spec.label}`,
      ])
    ).stdout;
  } catch {
    // A failed job lookup is only "absent" while the containing GUI domain is
    // still readable. Permission/session loss must remain a typed failure,
    // never silently degrade into an absence readback.
    await assertGuiDomain(spec, runCommand);
    return null;
  }
}

/** First ProgramArguments entry of a carrier plist — the dispatcher path
 * launchd actually runs. The plist is generated by buildMacosLoginCarrierSpec,
 * so a narrow extraction is exact; null on any structural surprise. */
export function dispatcherFromDefinition(definition: string): string | null {
  const argvMatch = definition.match(
    /<key>ProgramArguments<\/key>\s*<array>([\s\S]*?)<\/array>/,
  );
  if (argvMatch === null) return null;
  const first = argvMatch[1].match(/<string>([^<]*)<\/string>/);
  if (first === null) return null;
  const decoded = first[1]
    .replaceAll("&amp;", "&")
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&quot;", '"')
    .replaceAll("&apos;", "'");
  return decoded.length > 0 ? decoded : null;
}

/** True when the file exists and carries the executable bit. */
async function isExecutableFile(file: string): Promise<boolean> {
  try {
    await access(file, fsConstants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * Unload the live launchd job WITHOUT touching the on-disk definition.
 * Distinct from removeCliCarrier on purpose: a bootout failure here leaves
 * the old carrier fully intact (job loaded, plist on disk), which is what
 * makes the replace path able to fail safely before anything destructive
 * happens — the exact gap behind the 2026-10-02 outages, where the owner
 * marker was deleted before bootout and a bootout failure stranded the
 * machine with no login item and no service.
 */
async function bootoutCarrier(
  spec: MacosLoginCarrierSpec,
  runCommand: HostLifecycleCommandRunner,
): Promise<"booted-out" | "not-loaded"> {
  await assertGuiDomain(spec, runCommand);
  if ((await printJob(spec, runCommand)) === null) return "not-loaded";
  await runCommand("/bin/launchctl", [
    "bootout",
    `${spec.domain}/${spec.label}`,
  ]);
  return "booted-out";
}

async function removeCliCarrier(
  spec: MacosLoginCarrierSpec,
  runCommand: HostLifecycleCommandRunner,
): Promise<void> {
  await assertGuiDomain(spec, runCommand);
  if ((await printJob(spec, runCommand)) !== null) {
    try {
      await runCommand("/bin/launchctl", [
        "bootout",
        `${spec.domain}/${spec.label}`,
      ]);
    } catch (error) {
      throw new ComputerServiceError(
        "HOST_LIFECYCLE_REMOVAL_FAILED",
        "Raft Computer could not unload its macOS post-login carrier. Nothing was reported as removed.",
        error,
      );
    }
  }
  await rm(spec.definitionPath, { force: true });
  try {
    await readFile(spec.definitionPath, "utf8");
    throw new ComputerServiceError(
      "HOST_LIFECYCLE_REMOVAL_FAILED",
      "Raft Computer could not remove its macOS post-login definition.",
    );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  if ((await printJob(spec, runCommand)) !== null) {
    throw new ComputerServiceError(
      "HOST_LIFECYCLE_REMOVAL_FAILED",
      "Raft Computer removed the login definition but the live launchd job still exists.",
    );
  }
}

async function recoverPendingReplace(
  spec: MacosLoginCarrierSpec,
  pending: HostLifecyclePendingReplace,
  runCommand: HostLifecycleCommandRunner,
): Promise<HostLifecycleMarker> {
  if (
    pending.previousMarker.label !== spec.label
    || pending.previousMarker.definitionPath !== spec.definitionPath
  ) {
    throw new ComputerServiceError(
      "HOST_LIFECYCLE_RECOVERY_IDENTITY_MISMATCH",
      "Raft Computer found a macOS login-carrier recovery record for a different install identity. Nothing was changed; inspect it with `raft-computer doctor`.",
    );
  }
  // Fast path: a failed replace may have left the OLD carrier fully intact
  // (e.g. the bootout itself failed before any destructive step). Verify
  // before touching launchd — if the on-disk definition still matches the
  // backup AND the live job runs the backup dispatcher, only the marker and
  // the recovery record need bookkeeping repair. This is the programmatic
  // version of the manual reinstall the owner had to do twice on 2026-10-02.
  const intactDefinition = await readFile(spec.definitionPath, "utf8").catch(
    (error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return null;
      throw error;
    },
  );
  const intactJob = await printJob(spec, runCommand).catch(() => null);
  if (
    intactDefinition === pending.previousDefinition
    && intactJob !== null
    && intactJob.includes(pending.previousMarker.dispatcherPath!)
  ) {
    await writeMarker(spec.slockHome, pending.previousMarker);
    await rm(pendingReplacePath(spec.slockHome), { force: true });
    return pending.previousMarker;
  }
  try {
    await removeCliCarrier(spec, runCommand);
    await mkdir(path.dirname(spec.definitionPath), { recursive: true, mode: 0o700 });
    await writeDurableTextFile(spec.definitionPath, pending.previousDefinition);
    await runCommand("/bin/launchctl", [
      "bootstrap",
      spec.domain,
      spec.definitionPath,
    ]);
    const restored = await printJob(spec, runCommand);
    if (
      restored === null
      || !restored.includes(spec.label)
      || !restored.includes(pending.previousMarker.dispatcherPath!)
    ) {
      throw new Error("recovered carrier readback mismatch");
    }
    await writeMarker(spec.slockHome, pending.previousMarker);
    await rm(pendingReplacePath(spec.slockHome), { force: true });
    return pending.previousMarker;
  } catch (error) {
    await writePendingReplace(spec.slockHome, {
      ...pending,
      phase: "rollback-failed",
      errorCode:
        error instanceof ComputerServiceError
          ? error.code
          : (error as NodeJS.ErrnoException).code ?? "RECOVERY_FAILED",
    });
    throw new ComputerServiceError(
      "HOST_LIFECYCLE_RECOVERY_FAILED",
      "Raft Computer could not recover the saved macOS login carrier. The enabled owner marker remains absent; `raft-computer status` and `raft-computer doctor` expose the durable recovery record.",
      error,
    );
  }
}

async function enableCliCarrier(
  spec: MacosLoginCarrierSpec,
  baseRunCommand: HostLifecycleCommandRunner,
  previousMarker: HostLifecycleMarker | null,
  targetMarker: HostLifecycleMarker,
  deps: MacosHostLifecycleDeps,
): Promise<{ deferredRefresh?: { liveDispatcher: string; wantedDispatcher: string } }> {
  const runCommand = bindCommandSignal(baseRunCommand, deps.signal);
  await assertGuiDomain(spec, runCommand);
  const existingDefinition = await readFile(spec.definitionPath, "utf8").catch(
    (error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return null;
      throw error;
    },
  );
  const existingJob = await printJob(spec, runCommand);
  if (
    existingDefinition === spec.definition
    && existingJob !== null
    && existingJob.includes(spec.label)
    && existingJob.includes(spec.dispatcherPath)
  ) {
    if (JSON.stringify(previousMarker) !== JSON.stringify(targetMarker)) {
      await writeMarker(spec.slockHome, targetMarker);
    }
    return {};
  }
  // Healthy-carrier deferral: the live job already runs a dispatcher that
  // still exists and is executable. Swapping it just because THIS invocation
  // resolved a different path would bootout a possibly-running service for
  // zero benefit — the exact shape of both 2026-10-02 outages (a start /
  // restart resolved a new dispatcher path and tore down the login item to
  // install an equivalent one). Defer the swap: keep the marker describing
  // the carrier that is actually installed, touch nothing.
  if (
    (deps.carrierMode ?? "converge") === "converge"
    && existingJob !== null
    && existingDefinition !== null
  ) {
    const liveDispatcher = dispatcherFromDefinition(existingDefinition);
    if (
      liveDispatcher !== null
      && liveDispatcher !== spec.dispatcherPath
      && (await isExecutableFile(liveDispatcher))
    ) {
      return {
        deferredRefresh: { liveDispatcher, wantedDispatcher: spec.dispatcherPath },
      };
    }
  }
  const rollback =
    previousMarker?.owner === "cli"
    && previousMarker.enabled
    && previousMarker.label === spec.label
    && previousMarker.definitionPath === spec.definitionPath
    && typeof previousMarker.dispatcherPath === "string"
    && existingDefinition !== null
    && existingJob !== null
    && existingJob.includes(spec.label)
    && existingJob.includes(previousMarker.dispatcherPath)
      ? { definition: existingDefinition, marker: previousMarker }
      : null;

  const verifiedDisabledBoundary =
    previousMarker?.owner === "cli"
    && !previousMarker.enabled
    && existingDefinition === null
    && existingJob === null;
  if (
    previousMarker?.owner === "cli"
    && rollback === null
    && !verifiedDisabledBoundary
  ) {
    throw new ComputerServiceError(
      "HOST_LIFECYCLE_LAST_KNOWN_GOOD_UNVERIFIED",
      "Raft Computer could not verify the current macOS login job, definition, and owner record as one last-known-good carrier. Nothing was changed; run `raft-computer doctor` before retrying.",
    );
  }

  const pending: HostLifecyclePendingReplace | null = rollback === null
    ? null
    : {
        formatVersion: HOST_LIFECYCLE_PENDING_REPLACE_FORMAT_VERSION,
        phase: "prepared",
        previousMarker: rollback.marker,
        previousDefinition: rollback.definition,
        previousDefinitionSha256: definitionSha256(rollback.definition),
        targetDefinitionSha256: definitionSha256(spec.definition),
        errorCode: null,
      };

  let forwardDeadline: ReturnType<typeof deadlineSignal> | null = null;
  if (pending !== null && deps.deadlineAtMs !== undefined) {
    const remainingMs = deps.deadlineAtMs - (deps.now ?? currentTimeMs)();
    if (remainingMs < REPLACE_MINIMUM_BUDGET_MS + ROLLBACK_RESERVED_BUDGET_MS) {
      throw new ComputerServiceError(
        "HOST_LIFECYCLE_REFRESH_BUDGET_INSUFFICIENT",
        "Raft Computer did not have enough of the shared K resume deadline left to replace and, if needed, roll back the macOS login carrier. Nothing was changed.",
      );
    }
    forwardDeadline = deadlineSignal(
      deps.deadlineAtMs - ROLLBACK_RESERVED_BUDGET_MS,
      deps,
    );
  }
  const forwardRunCommand = bindCommandSignal(
    baseRunCommand,
    forwardDeadline?.signal ?? deps.signal,
  );

  // Integrity-cleanup runner: bound to NO external signal (neither the
  // forward deadline nor the caller's cancellation). Restoring the previous
  // carrier is a bounded finish-it-or-degrade step of the failed operation
  // itself; a caller that cancels must not also cancel the machine's chance
  // to get its login carrier back. Boundedness comes from the per-command
  // timeout the raw runner already applies.
  const recoveryRunCommand = baseRunCommand;
  const restorePreviousCarrier = async (): Promise<void> => {
    if (rollback === null) return;
    try {
      // The job was already booted out on the forward path; bootout again
      // only to clear a half-dead registration. "not loaded" (and even an
      // error on an already-absent job) is fine — bootstrap below is the
      // authoritative step.
      await bootoutCarrier(spec, recoveryRunCommand).catch(() => "not-loaded" as const);
      await mkdir(path.dirname(spec.definitionPath), { recursive: true, mode: 0o700 });
      await writeDurableTextFile(spec.definitionPath, rollback.definition);
      await recoveryRunCommand("/bin/launchctl", [
        "bootstrap",
        spec.domain,
        spec.definitionPath,
      ]);
      const restored = await printJob(spec, recoveryRunCommand);
      if (
        restored === null
        || !restored.includes(spec.label)
        || !restored.includes(rollback.marker.dispatcherPath!)
      ) {
        throw new Error("restored carrier readback mismatch");
      }
      await writeMarker(spec.slockHome, rollback.marker);
      await rm(pendingReplacePath(spec.slockHome), { force: true });
    } catch (error) {
        await writePendingReplace(spec.slockHome, {
        ...pending!,
        phase: "rollback-failed",
        errorCode:
          error instanceof ComputerServiceError
            ? error.code
            : (error as NodeJS.ErrnoException).code ?? "ROLLBACK_FAILED",
      });
      throw new ComputerServiceError(
        "HOST_LIFECYCLE_ROLLBACK_FAILED",
        "Raft Computer could not restore the last verified macOS login carrier after refresh failed. The enabled owner marker was removed; `raft-computer status` and `raft-computer doctor` expose the durable recovery record.",
        error,
      );
    }
  };

  // The durable recovery anchor is committed before the first destructive
  // operation. The new owner marker is committed only after definition + live
  // launchd job + dispatcher readback agree; failure restores all three old
  // surfaces or leaves a durable degraded record with no false enabled marker.
  let destructiveStarted = false;
  try {
    if (pending !== null) await writePendingReplace(spec.slockHome, pending);
    if (forwardDeadline?.signal.aborted) {
      await rm(pendingReplacePath(spec.slockHome), { force: true });
      throw new ComputerServiceError(
        "HOST_LIFECYCLE_REFRESH_TIMEOUT",
        "Raft Computer exhausted the replacement portion of the shared K resume deadline before changing the macOS login carrier. Nothing was changed.",
      );
    }
    // Phase 1 — unload the live job WITHOUT touching the on-disk definition
    // or the owner marker. A failure here leaves the previous carrier fully
    // intact (job loaded, plist on disk, marker still pointing at it), so it
    // is reported as a no-op instead of stranding the machine.
    try {
      await bootoutCarrier(spec, forwardRunCommand);
    } catch (error) {
      // A launchctl error does not prove nothing happened: bootout can
      // report failure AFTER unloading the job (late error). Verify the
      // actual state before claiming a safe no-op — an unloaded job means
      // the pending record must STAY as the durable recovery anchor.
      const jobStillLoaded = await printJob(spec, recoveryRunCommand).catch(() => null);
      if (jobStillLoaded === null) {
        // The unload DID happen despite the error. At this point the on-disk
        // definition is still the PREVIOUS one (the destructive definition
        // swap happens after bootout), so bounded recovery within THIS call
        // is just: re-bootstrap the existing definition and verify the old
        // job is live again. Only a failed recovery may fall back to leaving
        // the pending record as the durable degraded anchor.
        try {
          // Deliberately bound to NO external signal: neither the forward
          // deadline (whose abort may be why bootout failed) nor the
          // caller's cancellation may stillborn the machine's chance to get
          // its previous carrier back. The raw runner's per-command timeout
          // keeps this bounded — a failed or exhausted recovery degrades to
          // the pending record.
          await recoveryRunCommand("/bin/launchctl", [
            "bootstrap",
            spec.domain,
            spec.definitionPath,
          ]);
          const recovered = await printJob(spec, recoveryRunCommand);
          const previousDispatcher = previousMarker?.dispatcherPath
            ?? dispatcherFromDefinition(
              (await readFile(spec.definitionPath, "utf8").catch(() => "")) ?? "",
              );
          if (
            recovered === null
            || !recovered.includes(spec.label)
            || (previousDispatcher !== null && !recovered.includes(previousDispatcher))
          ) {
            throw new Error("recovered job readback mismatch");
          }
          await rm(pendingReplacePath(spec.slockHome), { force: true });
          throw new ComputerServiceError(
            "HOST_LIFECYCLE_BOOTOUT_FAILED",
            "Raft Computer failed to unload the macOS post-login job, but the job was in fact unloaded. The previous login carrier was re-registered and verified live within this operation; nothing else was changed.",
            error,
          );
        } catch (recoveryError) {
          if (recoveryError instanceof ComputerServiceError) throw recoveryError;
          throw new ComputerServiceError(
            "HOST_LIFECYCLE_BOOTOUT_FAILED",
            "Raft Computer failed to unload the macOS post-login job, the job was in fact unloaded, AND re-registering the previous carrier failed. The login definition and owner marker are intact and the recovery record is kept; the next lifecycle command recovers from it.",
            recoveryError,
          );
        }
      }
      await rm(pendingReplacePath(spec.slockHome), { force: true });
      throw new ComputerServiceError(
        "HOST_LIFECYCLE_BOOTOUT_FAILED",
        "Raft Computer could not unload the current macOS post-login job to replace it. The existing login carrier was left untouched; nothing was changed.",
        error,
      );
    }
    destructiveStarted = true;
    // The owner marker is deliberately NOT removed here: it keeps describing
    // the previous carrier until the new one is registered and verified, so
    // any failure below still leaves a truthful last-known-good record.
    await rm(spec.definitionPath, { force: true });
    await mkdir(path.dirname(spec.definitionPath), { recursive: true, mode: 0o700 });
    await writeDurableTextFile(spec.definitionPath, spec.definition);
    if ((await readFile(spec.definitionPath, "utf8")) !== spec.definition) {
      throw new ComputerServiceError(
        "HOST_LIFECYCLE_DEFINITION_READBACK_FAILED",
        "Raft Computer could not verify the macOS post-login definition after writing it.",
      );
    }
    await forwardRunCommand("/bin/launchctl", [
      "bootstrap",
      spec.domain,
      spec.definitionPath,
    ]);
    const live = await printJob(spec, forwardRunCommand);
    if (
      live === null
      || !live.includes(spec.label)
      || !live.includes(spec.dispatcherPath)
    ) {
      throw new ComputerServiceError(
        "HOST_LIFECYCLE_READBACK_FAILED",
        "Raft Computer registered a macOS login job but could not read back the exact live label and dispatcher.",
      );
    }
    await writeMarker(spec.slockHome, targetMarker);
    await rm(pendingReplacePath(spec.slockHome), { force: true });
    return {};
  } catch (error) {
    if (rollback !== null && destructiveStarted) {
      await restorePreviousCarrier();
    } else if (rollback === null) {
      try {
        await removeCliCarrier(spec, runCommand);
      } catch (cleanupError) {
        throw new ComputerServiceError(
          "HOST_LIFECYCLE_READBACK_FAILED",
          "Raft Computer could not verify the new macOS login carrier, and cleanup could not prove that the unverified job was removed.",
          cleanupError,
        );
      }
    }
    if (forwardDeadline?.signal.aborted) {
      throw new ComputerServiceError(
        "HOST_LIFECYCLE_REFRESH_TIMEOUT",
        "Raft Computer stopped macOS login-carrier replacement before the shared K resume deadline and restored the last verified carrier.",
        error,
      );
    }
    if (error instanceof ComputerServiceError) throw error;
    throw new ComputerServiceError(
      "HOST_LIFECYCLE_REGISTRATION_FAILED",
      "Raft Computer could not register post-login recovery with launchd. The start operation was not reported as converged.",
      error,
    );
  } finally {
    forwardDeadline?.dispose();
  }
}

export async function convergeCliHostLifecycle(
  slockHome: string,
  desired: "enabled" | "disabled",
  deps: MacosHostLifecycleDeps = {},
): Promise<HostLifecycleConvergenceResult> {
  let current = await readHostLifecycleMarker(slockHome);
  const context = resolveMacosContext(slockHome, deps);
  if (context.spec === null) {
    return {
      owner: current?.owner ?? "cli",
      enabled: desired === "enabled",
      status: "not-applicable",
      label: null,
      definitionPath: null,
      definition: null,
    };
  }
  const spec = context.spec;
  const runCommand = bindCommandSignal(context.runCommand, deps.signal);
  const pending = await readPendingReplace(slockHome);
  if (pending !== null) {
    current = await recoverPendingReplace(spec, pending, runCommand);
  }
  if (current === null) {
    await assertNoMarkerlessLegacyDesktop(deps, runCommand);
  }
  if (current?.owner === "app") {
    await removeCliCarrier(spec, runCommand);
    await writeMarker(slockHome, {
      ...current,
      enabled: desired === "enabled",
    });
    return {
      owner: "app",
      enabled: desired === "enabled",
      status: "converged",
      label: null,
      definitionPath: null,
      definition: null,
    };
  }

  const marker: HostLifecycleMarker = {
    formatVersion: HOST_LIFECYCLE_FORMAT_VERSION,
    owner: "cli",
    enabled: desired === "enabled",
    dispatcherPath: spec.dispatcherPath,
    label: spec.label,
    definitionPath: spec.definitionPath,
  };
  let deferredRefresh: HostLifecycleConvergenceResult["deferredRefresh"];
  if (desired === "enabled") {
    ({ deferredRefresh } = await enableCliCarrier(
      spec,
      context.runCommand,
      current,
      marker,
      deps,
    ));
  } else {
    await removeCliCarrier(
      spec,
      bindCommandSignal(context.runCommand, deps.signal),
    );
    await writeMarker(slockHome, marker);
  }
  return {
    owner: "cli",
    enabled: marker.enabled,
    status: "converged",
    label: spec.label,
    definitionPath: spec.definitionPath,
    definition: spec.definition,
    ...(deferredRefresh ? { deferredRefresh } : {}),
  };
}

/** Rebind the persisted CLI carrier after K has proved the successor serves
 * the exact parked machine set. App-owned and disabled modes are intentionally
 * untouched: their lifecycle authority lives elsewhere. */
export async function refreshCliLoginCarrierIfOwned(
  slockHome: string,
  deps: MacosHostLifecycleDeps = {},
): Promise<void> {
  const platform = deps.platform ?? process.platform;
  if (platform !== "darwin") return;
  const marker = await readHostLifecycleMarker(slockHome);
  const pending = await readPendingReplace(slockHome);
  if (pending === null && (marker?.owner !== "cli" || !marker.enabled)) return;
  const hostDeps = { ...deps, platform, carrierMode: "refresh" as const };
  if (hostDeps.dispatcherPath === undefined) {
    hostDeps.dispatcherPath = resolveStableDispatcherPath(slockHome);
  }
  await convergeCliHostLifecycle(slockHome, "enabled", hostDeps);
}

export async function convergeAppHostLifecycle(
  slockHome: string,
  openAtLogin: boolean,
  deps: AppHostLifecycleDeps,
): Promise<HostLifecycleConvergenceResult> {
  let current = await readHostLifecycleMarker(slockHome);
  const context = resolveMacosContext(slockHome, deps);
  if (context.spec === null) {
    return {
      owner: "app",
      enabled: current?.enabled ?? true,
      status: "not-applicable",
      label: null,
      definitionPath: null,
      definition: null,
    };
  }
  const runCommand = bindCommandSignal(context.runCommand, deps.signal);
  const pending = await readPendingReplace(slockHome);
  if (pending !== null) {
    current = await recoverPendingReplace(context.spec, pending, runCommand);
  }
  await rm(markerPath(slockHome), { force: true });
  await removeCliCarrier(context.spec, runCommand);
  await deps.setOpenAtLogin(openAtLogin);
  const readback = await deps.getOpenAtLogin();
  if (readback !== openAtLogin) {
    throw new ComputerServiceError(
      "HOST_LIFECYCLE_APP_READBACK_FAILED",
      "Raft Desktop could not verify its Launch at login setting after writing it.",
    );
  }
  const marker: HostLifecycleMarker = {
    formatVersion: HOST_LIFECYCLE_FORMAT_VERSION,
    owner: "app",
    enabled: current?.enabled ?? true,
    dispatcherPath: null,
    label: null,
    definitionPath: null,
  };
  await writeMarker(slockHome, marker);
  return {
    owner: "app",
    enabled: marker.enabled,
    status: "converged",
    label: null,
    definitionPath: null,
    definition: null,
  };
}

export async function removeHostLifecycle(
  slockHome: string,
  deps: HostLifecycleRemovalDeps = {},
): Promise<HostLifecycleRemovalResult> {
  const current = await readHostLifecycleMarker(slockHome);
  if (current?.owner === "app") {
    if (!deps.setOpenAtLogin || !deps.getOpenAtLogin) {
      throw new ComputerServiceError(
        "HOST_LIFECYCLE_APP_OWNER_REQUIRED",
        "Raft Desktop owns Launch at login. Remove it through the Desktop uninstall path before deleting the host-lifecycle owner record.",
      );
    }
    await deps.setOpenAtLogin(false);
    if (await deps.getOpenAtLogin()) {
      throw new ComputerServiceError(
        "HOST_LIFECYCLE_APP_READBACK_FAILED",
        "Raft Desktop could not verify that Launch at login was removed.",
      );
    }
  }
  const context = resolveMacosContext(slockHome, deps);
  if (context.spec === null) {
    await rm(markerPath(slockHome), { force: true });
    return { status: "not-applicable", label: null, definitionPath: null };
  }
  await removeCliCarrier(
    context.spec,
    bindCommandSignal(context.runCommand, deps.signal),
  );
  await rm(markerPath(slockHome), { force: true });
  await rm(pendingReplacePath(slockHome), { force: true });
  if ((await readHostLifecycleMarker(slockHome)) !== null) {
    throw new ComputerServiceError(
      "HOST_LIFECYCLE_REMOVAL_FAILED",
      "Raft Computer could not remove its host-lifecycle owner record.",
    );
  }
  return {
    status: "removed",
    label: context.spec.label,
    definitionPath: context.spec.definitionPath,
  };
}
