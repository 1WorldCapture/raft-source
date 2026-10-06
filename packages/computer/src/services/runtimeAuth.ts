// Cursor SDK runtime-auth — Computer domain service seam (AUTH worker).
//
// Wraps the daemon's credential broker (`@botiverse/raft-daemon/core`)
// behind the Computer service contract: typed opts + result, best-effort
// `onEvent`, AbortSignal, and `ComputerServiceError { code, message }` on
// failure. Like LoginService, the service never touches stdout/stderr and
// never performs an interactive login implicitly — browser login exists
// only through the explicit `login` control.
//
// The broker is loaded from the built daemon core (same dynamic-import
// contract as service.ts); tests inject the surface directly so they never
// depend on a daemon build. The broker's own redlines hold underneath:
// borrowed SDK store never deleted/revoked, strict principal/source binding,
// numeric user ids only, no secrets in errors.

import { ComputerServiceError } from "./errors.js";
import type { ComputerApiEvent } from "../lib/events.js";

/** Structural surface the daemon core must export for this service. */
export interface CursorRuntimeAuthBroker {
  connectExistingCursorSdkOwner?(
    input: { slockHome: string; signal?: AbortSignal },
  ): Promise<{ principalId: string; connectionId: string; generation: number; backendUrl: string; email: string | null }>;
  loginCursorSdkOwner(
    input: { slockHome: string },
    options: { signal?: AbortSignal; onEvent?: (event: { kind: "login-url"; url: string }) => void },
    deps?: unknown,
  ): Promise<{
    principalId: string;
    connectionId: string;
    generation: number;
    backendUrl: string;
    email: string | null;
  }>;
  getCursorSdkAuthStatus(
    input: { slockHome: string },
    deps?: unknown,
  ): Promise<{
    status: "bound" | "bound_stale_key" | "unbound" | "login_missing" | "invalid_store" | "disconnected";
    source: "cursor_sdk_store" | "raft_owned" | "owner_environment";
    borrowed: boolean;
    principalId?: string;
    connectionId?: string;
    generation?: number;
    backendUrl?: string;
    email?: string;
    apiKeyExpiresAtMs?: number;
  }>;
  logoutCursorSdkOwner(
    input: { slockHome: string },
    deps?: unknown,
  ): Promise<{
    status: "cleared" | "not-bound";
    sdkLoginPreserved: true;
    sdkStorePath: string;
  }>;
}

export interface CursorRuntimeAuthDeps {
  /** Injected broker surface (tests). */
  broker?: CursorRuntimeAuthBroker;
  /** Loader used once per call when no broker is injected. */
  loadBroker?: () => Promise<CursorRuntimeAuthBroker>;
}

async function resolveBroker(deps: CursorRuntimeAuthDeps): Promise<CursorRuntimeAuthBroker> {
  if (deps.broker) return deps.broker;
  const load = deps.loadBroker ?? defaultLoadBroker;
  try {
    return await load();
  } catch (err) {
    if (err instanceof ComputerServiceError) throw err;
    throw new ComputerServiceError(
      "RAFT_DAEMON_UNAVAILABLE",
      "The Raft daemon core could not be loaded for Cursor SDK authentication. " +
        "Run `pnpm --filter @botiverse/raft-daemon build` and retry.",
      err,
    );
  }
}

async function defaultLoadBroker(): Promise<CursorRuntimeAuthBroker> {
  const core = (await import("@botiverse/raft-daemon/core")) as Partial<CursorRuntimeAuthBroker> & {
    CursorCredentialError?: unknown;
  };
  if (
    typeof core.loginCursorSdkOwner !== "function" ||
    typeof core.getCursorSdkAuthStatus !== "function" ||
    typeof core.logoutCursorSdkOwner !== "function"
  ) {
    throw new ComputerServiceError(
      "RAFT_DAEMON_UNAVAILABLE",
      "This Raft daemon build does not expose the Cursor SDK auth controls. " +
        "Update Raft Computer (and its bundled daemon) to a version with the `cursor-sdk` runtime.",
    );
  }
  return core as CursorRuntimeAuthBroker;
}

