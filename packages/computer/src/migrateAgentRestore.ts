// Agent restore across migrate-home (task: "迁移后自动恢复迁移前在跑的 agent").
//
// The server is the ONLY authority on which agents were running and what
// they run with: before the migration stops the tree we snapshot the
// machine-assigned roster (`GET /internal/machine/agents`, machine auth
// from the per-server attachment key) and keep the agents whose status was
// `active`. After the new service is online we restart exactly those agents
// through the server (`POST /internal/machine/agents/:id/start`) — the same
// orchestrator.startAgent path the Start button and wake delivery use, so
// the dispatched configs and session ids always come from the server, never
// from a local cache (PM review 2026-10-10: a locally-cached self-start
// would bypass the server and desync its state).
import { readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";

import { listServerAttachments, type ServerAttachment } from "./serverState.js";
import { computerFetch } from "./proxy.js";

export const MIGRATE_RESTORE_AGENTS_FILE = "migrate-restore-agents.json";

/** One recorded agent: only what restore needs — identity + where it lives. */
export interface RecordedAgent {
  agentId: string;
  name: string | null;
  runtime: string | null;
  serverId: string;
}

export interface RunningAgentsRecord {
  schemaVersion: 1;
  fetchedAt: string;
  agents: RecordedAgent[];
}

/** Restore outcome per agent — the shape embedded into migrate-result.json. */
export interface AgentRestoreOutcome {
  agentId: string;
  name: string | null;
  outcome: "restored" | "already-running" | "missing-from-roster" | "start-failed" | "not-active-after-timeout";
  detail?: string;
}

export interface AgentRestoreReport {
  recorded: number;
  restored: string[];
  failed: AgentRestoreOutcome[];
}

export interface MachineAgentView {
  id: string;
  name?: unknown;
  displayName?: unknown;
  status?: unknown;
  activity?: unknown;
  runtime?: unknown;
}

export type MachineApi = (
  serverUrl: string,
  apiKey: string,
  path: string,
  init?: { method?: string },
) => Promise<{ status: number; json: () => Promise<unknown> }>;

export interface MigrateAgentRestoreDeps {
  fetchImpl?: MachineApi;
  listAttachments?: (slockHome: string) => Promise<ServerAttachment[]>;
  sleep?: (ms: number) => Promise<void>;
  now?: () => Date;
  /** Bound for "start accepted → agent observed active". */
  restoreTimeoutMs?: number;
  restorePollMs?: number;
  signal?: { aborted: boolean };
}

export function migrateRestoreAgentsPath(slockHome: string): string {
  return path.join(slockHome, "computer", MIGRATE_RESTORE_AGENTS_FILE);
}

async function loadAttachments(
  slockHome: string,
  deps: MigrateAgentRestoreDeps,
): Promise<ServerAttachment[]> {
  const list = deps.listAttachments ?? listServerAttachments;
  try {
    return await list(slockHome);
  } catch {
    return []; // unreadable attachment state — no server to ask, no agents to restore
  }
}

function defaultMachineApi(): MachineApi {
  return async (serverUrl, apiKey, apiPath, init) => {
    const res = await computerFetch(new URL(apiPath, serverUrl).toString(), {
      method: init?.method ?? "GET",
      headers: { Authorization: `Bearer ${apiKey}` },
    });
    const status = res.status;
    return { status, json: async () => { try { return await res.json(); } catch { return null; } } };
  };
}

/** Decode the /internal/machine/agents roster; malformed entries are skipped
 *  rather than trusted (the endpoint is server-owned but the parse is ours). */
export function parseMachineAgents(body: unknown): MachineAgentView[] {
  if (!Array.isArray(body)) return [];
  const out: MachineAgentView[] = [];
  for (const entry of body) {
    if (typeof entry !== "object" || entry === null) continue;
    const agent = entry as Record<string, unknown>;
    if (typeof agent.id !== "string" || agent.id.length === 0) continue;
    out.push({
      id: agent.id,
      name: agent.name,
      displayName: agent.displayName,
      status: agent.status,
      activity: agent.activity,
      runtime: agent.runtime,
    });
  }
  return out;
}

function agentStatus(view: MachineAgentView): string | null {
  return typeof view.status === "string" ? view.status : null;
}

function agentLabel(view: MachineAgentView): string | null {
  if (typeof view.displayName === "string" && view.displayName.length > 0) return view.displayName;
  if (typeof view.name === "string" && view.name.length > 0) return view.name;
  return null;
}

/** Snapshot the agents that are running right now, one merged roster across
 *  every attached server. Never throws: a server that cannot be asked simply
 *  contributes nothing (its agents are reported by `serversUnreachable`). */
export async function recordRunningAgents(
  slockHome: string,
  deps: MigrateAgentRestoreDeps = {},
): Promise<{ record: RunningAgentsRecord; serversUnreachable: string[] }> {
  const fetchImpl = deps.fetchImpl ?? defaultMachineApi();
  const attachments = await loadAttachments(slockHome, deps);
  const agents: RecordedAgent[] = [];
  const serversUnreachable: string[] = [];
  for (const attachment of attachments) {
    try {
      const res = await fetchImpl(attachment.serverUrl, attachment.apiKey, "/internal/machine/agents");
      if (res.status !== 200) {
        serversUnreachable.push(attachment.serverId);
        continue;
      }
      for (const view of parseMachineAgents(await res.json())) {
        if (agentStatus(view) !== "active") continue; // only what was really running
        agents.push({
          agentId: view.id,
          name: agentLabel(view),
          runtime: typeof view.runtime === "string" ? view.runtime : null,
          serverId: attachment.serverId,
        });
      }
    } catch {
      serversUnreachable.push(attachment.serverId);
    }
  }
  return {
    record: {
      schemaVersion: 1,
      fetchedAt: (deps.now ?? (() => new Date()))().toISOString(),
      agents,
    },
    serversUnreachable,
  };
}

export async function writeRunningAgentsRecord(
  slockHome: string,
  record: RunningAgentsRecord,
): Promise<void> {
  const file = migrateRestoreAgentsPath(slockHome);
  await writeFile(file, `${JSON.stringify(record, null, 2)}\n`, "utf8");
}

export async function readRunningAgentsRecord(slockHome: string): Promise<RunningAgentsRecord | null> {
  let raw: string;
  try {
    raw = await readFile(migrateRestoreAgentsPath(slockHome), "utf8");
  } catch {
    return null; // no record — nothing was running (or a pre-restore migration)
  }
  try {
    const parsed = JSON.parse(raw) as RunningAgentsRecord;
    if (parsed?.schemaVersion !== 1 || !Array.isArray(parsed.agents)) return null;
    return parsed;
  } catch {
    return null;
  }
}

export async function removeRunningAgentsRecord(slockHome: string): Promise<void> {
  await rm(migrateRestoreAgentsPath(slockHome), { force: true });
}

/** Restart every recorded agent through the server and wait until each is
 *  active again. The report names every agent that did NOT come back — the
 *  self-check turns that into an explicit failure instead of a silent gap.
 *
 *  EVERY recorded agent gets an explicit start — never skip on a roster that
 *  says "active": after an unclean daemon death the server's status AND
 *  activity can both be stale (drill 2026-10-10: process gone, roster still
 *  active+online, nothing wakes it). orchestrator.startAgent is idempotent —
 *  on a genuinely running agent it rebinds, exactly like the Start button. */
export async function restoreRecordedAgents(
  slockHome: string,
  record: RunningAgentsRecord,
  deps: MigrateAgentRestoreDeps = {},
): Promise<AgentRestoreReport> {
  const fetchImpl = deps.fetchImpl ?? defaultMachineApi();
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const now = deps.now ?? (() => new Date());
  const timeoutMs = deps.restoreTimeoutMs ?? 90_000;
  const pollMs = deps.restorePollMs ?? 3_000;

  const attachments = await loadAttachments(slockHome, deps);
  const byServer = new Map<string, ServerAttachment>();
  for (const attachment of attachments) byServer.set(attachment.serverId, attachment);

  const report: AgentRestoreReport = { recorded: record.agents.length, restored: [], failed: [] };
  if (record.agents.length === 0) return report;

  for (const agent of record.agents) {
    const attachment = byServer.get(agent.serverId);
    if (!attachment) {
      report.failed.push({ ...agent, outcome: "missing-from-roster", detail: "server attachment not found after migration" });
      continue;
    }
    let roster: MachineAgentView[] | null = null;
    try {
      const res = await fetchImpl(attachment.serverUrl, attachment.apiKey, "/internal/machine/agents");
      roster = res.status === 200 ? parseMachineAgents(await res.json()) : null;
    } catch {
      roster = null;
    }
    const view = roster?.find((candidate) => candidate.id === agent.agentId) ?? null;
    if (!view) {
      report.failed.push({ ...agent, outcome: "missing-from-roster", detail: "agent no longer assigned to this machine" });
      continue;
    }
    try {
      const res = await fetchImpl(attachment.serverUrl, attachment.apiKey, `/internal/machine/agents/${agent.agentId}/start`, { method: "POST" });
      if (res.status !== 200) {
        const body = (await res.json().catch(() => null)) as { error?: unknown } | null;
        const detail = typeof body?.error === "string" ? body.error : `HTTP ${res.status}`;
        report.failed.push({ ...agent, outcome: "start-failed", detail });
      }
    } catch (error) {
      report.failed.push({ ...agent, outcome: "start-failed", detail: (error as Error).message });
    }
  }

  // Wait for every started agent to surface as active. Agents that already
  // failed their start keep their failure; only the pending ones are polled.
  const pending = record.agents.filter(
    (agent) => !report.failed.some((entry) => entry.agentId === agent.agentId),
  );
  const deadline = now().getTime() + timeoutMs;
  const unsettled = new Set(pending.map((agent) => agent.agentId));
  while (unsettled.size > 0) {
    if (deps.signal?.aborted) {
      // Cancellation (SIGTERM / deadline): name what never came back instead
      // of letting it silently pass as restored.
      for (const agentId of unsettled) {
        const agent = record.agents.find((a) => a.agentId === agentId)!;
        report.failed.push({ ...agent, outcome: "not-active-after-timeout", detail: "aborted by cancellation" });
      }
      unsettled.clear();
      break;
    }
    await sleep(pollMs);
    for (const attachment of attachments) {
      const mine = [...unsettled].filter((agentId) => record.agents.find((a) => a.agentId === agentId)?.serverId === attachment.serverId);
      if (mine.length === 0) continue;
      let roster: MachineAgentView[];
      try {
        const res = await fetchImpl(attachment.serverUrl, attachment.apiKey, "/internal/machine/agents");
        roster = res.status === 200 ? parseMachineAgents(await res.json()) : [];
      } catch {
        continue; // transient — retry on the next poll until the deadline
      }
      for (const agentId of mine) {
        const view = roster.find((candidate) => candidate.id === agentId);
        if (view && agentStatus(view) === "active") {
          unsettled.delete(agentId);
          report.restored.push(agentId);
        }
      }
    }
    if (unsettled.size > 0 && now().getTime() >= deadline) {
      for (const agentId of unsettled) {
        const agent = record.agents.find((a) => a.agentId === agentId)!;
        report.failed.push({ ...agent, outcome: "not-active-after-timeout", detail: `not active after ${timeoutMs}ms` });
      }
      unsettled.clear();
    }
  }
  return report;
}
