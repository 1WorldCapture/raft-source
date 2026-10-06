// Raft Desktop (bundled app) — main process.
//
// This is the APP-version main: it loads the desktop's own bundled frontend
// locally (dist/frontend/index.html) and talks to the Raft backend directly.
// It is NOT the old thin shell that wrapped the remote website — there is no
// manifest preflight, no per-document handshake, and no remote-origin gating,
// because the content is our own first-party bundle.
//
// It keeps the genuinely reusable native pieces: window-state persistence, the
// application menu, single-instance, the auto-updater, and clean teardown.

import { existsSync } from "node:fs";
import { hostname as osHostname } from "node:os";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { BrowserWindow, app, dialog, ipcMain, nativeImage, protocol, session, shell } from "electron";
import { ELECTRON_IPC_CHANNELS } from "@raft/desktop-contract";
import { createComputerApi, runResident, runService } from "@botiverse/raft-computer/lib";
import { installApplicationMenu } from "../main/appMenu.js";
import { createCursorSdkControls } from "./cursorSdkControls.js";
import { isCursorSdkE2eBuild } from "../main/cursorSdkE2eBuild.js";
import {
  applyDownloadedUpdate,
  checkForUpdatesManually,
  getUpdateStatus,
  initializeAutoUpdater,
  onUpdateStatus,
  triggerBackgroundCheck,
} from "../main/autoUpdater.js";
import { INITIAL_LIFECYCLE_STATE, reduceLifecycle } from "../main/lifecycle.js";
import type { LifecycleEvent } from "../main/lifecycle.js";
import { loadQuitNoConfirm, loadZoomLevel, saveQuitNoConfirm, saveZoomLevel } from "../main/viewPrefs.js";
import { createQuitController, runQuitFlow } from "../main/quitFlow.js";
import { runShutdownTree } from "../main/shutdown.js";
import { loadWindowState, trackWindowState } from "../main/windowState.js";
import { MenubarResident, shouldHideOnClose } from "../main/menubarResident.js";
import { isHiddenLaunch } from "../main/loginItem.js";
import { armOAuthLoopback, cancelOAuthLoopback, isAllowedAuthorizationUrl } from "./oauthLoopback.js";
import { buildApiOrigins } from "./configuredApiOrigin.js";
import { ServerOriginConfig } from "./serverOriginConfig.js";
import { requestStorageWipeAndRelaunch, resolvePendingStorageWipe } from "./storageDoctor.js";
import { createOAuthCoordinator } from "./oauthCoordinator.js";
import { ComputerHost } from "./computerHost.js";
import { resolveBundledCursorSdkAssets } from "./cursorSdkAssets.js";
import { installStatusMonitorLifecycle } from "../main/statusMonitorLifecycle.js";
import { createStatusMonitor } from "../main/statusMonitor.js";
import { createAppProtocolHandler } from "../main/appProtocol.js";
import type { ComputerStatusReport } from "@botiverse/raft-computer/lib";

const moduleDir = path.dirname(fileURLToPath(import.meta.url));
const FRONTEND_ROOT = path.join(moduleDir, "frontend");
// The bundled SPA uses ES module scripts, which Chromium refuses to load over
// file:// (no real origin). A privileged app:// scheme gives it a proper secure
// origin, exactly like cumora/grok-bot serve their bundled content.
const APP_SCHEME = "app";
const APP_ORIGIN = `${APP_SCHEME}://raft`;
const BACKGROUND_COLOR = "#fffaef";
const MIN_WIDTH = 960;
const MIN_HEIGHT = 640;
const ZOOM_MIN = -3;
const ZOOM_MAX = 4;
// Center the ~14px macOS traffic lights in the desktop top toolbar (h-12 =
// 48px), inset from the left edge. The toolbar reserves the left inset via its
// data-raft-titlebar padding so content never sits under the lights.
const TRAFFIC_LIGHT_INSET_X = 16;
const TRAFFIC_LIGHT_INSET_Y = 16;

// Dev-only: point this instance at its own userData directory. The
// single-instance lock, login session and window state all key off userData,
// so a second instance with its own dir runs fully isolated — local
// verification of a dev build without disturbing the installed app (whose
// window would otherwise pop to the foreground on single-instance activation).
// Never active in packaged builds: the installed app must always share the
// one canonical data dir.
const userDataOverride = !app.isPackaged ? process.env.RAFT_DESKTOP_USER_DATA?.trim() : undefined;
if (userDataOverride) app.setPath("userData", userDataOverride);

// Runtime server origin (phase 3-1): userData/server-origin.json >
// RAFT_DESKTOP_API_ORIGIN env > the baked CONFIGURED_API_ORIGIN. Resolved
// ONCE per boot — a change is persisted and applied at relaunch. This is
// the "current deployment" concept; isOfficialApiBuild() stays the
// build-identity concept.
const serverOriginConfig = new ServerOriginConfig({ userDataDir: app.getPath("userData"), env: process.env });

