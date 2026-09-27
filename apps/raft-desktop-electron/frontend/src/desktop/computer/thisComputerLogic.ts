// Pure decision logic for the "This Computer" self-card, extracted so it can be
// unit-tested / ablated. Each function takes an optional `ablate` flag that
// DISABLES a specific hardening fix — used by the ablation study to prove the
// fix reproduces a real defect when off. Defaults = all fixes ON.

export interface MachineLike {
  id: string;
  hostname: string | null;
  computerVersion?: string | null;
}

export interface UpgradeRecord {
  phase: string;
  percent: number | null;
  outcome: unknown | null;
  targetVersion: string;
  updatedAt?: string;
}

export interface ServiceState {
  running: boolean;
  version?: { version?: string | null } | null;
}

// The subset of the local host status the card reads (secret-free).
export interface ComputerStatusReport {
  servers?: { serverId: string; serverSlug: string | null }[];
  service?: ServiceState;
  upgrade?: UpgradeRecord | null;
  /** Mirror of the main-process ConvergeState (src/app/convergeState.ts). */
  converge?: { ok: boolean; code?: string; message?: string };
}

/** What the card should show about a failed host takeover, and the single
 *  recovery action it offers. Derived purely from the converge state. */
export interface ConvergeNotice {
  message: string;
  action: "recycle" | "start" | "retry-converge" | null;
}

const VERSION_SKEW_CODES = new Set(["SERVICE_VERSION_SKEW", "SERVICE_VERSION_SKEW_SUSPECT"]);

export function deriveConvergeNotice(converge: ComputerStatusReport["converge"]): ConvergeNotice | null {
  if (!converge || converge.ok) return null;
  const code = converge.code ?? "CONVERGE_FAILED";
  const message = converge.message ?? "Local Computer service takeover failed.";
  if (VERSION_SKEW_CODES.has(code)) {
    // A resident from a different install refuses adoption; only a real
    // stop→start recycle replaces it (the card's Restart clears degraded
    // state only). The card confirms before recycling — it offlines every
    // agent on this machine.
    return { message: `Local service not hosted by this app — ${message}`, action: "recycle" };
  }
  if (code === "RECYCLE_START_FAILED") {
    // The old service is already stopped; retry must be start-only.
    return { message, action: "start" };
  }
  return { message, action: "retry-converge" };
}

/** Numeric dotted-version compare: is `a` strictly newer than `b`? */
export function isNewer(a: string | null, b: string | null): boolean {
  if (!a || !b) return false;
  const pa = a.replace(/^v/, "").split(".").map((n) => parseInt(n, 10) || 0);
  const pb = b.replace(/^v/, "").split(".").map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d !== 0) return d > 0;
  }
  return false;
}

// An in-flight upgrade record is only "live" for a bounded window; a service
// that died mid-upgrade leaves outcome:null forever, so without the bound the
// card would show "Updating…" (hiding all controls) indefinitely.
export const UPGRADE_STALE_MS = 10 * 60 * 1000;
export function isUpgradeLive(
  u: UpgradeRecord,
  now: number = Date.now(),
  ablate?: { staleBound?: boolean },
): boolean {
  if (u.outcome) return false;
  if (ablate?.staleBound === false) return true; // #3 OFF: no staleness bound
  if (!u.updatedAt) return true;
  const t = Date.parse(u.updatedAt);
  return Number.isNaN(t) || now - t < UPGRADE_STALE_MS;
}

/**
 * Which machineStore row is THIS machine (fix #2). machineId is authoritative;
 * hostname is used ONLY when it uniquely identifies a machine.
 * ablate.uniqueHostname=false → first-match (the defect: duplicate/default
 * hostnames bind to an arbitrary other machine).
 */
export function correlateSelfMachine<T extends MachineLike>(
  machines: readonly T[],
  localMachineIds: readonly string[],
  hostname: string | null,
  ablate?: { uniqueHostname?: boolean },
): T | null {
  for (const id of localMachineIds) {
    const match = machines.find((m) => m.id === id);
    if (match) return match;
  }
  if (hostname) {
    const matches = machines.filter((m) => m.hostname != null && m.hostname === hostname);
    if (ablate?.uniqueHostname === false) return matches[0] ?? null; // #2 OFF
    if (matches.length === 1) return matches[0];
  }
  return null;
}

