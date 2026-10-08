// Rethink UI phase A — server PM role (task #2).
//
// GET   /api/servers/:slug/pm               — PM summary + caller's DM + setup tri-state
// PUT   /api/servers/:slug/pm               — owner/admin sets/replaces the PM (audited)
// POST  /api/servers/:slug/pm/dismiss-setup — owner/admin dismisses the setup guide
//
// The server context is derived from the :slug row (credentials-route
// precedent): callers do not need an X-Server-Id header. Phase B (Anna)
// consumes GET's `setup` tri-state and the auto-create hook; she does NOT
// re-implement these routes. Phase D (May) reads GET on every PM-tab
// foreground refresh — keep it a couple of indexed point lookups.
import { Router, type Router as RouterType } from "express";

import { and, desc, eq, inArray, isNull } from "drizzle-orm";
import { getDb } from "../db/index.js";
import {
  agents,
  channels,
  dmChannelIdentities,
  pmRoleAuditEvents,
  serverMembers,
  servers,
} from "../db/schema.js";
import { getServerBySlug, PM_AUTO_PROVISION_SINCE } from "../services/serverService.js";
import type { ServerPmAgentSummary, ServerPmSetupState } from "@botiverse/raft-shared";
import { requireAuth, requireVerified } from "../middleware/auth.js";

export const pmRouter: RouterType = Router();

/** Returns the server (soft-delete/joint-storage filtered) and caller's role. */
async function loadServerMembership(slug: string, userId: string) {
  const server = await getServerBySlug(slug);
  if (!server) return { server: null, role: null as string | null };
  const db = getDb();
  const [row] = await db
    .select({ role: serverMembers.role })
    .from(serverMembers)
    .where(and(eq(serverMembers.serverId, server.id), eq(serverMembers.userId, userId)))
    .limit(1);
  return { server, role: row?.role ?? null };
}

/**
 * The stored PM, read as "not set" when it points at a soft-deleted agent
 * (agent deletion is soft; FK actions never fire — explicit guard here).
 */
async function loadPmSummary(pmAgentId: string | null): Promise<ServerPmAgentSummary | null> {
  if (!pmAgentId) return null;
  const db = getDb();
  const [row] = await db
    .select({
      agentId: agents.id,
      name: agents.name,
      displayName: agents.displayName,
      avatarUrl: agents.avatarUrl,
      status: agents.status,
      runtime: agents.runtime,
      model: agents.model,
    })
    .from(agents)
    .where(and(eq(agents.id, pmAgentId), isNull(agents.deletedAt)))
    .limit(1);
  return row ?? null;
}

/** Caller's existing (non-deleted) DM with the PM, via the provenance index. */
async function findPmDmChannelId(serverId: string, userId: string, pmAgentId: string): Promise<string | null> {
  const db = getDb();
  // peerKey joins the two participant ids in lexicographic order.
  const peerKeys = [`${userId}:${pmAgentId}`, `${pmAgentId}:${userId}`].sort();
  const [row] = await db
    .select({ channelId: dmChannelIdentities.channelId })
    .from(dmChannelIdentities)
    .innerJoin(channels, eq(channels.id, dmChannelIdentities.channelId))
    .where(and(
      eq(dmChannelIdentities.serverId, serverId),
      eq(dmChannelIdentities.kind, "human_agent"),
      inArray(dmChannelIdentities.peerKey, peerKeys),
      isNull(channels.deletedAt),
    ))
    .orderBy(desc(dmChannelIdentities.createdAt))
    .limit(1);
  return row?.channelId ?? null;
}

pmRouter.get("/:slug/pm", requireAuth, requireVerified, async (req, res) => {
  const userId = req.userId!;
  const { server, role } = await loadServerMembership(String(req.params.slug), userId);
  if (!server) {
    res.status(404).json({ error: "Server not found" });
    return;
  }
  if (!role) {
    res.status(403).json({ error: "You are not a member of this server" });
    return;
  }

  const storedPmId = server.pmAgentId ?? null;
  const pm = await loadPmSummary(storedPmId);
  let setup: ServerPmSetupState;
  if (pm) {
    setup = "set";
  } else if (server.pmSetupDismissedAt) {
    setup = "dismissed";
  } else {
    setup = "unset";
  }
  const dmChannelId = pm && storedPmId
    ? await findPmDmChannelId(server.id, userId, storedPmId)
    : null;

  // Phase B auto-provision eligibility (see PM_AUTO_PROVISION_SINCE): clients
  // use this to pick the guide copy — "connect a computer" for auto servers,
  // "pick an agent manually" for legacy ones.
  const autoProvision = server.createdAt >= PM_AUTO_PROVISION_SINCE;

  res.json({ pm, dmChannelId, setup, autoProvision });
});