const APP_VERSION = app.getVersion();
// Official-app updates only when THIS boot talks to an official backend —
// a runtime-configured private origin must not pull official app builds
// over the user's deployment (mirrors the baked self-hosted rule).
const desktopUpdaterAllowed = serverOriginConfig.isOfficial() && !isCursorSdkE2eBuild(APP_VERSION);

// ─── Computer host (raft-computer) argv dispatch ──────────────────────────────
// The detached Computer service re-execs THIS binary with a hidden `__service` /
// `__run <serverId>` argv (spawnDetachedService in packages/computer). We must
// route those to runService/runResident BEFORE any GUI setup — otherwise the
// child just opens a second window and the supervisor never starts (raft-computer
// BUG 5). The token position varies across dev/packaged layouts, so we scan.
function findHeadlessMode(argv: string[]): { mode: "__service" | "__run"; rest: string[] } | null {
  for (let i = 1; i < argv.length; i++) {
    if (argv[i] === "__service" || argv[i] === "__run") {
      return { mode: argv[i] as "__service" | "__run", rest: argv.slice(i + 1) };
    }
  }
  return null;
}

// The `__run` child hands the bundled `raft` CLI to each agent runtime as
// slockCliPath; without it the runtime throws "slockCliPath is required". Resolve
// it before any service spawn (packaged: <resources>/cli/index.js; dev: the
// workspace @botiverse/raft dist).
function resolveBundledCliPath(): string | null {
  if (app.isPackaged) return path.join(process.resourcesPath, "cli", "index.js");
  try {
    const pkg = createRequire(import.meta.url).resolve("@botiverse/raft/package.json");
    return path.join(path.dirname(pkg), "dist", "index.js");
  } catch {
    return null;
  }
}
if (!process.env.RAFT_COMPUTER_CLI_PATH) {
  const cliPath = resolveBundledCliPath();
  if (cliPath && existsSync(cliPath)) process.env.RAFT_COMPUTER_CLI_PATH = cliPath;
  else {
    // Without this, every __run child later throws "slockCliPath is required"
    // with no host-side clue — leave a one-line breadcrumb.
    console.warn(`[raft-desktop] bundled raft CLI not found (${cliPath ?? "unresolved"}); agent runtimes will fail until RAFT_COMPUTER_CLI_PATH is set.`);
  }
}

// Cursor SDK runtime assets (cursor-sdk runtime id): the daemon refuses to
// import @cursor/sdk in-process; it spawns the STAGED Node binary against the
// staged host entries instead. Packaged builds ship the asset root under
// <resources>/cursor-sdk (electron-builder extraResources) and we publish its
// exact location via RAFT_CURSOR_SDK_ASSETS BEFORE any daemon import — the
// detached __service/__run children inherit it, so every daemon this app
// spawns resolves the same root. Dev (unpackaged) builds leave it unset: the
// daemon then discovers packages/daemon/runtime-assets/cursor/<version>/<target>
// built by `pnpm --filter @botiverse/raft-daemon build:cursor-assets`.
const bundledCursorSdkAssets = resolveBundledCursorSdkAssets({
  isPackaged: app.isPackaged,
  resourcesPath: process.resourcesPath,
});
if (bundledCursorSdkAssets.root) {
  process.env.RAFT_CURSOR_SDK_ASSETS = bundledCursorSdkAssets.root;
} else if (bundledCursorSdkAssets.missing && !process.env.RAFT_CURSOR_SDK_ASSETS) {
  // Fail loud but non-fatal: the cursor-sdk runtime reports unavailable with
  // an actionable diagnostic; every other runtime is unaffected.
  console.warn(
    `[raft-desktop] packaged build is missing cursor-sdk assets under ${process.resourcesPath}; the cursor-sdk runtime will be unavailable until the app is rebuilt with build:cursor-assets.`,
  );
}

const headlessMode = findHeadlessMode(process.argv);

// Storage doctor (task #12): set once this process holds the single-instance
// lock and has consumed any pending wipe (see the lock-held branch below).
let storageWipedThisBoot = false;
let computerHost: ComputerHost | null = null;
const cursorSdkControls = createCursorSdkControls(() => {
  if (!computerHost) throw new Error("Local Computer is not ready.");
  return computerHost.slockHome;
});
let menubarResident: MenubarResident | null = null;
let mainWindow: BrowserWindow | null = null;
let lifecycle = INITIAL_LIFECYCLE_STATE;
let appReady = false;
const pendingDeepLinks: string[] = [];

const DEEP_LINK_SCHEME = "raft";

function deliverDeepLink(uri: string): void {
  if (!uri.startsWith(`${DEEP_LINK_SCHEME}://`)) return;
  const window = focusedWindow();
  if (!appReady || !window) {
    pendingDeepLinks.push(uri);
    return;
  }
  if (window.isMinimized()) window.restore();
  window.show();
  window.focus();
  window.webContents.send("app:deep-link", uri);
}

function flushDeepLinks(): void {
  if (!appReady || !focusedWindow()) return;
  while (pendingDeepLinks.length > 0) {
    const uri = pendingDeepLinks.shift();
    if (uri) deliverDeepLink(uri);
  }
}

