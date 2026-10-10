// `raft-computer start` on a macOS CLI-owned Computer converges the launchd carrier and then WAITS for the
// carrier's service to come up, still holding the home mutation lock. The carrier's `__service` is not a child of the
// CLI, so it does not carry the parent-lock marker; it used to queue for the bind lock, give up after ~5s with
// "Another Computer command is currently mutating state" and exit, while `start` waited out its 15s deadline for a
// service that could not start. This marker is the carrier-side equivalent of the parent-lock env marker: it says
// "a live `start` holds the lock FOR the service that is about to come up" (start spawns nothing in that branch, so
// no second starter can race the bind).
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { isProcessAlive } from "./internal/process-primitives.js";
import { serviceRunDir } from "./paths.js";

export const START_AWAITING_MAX_AGE_MS = 60_000;

export const startAwaitingPath = (slockHome: string): string => path.join(serviceRunDir(slockHome), "start-awaiting-service.json");

export async function markStartAwaitingService(slockHome: string, pid: number = process.pid, now: number = Date.now()): Promise<void> {
  await mkdir(serviceRunDir(slockHome), { recursive: true });
  await writeFile(startAwaitingPath(slockHome), JSON.stringify({ pid, at: now }), "utf8");
}

export async function clearStartAwaitingService(slockHome: string, pid: number = process.pid): Promise<void> {
  try {
    const current = JSON.parse(await readFile(startAwaitingPath(slockHome), "utf8")) as { pid?: unknown };
    if (current.pid !== pid) return; // someone else's marker
  } catch {
    return;
  }
  await rm(startAwaitingPath(slockHome), { force: true });
}

/** True when a live, recent `start` has announced it holds the lock while waiting for this home's service. */
export async function startIsAwaitingService(
  slockHome: string,
  deps: { isAlive?: (pid: number) => boolean; now?: () => number } = {},
): Promise<boolean> {
  try {
    const marker = JSON.parse(await readFile(startAwaitingPath(slockHome), "utf8")) as { pid?: unknown; at?: unknown };
    if (typeof marker.pid !== "number" || typeof marker.at !== "number") return false;
    if (((deps.now ?? Date.now)()) - marker.at > START_AWAITING_MAX_AGE_MS) return false;
    return (deps.isAlive ?? isProcessAlive)(marker.pid);
  } catch {
    return false;
  }
}
