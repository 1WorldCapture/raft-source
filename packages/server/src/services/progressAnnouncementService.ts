import { clearClockInterval, currentDate, setClockInterval } from "@botiverse/raft-shared";
import type { Server as SocketServer } from "socket.io";
import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import { getDb } from "../db/index.js";
import { channels, messages, progressAnnouncementState, servers } from "../db/schema.js";
import type { AgentOrchestrator } from "./agentOrchestrator.js";
import * as agentService from "./agentService.js";
import { broadcastAndDeliver, deliverSystemNoticeToAgent } from "./messageService.js";

// Hourly agent progress announcements (announcement channel, phase 2).
//
// Every server with progress announcements enabled is swept on a fixed tick.
// Per agent, by presence:
//   working -> if it has not posted to #announcement (and was not nudged) for an
//              hour, wake it with a system notice carrying the template.
//   idle    -> every full hour since it went idle, the system posts "currently
//              idle" in the agent's name (marked announcement-proxy) and does NOT
//              wake it.
//   offline / unknown -> nothing.
//
// Replicas race on conditional updates of progress_announcement_state: whoever
// wins the UPDATE does the work, so an agent is nudged / proxy-posted once.

export const ANNOUNCEMENT_HOUR_MS = 60 * 60 * 1000;
export const ANNOUNCEMENT_PROXY_KIND = "announcement-proxy";
const DEFAULT_TICK_MS = 5 * 60 * 1000;

type Presence = "working" | "idle" | "offline" | null | undefined;

export type ProgressAnnouncementDeps = {
  now: () => Date;
  /** Presence and its start (ms epoch) for one agent; null presence when unknown. */
  getPresence: (agentId: string) => Promise<{ presence: Presence; presenceSinceMs: number | null }>;
  /** Wake the agent with the template notice. */
  nudge: (input: { serverId: string; agentId: string; channelId: string }) => Promise<void>;
  /** Post "currently idle" in the agent's name. */
  postIdle: (input: { serverId: string; agentId: string; agentName: string; channelId: string; idleSince: Date }) => Promise<void>;
};

export type ProgressAnnouncementTickResult = { servers: number; nudged: number; idlePosted: number };

export function buildNudgeNotice(): string {
  return [
    "[Announcement reminder] You have not posted a progress update to #announcement in the last hour.",
    "Post one now, then carry on with your work:",
    "  raft message send --target \"#announcement\"",
    "Keep it short, in three parts:",
    "  1. Doing now: what you are working on",
    "  2. Done: what you finished in the last hour",
    "  3. Next: what you plan to do next",
    "#announcement is one-way: post a new top-level message, there are no replies or threads.",
  ].join("\n");
}

export function buildIdleAnnouncement(idleSince: Date): string {
  const hh = String(idleSince.getUTCHours()).padStart(2, "0");
  const mm = String(idleSince.getUTCMinutes()).padStart(2, "0");
  return `当前空闲（自 ${hh}:${mm} UTC 起）`;
}

/** Latest message per agent in the channel, split into the agent's own posts and system proxy posts. */
async function lastAnnouncementTimes(channelId: string, agentIds: string[]) {
  const result = new Map<string, { any: Date | null; own: Date | null }>();
  if (agentIds.length === 0) return result;
  const rows = await getDb()
    .select({
      senderId: messages.senderId,
      lastAny: sql<Date | null>`max(${messages.createdAt})`,
      lastOwn: sql<Date | null>`max(${messages.createdAt}) filter (where coalesce(${messages.actionMetadata}->>'kind', '') <> ${ANNOUNCEMENT_PROXY_KIND})`,
    })
    .from(messages)
    .where(and(
      eq(messages.channelId, channelId),
      eq(messages.senderType, "agent"),
      inArray(messages.senderId, agentIds),
    ))
    .groupBy(messages.senderId);
  for (const row of rows) {
    result.set(row.senderId, {
      any: row.lastAny ? new Date(row.lastAny) : null,
      own: row.lastOwn ? new Date(row.lastOwn) : null,
    });
  }
  return result;
}

/** Win (or lose) the right to nudge this agent now. */
async function claimNudge(serverId: string, agentId: string, now: Date): Promise<boolean> {
  const cutoff = new Date(now.getTime() - ANNOUNCEMENT_HOUR_MS);
  const won = await getDb()
    .insert(progressAnnouncementState)
    .values({ agentId, serverId, lastNudgedAt: now, updatedAt: now })
    .onConflictDoUpdate({
      target: progressAnnouncementState.agentId,
      set: { lastNudgedAt: now, serverId, updatedAt: now },
      setWhere: sql`${progressAnnouncementState.lastNudgedAt} IS NULL OR ${progressAnnouncementState.lastNudgedAt} <= ${cutoff}`,
    })
    .returning({ agentId: progressAnnouncementState.agentId });
  return won.length > 0;
}

/**
 * Claim the idle hour `hours` for the idle epoch `idleSince`. Returns true when this
 * caller moved the counter forward (and so owns the post for it).
 */
