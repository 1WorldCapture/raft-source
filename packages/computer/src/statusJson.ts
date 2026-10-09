import { promises as fs } from "node:fs";
import path from "node:path";

import { readDesiredState } from "./desiredState.js";
import type { ComputerStatusReport, ProcessVersionStatus, ServerStatusRow } from "./status.js";

/**
 * `raft-computer status --json` projection — the machine-facing contract the
 * Desktop ComputerController consumes (#computer-extract interface v1,
 * 2026-10-09). Pure mapping over `ComputerStatusReport` plus the three
 * extract-era data sources (desiredState, cursor-sdk presence, migration
 * result file) — no new collection logic, so the human `status` and the JSON
 * view can never disagree on the underlying state.
 */

export interface JsonServiceState {
  state: "starting" | "running" | "stopped" | "failed";
  pid: number | null;
  version: string | null;
  lastError: string | null;
  desiredState: "running" | "stopped";
}

export interface JsonServerRow {
  serverId: string;
  slug: string | null;
  serverUrl: string;
  daemonState: "online" | "offline" | "starting" | "failed";
  lastError: string | null;
  agentCount: number | null;
}

export interface JsonCursorSdk {
  installed: boolean;
  version: string | null;
  path: string | null;
}

export interface JsonMigration {
  state: "none" | "in-progress" | "done" | "failed";
  resultFile: string;
}

export interface ComputerStatusJson {
  home: string;
  socket: string;
  service: JsonServiceState;
  servers: JsonServerRow[];
  agentCount: number | null;
  cursorSdk: JsonCursorSdk;
  hostLifecycleOwner: string | null;
  migration: JsonMigration;
}

function versionString(v: ProcessVersionStatus | undefined): string | null {
  return v?.version ?? null;
}

/** Desktop v1 "Online" rule (status.ts ServerStatusRow.serverConnected). */
function daemonStateOf(row: ServerStatusRow): "online" | "offline" | "starting" | "failed" {
  if (row.daemon.running) return row.serverConnected ? "online" : "starting";
  // A registered but down runner with degraded health reads as failed; the
  // plain offline case stays offline so "stopped by the user" is distinct.
  return row.health === "degraded" ? "failed" : "offline";
}

async function cursorSdkOf(home: string): Promise<JsonCursorSdk> {
  const dir = path.join(home, "runtime", "cursor-sdk");
  try {
    const manifest = await fs.readFile(path.join(dir, "manifest.json"), "utf8");
    const parsed = JSON.parse(manifest) as { version?: unknown };
    return {
      installed: true,
      version: typeof parsed.version === "string" ? parsed.version : null,
      path: dir,
    };
  } catch {
    return { installed: false, version: null, path: null };
  }
}

async function migrationOf(home: string): Promise<JsonMigration> {
  const resultFile = path.join(home, "computer", "migrate-result.json");
  try {
    const raw = await fs.readFile(resultFile, "utf8");
    const parsed = JSON.parse(raw) as { result?: unknown };
    const result = parsed.result;
    if (result === "success") return { state: "done", resultFile };
    if (result === "rolled_back" || result === "failed") return { state: "failed", resultFile };
  } catch {
    /* absent/unreadable → none */
  }
  return { state: "none", resultFile };
}

export async function projectStatusJson(report: ComputerStatusReport): Promise<ComputerStatusJson> {
  const home = report.slockHome;
  const running = report.service.running;
  // The service reports a pid iff a live pidfile exists; a previously-failed
  // run is surfaced through the upgrade/crash channels the report already
  // collects (kept as null here until a dedicated lastError source lands).
  const service: JsonServiceState = {
    state: running ? "running" : "stopped",
    pid: running ? report.service.pid : null,
    version: versionString(report.service.version) ?? report.cliVersion,
    lastError: null,
    desiredState: await readDesiredState(home),
  };
  const servers: JsonServerRow[] = report.servers.map((row) => ({
    serverId: row.serverId,
    slug: row.serverSlug,
    serverUrl: row.serverUrl,
    daemonState: daemonStateOf(row),
    lastError: null,
    agentCount: null,
  }));
  return {
    home,
    socket: path.join(home, "computer", "run", "service.sock"),
    service,
    servers,
    agentCount: null,
    cursorSdk: await cursorSdkOf(home),
    hostLifecycleOwner: report.hostLifecycle?.owner ?? null,
    migration: await migrationOf(home),
  };
}
