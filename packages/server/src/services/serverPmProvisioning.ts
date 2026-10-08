/**
 * Rethink UI phase B — automatic PM agent provisioning.
 *
 * Trigger: the moment a machine persists its reported runtime capabilities
 * (first connect, or any later report while the server still has no PM).
 * Deliberately NOT at attach time: `machines.runtimes` is still null then, so
 * a PM created at attach would fall back to a default runtime that may not
 * exist on this machine and could never start.
 *
 * Conditions (all re-checked here as defense-in-depth for future callers):
 *   1. the machine belongs to the server;
 *   2. the machine's registering user (the attach initiator, immutable on
 *      the machines row) is currently owner/admin on that server;
 *   3. the server has no PM yet (`servers.pm_agent_id IS NULL`).
 *
 * Runtime selection uses ONLY the reported list, in declared preference
 * order. Zero hits -> do not create anything; the PM tab shows manual-setup
 * guidance instead (server-side contract: no PM + capability report seen).
 *
 * Every failure path is swallowed (console.warn + trace event) so the daemon
 * connect / capabilities-persist flow is never affected. A failed attempt
 * simply retries on the next capabilities report.
 *
 * Idempotency & concurrency: `createAgent({ claimServerPm: true })` claims
 * `servers.pm_agent_id` with a conditional update inside the same
 * advisory-lock transaction; a lost race rolls back the whole create
 * (PmAlreadyProvisionedError), so concurrent reports cannot create two PMs.
 *
 * PM identity is written exactly once at creation. No code path ever updates
 * `agents.description` afterwards, so user edits always survive upgrades.
 */
import { eq, sql } from "drizzle-orm";
import { getDefaultModel } from "@botiverse/raft-shared";
import { getDb } from "../db/index.js";
import { machines } from "../db/schema.js";
import { getActorServerRoleInServer } from "../lib/actorPermissions.js";
import { createAgent, PmAlreadyProvisionedError } from "./agentService.js";
import { findOrCreateDM } from "./channelService.js";
import { addTraceEvent } from "../tracing/semanticTrace.js";

/** Standard role description for an auto-provisioned PM. Written once. */
export const PM_ROLE_SPEC_V1 = [
  "你是本 server 的 PM（项目经理），代表用户协调这个 server 上的所有 agent。",
  "职责：",
  "1. 掌握全局：跟踪各条工作线的进展，向用户汇报关键进展与风险。",
  "2. 拆解与派发：把用户的目标拆解为清晰的任务，分派给合适的 agent，并跟进完成情况。",
  "3. 关键事项请示：发版、上生产、删除数据、对外发布等关键事项，先请示用户，获批后再执行。",
  "4. 协作边界：优先在用户分配的任务线程和相关频道里与其他 agent 沟通；给用户发消息保持简洁、结论先行。",
  "用户对你的指示优先于本说明。",
].join("\n");

/** Fixed identity for an auto-provisioned PM (avatar style TBD, not blocking). */
export const PM_IDENTITY = {
  name: "PM",
  displayName: "PM",
  avatarUrl: "pixel:mug",
  description: PM_ROLE_SPEC_V1,
} as const;

/**
 * Preference order over the machine's REPORTED runtime list. Non-deprecated,
 * supported runtimes only (RUNTIMES in raft-shared is the source of truth —
 * keep this in sync when a runtime is added or retired).
 */
export const PM_RUNTIME_PREFERENCE = [
  "claude",
  "codex",
  "cursor-sdk",
  "kimi-sdk",
  "omp",
  "copilot",
  "opencode",
  "grok",
  "builtin",
  "pi",
] as const;

export function selectPmRuntimeFromReported(reportedRuntimes: string[] | null): string | null {
  if (!reportedRuntimes || reportedRuntimes.length === 0) return null;
  const reported = new Set(reportedRuntimes);
  for (const runtime of PM_RUNTIME_PREFERENCE) {
    if (reported.has(runtime)) return runtime;
  }
  return null;
}