async function claimIdleHour(serverId: string, agentId: string, idleSince: Date, hours: number, now: Date): Promise<boolean> {
  const db = getDb();
  // A new idle epoch resets the counter; the epoch compare keeps replicas from clobbering each other.
  await db
    .insert(progressAnnouncementState)
    .values({ agentId, serverId, idleSince, idlePostsMade: 0, updatedAt: now })
    .onConflictDoUpdate({
      target: progressAnnouncementState.agentId,
      set: { idleSince, idlePostsMade: 0, serverId, updatedAt: now },
      setWhere: sql`${progressAnnouncementState.idleSince} IS DISTINCT FROM ${idleSince}`,
    });
  const claimed = await db
    .update(progressAnnouncementState)
    .set({ idlePostsMade: hours, updatedAt: now })
    .where(and(
      eq(progressAnnouncementState.agentId, agentId),
      eq(progressAnnouncementState.idleSince, idleSince),
      sql`${progressAnnouncementState.idlePostsMade} < ${hours}`,
    ))
    .returning({ agentId: progressAnnouncementState.agentId });
  return claimed.length > 0;
}

export async function runProgressAnnouncementTick(deps: ProgressAnnouncementDeps): Promise<ProgressAnnouncementTickResult> {
  const db = getDb();
  const now = deps.now();
  const result: ProgressAnnouncementTickResult = { servers: 0, nudged: 0, idlePosted: 0 };

  const enabledServers = await db
    .select({ id: servers.id, channelId: channels.id })
    .from(servers)
    .innerJoin(channels, and(
      eq(channels.serverId, servers.id),
      eq(channels.systemKind, "announcement"),
      isNull(channels.deletedAt),
    ))
    .where(and(eq(servers.progressAnnouncementsEnabled, true), isNull(servers.deletedAt)));

  for (const server of enabledServers) {
    result.servers += 1;
    const agentRows = await agentService.listAgents(server.id, false);
    const lastTimes = await lastAnnouncementTimes(server.channelId, agentRows.map((agent) => agent.id));
    for (const agent of agentRows) {
      try {
        const { presence, presenceSinceMs } = await deps.getPresence(agent.id);
        const last = lastTimes.get(agent.id);
        if (presence === "working") {
          const anchor = last?.any ?? null;
          if (anchor && now.getTime() - anchor.getTime() < ANNOUNCEMENT_HOUR_MS) continue;
          if (!(await claimNudge(server.id, agent.id, now))) continue;
          await deps.nudge({ serverId: server.id, agentId: agent.id, channelId: server.channelId });
          result.nudged += 1;
        } else if (presence === "idle") {
          // Without a trustworthy idle start there is nothing to count hours from.
          if (presenceSinceMs === null) continue;
          const idleSince = new Date(presenceSinceMs);
          const hours = Math.floor((now.getTime() - presenceSinceMs) / ANNOUNCEMENT_HOUR_MS);
          if (hours < 1) continue;
          if (!(await claimIdleHour(server.id, agent.id, idleSince, hours, now))) continue;
          // The agent already told everyone itself within the last hour: advance, do not repeat.
          if (last?.own && now.getTime() - last.own.getTime() < ANNOUNCEMENT_HOUR_MS) continue;
          await deps.postIdle({ serverId: server.id, agentId: agent.id, agentName: agent.name, channelId: server.channelId, idleSince });
          result.idlePosted += 1;
        }
      } catch (error) {
        const message = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
        console.error(`[ProgressAnnouncements] agent ${agent.id} failed`, message.slice(0, 300));
      }
    }
  }
  return result;
}

export function createProgressAnnouncementDeps(input: {
  io: SocketServer;
  orchestrator: AgentOrchestrator;
  now?: () => Date;
}): ProgressAnnouncementDeps {
  return {
    now: input.now ?? currentDate,
    getPresence: async (agentId) => {
      const activity = await input.orchestrator.getActivity(agentId);
      return { presence: activity.presence ?? null, presenceSinceMs: activity.presenceSinceMs ?? null };
    },
    nudge: async ({ serverId, agentId, channelId }) => {
      await deliverSystemNoticeToAgent(input.orchestrator, agentId, {
        serverId,
        channel_id: channelId,
        channel_name: "announcement",
        channel_type: "channel",
        content: buildNudgeNotice(),
      });
    },
    postIdle: async ({ agentId, agentName, channelId, idleSince }) => {
      await broadcastAndDeliver(input.io, input.orchestrator, {
        channelId,
        senderType: "agent",
        senderId: agentId,
        senderName: agentName,
        content: buildIdleAnnouncement(idleSince),
        actionMetadata: { kind: ANNOUNCEMENT_PROXY_KIND },
      });
    },
  };
}

export function startProgressAnnouncementWorker(input: {
  io: SocketServer;
  orchestrator: AgentOrchestrator;
  intervalMs?: number;
}) {
  const deps = createProgressAnnouncementDeps({ io: input.io, orchestrator: input.orchestrator });
  const run = () => {
    runProgressAnnouncementTick(deps).catch((error) => {
      const message = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
      console.error("[ProgressAnnouncements] tick failed", message.slice(0, 500));
    });
  };
  const handle = setClockInterval(run, input.intervalMs ?? DEFAULT_TICK_MS);
  if (typeof handle === "object" && handle && "unref" in handle && typeof handle.unref === "function") handle.unref();
  return {
    stop() {
      clearClockInterval(handle);
    },
  };
}

