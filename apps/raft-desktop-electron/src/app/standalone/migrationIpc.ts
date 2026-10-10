// Main-process wiring of the one-click migration: which binary to run, what to do after a successful move,
// and the IPC channels. Registered only in embedded mode when the app carries a Computer.
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import type { IpcMainLike } from "./ipc.js";
import { installBundledComputer, type BundledComputer } from "./bundledInstall.js";
import { createStandaloneCli } from "./cli.js";
import { writeHostMode } from "./hostMode.js";
import { MigrationController, type MigrateRunner, type MigrationState } from "./migration.js";

export interface MigrationWiringDeps {
  bundled: BundledComputer;
  /** `~/.local/bin/raft-computer`. */
  binaryTarget: string;
  /** Home the app-hosted Computer uses now (the migration source). */
  getFromHome: () => Promise<string>;
  userDataDir: string;
  publish: (state: MigrationState) => void;
  /** Called after computer-host.json is written: detach the embedded host (so quitting stops nothing) and restart the app. */
  switchToStandalone: () => void;
  /** Test seams. */
  run?: MigrateRunner;
  handOver?: () => Promise<void>;
  restoreAfterHandOverFailure?: () => Promise<void>;
  signal?: (pid: number, signal: NodeJS.Signals) => void;
  supportsCancel?: (binaryPath: string) => Promise<boolean>;
  install?: typeof installBundledComputer;
  fileExists?: (target: string) => boolean;
  readVersion?: (binaryPath: string, home: string) => Promise<string | null>;
  writeMode?: typeof writeHostMode;
}

/**
 * The binary is installed BEFORE the move (version-gated: an older raft-computer is replaced by the bundled one,
 * which carries `migrate-home`), but the Cursor SDK only AFTER it: the target home must be empty for the move.
 */
/**
 * What follows a successful move, in the dialog and in launch-time recovery alike: copy the Cursor SDK next to the
 * moved home (a failure is only a warning) and write the standalone marker.
 */
export async function finishSwitch(
  deps: Pick<MigrationWiringDeps, "bundled" | "binaryTarget" | "userDataDir" | "install" | "writeMode">,
  to: string,
): Promise<{ warnings: string[] }> {
  if (!to) throw new Error("the migration did not report the new home");
  const install = deps.install ?? installBundledComputer;
  const writeMode = deps.writeMode ?? writeHostMode;
  const warnings: string[] = [];
  try {
    await install({ bundled: { ...deps.bundled, binaryPath: null, photonWasmPath: null }, binaryTarget: deps.binaryTarget, home: to, installedBinaryVersion: null });
  } catch (error) {
    warnings.push(`The Cursor SDK could not be copied next to the moved Computer (${error instanceof Error ? error.message : String(error)}); the card will offer Update.`);
  }
  // Without this, the app would come back up hosting a Computer that no longer lives where it looks.
  await writeMode(deps.userDataDir, { mode: "standalone", home: to });
  return { warnings };
}

/** `migrate-home --help` lists `--deadline` only in a raft-computer that handles SIGTERM as a clean cancel. */
export function defaultSupportsCancel(binaryPath: string): Promise<boolean> {
  return new Promise((resolve) => {
    execFile(binaryPath, ["migrate-home", "--help"], { timeout: 15_000 }, (error, stdout) => resolve(!error && /--deadline/.test(String(stdout))));
  });
}

export function createMigrationController(deps: MigrationWiringDeps): MigrationController {
  const install = deps.install ?? installBundledComputer;
  const fileExists = deps.fileExists ?? existsSync;
  const readVersion = deps.readVersion ?? ((binaryPath: string, home: string) => createStandaloneCli({ binaryPath, home }).version());
  return new MigrationController({
    available: deps.bundled.binaryPath !== null,
    getFromHome: deps.getFromHome,
    publish: deps.publish,
    run: deps.run,
    handOver: deps.handOver,
    restoreAfterHandOverFailure: deps.restoreAfterHandOverFailure,
    signal: deps.signal,
    supportsCancel: deps.supportsCancel ?? defaultSupportsCancel,
    ensureBinary: async () => {
      const from = await deps.getFromHome();
      const installed = fileExists(deps.binaryTarget) ? await readVersion(deps.binaryTarget, from) : null;
      const result = await install({ bundled: { ...deps.bundled, cursorRoot: null }, binaryTarget: deps.binaryTarget, home: from, installedBinaryVersion: installed });
      if (result.binary === "unavailable") throw new Error("This app does not carry the Computer to migrate with.");
      return deps.binaryTarget;
    },
    afterSuccess: async (to) => {
      const { warnings } = await finishSwitch(deps, to);
      deps.switchToStandalone();
      return { warnings };
    },
  });
}

/** Embedded-host controls that must not run while a move is in progress (converge() would restart the service in the source home). */
export function refuseWhileMigrating<A extends unknown[], R>(isApplying: () => boolean, fn: (...args: A) => R): (...args: A) => R {
  return (...args: A) => {
    if (isApplying()) throw new Error("The Computer is being moved out of this app. Wait until it finishes.");
    return fn(...args);
  };
}

export function registerMigrationIpc(ipc: IpcMainLike, controller: { getState(): MigrationState; plan(): Promise<MigrationState>; apply(): Promise<MigrationState>; reset(): MigrationState; cancel(): MigrationState }): void {
  ipc.handle("migration:state", () => controller.getState());
  ipc.handle("migration:plan", () => controller.plan());
  ipc.handle("migration:apply", () => controller.apply());
  ipc.handle("migration:reset", () => controller.reset());
  ipc.handle("migration:cancel", () => controller.cancel());
}
