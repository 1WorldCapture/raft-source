// IPC for the standalone Computer (main side). Registered only when computer-host.json says
// "standalone"; in embedded mode none of these handlers exist and the app behaves as before.
import { createStatusMonitor } from "../../main/statusMonitor.js";
import type { StandaloneComputerHost, StandaloneUiState } from "./standaloneHost.js";
import type { ComputerHostMode } from "./hostMode.js";

export const STANDALONE_STATE_POLL_MS = 5_000;

export interface IpcMainLike {
  handle(channel: string, listener: (event: unknown, ...args: unknown[]) => unknown): void;
}

export interface StandaloneIpcDeps {
  ipc: IpcMainLike;
  host: StandaloneComputerHost;
  publish: (state: StandaloneUiState) => void;
  quitting: () => boolean;
}

/** `computer:host-mode` is answered in BOTH modes so the renderer can pick the right UI. */
export function registerHostModeIpc(ipc: IpcMainLike, mode: ComputerHostMode): void {
  ipc.handle("computer:host-mode", () => (mode.mode === "standalone" ? { mode: "standalone", home: mode.home } : { mode: "embedded" }));
}

/**
 * The embedded `computer:*` channels exist in the preload bridge; in standalone mode they must fail loudly
 * (never act on a Computer this app does not host).
 */
export function registerEmbeddedStubs(ipc: IpcMainLike): void {
  const refuse = () => { throw new Error("This Computer is managed by the standalone Computer; use the Start/Stop controls."); };
  for (const channel of [
    "computer:enable", "computer:start", "computer:stop", "computer:restart", "computer:recycle", "computer:retry-converge",
    "computer:connect-deployment", "computer:upgrade", "computer:upgrade-fresh-install",
  ]) ipc.handle(channel, refuse);
  ipc.handle("computer:local-info", () => ({ hostname: "" }));
  ipc.handle("computer:status", () => null);
  ipc.handle("computer:upgrade-info", () => ({ latestVersion: null }));
  ipc.handle("computer:management", () => ({ model: "standalone" }));
}

export function registerStandaloneIpc(deps: StandaloneIpcDeps) {
  const monitor = createStatusMonitor<StandaloneUiState>({
    read: () => deps.host.getState(),
    publish: deps.publish,
    intervalMs: STANDALONE_STATE_POLL_MS,
  });
  deps.ipc.handle("standalone:state", () => monitor.read());
  deps.ipc.handle("standalone:start", () => monitor.afterOperation(() => deps.host.start()));
  deps.ipc.handle("standalone:stop", () => monitor.afterOperation(() => deps.host.stop()));
  deps.ipc.handle("standalone:install", () => monitor.afterOperation(() => deps.host.installFromBundle()));
  deps.ipc.handle("standalone:upgrade", () => monitor.afterOperation(() => deps.host.upgradeFromBundle()));
  return monitor;
}
