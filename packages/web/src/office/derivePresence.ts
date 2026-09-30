/**
 * Temporary copy of DevJayson's shared `derivePresence` (branch tip 4c36406,
 * packages/shared/src/agentPresence.ts). Task #4 will land that module.
 * When it is on dev, delete this file and import from shared instead.
 */

export const AGENT_PRESENCES = ["working", "idle", "offline"] as const;
export type AgentPresence = (typeof AGENT_PRESENCES)[number];

export interface DerivePresenceInput {
  /** Raw activity frame value. Unknown strings degrade to "idle". */
  activity: string | null | undefined;
  /**
   * Agent lifecycle status ("active" | "inactive" | "stopped"). Null/undefined
   * means "unknown" and does NOT trigger the offline branch — only a known
   * non-active status proves the agent should read as offline.
   */
  lifecycleStatus?: string | null | undefined;
  /**
   * Hosting machine reachability ("online" | "offline"). Null/undefined means
   * "unknown" and does NOT trigger the offline branch — only a known offline
   * machine proves the agent is unobservable through that machine.
   */
  machineStatus?: string | null | undefined;
}

/**
 * Pure presence projection. Offline facts win in a fixed order (offline frame,
 * then lifecycle, then machine), then the activity maps onto working/idle.
 * Unknown activity values degrade to "idle" so a schema drift never fabricates
 * an offline state.
 */
export function derivePresence(input: DerivePresenceInput): AgentPresence {
  const activity = input.activity;
  if (activity === "offline") return "offline";
  if (input.lifecycleStatus && input.lifecycleStatus !== "active") return "offline";
  if (input.machineStatus === "offline") return "offline";
  if (activity === "thinking" || activity === "working") return "working";
  return "idle";
}