// The bundled frontend runs on the app:// origin but calls the Raft API on a
// different origin, so the browser enforces CORS. The API's allowlist is the
// web origins, not app://. Since this is our own first-party app talking to our
// own backend, inject permissive CORS headers onto the API's responses so the
// browser accepts them (this is the standard Electron approach for a bundled
// first-party client; it does not weaken the API itself).
// Self-hosted builds (VITE_API_URL configured to a non-official origin) and
// runtime-configured private origins (phase 3-1) bridge exactly that one
// extra origin — never bare http:, and look-alike hosts stay rejected by the
// parsed-origin matching below (see configuredApiOrigin.ts). The origin is
// boot-stable (changes apply at relaunch), so a const set is still correct.
const API_ORIGINS = buildApiOrigins(serverOriginConfig.current());

function installApiCorsBridge(): void {
  session.defaultSession.webRequest.onHeadersReceived({ urls: [...API_ORIGINS].map((origin) => `${origin}/*`) }, (details, callback) => {
    // Match on the parsed origin, not a raw-URL prefix — a prefix test would
    // also match look-alike hosts like https://api.raft.build.evil.com.
    let origin: string;
    try {
      origin = new URL(details.url).origin;
    } catch {
      callback({ responseHeaders: details.responseHeaders });
      return;
    }
    if (!API_ORIGINS.has(origin)) {
      callback({ responseHeaders: details.responseHeaders });
      return;
    }
    const headers = { ...(details.responseHeaders ?? {}) };
    // Drop any server-set variants (case-insensitively) before setting ours.
    for (const key of Object.keys(headers)) {
      if (key.toLowerCase().startsWith("access-control-")) delete headers[key];
    }
    // The client uses Bearer tokens, not cookies, so no credentials are sent —
    // a wildcard origin is valid. IMPORTANT: per the Fetch spec, the `*`
    // wildcard in Access-Control-Allow-Headers does NOT cover `Authorization`;
    // it must be named explicitly, or every authenticated (Bearer) request
    // fails its CORS preflight. List it alongside the wildcard.
    headers["Access-Control-Allow-Origin"] = ["*"];
    headers["Access-Control-Allow-Methods"] = ["*"];
    headers["Access-Control-Allow-Headers"] = ["*, Authorization"];
    callback({ responseHeaders: headers });
  });
}

// Detect the web social-login start URL (…/auth/<provider>/start) so the
// desktop can intercept it and run the native PKCE flow instead.
const OAUTH_PROVIDERS = new Set(["google", "github", "apple"]);
function socialProviderFromStartUrl(rawUrl: string): string | null {
  try {
    const provider = new URL(rawUrl).pathname.match(/\/auth\/([a-z]+)\/start$/)?.[1];
    if (provider && OAUTH_PROVIDERS.has(provider)) return provider;
  } catch {
    // not a URL we care about
  }
  return null;
}

// Desktop OAuth coordinator — pure logic (token/sender scoping + URL allowlist)
// lives in oauthCoordinator so it's unit-testable; here it's wired to the real
// loopback + shell.openExternal. Tokens are never handled here — the renderer
// exchanges the handoff code over HTTPS /complete.
const oauthCoordinator = createOAuthCoordinator({
  arm: armOAuthLoopback,
  cancel: cancelOAuthLoopback,
  openExternal: (url) => shell.openExternal(url),
  // The authorization-URL allowlist follows the RUNTIME origin (a private
  // deployment's authorize pages are served from it), not just the baked one.
  isAllowedUrl: (url) => isAllowedAuthorizationUrl(url, serverOriginConfig.current()),
  randomToken: randomUUID,
});

