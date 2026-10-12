import { PROVIDER_CONNECTIONS_FEATURE_FLAG_KEY } from "@botiverse/raft-shared";
import { type DatabaseExecutor, getDb } from "../db/index.js";
import { evaluateFeatureFlag } from "./featureFlagService.js";

export async function isProviderConnectionsEnabled(
  serverId: string,
  executor: DatabaseExecutor = getDb(),
): Promise<boolean> {
  const evaluation = await evaluateFeatureFlag({
    key: PROVIDER_CONNECTIONS_FEATURE_FLAG_KEY,
    serverId,
  }, executor);
  return evaluation.enabled;
}

/** Probes reuse the provider-connections flag. There is no separate probe flag. */
export async function isProviderProbesEnabled(
  serverId: string,
  executor: DatabaseExecutor = getDb(),
): Promise<boolean> {
  return isProviderConnectionsEnabled(serverId, executor);
}

/**
 * Kept as an alias of the connections flag so callers can name the
 * enforcement question. This card does not retire server-side /test or model
 * catalog I/O when the flag is on.
 */
export async function isProviderProbeEnforcementEnabled(
  serverId: string,
  executor: DatabaseExecutor = getDb(),
): Promise<boolean> {
  return isProviderConnectionsEnabled(serverId, executor);
}
