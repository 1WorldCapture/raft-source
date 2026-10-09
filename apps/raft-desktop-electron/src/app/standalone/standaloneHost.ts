// The app's controller for the standalone Computer (one `raft-computer` per
// machine, home ~/.slock). It never hosts anything itself: it asks the CLI for
// status, starts/stops it on the user's request, and copies the bundled files.
// Quitting the app never touches the Computer (agents keep their state).
import { access } from "node:fs/promises";
import type { StandaloneCli, StandaloneStatus } from "./cli.js";
import { compareVersions, installBundledComputer, type BundledComputer, type InstallResult } from "./bundledInstall.js";

/** What the UI needs to decide what to show. */
export type StandalonePhase =
  | "not_installed" // no raft-computer binary on this machine
  | "stopped_by_user" // the user pressed Stop (desiredState=stopped): show "Start", not an error
  | "stopped" // not running although it should be: show the reason if any
  | "starting"
  | "running"
  | "failed"
  | "unreachable"; // the binary exists but its status could not be read

export interface StandaloneUiState {
  phase: StandalonePhase;
  home: string;
  binaryPath: string;
  status: StandaloneStatus | null;
  error: string | null;
  /** The app carries a newer Computer than the one installed (offer an upgrade). */
  upgradeAvailable: boolean;
  /** The app carries a Computer it could install (offer the install wizard when not_installed). */
  bundledAvailable: boolean;
}

export interface StandaloneHostDeps {
  home: string;
  binaryPath: string;
  cli: StandaloneCli;
  bundled: BundledComputer;
  install?: typeof installBundledComputer;
  fileExists?: (target: string) => Promise<boolean>;
}

export class StandaloneComputerHost {
  readonly home: string;
  readonly binaryPath: string;
  private readonly cli: StandaloneCli;
  private readonly bundled: BundledComputer;
  private readonly install: typeof installBundledComputer;
  private readonly fileExists: (target: string) => Promise<boolean>;
  /** Serializes start/stop/install/upgrade: two clicks never run two lifecycle commands at once. */
  private chain: Promise<unknown> = Promise.resolve();

  constructor(deps: StandaloneHostDeps) {
    this.home = deps.home;
    this.binaryPath = deps.binaryPath;
    this.cli = deps.cli;
    this.bundled = deps.bundled;
    this.install = deps.install ?? installBundledComputer;
    this.fileExists = deps.fileExists ?? ((target) => access(target).then(() => true, () => false));
  }

  private serialize<T>(task: () => Promise<T>): Promise<T> {
    const next = this.chain.then(task, task);
    this.chain = next.catch(() => undefined);
    return next;
  }

  async getState(): Promise<StandaloneUiState> {
    const base = {
      home: this.home,
      binaryPath: this.binaryPath,
      status: null as StandaloneStatus | null,
      error: null as string | null,
      upgradeAvailable: false,
      bundledAvailable: this.bundled.binaryPath !== null,
    };
    if (!(await this.fileExists(this.binaryPath))) return { ...base, phase: "not_installed" };
    let status: StandaloneStatus;
    try {
      status = await this.cli.status();
    } catch (error) {
      return { ...base, phase: "unreachable", error: error instanceof Error ? error.message : String(error) };
    }
    const upgradeAvailable = this.bundled.binaryVersion !== null && compareVersions(this.bundled.binaryVersion, status.service.version) > 0;
    const common = { ...base, status, upgradeAvailable };
    switch (status.service.state) {
      case "running": return { ...common, phase: "running" };
      case "starting": return { ...common, phase: "starting" };
      case "failed": return { ...common, phase: "failed", error: status.service.lastError };
      case "stopped":
        return status.desiredState === "stopped"
          ? { ...common, phase: "stopped_by_user" }
          : { ...common, phase: "stopped", error: status.service.lastError };
    }
  }

  start(): Promise<StandaloneUiState> {
    return this.serialize(async () => {
      const result = await this.cli.start();
      const state = await this.getState();
      return result.ok ? state : { ...state, error: result.error?.message || "Start failed" };
    });
  }

  stop(): Promise<StandaloneUiState> {
    return this.serialize(async () => {
      const result = await this.cli.stop();
      const state = await this.getState();
      return result.ok ? state : { ...state, error: result.error?.message || "Stop failed" };
    });
  }

  /** First install, or re-copy when the app carries a newer Computer. Does not start anything. */
  installFromBundle(): Promise<InstallResult> {
    return this.serialize(() => this.copyBundled(null));
  }

  /**
   * Replace the installed Computer with the bundled one: remember whether it was running, stop it, copy,
   * and bring it back to that state. A Computer the user stopped stays stopped.
   */
  upgradeFromBundle(): Promise<{ install: InstallResult; restarted: boolean }> {
    return this.serialize(async () => {
      let wasRunning = false;
      let version: string | null = null;
      if (await this.fileExists(this.binaryPath)) {
        try {
          const status = await this.cli.status();
          wasRunning = status.service.state === "running" || status.service.state === "starting";
          version = status.service.version;
        } catch {
          // unreadable status: treat as not running; the copy below is still safe
        }
      }
      if (wasRunning) await this.cli.stop();
      let install: InstallResult;
      try {
        install = await this.copyBundled(version);
      } catch (error) {
        if (wasRunning) await this.cli.start().catch(() => undefined); // never leave agents down because the copy failed
        throw error;
      }
      if (wasRunning) await this.cli.start();
      return { install, restarted: wasRunning };
    });
  }

  private async copyBundled(installedVersion: string | null): Promise<InstallResult> {
    const version = installedVersion ?? (await this.fileExists(this.binaryPath) ? await this.cli.version().catch(() => null) : null);
    return this.install({ bundled: this.bundled, binaryTarget: this.binaryPath, home: this.home, installedBinaryVersion: version });
  }
}