/**
 * Provision the server's PM agent if all conditions hold. Never throws.
 * The server is resolved from the machine row. Returns the created agent id,
 * or null when nothing was created (already provisioned, not authorized, or
 * no usable runtime reported).
 */
export async function maybeProvisionServerPm(input: {
  machineId: string;
  io?: {
    to: (room: string) => { emit: (event: string, payload: unknown) => void };
  } | null;
}): Promise<string | null> {
  try {
    const db = getDb();

    // The machine row ties this daemon to its server and its registering
    // user (the attach initiator, immutable on the row).
    const [machine] = await db
      .select({ serverId: machines.serverId, userId: machines.userId, runtimes: machines.runtimes })
      .from(machines)
      .where(eq(machines.id, input.machineId));
    if (!machine) return null;
    const { serverId } = machine;

    // Fast path: nothing to do when a PM already exists (the common case for
    // every capabilities report after the first). Raw SQL on purpose: the
    // pm_agent_id column ships with migration 0275 (phase A); until then the
    // drizzle schema must not reference it (see schema.ts note).
    const [serverRow] = (await db.execute(sql`
      SELECT pm_agent_id, deleted_at
      FROM servers
      WHERE id = ${serverId}
    `)).rows as Array<{ pmAgentId: string | null; deletedAt: Date | string | null }>;
    if (!serverRow || serverRow.deletedAt || serverRow.pmAgentId) return null;

    // The registering user must still be owner/admin — attach enforced this
    // at attach time; re-check for future non-attach callers.
    const role = await getActorServerRoleInServer(serverId, "user", machine.userId);
    if (role !== "owner" && role !== "admin") {
      addTraceEvent("server.pm.auto_provision", {
        surface: "server",
        kind: "internal",
        attrs: { server_id: serverId, machine_id: input.machineId, outcome: "skipped_not_admin" },
      });
      return null;
    }

    const runtime = selectPmRuntimeFromReported(machine.runtimes);
    if (!runtime) {
      // No usable runtime reported: leave PM unset so the client shows
      // manual-setup guidance. Retries on later reports if runtimes appear.
      addTraceEvent("server.pm.auto_provision", {
        surface: "server",
        kind: "internal",
        attrs: { server_id: serverId, machine_id: input.machineId, outcome: "skipped_no_runtime" },
      });
      return null;
    }

    let agentId: string;
    try {
      const agent = await createAgent(serverId, PM_IDENTITY.name, {
        description: PM_IDENTITY.description,
        runtime,
        model: getDefaultModel(runtime),
        machineId: input.machineId,
        avatarUrl: PM_IDENTITY.avatarUrl,
        creatorType: "user",
        creatorId: machine.userId,
        claimServerPm: true,
      });
      agentId = agent.id;
    } catch (err) {
      if (err instanceof PmAlreadyProvisionedError) {
        // Lost the race against a concurrent provision (or a user-set PM that
        // landed between our read and the claim) — nothing to do.
        return null;
      }
      throw err;
    }

    // Make the PM immediately visible as a DM for the provisioning user.
    try {
      const dm = await findOrCreateDM(serverId, machine.userId, agentId);
      if (dm) {
        input.io?.to(`channel:${dm.id}`).emit("dm:new", { channelId: dm.id });
        input.io?.to(`user:${machine.userId}`).emit("dm:new", { channelId: dm.id });
      }
    } catch (dmError) {
      console.warn("pm.auto_provision dm setup failed", dmError);
      // DM setup failure must not fail the provisioning result.
    }

    addTraceEvent("server.pm.auto_provision", {
      surface: "server",
      kind: "internal",
      attrs: {
        server_id: serverId,
        machine_id: input.machineId,
        agent_id: agentId,
        runtime,
        outcome: "created",
      },
    });
    return agentId;
  } catch (err) {
    // Never break the daemon connect / capabilities-persist flow.
    console.warn("pm.auto_provision failed", err);
    addTraceEvent("server.pm.auto_provision", {
      surface: "server",
      kind: "internal",
      attrs: { machine_id: input.machineId, outcome: "error" },
    });
    return null;
  }
}