pmRouter.put("/:slug/pm", requireAuth, requireVerified, async (req, res) => {
  const userId = req.userId!;
  const { server, role } = await loadServerMembership(String(req.params.slug), userId);
  if (!server) {
    res.status(404).json({ error: "Server not found" });
    return;
  }
  if (role !== "owner" && role !== "admin") {
    res.status(403).json({ error: "Only the server owner or an admin can set the PM" });
    return;
  }

  const agentId = (req.body as { agentId?: unknown } | undefined)?.agentId;
  if (typeof agentId !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(agentId)) {
    res.status(400).json({ error: "agentId (uuid) is required" });
    return;
  }

  const db = getDb();
  // Eligibility = belongs to this server AND not soft-deleted. Runtime
  // status (active/inactive/stopped) is deliberately NOT a criterion:
  // `inactive` is the resting default for most idle agents and freshly
  // auto-created PMs alike (agents are soft-deleted, never hard-deleted, so
  // "deleted" already means the soft flag), and a `stopped` agent is a
  // legitimate pick — the owner can appoint it and start it afterwards; the
  // PM tab simply shows it offline until then.
  const [target] = await db
    .select({ id: agents.id })
    .from(agents)
    .where(and(eq(agents.id, agentId), eq(agents.serverId, server.id), isNull(agents.deletedAt)))
    .limit(1);
  if (!target) {
    res.status(404).json({ error: "Agent not found in this server" });
    return;
  }

  const previousPmId = server.pmAgentId ?? null;
  if (previousPmId === agentId) {
    // Idempotent: same PM again, no audit line.
    const pm = await loadPmSummary(agentId);
    res.json({ pm, changed: false });
    return;
  }

  const updatedAt = new Date();
  const applied = await db.transaction(async (tx) => {
    // Conditional update: a concurrent replace invalidates our CAS anchor and
    // this write becomes a no-op instead of clobbering the winner.
    const updated = await tx
      .update(servers)
      .set({ pmAgentId: agentId, updatedAt })
      .where(and(
        eq(servers.id, server.id),
        isNull(servers.deletedAt),
        previousPmId === null
          ? isNull(servers.pmAgentId)
          : eq(servers.pmAgentId, previousPmId),
      ))
      .returning({ id: servers.id });
    if (updated.length === 0) return false;
    await tx.insert(pmRoleAuditEvents).values({
      serverId: server.id,
      actorType: "user",
      actorId: userId,
      fromAgentId: previousPmId,
      toAgentId: agentId,
    });
    return true;
  });

  if (!applied) {
    // Someone else replaced the PM first — surface the winner, no audit dup.
    const [fresh] = await db
      .select({ pmAgentId: servers.pmAgentId })
      .from(servers)
      .where(eq(servers.id, server.id))
      .limit(1);
    res.json({ pm: await loadPmSummary(fresh?.pmAgentId ?? null), changed: false });
    return;
  }

  res.json({ pm: await loadPmSummary(agentId), changed: true });
});

pmRouter.post("/:slug/pm/dismiss-setup", requireAuth, requireVerified, async (req, res) => {
  const userId = req.userId!;
  const { server, role } = await loadServerMembership(String(req.params.slug), userId);
  if (!server) {
    res.status(404).json({ error: "Server not found" });
    return;
  }
  if (role !== "owner" && role !== "admin") {
    res.status(403).json({ error: "Only the server owner or an admin can dismiss the PM setup guide" });
    return;
  }

  const db = getDb();
  const dismissedAt = new Date();
  await db
    .update(servers)
    .set({ pmSetupDismissedAt: dismissedAt, updatedAt: dismissedAt })
    .where(and(eq(servers.id, server.id), isNull(servers.deletedAt)));
  res.json({ dismissedAt: dismissedAt.toISOString() });
});
