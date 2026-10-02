// Quit flow (task #7): quitting the desktop app stops every local background
// process. The flow is: optional confirmation (skipped when the OS is already
// shutting down, when "don't ask again" is set, or when there is nothing
// running to stop), then the shutdown ladder from shutdown.ts (IPC stop →
// verified-PID SIGTERM → SIGKILL), then the real app quit. Pure decision
// helpers stay unit-testable; `runQuitFlow` wires them to Electron.
import { dialog, powerMonitor } from "electron";
import { PRODUCT_NAME } from "./productName.js";

export interface QuitConfirmPrefs {
  quitNoConfirm: boolean;
}

/**
 * Ask only when it matters: never after "don't ask again", never when the OS
 * is already shutting down (powerMonitor saw it — a modal there would hang
 * logout), and never when there is nothing to stop. agentCount is null while
 * the daemon-side count reporter isn't deployed yet (follow-up PR): the
 * dialog then omits the number instead of inventing one.
 */
export function shouldAskQuitConfirm(input: {
  prefs: QuitConfirmPrefs;
  osShuttingDown: boolean;
  anythingRunning: boolean;
}): boolean {
  if (input.prefs.quitNoConfirm) return false;
  if (input.osShuttingDown) return false;
  return input.anythingRunning;
}

export interface QuitDialogCopy {
  message: string;
  detail: string;
  checkboxLabel: string;
}

/** Pure copy: names the real agent count only when the reporter supplied one. */
export function quitDialogCopy(agentCount: number | null): QuitDialogCopy {
  const noun = agentCount === 1 ? "agent" : "agents";
  const who = agentCount === null ? "all local agents" : `${agentCount} local ${noun}`;
  return {
    message: `Quit ${PRODUCT_NAME}?`,
    detail: `Quitting stops this app's Computer service and ${who} owned by it. They restart when you open ${PRODUCT_NAME} again.`,
    checkboxLabel: "Don't ask again",
  };
}

export interface QuitFlowDeps {
  /** Whether any local background piece is running (service or agent). */
  anythingRunning(): boolean | Promise<boolean>;
  /** Live agent count when the reporter supports it; null otherwise. */
  agentCount(): number | null | Promise<number | null>;
  prefs(): QuitConfirmPrefs;
  savePrefs(prefs: QuitConfirmPrefs): void;
  /** The shutdown ladder: IPC stop already issued + escalation to verified
   * process termination. Receives the OS-shutdown flag so timeouts compress when logout
   * must not stall. */
  orchestrateShutdown(systemShutdown: boolean): Promise<void>;
  quit(): void;
}

/**
 * Drive one quit attempt. Resolves true when the app may proceed to quit
 * (orchestration done), false when the user cancelled or nothing needed
 * stopping and the ladder ran clean.
 */
export async function runQuitFlow(deps: QuitFlowDeps): Promise<boolean> {
  const osShuttingDown = powerMonitorIsShuttingDown();
  const anythingRunning = await deps.anythingRunning();
  const mustAsk = shouldAskQuitConfirm({ prefs: deps.prefs(), osShuttingDown, anythingRunning });
  if (mustAsk) {
    const copy = quitDialogCopy(await deps.agentCount());
    const choice = await dialog.showMessageBox({
      type: "warning",
      buttons: ["Quit", "Cancel"],
      defaultId: 0,
      cancelId: 1,
      message: copy.message,
      detail: copy.detail,
      checkboxLabel: copy.checkboxLabel,
      noLink: true,
    });
    if (choice.response !== 0) return false;
    if (choice.checkboxChecked) deps.savePrefs({ quitNoConfirm: true });
  }
  // Status can be stale or omit orphaned agents. Always inspect the tree.
  await deps.orchestrateShutdown(osShuttingDown);
  return true;
}

// powerMonitor has no "was shutdown requested" query; subscribe once and keep
// the flag. Best-effort: macOS notifies early in the logout sequence.
let shutdownSeen = false;
let subscribed = false;
function powerMonitorIsShuttingDown(): boolean {
  if (!subscribed) {
    subscribed = true;
    try {
      powerMonitor.on("shutdown", () => {
        shutdownSeen = true;
      });
    } catch {
      // powerMonitor needs app ready; before that, treat as not shutting down.
    }
  }
  return shutdownSeen;
}

/** Single-flight quit: repeated requests stay intercepted until cleanup really
 * finishes. Cancellation/error reopens the gate so a later attempt can retry. */
export function createQuitController(options: {
  attempt(): Promise<boolean>;
  complete(): void;
  failed(error: unknown): void;
}) {
  let state: "idle" | "running" | "ready" = "idle";
  return {
    beforeQuit(event: { preventDefault(): void }): void {
      if (state === "ready") return;
      event.preventDefault();
      if (state === "running") return;
      state = "running";
      void Promise.resolve().then(() => options.attempt()).then((proceed) => {
        if (!proceed) { state = "idle"; return; }
        state = "ready";
        options.complete();
      }).catch((error: unknown) => {
        state = "idle";
        options.failed(error);
      });
    },
  };
}