export interface ControlsInput {
  service?: ServiceState;
  upgrade?: UpgradeRecord | null;
  latestVersion: string | null;
  serverVersion: string | null;
  // "app": the Computer ships with this app, so a newer standalone release is
  // never an update for it.
  managementModel?: ManagementModel;
}

export interface AblationFlags {
  staleBound?: boolean; // #3
  localVersionCompare?: boolean; // #5
  rolledBackHide?: boolean; // #6
}

export interface Controls {
  running: boolean;
  upgrading: UpgradeRecord | null;
  updateAvailable: boolean;
  localVersion: string | null;
}

// ── Upgrade routing (desktop advantage: the app EXECUTES upgrades) ───────────
// The local computer can be managed three ways, each with a different upgrade
// path. The user sees one [Update]; this picks the route.
export type ManagementModel = "app" | "standalone" | "unknown";
export type UpdateAction = "none" | "remote" | "fresh-install";

export interface UpdateRouteInput {
  managementModel: ManagementModel;
  // Server broadcast-policy eligibility for a remote (self) upgrade, or null when
  // the machine carries no policy.
  eligibility: "eligible" | "no_broadcast" | null;
  // isNewer(latest, local) on the computer plane.
  updateAvailable: boolean;
}

/**
 * Route the single [Update] action for the local computer:
 *  - "app": the computer binary IS this app (embedded); it upgrades WITH the app
 *    via the electron updater (the top-bar "restart to update" pill), so the
 *    computer plane offers no separate button → "none".
 *  - "standalone"/"unknown" + a newer version:
 *      - server says "eligible" → "remote" (tryUpgradeViaService self-upgrade),
 *      - else ("no_broadcast" / unknown) → "fresh-install": the app runs the
 *        official installer itself (what web can only show as a shell command).
 */
export function routeUpdateAction(input: UpdateRouteInput): UpdateAction {
  if (input.managementModel === "app") return "none";
  if (!input.updateAvailable) return "none";
  // Remote self-upgrade is non-destructive (routes to the running service), so
  // it's safe even when the model is "unknown".
  if (input.eligibility === "eligible") return "remote";
  // Fresh install PROVISIONS A STANDALONE binary — running it on an app-embedded
  // computer forks a competing owner. So only take it for a CONFIRMED standalone;
  // if management is "unknown" (service momentarily unreachable), do nothing
  // rather than risk a destructive install on the wrong kind of computer.
  return input.managementModel === "standalone" ? "fresh-install" : "none";
}

/** The official installer one-liner (shown only as the last-resort manual
 *  fallback if the app-run fresh install fails). Mirrors the web command. */
export function freshInstallCommand(version: string, baseUrl = "https://cdn.raft.build/computer"): string {
  return `curl -fsSL ${baseUrl}/install.sh | RAFT_COMPUTER_VERSION=${version} sh`;
}

export function deriveControls(input: ControlsInput, now: number = Date.now(), ablate?: AblationFlags): Controls {
  const { service, upgrade, latestVersion, serverVersion } = input;
  const upgrading = upgrade && isUpgradeLive(upgrade, now, { staleBound: ablate?.staleBound }) ? upgrade : null;
  const running = service?.running ?? true;

  // #5: compare the CDN latest against the LOCAL running service version (fresh),
  // falling back to the server row. OFF → compare against the (stale) server row.
  const localVersion =
    ablate?.localVersionCompare === false
      ? serverVersion
      : service?.version?.version ?? serverVersion ?? null;

  // #6: don't offer a version that already rolled back on THIS machine (no-op).
  const rolledBackToLatest =
    ablate?.rolledBackHide === false
      ? false
      : upgrade?.outcome === "rolled-back" && upgrade.targetVersion === latestVersion;

  const appManaged = input.managementModel === "app";
  const updateAvailable = !appManaged && !upgrading && !rolledBackToLatest && isNewer(latestVersion, localVersion);
  return { running, upgrading, updateAvailable, localVersion };
}