function registerIpcHandlers(): void {
  ipcMain.handle("oauth:arm", (e, nonce: unknown) => oauthCoordinator.arm(nonce, e.sender.id));
  ipcMain.handle("oauth:open-await", (e, payload: unknown) => oauthCoordinator.openAwait(payload, e.sender.id));
  ipcMain.on("oauth:cancel", (e, token: unknown) => oauthCoordinator.cancel(token, e.sender.id));
  ipcMain.on("window:minimize", (e) => BrowserWindow.fromWebContents(e.sender)?.minimize());
  ipcMain.on("window:toggle-maximize", (e) => {
    const w = BrowserWindow.fromWebContents(e.sender);
    if (!w) return;
    if (w.isMaximized()) w.unmaximize();
    else w.maximize();
  });
  ipcMain.on("window:close", (e) => BrowserWindow.fromWebContents(e.sender)?.close());
  ipcMain.handle(ELECTRON_IPC_CHANNELS.isFocused, (e) => BrowserWindow.fromWebContents(e.sender)?.isFocused() ?? false);
  ipcMain.on(ELECTRON_IPC_CHANNELS.setBadge, (_e, count: unknown) => {
    const n = typeof count === "number" && Number.isFinite(count) ? Math.max(0, Math.round(count)) : 0;
    app.setBadgeCount(n);
  });
  ipcMain.on(ELECTRON_IPC_CHANNELS.focusWindow, (e) => {
    const w = BrowserWindow.fromWebContents(e.sender);
    if (!w) return;
    if (w.isMinimized()) w.restore();
    w.show();
    w.focus();
  });
  ipcMain.handle(ELECTRON_IPC_CHANNELS.storageWipeStatus, () => storageWipedThisBoot);
  ipcMain.on(ELECTRON_IPC_CHANNELS.storageResetRequest, () => {
    // Renderer-side corruption heuristic fired (canary lost while the
    // IndexedDB cache clearly has data): schedule the wipe marker and
    // relaunch so the next boot starts from a clean Local Storage.
    requestStorageWipeAndRelaunch(app.getPath("userData"), () => app.relaunch(), (code) => app.exit(code));
  });
  // Server-origin configuration (phase 3-1). set/reset re-validate in THIS
  // process — the renderer's value is never trusted. A persisted change is
  // pending until relaunch (the renderer drives the confirm + relaunch UX).
  ipcMain.handle(ELECTRON_IPC_CHANNELS.serverOriginGet, () => serverOriginConfig.status());
  ipcMain.handle(ELECTRON_IPC_CHANNELS.serverOriginSet, (_e, raw: unknown) =>
    typeof raw === "string" ? serverOriginConfig.set(raw) : Promise.resolve({ ok: false, error: "invalid_server_origin" }));
  ipcMain.handle(ELECTRON_IPC_CHANNELS.serverOriginReset, () => serverOriginConfig.reset());
  ipcMain.on(ELECTRON_IPC_CHANNELS.serverOriginRelaunch, () => {
    app.relaunch();
    app.exit(0);
  });
}

// Computer host IPC — the renderer's window.raftDesktop.computer bridge. All
// calls delegate to the single ComputerHost; results are secret-free (attach
// returns a redacted prefix, never an apiKey). Status is both pull (computer:
// status) and push (computer:status-update, broadcast on a 5s poll).
const COMPUTER_STATUS_POLL_MS = 5_000;
let computerStatusMonitor: ReturnType<typeof createStatusMonitor<ComputerStatusReport>> | null = null;

function broadcastComputerStatus(status: ComputerStatusReport): void {
  // The tray's "N agents running" row rides the same 5s poll — no extra IPC.
  menubarResident?.setStatusReport(status);
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) win.webContents.send("computer:status-update", status);
  }
}

function registerComputerIpc(host: ComputerHost): void {
  // The local OS hostname lets the renderer correlate THIS machine to its row in
  // the server-derived machine list (so the self-card IS that computer, not a
  // separate entry) even when the local attachment predates the machineId field.
  ipcMain.handle("computer:local-info", () => ({ hostname: osHostname() }));
  const monitor = createStatusMonitor({
    read: () => host.getStatus(),
    publish: broadcastComputerStatus,
    intervalMs: COMPUTER_STATUS_POLL_MS,
  });
  computerStatusMonitor = monitor;
  installStatusMonitorLifecycle(monitor, () => lifecycle.quitting);
  ipcMain.handle("computer:status", () => monitor.read());
  ipcMain.handle("computer:enable", (_e, input: unknown) => monitor.afterOperation(() => host.enable(input as never)));
  ipcMain.handle("computer:start", () => monitor.afterOperation(() => host.start()));
  ipcMain.handle("computer:stop", () => monitor.afterOperation(() => host.stop()));
  ipcMain.handle("computer:restart", () => monitor.afterOperation(() => host.restart()));
  // Real stop→start recycle for a version-skewed resident (see computerHost).
  // The renderer confirms with the user first: it briefly offlines every agent
  // on this machine.
  ipcMain.handle("computer:recycle", () => monitor.afterOperation(() => host.recycleService()));
  ipcMain.handle("computer:retry-converge", () => monitor.afterOperation(() => host.retryConverge()));
  ipcMain.handle("computer:connect-deployment", (_event, userId: unknown) => monitor.afterOperation(async () => {
    const abort = new AbortController();
    const cancelOnQuit = () => abort.abort();
    app.once("before-quit", cancelOnQuit);
    try {
      await host.connectCurrentDeployment({
        signal: abort.signal,
        targetUserId: typeof userId === "string" && userId.length <= 256 ? userId : undefined,
        confirm: async (plan) => {
          const choice = await dialog.showMessageBox({
            type: "warning", buttons: ["连接当前部署", "取消"], defaultId: 1, cancelId: 1,
            signal: abort.signal,
            message: "连接当前部署？",
            detail: `当前部署：${plan.currentOrigin}\n目标部署：${plan.targetOrigin}\n当前状态目录：${plan.currentHome}\n新状态目录将在 ${plan.storageDirectory} 下创建。\n旧连接（${plan.connections.length}）：${plan.connections.join("、") || "无"}\n旧会话、数据和连接会保留，原 Computer 不会被停止。你需要独立认证并重新添加有权限的连接。`,
          });
          return choice.response === 0;
        },
        authenticate: async (home, origin) => {
          const dialogAbort = new AbortController();
          const closeOnAbort = () => dialogAbort.abort();
          abort.signal.addEventListener("abort", closeOnAbort, { once: true });
          try {
            await createComputerApi(home).login({ serverUrl: origin }, (event) => {
              if (event.kind !== "login.device-code") return;
              // A deployment can serve approval on a separate web origin. Show
              // that destination for explicit consent before opening the browser.
              void (async () => {
                const url = new URL(event.verifyUrl);
                if (!["https:", "http:"].includes(url.protocol) || url.username || url.password) {
                  abort.abort();
                  return;
                }
                const approval = await dialog.showMessageBox({
                  type: "info", message: "打开 Computer 授权页面？",
                  detail: `部署：${origin}\n授权页面：${url.href}\n授权码：${event.userCode}\n请核对页面地址，并使用当前桌面账号登录。`,
                  buttons: ["打开授权页面", "取消连接"], defaultId: 1, cancelId: 1,
                  signal: dialogAbort.signal,
                });
                if (dialogAbort.signal.aborted || abort.signal.aborted) return;
                if (approval.response !== 0) { abort.abort(); return; }
                await shell.openExternal(url.href);
                if (dialogAbort.signal.aborted || abort.signal.aborted) return;
                const waiting = await dialog.showMessageBox({
                  type: "info", message: "请在浏览器确认 Computer 登录",
                  detail: `部署：${origin}\n授权码：${event.userCode}`,
                  buttons: ["等待浏览器授权", "取消连接"], cancelId: 1,
                  signal: dialogAbort.signal,
                });
                if (!dialogAbort.signal.aborted && waiting.response === 1) abort.abort();
              })().catch(() => { if (!dialogAbort.signal.aborted) abort.abort(); });
            }, { signal: abort.signal });
          } finally {
            dialogAbort.abort();
            abort.signal.removeEventListener("abort", closeOnAbort);
          }
        },
      });
    } finally { app.removeListener("before-quit", cancelOnQuit); }
  }));

  ipcMain.handle("computer:upgrade-info", () => host.getUpgradeInfo());
  ipcMain.handle("computer:upgrade", () => monitor.afterOperation(() => host.upgrade()));
  ipcMain.handle("computer:upgrade-fresh-install", (_e, version: unknown) =>
    monitor.afterOperation(() => host.upgradeViaFreshInstall(typeof version === "string" ? version : "")),
  );
  ipcMain.handle("computer:management", () => host.getManagement());
}

