import { and, asc, eq, inArray, isNull, or, sql, type SQL } from "drizzle-orm";
import type { ServerId, TaskStatus } from "@botiverse/raft-shared";
import { getDb } from "../db/index.js";
import { agents, channels, tasks, users } from "../db/schema.js";
import { canUserAccessChannel } from "./channelService.js";
import { buildMessageSnippet } from "@botiverse/raft-shared/src/messageSnippet.js";
import { resolveTaskChannelSurface, type TaskSurfaceChannel } from "./taskChannelSurface.js";
import {
  enrichTaskRows,
  projectTasksToChannel,
  toServerTaskSummary,
  type ServerTaskSummary,
} from "./taskService.js";

/**
 * Board read for `GET /api/tasks/server?view=board` (#mobile-tasks-ux task #1).
 *
 * One page = tasks ordered by most recent activity, each with the thread facts
 * a progress board needs (latest activity, reply count, the caller's unread
 * count and whether they were directly mentioned since their last reply).
 *
 * Shape of the work, so it stays O(1) queries in the number of tasks:
 * 1. resolve the caller's visible task surfaces (per channel, same access
 *    check as the legacy list, now including private channels they belong to);
 * 2. one ranking query over every visible task computes `lastActivityAt`,
 *    applies the keyset cursor and returns the page's ids;
 * 3. one stats query computes the per-thread facts for just that page;
 * 4. the existing enrich/summary path renders the task rows.
 */

export const TASK_BOARD_DEFAULT_LIMIT = 100;
export const TASK_BOARD_MAX_LIMIT = 200;
export const TASK_BOARD_MAX_IDS = 50;
export const TASK_BOARD_SNIPPET_MAX_CHARS = 120;

export interface TaskBoardCursor {
  /** lastActivityAt as integer microseconds since epoch (full Postgres precision). */
  activityMicros: string;
  id: string;
}

export interface TaskBoardActivity {
  kind: "reply" | "task_event";
  at: string;
  actorType: "user" | "agent" | "system" | "external_projection";
  actorId: string | null;
  actorName: string | null;
  snippet: string | null;
  eventType: string | null;
}

export interface TaskBoardItem extends ServerTaskSummary {
  threadChannelId: string | null;
  lastActivityAt: string;
  latestActivity: TaskBoardActivity | null;
  replyCount: number;
  unreadCount: number;
  mentionsMe: boolean;
}

export interface TaskBoardOptions {
  statuses?: TaskStatus[];
  limit?: number;
  cursor?: TaskBoardCursor | null;
  completedAfter?: Date | null;
  ids?: string[] | null;
}

/** Plain-text, single-line reply preview (shared `buildMessageSnippet`). */
export function buildTaskActivitySnippet(content: string, maxChars = TASK_BOARD_SNIPPET_MAX_CHARS): string {
  return buildMessageSnippet(content, maxChars);
}

type BoardSurface = { storageChannelId: string; localChannel: TaskSurfaceChannel };

/**
 * Task surfaces the caller can read: public, joint and private channels
 * (private only when they are a member — `canUserAccessChannel` decides, so
 * guest rules apply unchanged). DMs, threads and archived channels are out.
 */
async function listVisibleBoardSurfaces(serverId: string, userId: string): Promise<BoardSurface[]> {
  const db = getDb();
  const serverChannels = await db
    .select({ id: channels.id })
    .from(channels)
    .where(and(
      eq(channels.serverId, serverId),
      or(eq(channels.type, "channel"), eq(channels.type, "joint"), eq(channels.type, "private")),
      isNull(channels.archivedAt),
    ))
    .orderBy(asc(channels.name), asc(channels.id));

  const surfaces = await Promise.all(serverChannels.map(async (channel) => {
    if (!await canUserAccessChannel(channel.id, userId, serverId as ServerId)) return null;
    const surface = await resolveTaskChannelSurface(serverId, channel.id);
    return surface ? { storageChannelId: surface.storageChannelId, localChannel: surface.localChannel } : null;
  }));
  return surfaces.filter((surface): surface is BoardSurface => surface !== null);
}