async function viaBroker<T>(deps: CursorRuntimeAuthDeps, run: (broker: CursorRuntimeAuthBroker) => Promise<T>): Promise<T> {
  const broker = await resolveBroker(deps);
  try {
    return await run(broker);
  } catch (err) {
    // The broker's own typed errors carry closed CURSOR_SDK_* codes with
    // secret-free, actionable messages: pass code + message through 1:1.
    if (err instanceof ComputerServiceError) throw err;
    if (err instanceof Error && err.name === "AbortError") throw err;
    if (isBrokerTypedError(err)) {
      throw new ComputerServiceError(err.code, err.message);
    }
    throw err;
  }
}

function isBrokerTypedError(err: unknown): err is { code: string; message: string } {
  return (
    typeof err === "object" &&
    err !== null &&
    typeof (err as { code?: unknown }).code === "string" &&
    typeof (err as { message?: unknown }).message === "string" &&
    String((err as { code?: unknown }).code).startsWith("CURSOR_SDK_")
  );
}

// --- result surfaces ---

export type CursorRuntimeAuthLoginResult = Awaited<ReturnType<CursorRuntimeAuthBroker["loginCursorSdkOwner"]>>;
export type CursorRuntimeAuthStatusResult = Awaited<ReturnType<CursorRuntimeAuthBroker["getCursorSdkAuthStatus"]>>;
export type CursorRuntimeAuthLogoutResult = Awaited<ReturnType<CursorRuntimeAuthBroker["logoutCursorSdkOwner"]>>;

export interface CursorRuntimeAuthOptions {
  signal?: AbortSignal;
  onEvent?: (event: ComputerApiEvent) => void;
}

// --- controls ---

/** Explicitly reuse a verified saved connection without a browser or new key. */
export function cursorRuntimeAuthConnectExisting(
  input: { slockHome: string },
  options: CursorRuntimeAuthOptions = {},
  deps: CursorRuntimeAuthDeps = {},
): Promise<CursorRuntimeAuthLoginResult> {
  return viaBroker(deps, (broker) => {
    if (!broker.connectExistingCursorSdkOwner) throw new ComputerServiceError("RAFT_DAEMON_UNAVAILABLE", "This Computer cannot reuse the saved Cursor login. Update Raft Computer.");
    return broker.connectExistingCursorSdkOwner({ slockHome: input.slockHome, signal: options.signal });
  });
}

/** Explicit browser login for the cursor-sdk runtime (owner action). */
export function cursorRuntimeAuthLogin(
  input: { slockHome: string },
  options: CursorRuntimeAuthOptions = {},
  deps: CursorRuntimeAuthDeps = {},
): Promise<CursorRuntimeAuthLoginResult> {
  return viaBroker(deps, (broker) =>
    broker.loginCursorSdkOwner(
      { slockHome: input.slockHome },
      {
        signal: options.signal,
        onEvent: (event) => {
          if (event.kind === "login-url") {
            // URL reaches the owner callback only; never logged here.
            emit(options, { kind: "cursor-sdk.login-url", url: event.url });
          }
        },
      },
    ),
  );
}

/** Offline auth status for the cursor-sdk runtime (read-only). */
export function cursorRuntimeAuthStatus(
  input: { slockHome: string },
  deps: CursorRuntimeAuthDeps = {},
): Promise<CursorRuntimeAuthStatusResult> {
  return viaBroker(deps, (broker) => broker.getCursorSdkAuthStatus({ slockHome: input.slockHome }));
}

/** Clear ONLY the local binding; the borrowed SDK login is preserved. */
export function cursorRuntimeAuthLogout(
  input: { slockHome: string },
  deps: CursorRuntimeAuthDeps = {},
): Promise<CursorRuntimeAuthLogoutResult> {
  return viaBroker(deps, (broker) => broker.logoutCursorSdkOwner({ slockHome: input.slockHome }));
}

function emit(options: CursorRuntimeAuthOptions, event: ComputerApiEvent): void {
  const cb = options.onEvent;
  if (!cb) return;
  try {
    cb(event);
  } catch {
    // onEvent is best-effort — a listener fault must not break the flow.
  }
}