// App self-update IPC — the renderer's window.raftDesktop.appUpdate bridge. The
// updater auto-downloads in the background; the renderer renders a non-intrusive
// "restart to update" affordance from this status stream (no native modal).
function broadcastAppUpdateStatus(status: unknown): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) win.webContents.send("app-update:status-update", status);
  }
}

function registerAppUpdateIpc(deps: { markQuitting(): void; updaterAllowed?: boolean }): void {
  ipcMain.handle("app-update:status", () => getUpdateStatus());
  ipcMain.on("app-update:check", () => void triggerBackgroundCheck(deps));
  ipcMain.on("app-update:restart", () => applyDownloadedUpdate(deps));
  onUpdateStatus(broadcastAppUpdateStatus);
}

// Register before app-ready. `standard` gives it URL semantics, `secure` makes
// it a secure context (crypto/service workers), `supportFetchAPI` allows fetch.
protocol.registerSchemesAsPrivileged([
  {
    scheme: APP_SCHEME,
    privileges: { standard: true, secure: true, supportFetchAPI: true, codeCache: true },
  },
]);

function registerAppProtocol(): void {
  protocol.handle(APP_SCHEME, createAppProtocolHandler(FRONTEND_ROOT));
}

function createMainWindow(): BrowserWindow {
  const restored = loadWindowState();
  const window = new BrowserWindow({
    width: restored.bounds?.width ?? 1280,
    height: restored.bounds?.height ?? 800,
    x: restored.bounds?.x,
    y: restored.bounds?.y,
    minWidth: MIN_WIDTH,
    minHeight: MIN_HEIGHT,
    show: false,
    backgroundColor: BACKGROUND_COLOR,
    titleBarStyle: "hiddenInset",
    // Electron defaults this to false for our hidden-titlebar window, which
    // silently disables native fullscreen (the green button falls back to
    // zoom = "fills the screen"). Force it on so the traffic-light green button
    // and View → Toggle Full Screen enter real macOS fullscreen.
    fullscreenable: true,
    // Align the macOS traffic lights to the center of our 62px top bar (the
    // login brand bar and the app's panel-header row are both h-panel-header =
    // 62px), so the lights sit inside a real title-bar strip instead of
    // floating over content. Matches grok-bot's trafficLightPosition approach.
    trafficLightPosition: { x: TRAFFIC_LIGHT_INSET_X, y: TRAFFIC_LIGHT_INSET_Y },
    fullscreen: false,
    webPreferences: {
      preload: path.join(moduleDir, "app-preload.cjs"),
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      spellcheck: true,
      // Our own realtime UI relies on the socket firing while backgrounded.
      backgroundThrottling: false,
      // Runtime server-origin environment (phase 3-1): hand the boot's
      // resolved origin + generation to the sandboxed preload BEFORE page
      // scripts run (it injects __RAFT_DESKTOP_ENVIRONMENT__ from these).
      // Absent for stock official boots with no override — the renderer
      // then follows the compiled origin exactly as before.
      ...(serverOriginConfig.hasOverride()
        ? {
          additionalArguments: [
            `--raft-server-origin=${serverOriginConfig.current()}`,
            `--raft-environment-generation=${serverOriginConfig.injectionGeneration()}`,
          ],
        }
        : {}),
    },
  });
  mainWindow = window;
  trackWindowState(window);

  window.webContents.on("did-fail-load", (_e, code, desc, url) => {
    if (code === -3) return; // aborted (e.g. superseded navigation)
    console.warn(`[raft-desktop] load failed ${code} ${desc} ${url}`);
  });
  window.webContents.on("render-process-gone", (_e, details) =>
    console.warn(`[raft-desktop] renderer gone: ${details.reason}`),
  );

  window.once("ready-to-show", () => {
    if (window.isDestroyed()) return;
    window.webContents.setZoomLevel(loadZoomLevel());
    if (restored.fullscreen) window.setFullScreen(true);
    else if (restored.maximized) window.maximize();
    window.show();
  });

  // External links open in the system browser; the app itself never navigates
  // away from its bundled frontend.
  window.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith("https://") || url.startsWith("http://")) {
      void shell.openExternal(url);
    }
    return { action: "deny" };
  });

  // The app stays on app://. A social-login button navigates the page at the
  // web OAuth start URL (…/auth/<provider>/start); on desktop we don't follow
  // it — we intercept and run the native PKCE + loopback flow instead. Any other
  // off-app:// http(s) navigation opens in the system browser.
  window.webContents.on("will-navigate", (event, url) => {
    if (url.startsWith(`${APP_ORIGIN}/`)) return;
    event.preventDefault();
    const provider = socialProviderFromStartUrl(url);
    if (provider) {
      window.webContents.send("app:oauth-start", provider);
      return;
    }
    if (url.startsWith("https://") || url.startsWith("http://")) {
      void shell.openExternal(url);
    }
  });

  // Native focus state → renderer (reliable substitute for document.hasFocus).
  window.on("focus", () => window.webContents.send(ELECTRON_IPC_CHANNELS.focusState, true));
  window.on("blur", () => window.webContents.send(ELECTRON_IPC_CHANNELS.focusState, false));

  // Menubar residency: closing the window (red button / Cmd+W) hides it and
  // the Dock icon instead of quitting — the Tray icon is the remaining
  // presence, and every re-open path funnels through revealMainWindow().
  // A real quit (Cmd+Q / Quit menu) runs with lifecycle.quitting=true and
  // must close for real, or the app could never exit.
  window.on("close", (event) => {
    if (!shouldHideOnClose({ quitting: lifecycle.quitting, platform: process.platform })) return;
    event.preventDefault();
    window.hide();
    app.dock?.hide();
  });

  // Flush any deep links buffered before this window was ready. Wired per
  // window (not just the first) so a raft:// link that arrives while the app is
  // running windowless — the macOS "closed but resident" state — is delivered
  // when the next window opens rather than sitting in the buffer forever.
  window.webContents.once("did-finish-load", () => flushDeepLinks());

  window.on("closed", () => {
    if (mainWindow === window) mainWindow = null;
  });

  // Load at the app root (not /index.html) so BrowserRouter's initial pathname
  // is "/". The protocol handler serves index.html for it.
  void window.loadURL(`${APP_ORIGIN}/`);
  return window;
}

