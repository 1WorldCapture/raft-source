import type { OfficePresence } from "./agentOverview";

/** First boundary starts the middle tier; second starts the long tier. */
export interface TierThresholds {
  working: { midMs: number; longMs: number };
  idle: { midMs: number; longMs: number };
  offline: { midMs: number; longMs: number };
}

const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;

/** Configurable. Defaults: work 30m/2h, idle 30m/3h, offline 1h/12h. */
export const OFFICE_TIER_THRESHOLDS: TierThresholds = {
  working: { midMs: 30 * MINUTE, longMs: 2 * HOUR },
  idle: { midMs: 30 * MINUTE, longMs: 3 * HOUR },
  offline: { midMs: 1 * HOUR, longMs: 12 * HOUR },
};

export type DurationTier = 0 | 1 | 2;

/**
 * Duration against a server-calibrated clock.
 * `receivedAt` is the client clock when `serverTime` was observed.
 */
export function calibratedNow(serverTime: number, receivedAt: number, now = Date.now()): number {
  return serverTime + (now - receivedAt);
}

/** Null since stays null. Never invent a timestamp. */
export function presenceDurationMs(presenceSince: number | null, nowMs: number): number | null {
  if (presenceSince == null) return null;
  return Math.max(0, nowMs - presenceSince);
}

/**
 * 0 short, 1 mid, 2 long.
 * Unknown duration (null since) draws the first tier.
 */
export function durationTier(
  presence: OfficePresence,
  durationMs: number | null,
  thresholds: TierThresholds = OFFICE_TIER_THRESHOLDS,
): DurationTier {
  if (durationMs == null) return 0;
  const bounds = thresholds[presence];
  if (durationMs < bounds.midMs) return 0;
  if (durationMs < bounds.longMs) return 1;
  return 2;
}