type RankedRow = {
  id: string;
  threadChannelId: string | null;
  activityMicros: string;
  lastActivityAt: string;
};

type StatsRow = {
  id: string;
  replyCount: number;
  unreadCount: number;
  mentionsMe: boolean;
  replyAt: string | null;
  replySenderType: string | null;
  replySenderId: string | null;
  replyContent: string | null;
  eventType: string | null;
  eventActorType: string | null;
  eventActorId: string | null;
  eventAt: string | null;
};

function idList(ids: string[]): SQL {
  return sql.join(ids.map((id) => sql`${id}::uuid`), sql`, `);
}

function toIso(value: string | Date | null): string | null {
  if (value == null) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

export async function listBoardTasks(
  serverId: string,
  userId: string,
  options: TaskBoardOptions = {},
): Promise<{ tasks: TaskBoardItem[]; nextCursor: TaskBoardCursor | null }> {
  const surfaces = await listVisibleBoardSurfaces(serverId, userId);
  if (surfaces.length === 0) return { tasks: [], nextCursor: null };
  const surfaceByStorage = new Map(surfaces.map((surface) => [surface.storageChannelId, surface]));

  const byIds = options.ids != null;
  if (byIds && options.ids!.length === 0) return { tasks: [], nextCursor: null };
  const limit = byIds ? options.ids!.length : (options.limit ?? TASK_BOARD_DEFAULT_LIMIT);

  const conditions: SQL[] = [sql`t.channel_id IN (${idList([...surfaceByStorage.keys()])})`];
  if (options.statuses && options.statuses.length > 0) {
    conditions.push(sql`t.status IN (${sql.join(options.statuses.map((s) => sql`${s}`), sql`, `)})`);
  }
  if (options.completedAfter) {
    conditions.push(sql`(t.status NOT IN ('done', 'closed') OR t.completed_at >= ${options.completedAfter.toISOString()}::timestamptz)`);
  }
  if (byIds) conditions.push(sql`t.id IN (${idList(options.ids!)})`);

  const cursorCondition = !byIds && options.cursor
    ? sql`WHERE (r.activity_micros, r.id) < (${options.cursor.activityMicros}::bigint, ${options.cursor.id}::uuid)`
    : sql``;

  const db = getDb();
  // Ranking pass over every visible task: only index-backed "latest reply"
  // lookups (messages(channel_id, seq)), so it stays cheap; the heavier stats
  // run for the page only. The latest reply is the highest seq; its
  // created_at is what lastActivityAt reports.
  const ranked = (await db.execute(sql`
    SELECT
      r.id::text AS "id",
      r.thread_id::text AS "threadChannelId",
      r.activity_micros::text AS "activityMicros",
      r.last_activity_at AS "lastActivityAt"
    FROM (
      SELECT
        t.id,
        thr.id AS thread_id,
        GREATEST(t.updated_at, COALESCE(lr.created_at, t.updated_at)) AS last_activity_at,
        (EXTRACT(EPOCH FROM GREATEST(t.updated_at, COALESCE(lr.created_at, t.updated_at))) * 1000000)::bigint AS activity_micros
      FROM tasks t
      LEFT JOIN LATERAL (
        SELECT c.id
        FROM channels c
        WHERE c.type = 'thread'
          AND c.deleted_at IS NULL
          AND c.parent_message_id = t.message_id
        ORDER BY c.created_at ASC, c.id ASC
        LIMIT 1
      ) thr ON t.message_id IS NOT NULL
      LEFT JOIN LATERAL (
        SELECT m.created_at
        FROM messages m
        WHERE m.channel_id = thr.id
          AND m.message_type <> 'system'
        ORDER BY m.seq DESC
        LIMIT 1
      ) lr ON thr.id IS NOT NULL
      WHERE ${sql.join(conditions, sql` AND `)}
    ) r
    ${cursorCondition}
    ORDER BY r.activity_micros DESC, r.id DESC
    LIMIT ${limit + 1}
  `)).rows as RankedRow[];

  const hasMore = !byIds && ranked.length > limit;
  const pageRows = ranked.slice(0, limit);
  if (pageRows.length === 0) return { tasks: [], nextCursor: null };

  const statsById = new Map<string, StatsRow>();
  // Stats for the page. Unread follows the badge rule (after the caller's read
  // cursor, not their own messages, no system rows) but does NOT require a
  // thread follow: the board is for watching delegated work.
  const statsRows = (await db.execute(sql`
    WITH page(task_id, thread_id) AS (
      VALUES ${sql.join(pageRows.map((row) => sql`(${row.id}::uuid, ${row.threadChannelId}::uuid)`), sql`, `)}
    )
    SELECT
      p.task_id::text AS "id",
      COALESCE(stats.reply_count, 0)::int AS "replyCount",
      COALESCE(unread.n, 0)::int AS "unreadCount",
      COALESCE(men.flag, false) AS "mentionsMe",
      lr.created_at AS "replyAt",
      lr.sender_type AS "replySenderType",
      lr.sender_id AS "replySenderId",
      lr.content AS "replyContent",
      ev.event_type AS "eventType",
      ev.actor_type AS "eventActorType",
      ev.actor_id AS "eventActorId",
      ev.created_at AS "eventAt"
    FROM page p
    LEFT JOIN LATERAL (
      SELECT count(*)::int AS reply_count
      FROM messages m
      WHERE m.channel_id = p.thread_id AND m.message_type <> 'system'
    ) stats ON p.thread_id IS NOT NULL
    LEFT JOIN LATERAL (
      SELECT m.created_at, m.sender_type, m.sender_id, left(m.content, 4000) AS content
      FROM messages m
      WHERE m.channel_id = p.thread_id AND m.message_type <> 'system'
      ORDER BY m.seq DESC
      LIMIT 1
    ) lr ON p.thread_id IS NOT NULL
    LEFT JOIN user_channel_read_cursors rc
      ON rc.channel_id = p.thread_id AND rc.user_id = ${userId}::uuid
    LEFT JOIN LATERAL (
      SELECT count(*)::int AS n
      FROM messages m
      WHERE m.channel_id = p.thread_id
        AND m.seq > COALESCE(rc.last_read_seq, 0)
        AND m.message_type <> 'system'
        AND NOT (m.sender_type = 'user' AND m.sender_id = ${userId})
    ) unread ON p.thread_id IS NOT NULL
    LEFT JOIN LATERAL (
      SELECT max(m.seq) AS seq
      FROM messages m
      WHERE m.channel_id = p.thread_id AND m.sender_type = 'user' AND m.sender_id = ${userId}
    ) mine ON p.thread_id IS NOT NULL
    LEFT JOIN LATERAL (
      SELECT true AS flag
      FROM message_mentions mm
      WHERE mm.target_type = 'user'
        AND mm.target_id = ${userId}::uuid
        AND mm.channel_id = p.thread_id
        AND mm.message_seq > COALESCE(mine.seq, 0)
      LIMIT 1
    ) men ON p.thread_id IS NOT NULL
    LEFT JOIN LATERAL (
      SELECT e.event_type, e.actor_type, e.actor_id, e.created_at
      FROM task_events e
      WHERE e.task_id = p.task_id
      ORDER BY e.seq DESC
      LIMIT 1
    ) ev ON TRUE
  `)).rows as StatsRow[];
  for (const row of statsRows) statsById.set(row.id, row);

  // Render the task rows through the same enrich/project/summary path as the
  // summary list, so board items are a strict superset of summary items.
  const taskRows = await db.select().from(tasks).where(inArray(tasks.id, pageRows.map((row) => row.id)));
  const enriched = await enrichTaskRows(taskRows);
  const summaryById = new Map<string, ServerTaskSummary>();
  for (const task of enriched) {
    const surface = surfaceByStorage.get(task.channelId);
    if (!surface) continue;
    summaryById.set(task.id, toServerTaskSummary(projectTasksToChannel([task], surface.localChannel)[0]!));
  }

  const actorNames = await loadActorNames(statsRows);

  const items: TaskBoardItem[] = [];
  for (const row of pageRows) {
    const summary = summaryById.get(row.id);
    if (!summary) continue;
    const stats = statsById.get(row.id);
    items.push({
      ...summary,
      threadChannelId: row.threadChannelId,
      lastActivityAt: toIso(row.lastActivityAt) ?? summary.updatedAt,
      latestActivity: stats ? pickLatestActivity(stats, actorNames) : null,
      replyCount: stats?.replyCount ?? 0,
      unreadCount: stats?.unreadCount ?? 0,
      mentionsMe: stats?.mentionsMe ?? false,
    });
  }

  const last = pageRows[pageRows.length - 1]!;
  return {
    tasks: items,
    nextCursor: hasMore ? { activityMicros: last.activityMicros, id: last.id } : null,
  };
}

function actorKey(type: string | null, id: string | null): string | null {
  return type && id ? `${type}:${id}` : null;
}

async function loadActorNames(rows: StatsRow[]): Promise<Map<string, string>> {
  const userIds = new Set<string>();
  const agentIds = new Set<string>();
  const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  for (const row of rows) {
    for (const [type, id] of [[row.replySenderType, row.replySenderId], [row.eventActorType, row.eventActorId]] as const) {
      if (!id || !uuid.test(id)) continue;
      if (type === "user") userIds.add(id);
      if (type === "agent") agentIds.add(id);
    }
  }
  const db = getDb();
  const names = new Map<string, string>();
  if (userIds.size > 0) {
    const found = await db.select({ id: users.id, name: users.name, displayName: users.displayName })
      .from(users).where(inArray(users.id, [...userIds]));
    for (const u of found) names.set(`user:${u.id}`, u.displayName || u.name || "User");
  }
  if (agentIds.size > 0) {
    const found = await db.select({ id: agents.id, name: agents.name, displayName: agents.displayName })
      .from(agents).where(inArray(agents.id, [...agentIds]));
    for (const a of found) names.set(`agent:${a.id}`, a.displayName || a.name || "Agent");
  }
  return names;
}

function pickLatestActivity(stats: StatsRow, names: Map<string, string>): TaskBoardActivity | null {
  const replyAt = toIso(stats.replyAt);
  const eventAt = toIso(stats.eventAt);
  if (replyAt && (!eventAt || replyAt >= eventAt)) {
    const key = actorKey(stats.replySenderType, stats.replySenderId);
    return {
      kind: "reply",
      at: replyAt,
      actorType: (stats.replySenderType ?? "user") as TaskBoardActivity["actorType"],
      actorId: stats.replySenderId,
      actorName: key ? names.get(key) ?? null : null,
      snippet: buildTaskActivitySnippet(stats.replyContent ?? ""),
      eventType: null,
    };
  }
  if (eventAt) {
    const key = actorKey(stats.eventActorType, stats.eventActorId);
    return {
      kind: "task_event",
      at: eventAt,
      actorType: (stats.eventActorType ?? "system") as TaskBoardActivity["actorType"],
      actorId: stats.eventActorId,
      actorName: stats.eventActorType === "system" ? "System" : key ? names.get(key) ?? null : null,
      snippet: null,
      eventType: stats.eventType,
    };
  }
  return null;
}

export function encodeTaskBoardCursor(cursor: TaskBoardCursor): string {
  return Buffer.from(JSON.stringify({ a: cursor.activityMicros, i: cursor.id }), "utf8").toString("base64url");
}

export function decodeTaskBoardCursor(raw: string): TaskBoardCursor | null {
  try {
    const parsed = JSON.parse(Buffer.from(raw, "base64url").toString("utf8")) as { a?: unknown; i?: unknown };
    if (typeof parsed?.a !== "string" || !/^-?\d{1,20}$/.test(parsed.a)) return null;
    if (typeof parsed?.i !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(parsed.i)) return null;
    return { activityMicros: parsed.a, id: parsed.i };
  } catch {
    return null;
  }
}