function focusedWindow(): BrowserWindow | null {
  return mainWindow && !mainWindow.isDestroyed() ? mainWindow : null;
}

// One funnel for every "show me the window" path: tray click / tray menu,
// second-instance (Dock / Spotlight / `open -a`), and activate. Brings the
// Dock icon back, then restores the existing window (maximized/fullscreen
// state survives hide) or recreates it from persisted state.
function revealMainWindow(): void {
  if (process.platform === "darwin") app.dock?.show();
  const window = focusedWindow();
  if (window) {
    if (window.isMinimized()) window.restore();
    window.show();
    window.focus();
  } else {
    createMainWindow();
  }
}

// The same root/identity registry guards takeover and real app quit.
async function orchestrateQuitShutdown(systemShutdown: boolean): Promise<void> {
  const host = computerHost;
  if (!host || !(await host.canShutdown())) return;
  const abort = new AbortController();
  try {
    const complete = await runShutdownTree({
      scope: host.processScope,
      snapshot: host.readProcesses,
      requestStop: () => host.stop(abort.signal),
      now: () => Date.now(),
      sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
      signal: (pid, signal) => process.kill(pid, signal),
      logFile: path.join(host.slockHome, "computer", "run", "shutdown.log"),
      systemShutdown,
    });
    if (!complete) throw new Error("这台计算机的退出清理未完成，进程或停止收尾仍需处理，请重试。无法确认归属的进程未被终止。");
  } finally {
    abort.abort();
  }
}

