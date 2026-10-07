// Session-origin guard: the embedded Computer adopts whatever state root
// resolveRaftHome() picks (~/.slock unless RAFT_HOME/SLOCK_HOME says
// otherwise), and a leftover login session from a DIFFERENT deployment in
// that root must never be silently taken over by a build whose API origin is
// baked at build time. Before any takeover action (converge/start/stop/
// recycle), compare the persisted user session's serverUrl origin with
// CONFIGURED_API_ORIGIN; a mismatch blocks the action so the user is sent to
// explicit deployment connection instead of silently controlling the old
// backend. Recovery authenticates in a separate root; this guard never writes.

import { readFile } from "node:fs/promises";
import { userSessionPath } from "@botiverse/raft-computer/lib";
import { CONFIGURED_API_ORIGIN } from "./configuredApiOrigin.js";

export const SESSION_ORIGIN_MISMATCH_CODE = "SESSION_ORIGIN_MISMATCH";

export interface SessionOriginCheck {
  /**
   * - "ok": persisted session's origin matches the build's configured origin.
   * - "none": no session file on a fresh machine.
   * - "invalid": unreadable/corrupt session; block rather than assume fresh.
   * - "mismatch": session belongs to another deployment — block.
   */
  status: "ok" | "none" | "mismatch" | "invalid";
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
  } catch (error) {
    return { status: (error as NodeJS.ErrnoException).code === "ENOENT" ? "none" : "invalid", configuredOrigin };
  }
  let parsed: { serverUrl?: unknown };
  try {
    parsed = JSON.parse(raw) as { serverUrl?: unknown };
  } catch {
    return { status: "invalid", configuredOrigin };
  }
  const sessionOrigin = originOf(typeof parsed?.serverUrl === "string" ? parsed.serverUrl : undefined);
  if (sessionOrigin === null) return { status: "invalid", configuredOrigin };
  if (sessionOrigin === configuredOrigin) return { status: "ok", configuredOrigin };
  return { status: "mismatch", sessionOrigin, configuredOrigin };
}

export function describeSessionOriginMismatch(check: SessionOriginCheck): string {
  if (check.status === "invalid") return "无法读取本地 Computer 登录信息，未接管服务；请检查状态目录权限或点击“连接当前部署”独立认证。";
  return `本地 Computer 登录在 ${check.sessionOrigin}，当前桌面应用连接 ${check.configuredOrigin}。请点击“连接当前部署”独立认证后再启用这台计算机；旧服务器挂载和数据会保留。`;
}
