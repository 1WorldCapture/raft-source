// Session-origin guard: the embedded Computer adopts whatever state root
// resolveRaftHome() picks (~/.slock unless RAFT_HOME/SLOCK_HOME says
// otherwise), and a leftover login session from a DIFFERENT deployment in
// that root must never be silently taken over by a build whose API origin is
// baked at build time. Before any takeover action (converge/start/stop/
// recycle), compare the persisted user session's serverUrl origin with
// CONFIGURED_API_ORIGIN; a mismatch blocks the action so the user is sent to
// re-login instead of the app driving a Computer that talks to a stranger
// backend. Sessions are never deleted or rewritten here — re-login (enable)
// is the explicit migration path.

import { readFile } from "node:fs/promises";
import { userSessionPath } from "@botiverse/raft-computer/lib";
import { CONFIGURED_API_ORIGIN } from "./configuredApiOrigin.js";

export const SESSION_ORIGIN_MISMATCH_CODE = "SESSION_ORIGIN_MISMATCH";

export interface SessionOriginCheck {
  /**
   * - "ok": persisted session's origin matches the build's configured origin.
   * - "none": no readable session (fresh machine, or session without a
   *   parsable serverUrl) — nothing to protect, takeover may proceed.
   * - "mismatch": session belongs to another deployment — block.
   */
  status: "ok" | "none" | "mismatch";
  sessionOrigin?: string;
  configuredOrigin: string;
}

function originOf(raw: string | undefined): string | null {
  if (typeof raw !== "string" || raw.trim() === "") return null;
  try {
    return new URL(raw.trim()).origin;
  } catch {
    return null;
  }
}

export async function checkSessionOrigin(
  slockHome: string,
  configuredOrigin: string = CONFIGURED_API_ORIGIN,
  deps: { readFile?: typeof readFile } = {},
): Promise<SessionOriginCheck> {
  const read = deps.readFile ?? readFile;
  let raw: string;
  try {
    raw = await read(userSessionPath(slockHome), "utf8");
  } catch {
    return { status: "none", configuredOrigin };
  }
  let parsed: { serverUrl?: unknown };
  try {
    parsed = JSON.parse(raw) as { serverUrl?: unknown };
  } catch {
    // An unparseable session carries no origin evidence to protect.
    return { status: "none", configuredOrigin };
  }
  const sessionOrigin = originOf(typeof parsed.serverUrl === "string" ? parsed.serverUrl : undefined);
  if (sessionOrigin === null) return { status: "none", configuredOrigin };
  if (sessionOrigin === configuredOrigin) return { status: "ok", configuredOrigin };
  return { status: "mismatch", sessionOrigin, configuredOrigin };
}

export function describeSessionOriginMismatch(check: SessionOriginCheck): string {
  return `This Mac's local Computer session belongs to ${check.sessionOrigin}, `
    + `but this build of Raft Desktop is configured for ${check.configuredOrigin}. `
    + `Sign out of the old deployment and sign in to ${check.configuredOrigin} before using This Computer.`;
}
