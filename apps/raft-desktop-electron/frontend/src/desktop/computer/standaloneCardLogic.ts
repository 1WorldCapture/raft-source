// What the "This Computer" card shows when the machine's Computer is a standalone `raft-computer`
// (computer-host.json = standalone). Pure: UiState in, a display model out (unit-tested in
// standaloneCardLogic.test.ts); the component only renders it.

export type StandalonePhase = "not_installed" | "stopped_by_user" | "stopped" | "starting" | "running" | "failed" | "unreachable";

/** The slice of the main-process StandaloneUiState the card reads (kept structural: the renderer does not import main-process code). */
export interface StandaloneState {
  phase: StandalonePhase;
  error: string | null;
  upgradeAvailable: boolean;
  bundledAvailable: boolean;
  status: {
    agentCount: number;
    servers: Array<{ daemonState: string }>;
    service: { version: string | null };
  } | null;
}

export type StandaloneActionId = "start" | "stop" | "install" | "upgrade" | "refresh";

export interface StandaloneAction {
  id: StandaloneActionId;
  label: string;
  primary: boolean;
  /** Asked before running (the action takes agents offline). */
  confirm: string | null;
}

export interface StandaloneCardModel {
  tone: "ok" | "idle" | "warn" | "error";
  title: string;
  detail: string | null;
  version: string | null;
  actions: StandaloneAction[];
}

const act = (id: StandaloneActionId, label: string, primary = false, confirm: string | null = null): StandaloneAction => ({ id, label, primary, confirm });

export function deriveStandaloneCard(state: StandaloneState | null): StandaloneCardModel {
  if (!state) return { tone: "idle", title: "Checking this computer…", detail: null, version: null, actions: [] };
  const version = state.status?.service.version ?? null;
  const upgrade = state.upgradeAvailable ? [act("upgrade", "Update Computer", true, "Updating restarts the Computer, so its agents go offline for a moment.")] : [];
  switch (state.phase) {
    case "not_installed":
      return {
        tone: "idle",
        title: "Not installed",
        detail: state.bundledAvailable
          ? "Install the Computer that comes with this app. It keeps running your agents even when this app is closed."
          : "Install Raft Computer (raft-computer) on this machine to run agents here.",
        version: null,
        actions: state.bundledAvailable ? [act("install", "Install Computer", true)] : [],
      };
    case "stopped_by_user":
      return { tone: "idle", title: "Stopped", detail: "You stopped this Computer. Its agents stay offline until you start it.", version, actions: [act("start", "Start", true), ...upgrade] };
    case "stopped":
      // Fresh install: nothing is attached yet, so "stopped unexpectedly" would be untrue; say what is missing.
      if (state.status && state.status.servers.length === 0 && !state.error) {
        return { tone: "idle", title: "Not connected", detail: "No server is connected to this Computer yet. In a terminal, run: raft-computer setup /<your-server>", version, actions: [act("refresh", "Check again", true), ...upgrade] };
      }
      return { tone: "warn", title: "Not running", detail: state.error || "The Computer stopped unexpectedly.", version, actions: [act("start", "Start", true), ...upgrade] };
    case "starting":
      return { tone: "warn", title: "Starting…", detail: null, version, actions: [] };
    case "running": {
      const online = state.status?.servers.filter((server) => server.daemonState === "online").length ?? 0;
      const total = state.status?.servers.length ?? 0;
      const agents = state.status?.agentCount ?? 0;
      return {
        tone: "ok",
        title: "Running",
        detail: `${agents} ${agents === 1 ? "agent" : "agents"} · ${online}/${total} ${total === 1 ? "server" : "servers"} connected`,
        version,
        actions: [...upgrade, act("stop", "Stop", false, "Stop the Computer? All agents on this machine go offline until you start it again. Closing this app does not stop them.")],
      };
    }
    case "failed":
      return { tone: "error", title: "Couldn't start", detail: state.error || "The Computer failed to start.", version, actions: [act("start", "Try again", true)] };
    case "unreachable":
      return { tone: "error", title: "Can't read the Computer's status", detail: state.error || null, version, actions: [act("refresh", "Check again", true)] };
  }
}

/** One short human line for an error that came back from the main process. */
export function friendlyStandaloneError(raw: string): string {
  if (/ENOENT|not installed/i.test(raw)) return "The Computer isn't installed.";
  if (/timeout|timed out/i.test(raw)) return "That took too long — try again.";
  if (/EACCES|permission/i.test(raw)) return "Permission denied while changing the Computer.";
  return "Couldn't complete that — try again.";
}
