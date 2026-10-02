import type { RequestHandler } from "express";
import { and, eq, isNull } from "drizzle-orm";
import { agentCredentials } from "../db/schema.js";
import { DelegationError, readConnection, requireAgent, withAgentTransaction } from "../services/agentTransactionAuthority.js";

// This registry is deliberately independent from GET/POST and capability.
// Legacy history, claims and diagnostic lists can consume bodies or mutate
// cursors. Phase A admits only identity through this old router; delegated
// activation APIs have their own transaction-bound service entry points.
export const guardLegacyAgentConsumption: RequestHandler = async (req, res, next) => {
  if (req.principalKind !== "agent_credential") { next(); return; }
  const { actingAgentId: agentId, serverId, agentCredentialId: credentialId } = req;
  if (!agentId || !serverId || !credentialId) { res.status(401).json({ code: "agent_identity_missing" }); return; }
  try {
    await withAgentTransaction([agentId], async (context) => {
      await requireAgent(context, { agentId, serverId });
      const [credential] = await context.tx.select({ id: agentCredentials.id }).from(agentCredentials)
        .where(and(eq(agentCredentials.id, credentialId), eq(agentCredentials.agentId, agentId), isNull(agentCredentials.revokedAt))).limit(1);
      if (!credential) throw new DelegationError("credential_denied", 403);
      const connection = await readConnection(context, agentId);
      if (connection?.consumptionMode === "delegated" && !(req.method === "GET" && req.path === "/")) {
        throw new DelegationError("delegated_legacy_route_unsupported", 403);
      }
    });
    next();
  } catch (error) {
    if (error instanceof DelegationError) { res.status(error.status).json({ code: error.code }); return; }
    next(error);
  }
};
