/**
 * Where a managed Computer runs, self-reported in the daemon `ready` frame.
 *
 * - `desktop_app`: embedded in the Raft desktop app. Its version ships with the
 *   desktop release, so it cannot be upgraded on its own.
 * - `standalone`: the independently installed `raft-computer` CLI.
 *
 * The value is client-reported and unauthenticated. The server may only use it
 * to suppress upgrade prompts / remote upgrades (the safe direction) and must
 * never use it to grant anything. Missing or unknown values normalize to
 * `standalone`, so older Computers keep their existing behavior.
 */
export const COMPUTER_HOST_KINDS = ["desktop_app", "standalone"] as const;
export type ComputerHostKind = (typeof COMPUTER_HOST_KINDS)[number];
export const DEFAULT_COMPUTER_HOST_KIND: ComputerHostKind = "standalone";

export function normalizeComputerHostKind(value: unknown): ComputerHostKind {
  return (COMPUTER_HOST_KINDS as readonly unknown[]).includes(value)
    ? (value as ComputerHostKind)
    : DEFAULT_COMPUTER_HOST_KIND;
}
