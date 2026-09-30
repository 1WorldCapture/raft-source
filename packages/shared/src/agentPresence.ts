import type { AgentActivityKind } from "./index.js";

/**
 * User-visible presence projected from the raw agent activity plus lifecycle
 * and machine facts. Presence collapses the five raw activity values into the
 * three states the dashboard overview needs:
 * - "working": the agent is actively producing (thinking / working frames)
 * - "idle": reachable and healthy but not producing (online / error frames)
 * - "offline": not observable (offline frame, non-active lifecycle, or the
 *   hosting machine being unreachable)
 */
export const AGENT_PRESENCES = ["working", "idle", "offline"] as const;
export type AgentPresence = (typeof AGENT_PRESENCES)[number];

export const isAgentPresence = (value: unknown): value is AgentPresence =>
  value === "working" || value === "idle" || value === "offline";

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
  // Falsy (null/undefined/"") means "unknown" and must not fabricate an
  // offline state; every known non-active status proves offline.
  if (input.lifecycleStatus && input.lifecycleStatus !== "active") return "offline";
  if (input.machineStatus === "offline") return "offline";
  if (activity === "thinking" || activity === "working") return "working";
  // online / error / unknown → reachable-or-unknown, not producing.
  return "idle";
}

/** Convenience overload accepting already-typed activity values. */
export function derivePresenceFromActivity(
  activity: AgentActivityKind,
  lifecycleStatus?: string | null,
  machineStatus?: string | null,
): AgentPresence {
  return derivePresence({ activity, lifecycleStatus, machineStatus });
}
