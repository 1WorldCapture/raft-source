// Owner sign-in coordinator for remote (web-triggered) Cursor SDK logins.
//
// One machine runs one daemon, so a single in-flight login is enough: repeat
// login requests while a sign-in is pending return the SAME loginUrl (the
// user may not have opened the browser yet) instead of spawning a second
// native authorization host. The authorization wait is capped at
// CURSOR_SDK_LOGIN_TIMEOUT_MS; the web client observes completion by polling
// the (sanitized) status, which flips to "bound" once the broker persists the
// new binding.

import { randomUUID } from "node:crypto";
import { resolveRaftHome } from "../../raftHome.js";
import { CursorAuthorizationError } from "./nativeAuthClient.js";
import {
  getCursorSdkAuthStatus,
  loginCursorSdkOwner,
  type NativeBrokerDeps,
} from "./nativeCredentialBroker.js";

/** Total window for one web-triggered sign-in, including browser authorization. */
export const CURSOR_SDK_LOGIN_TIMEOUT_MS = 10 * 60_000;
/** How long a login request waits for the native host to hand back the URL. */
const LOGIN_URL_WAIT_MS = 30_000;
/** How long a repeat request waits for the pending session's URL. */
const LOGIN_URL_REUSE_WAIT_MS = 5_000;

export type CursorSdkLoginStart =
  | { ok: true; loginUrl: string; reused: boolean }
  | { ok: false; errorCode: "login_in_progress" | "failed"; message: string };

type LoginOutcome = { ok: true } | { ok: false; errorCode: string; message: string };

interface LoginSession {
  startedAtMs: number;
  abort: AbortController;
  id: string;
  urlReady: Promise<string | null>;
  currentUrl: () => string | null;
  finished: Promise<LoginOutcome>;
}

/** Sanitized status for the web: five closed values, no credential metadata. */
export type CursorSdkStatusSummary = {
  status: "unbound" | "bound" | "bound_stale_key" | "disconnected" | "error";
  source: "cursor_sdk_store" | "raft_owned" | "owner_environment";
};

export async function cursorSdkStatusSummary(
  input: { slockHome?: string } = {},
  deps: NativeBrokerDeps = {},
): Promise<CursorSdkStatusSummary> {
  const full = await getCursorSdkAuthStatus({ slockHome: input.slockHome ?? resolveRaftHome() }, deps);
  const status = full.status === "unbound" || full.status === "login_missing"
    ? "unbound" as const
    : full.status === "invalid_store"
      ? "error" as const
      : full.status;
  return { status, source: full.source };
}

export class CursorSdkLoginCoordinator {
  private session: LoginSession | null = null;
  private readonly timeoutMs: number;

  constructor(options: { timeoutMs?: number } = {}) {
    this.timeoutMs = options.timeoutMs ?? CURSOR_SDK_LOGIN_TIMEOUT_MS;
  }

  hasActiveSession(nowMs = Date.now()): boolean {
    return this.session !== null && nowMs - this.session.startedAtMs < this.timeoutMs;
  }

  /**
   * Start a sign-in, or re-report the pending session's URL. Returns as soon
   * as the authorization URL is known (or the attempt failed early); browser
   * completion is observed via status polling, not by holding this call open.
   */
  async begin(input: { slockHome?: string } = {}, deps: NativeBrokerDeps = {}): Promise<CursorSdkLoginStart> {
    if (this.hasActiveSession() && this.session) {
      const pending = this.session;
      const url = await Promise.race([
        pending.urlReady,
        new Promise<null>((resolve) => setTimeout(() => resolve(null), LOGIN_URL_REUSE_WAIT_MS)),
      ]);
      if (url) return { ok: true, loginUrl: url, reused: true };
      return {
        ok: false,
        errorCode: "login_in_progress",
        message: "A Cursor sign-in is already in progress on this machine. Complete it in the browser; the model list refreshes once authorization finishes.",
      };
    }

    const slockHome = input.slockHome ?? resolveRaftHome();
    const abort = new AbortController();
    const sessionId = randomUUID();
    let currentUrl: string | null = null;
    let resolveUrl: (url: string | null) => void = () => {};
    const urlReady = new Promise<string | null>((resolve) => { resolveUrl = resolve; });
    const timeout = setTimeout(() => abort.abort(new Error("cursor login timeout")), this.timeoutMs);
    const finished = (async (): Promise<LoginOutcome> => {
      try {
        await loginCursorSdkOwner({ slockHome }, {
          signal: abort.signal,
          onEvent: (event) => {
            if (event.kind !== "login-url" || currentUrl !== null) return;
            currentUrl = event.url;
            resolveUrl(event.url);
          },
        }, deps);
        return { ok: true };
      } catch (error) {
        return {
          ok: false,
          errorCode: error instanceof CursorAuthorizationError ? error.code : "CURSOR_SDK_LOGIN_FAILED",
          message: error instanceof Error ? error.message : String(error),
        };
      } finally {
        clearTimeout(timeout);
        resolveUrl(currentUrl);
        if (this.session?.id === sessionId) this.session = null;
      }
    })();
    const session: LoginSession = {
      startedAtMs: Date.now(),
      abort,
      id: sessionId,
      urlReady,
      currentUrl: () => currentUrl,
      finished,
    };
    this.session = session;

    const url = await Promise.race([
      urlReady,
      new Promise<null>((resolve) => setTimeout(() => resolve(null), LOGIN_URL_WAIT_MS)),
    ]);
    if (url) return { ok: true, loginUrl: url, reused: false };
    // No URL within the wait window: surface an already-settled early failure,
    // otherwise the sign-in is still spinning up — report it as in progress.
    const settled = await Promise.race([session.finished, new Promise<null>((resolve) => setTimeout(() => resolve(null), 0))]);
    if (settled && !settled.ok) return { ok: false, errorCode: "failed", message: settled.message };
    return {
      ok: false,
      errorCode: "login_in_progress",
      message: "The Cursor sign-in is starting. Retry in a moment to receive the authorization link.",
    };
  }
}