function zoom(direction: "in" | "out" | "reset"): void {
  const window = focusedWindow();
  if (!window) return;
  const contents = window.webContents;
  if (direction === "reset") {
    contents.setZoomLevel(0);
    saveZoomLevel(0);
    return;
  }
  const next = Math.max(
    ZOOM_MIN,
    Math.min(ZOOM_MAX, contents.getZoomLevel() + (direction === "in" ? 0.5 : -0.5)),
  );
  contents.setZoomLevel(next);
  saveZoomLevel(next);
}

function applyLifecycle(event: LifecycleEvent): void {
  const { state, decision } = reduceLifecycle(lifecycle, event, process.platform);
  lifecycle = state;
  if (decision === "quit") app.quit();
  if (decision === "reboot" && !mainWindow) createMainWindow();
}

function markQuitting(): void {
  cursorSdkControls.cancelLogin();
  computerStatusMonitor?.setActive(false);
  applyLifecycle({ type: "before-quit" });
}

if (headlessMode) {
  // A headless service/runner child re-launched this bundle. It shares the
  // GUI's executable and bundle id, so macOS LaunchServices would otherwise
  // treat it as just another instance of the app — and once the GUI quits,
  // the headless child becomes the bundle's activation target: clicking the
  // Dock icon then "activates" a process with no window (the no-window
  // hijack). dock.hide() only hides the icon; it does not make the process
  // un-activatable. "prohibited" does: the child can never become the
  // foreground representative, so activation always routes to (or spawns) a
  // real GUI. macOS-only API; set before app-ready AND re-set once ready,
  // because Electron may restore the default policy on launch completion.
  if (process.platform === "darwin") {
    app.setActivationPolicy("prohibited");
    void app.whenReady().then(() => app.setActivationPolicy("prohibited"));
  }
}
if (headlessMode?.mode === "__service") {
  // Detached supervisor process — run the service, then exit. No GUI, no lock.
  void runService()
    .then(() => process.exit(0))
    .catch((error: unknown) => {
      process.stderr.write(`[raft-desktop] __service failed: ${String(error)}\n`);
      process.exit(1);
    });
} else if (headlessMode?.mode === "__run") {
  // Per-server daemon child. runResident must NOT be followed by process.exit:
  // its open WebSocket keeps the process alive.
  const serverId = headlessMode.rest[0];
  if (!serverId) {
    process.stderr.write("[raft-desktop] __run requires a serverId\n");
    process.exit(2);
  } else {
    // This Computer ships with the desktop app; tell the server so it never
    // offers a standalone upgrade for it.
    void runResident(serverId, { hostKind: "desktop_app" }).catch((error: unknown) => {
      process.stderr.write(`[raft-desktop] __run failed: ${String(error)}\n`);
      process.exit(1);
    });
  }
} else if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  // Storage doctor (task #12): consume a pending wipe only once this process
  // holds the single-instance lock — a second instance must never delete
  // Local Storage while the first still has it open. Still module scope,
  // ahead of app ready and any window/session, so nothing has opened storage.
  storageWipedThisBoot = resolvePendingStorageWipe(app.getPath("userData"));

  // Isolated test builds (electron-builder.isolated.yml) skip raft://
  // registration: LaunchServices would otherwise make the test build the
  // deep-link handler and steal links meant for the installed app.
  if (app.isPackaged && !app.getName().includes("Isolated")) {
    app.setAsDefaultProtocolClient(DEEP_LINK_SCHEME);
  }

  // macOS deep links arrive via open-url (may fire before ready).
  app.on("open-url", (event, url) => {
    event.preventDefault();
    deliverDeepLink(url);
  });
  // Windows/Linux: a raft:// launch arrives as argv of the (second) instance.
  const coldStartLink = process.argv.slice(1).find((a) => a.startsWith(`${DEEP_LINK_SCHEME}://`));
  if (coldStartLink) pendingDeepLinks.push(coldStartLink);

  app.on("second-instance", (_event, commandLine) => {
    // Defense in depth: a forwarded activation must never silently no-op —
    // revealMainWindow restores the window or recreates it, so "click the
    // Dock icon" always yields a window.
    revealMainWindow();
    const link = commandLine.find((a) => a.startsWith(`${DEEP_LINK_SCHEME}://`));
    if (link) deliverDeepLink(link);
  });

  const quitController = createQuitController({
    attempt: async () => {
      const host = computerHost;
      const attempt = () => runQuitFlow({
        anythingRunning: async () => {
          const host = computerHost;
          if (!host) return false;
          await host.waitForConnection();
          if (!(await host.canShutdown())) return false;
          const snapshot = await host.readProcesses();
          host.processScope.assertRoots(snapshot);
          return host.processScope.observe(snapshot).length > 0;
        },
        agentCount: async () => {
          const host = computerHost;
          if (!host) return null;
          const owned = host.processScope.observe(await host.readProcesses());
          return owned.filter((row) => row.agent).length;
        },
        prefs: () => ({ quitNoConfirm: loadQuitNoConfirm() }),
        savePrefs: (prefs) => saveQuitNoConfirm(prefs.quitNoConfirm),
        orchestrateShutdown: orchestrateQuitShutdown,
        quit: () => app.quit(),
      });
      return host ? host.runQuitAttempt(attempt) : attempt();
    },
    complete: () => {
      menubarResident?.destroy();
      computerStatusMonitor?.setActive(false);
      applyLifecycle({ type: "before-quit" });
      app.quit();
    },
    failed: (error) => {
      const detail = error instanceof Error ? error.message : "请重试退出。";
      void dialog.showMessageBox({ type: "error", message: "退出尚未完成", detail, buttons: ["知道了"] });
    },
  });
  app.on("before-quit", (event) => quitController.beforeQuit(event));
  app.on("window-all-closed", () => applyLifecycle({ type: "window-all-closed" }));
  // activate (Dock icon / app re-focus) reveals the window. This replaces the
  // reducer's old activate→reboot wiring: with hide-to-menubar the window is
  // usually alive-but-hidden, and revealMainWindow covers both that case and
  // the recreate case in one place.
  app.on("activate", () => revealMainWindow());
  for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const) {
    process.on(signal, () => app.quit());
  }

  void app.whenReady().then(async () => {
    // In dev (unpacked), macOS shows the default Electron dock icon — the real
    // brand mark only ships inside the packaged .app (build/icon.icns). Set it
    // explicitly so `pnpm start` also shows the Raft icon. Packaged builds get
    // the bundle icon automatically, so skip there.
    if (process.platform === "darwin" && !app.isPackaged) {
      const brandIcon = nativeImage.createFromPath(path.join(app.getAppPath(), "build", "icon.png"));
      if (!brandIcon.isEmpty()) app.dock?.setIcon(brandIcon);
    }
    registerAppProtocol();
    installApiCorsBridge();
    registerIpcHandlers();
    installApplicationMenu({
      cursorSdk: {
        status: () => { void cursorSdkControls.showStatus(); },
        login: () => { void cursorSdkControls.connect(); },
        cancelLogin: () => { cursorSdkControls.cancelLogin(); },
        disconnect: () => { void cursorSdkControls.disconnect(); },
      },
      openAbout: () => {
        // A native About panel; the app's own UI can add a richer one later.
        app.setAboutPanelOptions({
          applicationName: "Raft Desktop",
          applicationVersion: APP_VERSION,
          version: `Electron ${process.versions.electron}`,
        });
        app.showAboutPanel();
      },
      checkForUpdates: () => void checkForUpdatesManually({ markQuitting, updaterAllowed: desktopUpdaterAllowed }),
      reload: () => focusedWindow()?.webContents.reload(),
      zoom,
      focusedServerWindow: () => focusedWindow(),
    });

    // Self-hosted builds (VITE_API_URL → non-official origin) must not pull
    // official updates over a self-hosted install (see autoUpdater.ts).
    const updaterDeps = { markQuitting, updaterAllowed: desktopUpdaterAllowed };
    initializeAutoUpdater(updaterDeps);
    registerAppUpdateIpc(updaterDeps);

    // Become the OS-supervised host of the local Computer service. The heavy
    // __service/__run tree stays detached and login-item supervised, so quitting
    // this window never stops running agents; we only control + observe it.
    // Safety valve: RAFT_DESKTOP_DISABLE_COMPUTER_HOST=1 skips host init entirely
    // (no lifecycle mutation, no service spawn) — for dev/CI smoke boots on a
    // machine that already runs a Computer service. Default is enabled.
    if (process.env.RAFT_DESKTOP_DISABLE_COMPUTER_HOST !== "1") {
      computerHost = new ComputerHost({ configuredOrigin: serverOriginConfig.current() });
      await computerHost.restoreSelection();
      registerComputerIpc(computerHost);
      // Read-only mode observes + surfaces an already-installed Computer (the
      // "adopt" path) but does NOT converge host lifecycle — no launch-at-login
      // mutation, no service spawn. Safe to run on a machine already hosting a
      // live Computer service. Full mode (default) converges + can boot it.
      if (process.env.RAFT_DESKTOP_COMPUTER_READONLY !== "1") {
        void computerHost.converge().then((result) => {
          if (!result.ok) console.warn(`[raft-desktop] computer host converge: ${result.error ?? "failed"}`);
        });
      }
    }

    // Task #7 login start: the LaunchAgent opens the app with --hidden — the
    // tray is installed (always) but the window is not; every reveal path
    // (tray click, Dock, open -a, activate) creates it on demand.
    const hiddenStart = isHiddenLaunch(process.argv);
    appReady = true;
    // Menubar presence first: the window may be hidden on purpose (user closed
    // it earlier this session / login-item starts hidden in a later task), and
    // the tray icon must exist before anything can hide the window.
    menubarResident = new MenubarResident({
      iconPath: path.join(app.getAppPath(), "build", "tray-icon.png"),
      reveal: revealMainWindow,
    });
    menubarResident.install();
    // createMainWindow wires its own per-window did-finish-load → flushDeepLinks.
    if (!hiddenStart) createMainWindow();
    else console.log("[raft-desktop] login start: hidden to menu bar (--hidden)");
  });
}
