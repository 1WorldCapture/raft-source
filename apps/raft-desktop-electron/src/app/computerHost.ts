// ComputerHost — the ONLY place in the desktop main process that touches
// `@botiverse/raft-computer/lib` (aside from the `__service`/`__run` argv guard
// in index.ts). It makes this app the OS-supervised host of the local Computer
// service without becoming the runtime owner: the heavy `__service`/`__run`
// daemon tree is detached; real app quit explicitly stops its verified tree. This module only *controls* it (converge lifecycle,
// attach, start/stop) and *observes* it (status polling), exactly the surface
// the CLI drives.
//
// Identity unification (the elegant core): the standalone Computer flow needs a
// separate device-code login because it has no session of its own. This app is
// already authenticated for chat, so we bridge the renderer's existing chat
// tokens into the lib's shared `user-session.json` (the exact on-disk shape
// `services/login.ts` writes). Then `api.attach(...)` — whose auth path reads
// that session via `ensureUsableUserSession` — just works, with no second login.

import { execFile } from "node:child_process";
import { mkdir, readFile, readdir, realpath, rename, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { app } from "electron";
import {
  connectService,
  convergeAppHostLifecycle,
  rebindParentEvidence,
  readProcessStartTime,
  createComputerApi,
  DEFAULT_UPGRADE_BASE_URL,
  fetchCdnLatestVersion,
  resolveRaftHome,
  userSessionPath,
  listServerAttachments,
  serversDir,
  canonicalizeServerUrl,
  type AttachResult,
  type ComputerApi,
  type ComputerStatusReport,
} from "@botiverse/raft-computer/lib";
import { createUpgradeInfoReader } from "../main/upgradeInfo.js";
import { cleanupLegacyLoginAgents, getLoginItemAtLogin, setLoginItemAtLogin } from "../main/loginItem.js";
import { isValidEnableInput, type EnableComputerInput } from "./enableInput.js";
import {
  checkSessionOrigin,
  describeSessionOriginMismatch,
  SESSION_ORIGIN_MISMATCH_CODE,
} from "./sessionOriginGuard.js";
import { reduceConvergeFailure, type ConvergeState } from "./convergeState.js";
import { ComputerProcessScope, readComputerProcesses, type ComputerProcessSnapshot } from "../main/computerProcesses.js";
import { connectDeployment, readDeploymentSelection, type DeploymentConnectionPlan } from "./deploymentConnection.js";
import { CONFIGURED_API_ORIGIN, OFFICIAL_API_ORIGINS } from "./configuredApiOrigin.js";
import { runServiceRecycle } from "./serviceRecycle.js";

// Mirrors `paths.ts` CURRENT_SCHEMA_VERSION (readers tolerate a missing value,
// but we stamp it like login.ts does).
const USER_SESSION_SCHEMA_VERSION = 1;

// A fresh install downloads + verifies + swaps a binary and restarts the
// resident; give it a generous ceiling but never hang forever.
const FRESH_INSTALL_TIMEOUT_MS = 5 * 60 * 1000;

/**
 * Is `exe` this app's own executable (i.e. an app-embedded Computer)? The
 * embedded service re-execs `process.execPath`; a standalone lives elsewhere
 * (~/.local/bin/raft-computer or a K slot). Matches the exact path or the same
 * `.app` bundle so the packaged app's helper paths still count as embedded.
 */
function isAppBundledExecutable(exe: string): boolean {
  const appExe = process.execPath;
  if (exe === appExe) return true;
  const marker = ".app/Contents/";
  const idx = appExe.indexOf(marker);
  if (idx < 0) return false; // non-.app layout (dev linux): only exact match is embedded
  return exe.startsWith(appExe.slice(0, idx + 4)); // shared ".app" bundle root
}

// A secret-free host state snapshot for the renderer. Never carries apiKeys.
export interface ComputerHostSnapshot {
  hostCapable: true;
  status: ComputerStatusReport | null;
}

class ComputerHost {
  /** Shared with the quit orchestration (task #7) to locate pidfiles. */
  slockHome: string;
  processScope: ComputerProcessScope;
  readonly readProcesses: () => Promise<ComputerProcessSnapshot>;
  private api: ComputerApi;
  private readonly configuredOrigin: string;
  private connecting = false;
  private controlInFlight = 0;
  private connectionSettled: Promise<void> = Promise.resolve();
  private selectionError: Error | null = null;
  private readonly storageDirectory: string;
  private readonly signalProcess: (pid: number, signal: NodeJS.Signals) => void;
  constructor(options: { home?: string; configuredOrigin?: string; readProcesses?: () => Promise<ComputerProcessSnapshot>; storageDirectory?: string; signalProcess?: (pid: number, signal: NodeJS.Signals) => void } = {}) {
    this.signalProcess = options.signalProcess ?? ((pid, signal) => process.kill(pid, signal));
    this.slockHome = options.home ?? resolveRaftHome();
    this.configuredOrigin = options.configuredOrigin ?? CONFIGURED_API_ORIGIN;
    this.storageDirectory = options.storageDirectory ?? `${app.getPath("userData")}/computer-deployments`;
    this.processScope = new ComputerProcessScope(this.slockHome);
    this.readProcesses = options.readProcesses ?? (() => readComputerProcesses(this.slockHome));
    this.api = createComputerApi(this.slockHome, { hostLifecycleOwner: "app" });
  }
  private readonly readUpgradeInfo = createUpgradeInfoReader(
    // Resolved per call: the official CDN for official origins, the
    // deployment's own downloads tree otherwise (phase 3-1 — a private
    // desktop must make zero official egress for version checks).
    () => fetchCdnLatestVersion(this.upgradeBase()),
  );

  /**
   * The manifest base this host's upgrade checks read. Official origins
   * keep the historical CDN byte-for-byte; a runtime-configured private
   * origin reads its own `/downloads/computer` tree (same shape the
   * standalone installer and the service-side server backend consume).
   */
  private upgradeBase(): string {
    return OFFICIAL_API_ORIGINS.has(this.configuredOrigin)
      ? DEFAULT_UPGRADE_BASE_URL
      : `${this.configuredOrigin}/downloads/computer`;
  }
  private lastStatus: ComputerStatusReport | null = null;
  /**
   * Outcome of the app-ready host converge (and of later recycle attempts),
   * surfaced through getStatus() so the renderer can explain WHY the local
   * Computer isn't hosted by this app — e.g. a version-skewed resident that
   * start() refuses to adopt. null until the first converge settles.
   */
  private convergeState: ConvergeState | null = null;

  /**
   * Converge the app-owned host lifecycle (this app becomes the login item that
   * owns "launch at login"; any CLI-owned launchd carrier is removed), then, if
   * launch-at-login is on and there is already an attachment, boot the detached
   * service. Called once at app-ready. Failures are returned, not thrown, so a
   * lifecycle hiccup never blocks the chat app from starting — but they ARE
   * recorded in convergeState for the renderer.
   */
  /**
   * Fail-closed takeover gate: a persisted session in this state root that
   * belongs to a DIFFERENT deployment (origin ≠ the build's baked
   * CONFIGURED_API_ORIGIN) must never be adopted, stopped, or recycled by
   * this app — the 2026-10-02 incident had a self-hosted build drive a
   * leftover session (and a sibling state root) it had no business touching.
   */
  private async sessionOriginMismatch(): Promise<string | null> {
    const check = await checkSessionOrigin(this.slockHome, this.configuredOrigin);
    if (check.status === "ok" || check.status === "none") return null;
    return describeSessionOriginMismatch(check);
  }

  private selectHome(home: string): void {
    this.slockHome = home;
    this.processScope = new ComputerProcessScope(home);
    this.api = createComputerApi(home, { hostLifecycleOwner: "app" });
    this.lastStatus = null;
  }

  async restoreSelection(): Promise<void> {
    try {
      const selected = await readDeploymentSelection(this.storageDirectory, this.configuredOrigin);
      if (selected) this.selectHome(selected);
    } catch {
      this.selectionError = Object.assign(new Error("无法读取桌面 Computer 状态目录选择，请通过连接当前部署恢复；原服务未接管。"), { code: SESSION_ORIGIN_MISMATCH_CODE });
    }
  }

  async connectCurrentDeployment(deps: {
    confirm(plan: DeploymentConnectionPlan): Promise<boolean>;
    authenticate(home: string, origin: string): Promise<void>;
    targetUserId?: string;
    signal?: AbortSignal;
  }): Promise<void> {
    if (this.connecting) throw new Error("正在连接当前部署，请完成或取消本次认证。");
    if (this.controlInFlight > 0) throw new Error("Computer 正在处理操作，请完成后再连接当前部署。");
    this.connecting = true;
    let settle!: () => void;
    this.connectionSettled = new Promise<void>((resolve) => { settle = resolve; });
    try {
      const check = await checkSessionOrigin(this.slockHome, this.configuredOrigin);
      const status = await this.api.getStatus();
      const selected = await connectDeployment({
        currentOrigin: check.sessionOrigin ?? (check.status === "ok" ? this.configuredOrigin : "未知"),
        targetOrigin: this.configuredOrigin,
        currentHome: this.slockHome,
        storageDirectory: this.storageDirectory,
        connections: status.servers.map((server) => server.serverId),
        targetUserId: deps.targetUserId,
      }, deps);
      if (selected) {
        this.selectHome(selected);
        this.selectionError = null;
        // Authentication does not start a service or transfer any attachments.
        this.convergeState = { ok: true };
      }
    } finally { this.connecting = false; settle(); }
  }

  /**
   * While set and returning a message, every control operation (start/stop/restart/recycle/converge/enable/upgrade,
   * whoever calls it: IPC, converge, retry) is refused. The one-click migration uses it so nothing can restart the
   * service in the home that is being moved. Quit attempts are never gated.
   */
  private controlGate: (() => string | null) | null = null;
  setControlGate(gate: (() => string | null) | null): void { this.controlGate = gate; }

  private async control<T>(operation: () => Promise<T>): Promise<T> {
    const blocked = this.controlGate?.();
    if (blocked) throw new Error(blocked);
    return this.track(operation);
  }

  private async track<T>(operation: () => Promise<T>): Promise<T> {
    this.controlInFlight++;
    try { return await operation(); }
    finally { this.controlInFlight--; }
  }

  async waitForConnection(): Promise<void> { await this.connectionSettled; }

  async runQuitAttempt(attempt: () => Promise<boolean>): Promise<boolean> {
    // Keep the selected root stable through confirmation and the full ladder,
    // including the window after stop() has returned but tools remain alive.
    return this.track(attempt);
  }

  async assertCanControl(): Promise<void> {
    if (this.connecting) throw new Error("正在连接当前部署，请完成或取消认证后再操作 Computer。");
    if (this.selectionError) throw this.selectionError;
    const mismatch = await this.sessionOriginMismatch();
    if (mismatch !== null) throw Object.assign(new Error(mismatch), { code: SESSION_ORIGIN_MISMATCH_CODE });
    this.processScope.assertRoots(await this.readProcesses());
  }

  /** Origin mismatch means this GUI never adopted the existing Computer. */
  async canShutdown(): Promise<boolean> {
    return !this.selectionError && (await this.sessionOriginMismatch()) === null;
  }

  async converge(): Promise<{ ok: boolean; error?: string }> {
    return this.control(() => this.convergeInternal());
  }

  private async convergeInternal(): Promise<{ ok: boolean; error?: string }> {
    try {
      const mismatch = await this.sessionOriginMismatch();
      if (mismatch !== null) {
        // Block BEFORE any lifecycle action — no login-item convergence, no
        // service stop/start, nothing that touches the foreign session.
        this.convergeState = { ok: false, code: SESSION_ORIGIN_MISMATCH_CODE, message: mismatch };
        return { ok: false, error: mismatch };
      }

      await this.assertCanControl();

      // Task #7 login item: on macOS the login start is OUR LaunchAgent
      // running `open -a "Raft Desktop" --args --hidden` (the OS-native
      // setLoginItemSettings cannot carry args there, and wasOpenedAtLogin is
      // unverifiable without a real login). Also sweeps away the legacy
      // headless-service login items the old carrier registered.
      if (process.platform === "darwin") {
        const cleanup = await cleanupLegacyLoginAgents((dir) => readdir(dir), {
          readFile,
          rm,
          ownExecutablePath: process.execPath,
          ownSlockHome: this.slockHome,
        });
        for (const skipped of cleanup.skipped) {
          console.warn(`[raft-desktop] left foreign login item ${skipped.label} alone: ${skipped.reason}`);
        }
      }
      const lifecycle = await convergeAppHostLifecycle(
        this.slockHome,
        process.platform === "darwin" ? await getLoginItemAtLogin() : app.getLoginItemSettings().openAtLogin,
        {
          // The stable app-bundle executable is the dispatcher: the `__service`/
          // `__run` re-exec relaunches this binary and the argv guard routes it.
          dispatcherPath: process.execPath,
          setOpenAtLogin: process.platform === "darwin"
            ? (enabled: boolean) => setLoginItemAtLogin(enabled)
            : (enabled: boolean) => app.setLoginItemSettings({ openAtLogin: enabled }),
          getOpenAtLogin: process.platform === "darwin"
            ? () => getLoginItemAtLogin()
            : () => app.getLoginItemSettings().openAtLogin,
        },
      );
      if (lifecycle.enabled) {
        const status = await this.api.getStatus();
        this.lastStatus = status;
        if (status.servers.length > 0) {
          await this.sweepOrphansBeforeStart();
          await this.api.start({ serverId: null, serverLabel: null });
        }
        // Task #7 anti-orphan: whether we spawned the tree or adopted an
        // existing one, its watchdog binding must name THIS GUI — the recorded
        // parent of an adopted tree still points at the previous GUI pid, and
        // without this rewrite the tree's own watchdog would kill it. Best
        // effort: a failed rebind never blocks the chat app.
        if (status.service.running) {
          try {
            const startedAt = await readProcessStartTime(process.pid);
            if (startedAt) {
              await rebindParentEvidence(this.slockHome, { parentPid: process.pid, parentStartedAt: startedAt });
            }
          } catch {
            // Missing evidence file or a busy rename — next converge retries.
          }
        }
      }
      this.convergeState = { ok: true };
      return { ok: true };
    } catch (error) {
      const failure = reduceConvergeFailure("Local Computer service takeover failed: ", error);
      this.convergeState = { ok: false, ...failure };
      return { ok: false, error: failure.message };
    }
  }

  async getStatus(): Promise<ComputerStatusReport & { converge?: ConvergeState; controlHome: string }> {
    const status = await this.api.getStatus();
    this.lastStatus = status;
    // converge rides the existing status snapshot — no new IPC channel. It is
    // omitted while null so pre-converge frames look exactly like before.
    return { ...status, controlHome: this.slockHome, ...(this.convergeState === null ? {} : { converge: this.convergeState }) };
  }

  /**
   * One-click "make this computer available for <server>" using the caller's
   * existing chat session — no device-code login. Writes the shared user session
   * from the passed tokens, attaches, then starts the service for the new server.
   */
  async enable(input: EnableComputerInput): Promise<AttachResult> {
    return this.control(() => this.enableInternal(input));
  }

  private async enableInternal(input: EnableComputerInput): Promise<AttachResult> {
    // Validate BEFORE touching the shared session on disk — never overwrite a
    // working session with an empty/garbage one from a malformed call.
    if (!isValidEnableInput(input)) throw new Error("enable_missing_fields");
    let inputOrigin: string | null = null;
    try { inputOrigin = new URL(input.serverUrl).origin; } catch { /* invalid URL */ }
    if (inputOrigin !== this.configuredOrigin) {
      throw Object.assign(new Error(`请登录当前部署 ${this.configuredOrigin} 后启用这台计算机。`), { code: SESSION_ORIGIN_MISMATCH_CODE });
    }
    await this.assertCanControl();
    // Existing device authorization remains authoritative. Web tokens must
    // never replace a saved Computer identity, including after recovery.
    const sessionCheck = await checkSessionOrigin(this.slockHome, this.configuredOrigin);
    if (sessionCheck.status === "none") {
      await this.writeUserSession(input);
    } else {
      const saved = JSON.parse(await readFile(userSessionPath(this.slockHome), "utf8")) as { userId?: unknown };
      if (input.userId && saved.userId !== input.userId) {
        const message = "本地 Computer 授权账号与当前桌面账号不同，请连接当前部署并用当前账号认证；原会话和挂载会保留。";
        this.convergeState = { ok: false, code: SESSION_ORIGIN_MISMATCH_CODE, message };
        throw Object.assign(new Error(message), { code: SESSION_ORIGIN_MISMATCH_CODE });
      }
    }
    // One home, one origin (phase 3-1, PM-approved): before attaching THIS
    // deployment, archive any attachment from a different origin. This is
    // the only point where the invariant can break (a fresh per-origin
    // root cannot hold foreign attachments; the session-origin guard
    // blocks the shared-root path unless no session exists). Fail the
    // enable rather than create a home the upgrade source resolution
    // would later refuse as AMBIGUOUS.
    await this.archiveForeignAttachments();
    const attached = await this.api.attach({
      serverSlug: input.serverSlug,
      serverUrl: input.serverUrl,
      ...(input.name ? { name: input.name } : {}),
    });
    // Boot (or converge) the detached service so the just-attached server gets a
    // running daemon child.
    await this.api.start({ serverId: attached.serverId, serverLabel: input.serverSlug });
    this.convergeState = { ok: true };
    return attached;
  }

  async start(): Promise<void> {
    return this.control(() => this.startInternal());
  }

  /**
   * A service that died (or was killed with the app) can leave its runners behind as orphans. A new service started
   * over them never gets a runner of its own (the orphan keeps the slot and the server connection). So before the
   * service is started, any process of THIS home that is still alive while its service is not is swept with the
   * verified shutdown ladder (identity re-read before every signal). Anything that cannot be verified stops the start.
   */
  private async sweepOrphansBeforeStart(): Promise<void> {
    // Cheap pre-filter: no __service/__run process on the machine at all, nothing to look at.
    const snapshot = await this.readProcesses();
    if (!snapshot.rows.some((row) => row.root)) return;
    // Attribution 1: the Computer's own, which knows EVERY spelling of the home (realpath, as configured, the
    // ~/.slock-raft alias) by looking at each process's argv/env. One spelling is not enough: a live service launched
    // with the alias spelling must count as alive even if the host was restored with the realpath.
    const lib = await import("@botiverse/raft-computer/lib");
    const real = await realpath(this.slockHome).catch(() => this.slockHome);
    const aliasPath = join(homedir(), ".slock-raft");
    const alias = (await realpath(aliasPath).catch(() => null)) === real ? aliasPath : null;
    // macOS: /tmp, /var and /etc are symlinks into /private; a process may carry either spelling.
    const variants = new Set<string>([real, this.slockHome]);
    for (const p of [...variants]) {
      if (/^\/private\/(tmp|var|etc)(\/|$)/.test(p)) variants.add(p.slice("/private".length));
      else if (/^\/(tmp|var|etc)(\/|$)/.test(p)) variants.add(`/private${p}`);
    }
    const spellings = [...new Set([...lib.homeProcessSpellings(real, this.slockHome, alias), ...variants])];
    const found = await lib.defaultScanHomeProcesses(spellings);
    // Attribution 2: this home's own pidfiles (service.pid, servers/*/runner.pid). A process the home's pidfile names,
    // that really is a __service/__run and is not claimed by a DIFFERENT home, is this home's even when its env/argv
    // spelling could not be read (the drill-290-anna ②a retest: the sweep matched nothing and the orphan was adopted).
    const attested = snapshot.rows.filter((row) => row.root && snapshot.rootPids.includes(row.pid) && row.pid !== process.pid && (row.home === this.processScope.home || (row.home !== null && spellings.includes(row.home))));
    const serviceAlive = found.some((proc) => proc.kind === "service") || attested.some((row) => /(?:^|\s)__service(?:\s|$)/.test(row.command));
    if (serviceAlive) return; // a live service: its runners are its own
    if (found.length === 0 && attested.length === 0) return;
    if (found.length === 0) {
      console.warn(`[raft-desktop] orphan sweep: no process matched the home spellings ${JSON.stringify(spellings)}, but ${attested.length} pidfile-attested process(es) belong to it: ${attested.map((row) => `${row.pid}(home=${row.home ?? "unknown"})`).join(", ")}`);
    }
    const left = found.length > 0 ? await lib.sweepHomeProcesses(spellings) : [];
    // Whatever the home's pidfiles still name after the spelling-based sweep: verified TERM → KILL (identity re-read).
    const stillAttested = async () => {
      const fresh = await this.readProcesses();
      return attested.filter((row) => fresh.rows.some((now) => now.pid === row.pid && now.lstart === row.lstart && now.command === row.command));
    };
    let remaining = await stillAttested();
    for (const [signal, waitMs] of [["SIGTERM", 5_000], ["SIGKILL", 2_000]] as const) {
      if (remaining.length === 0) break;
      for (const row of remaining) { try { this.signalProcess(row.pid, signal); } catch { /* already gone */ } }
      const deadline = Date.now() + waitMs;
      while (remaining.length > 0 && Date.now() < deadline) { await new Promise((resolve) => setTimeout(resolve, 250)); remaining = await stillAttested(); }
    }
    if (left.length > 0 || remaining.length > 0) throw new Error("This Computer left processes behind that could not be cleaned up, so it was not started. Quit the app and try again.");
  }

  private async startInternal(): Promise<void> {
    await this.assertCanControl();
    await this.sweepOrphansBeforeStart();
    await this.api.start({ serverId: null, serverLabel: null });
    // Any action that leaves the local service running clears a stale
    // converge/recycle failure notice (e.g. the start-only retry offered after
    // RECYCLE_START_FAILED) — otherwise the notice would linger until restart.
    this.convergeState = { ok: true };
  }

  async stop(signal?: AbortSignal): Promise<void> {
    return this.control(() => this.stopInternal(signal));
  }

  /** The migration's own hand-over stop: it IS the migration, so it is not subject to the migration control gate. */
  async stopForMigrationHandOver(signal?: AbortSignal): Promise<void> {
    return this.track(() => this.stopInternal(signal));
  }

  private async stopInternal(signal?: AbortSignal): Promise<void> {
    await this.assertCanControl();
    const expected = this.processScope.observe(await this.readProcesses());
    await this.api.stop(undefined, {
      signal,
      killService: async (pid) => {
        const identity = expected.find((row) => row.pid === pid && row.root);
        const current = (await this.readProcesses()).rows.find((row) => row.pid === pid);
        if (!identity || !this.processScope.matches(identity, current)) {
          throw new Error(`进程 ${pid} 的归属或启动身份已变化，未发送停止信号。`);
        }
        signal?.throwIfAborted();
        process.kill(pid, "SIGTERM");
      },
    });
  }

  /** Bring a degraded service back (the reference app's "restart"). */
  async restart(): Promise<void> {
    return this.control(() => this.restartInternal());
  }

  private async restartInternal(): Promise<void> {
    await this.assertCanControl();
    await this.api.resetService();
  }

  /**
   * Recycle the local service for real: stop it, confirm it exited, then start
   * it from THIS app — the remedy for a version-skewed resident that
   * converge/start refuses to adopt (the card's "Restart" only clears
   * degraded state and never restarts the process). Disruptive: agents on this
   * machine go offline briefly; the renderer confirms before invoking.
   * Failures surface through the same convergeState channel (a failed start
   * leaves the machine stopped, so the retry must be start-only).
   */
  async recycleService(): Promise<void> {
    return this.control(() => this.recycleServiceInternal());
  }

  private async recycleServiceInternal(): Promise<void> {
    await this.assertCanControl();
    await runServiceRecycle({
      stop: async () => {
        await this.stop();
      },
      start: async () => {
        await this.api.start({ serverId: null, serverLabel: null });
      },
      isCleared: async () => {
        try {
          const status = await this.api.getStatus();
          return status.service?.running !== true;
        } catch {
          // An unreachable service reports nothing — treat as cleared; start()
          // will surface any real problem.
          return true;
        }
      },
      delay: (ms) => new Promise<void>((resolve) => setTimeout(resolve, ms)),
      settle: (state) => {
        this.convergeState = state;
      },
    });
  }

  /** Re-run the startup host converge (the generic failure retry path). */
  async retryConverge(): Promise<void> {
    await this.converge();
  }

  /** The latest Computer version on the CDN (null if unreachable). The renderer
   *  compares it to the running service version to decide whether to offer an
   *  update — a local check, no server rollout dependency. */
  async getUpgradeInfo(): Promise<{ latestVersion: string | null }> {
    return this.readUpgradeInfo();
  }

  /**
   * Upgrade THIS machine's local service to the CDN's latest version — a local
   * action (same plane as start/stop/restart), routed to the running service
   * over local IPC. The service performs the download/verify/apply/restart and
   * reports progress through getStatus().upgrade (polled + pushed to the card).
   */
  async upgrade(): Promise<void> {
    return this.control(() => this.upgradeInternal());
  }

  private async upgradeInternal(): Promise<void> {
    await this.assertCanControl();
    const latest = await fetchCdnLatestVersion(this.upgradeBase());
    if (!latest) throw new Error("no_update_available");
    const result = await this.api.tryUpgradeViaService(latest, undefined, { trigger: "tray" });
    if (!result.routed) {
      throw new Error(result.reason === "no-service" ? "service_not_running" : "service_unreachable");
    }
  }

  /**
   * How the local Computer is managed, so the renderer can route [Update]:
   *  - "app": the live service binary IS this app's executable (the __service
   *    argv guard re-execs process.execPath) → it upgrades WITH the app.
   *  - "standalone": an external raft-computer (a PATH install or a K slot) the
   *    app only controls → remote self-upgrade or fresh-install.
   *  - "unknown": the service didn't attest a path (not reachable / older).
   * Authoritative signal: the live service self-reports its executable path via
   * the machine-attestation IPC (never release metadata).
   */
  async getManagement(): Promise<{ model: "app" | "standalone" | "unknown" }> {
    try {
      const client = await connectService(this.slockHome);
      try {
        const attestation = await client.request("machine-attestation", undefined);
        const exe = typeof attestation.serviceExecutablePath === "string" ? attestation.serviceExecutablePath : "";
        if (!exe) return { model: "unknown" };
        return { model: isAppBundledExecutable(exe) ? "app" : "standalone" };
      } finally {
        await client.close();
      }
    } catch {
      return { model: "unknown" };
    }
  }

  /**
   * Fresh-install a specific published version via the OFFICIAL installer, then
   * let the installer restart the resident onto it. This is the desktop-executed
   * fallback for a STANDALONE computer whose source can't remote self-upgrade —
   * exactly what the web can only show as a copy-paste shell command, run by the
   * app instead. Mirrors the web command (no install-dir override → the standard
   * ~/.local/bin, where the CLI installer puts the binary).
   *
   * MUST NOT be called for an app-embedded computer (the router guards on the
   * management model): the installer provisions a STANDALONE binary and would
   * fork a second, competing owner. We also deliberately do NOT call
   * api.resetService() afterward — that would re-exec the APP binary and undo the
   * standalone install; install.sh restarts the resident onto the new bytes.
   */
  async upgradeViaFreshInstall(version: string): Promise<void> {
    return this.control(() => this.upgradeViaFreshInstallInternal(version));
  }

  private async upgradeViaFreshInstallInternal(version: string): Promise<void> {
    await this.assertCanControl();
    if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.]+)?$/.test(version)) throw new Error("bad_version");
    // Defense in depth at the execution boundary (the renderer router already
    // guards): the installer provisions a STANDALONE binary, so refuse unless we
    // can CONFIRM this computer is standalone. "app" would fork a competing
    // owner; "unknown" (service unreachable) is not a confirmation.
    const { model } = await this.getManagement();
    if (model !== "standalone") throw new Error("not_standalone_computer");
    const command = `curl -fsSL ${this.upgradeBase()}/install.sh | RAFT_COMPUTER_VERSION=${version} sh`;
    await new Promise<void>((resolve, reject) => {
      execFile("/bin/sh", ["-c", command], {
        timeout: FRESH_INSTALL_TIMEOUT_MS,
        env: { ...process.env, RAFT_HOME: this.slockHome, SLOCK_HOME: this.slockHome },
      }, (error, _stdout, stderr) => {
        if (error) reject(new Error(`fresh_install_failed: ${String(stderr || error.message).slice(0, 400)}`));
        else resolve();
      });
    });
  }

  /**
   * Archive (not delete — reversible by design) every attachment under the
   * current home that belongs to a DIFFERENT origin: move
   * `servers/<serverId>/` into a sibling `servers-retired-<id>/` directory.
   * The computer only scans `servers/`, so the retired entries stop
   * existing for it while their bytes (credentials, machine identity)
   * remain restorable by moving them back.
   */
  private async archiveForeignAttachments(): Promise<void> {
    const currentOrigin = canonicalizeServerUrl(this.configuredOrigin);
    const foreign = (await listServerAttachments(this.slockHome))
      .filter((attachment) => canonicalizeServerUrl(attachment.serverUrl) !== currentOrigin);
    if (foreign.length === 0) return;
    const retiredRoot = join(dirname(serversDir(this.slockHome)), `servers-retired-${Date.now()}`);
    await mkdir(retiredRoot, { recursive: true, mode: 0o700 });
    for (const attachment of foreign) {
      await rename(join(serversDir(this.slockHome), attachment.serverId), join(retiredRoot, attachment.serverId));
    }
    console.warn(
      `[raft-desktop] archived ${foreign.length} foreign-origin attachment(s) to ${retiredRoot} before attaching ${currentOrigin}`,
    );
  }

  // Write the lib's shared `user-session.json` from the renderer's chat tokens,
  // in the exact shape `services/login.ts` writes (kind/schemaVersion/tokens/
  // serverUrl + identity), mode 0600. This is what makes `api.attach`
  // authenticate as the already-signed-in human without a second login.
  //
  // ATOMIC (temp file + rename), matching lib/userSession.ts, because the live
  // detached service reads/refreshes this same file concurrently — a bare
  // writeFile could expose a truncated file mid-write and log the service out.
  private async writeUserSession(input: EnableComputerInput): Promise<void> {
    const file = userSessionPath(this.slockHome);
    await mkdir(dirname(file), { recursive: true });
    const body = JSON.stringify(
      {
        kind: "user-session",
        schemaVersion: USER_SESSION_SCHEMA_VERSION,
        // Identity so ComputerStatusReport.userId/userName/userEmail resolve
        // (a device-code login persists these too).
        ...(input.userId ? { userId: input.userId } : {}),
        accessToken: input.accessToken,
        refreshToken: input.refreshToken,
        serverUrl: input.serverUrl,
        ...(input.userEmail ? { email: input.userEmail } : {}),
        ...(input.userName ? { name: input.userName } : {}),
        ...(input.userDisplayName ? { displayName: input.userDisplayName } : {}),
        createdAt: new Date().toISOString(),
      },
      null,
      2,
    );
    const tmp = `${file}.${process.pid}.tmp`;
    await writeFile(tmp, body, { mode: 0o600 });
    await rename(tmp, file);
  }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export { ComputerHost };
