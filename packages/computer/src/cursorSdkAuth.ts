// `raft-computer cursor-sdk login|status|logout` — CLI presenters over the
// ComputerApi cursor-sdk auth controls (AUTH worker, minimal owner-facing
// wiring). The service logic lives in services/runtimeAuth.ts; these
// presenters own the human surface: the browser login URL, the borrowed
// login guarantee, and secret-free failure text.
import { info, present } from "./output.js";
import { formatRaftHomeForDisplay, resolveRaftHome } from "./paths.js";
import { createComputerApi } from "./lib/api.js";
import { canInstallEnterToOpenUrl, installEnterToOpenUrl, openUrlInBrowser } from "./browserHandoff.js";
import type { CursorRuntimeAuthDeps } from "./services/runtimeAuth.js";

export type RunCursorSdkLoginOptions = {
  orchestrated?: boolean;
  reuseExisting?: boolean;
  input?: NodeJS.ReadableStream;
  openUrl?: (url: string) => void;
  deps?: CursorRuntimeAuthDeps;
};

export async function runCursorSdkLogin(opts: RunCursorSdkLoginOptions = {}): Promise<void> {
  if (process.env.VITEST && !opts.openUrl && !opts.reuseExisting) {
    throw new Error("HERMETIC_BROWSER_VIOLATION: cursor-sdk login tests must inject openUrl before login starts");
  }
  const api = createComputerApi(resolveHomeForApi());
  const input = opts.input ?? process.stdin;
  const openUrl = opts.openUrl ?? openUrlInBrowser;
  let cleanupEnterToOpen: (() => void) | undefined;
  const abort = new AbortController();
  const cancel = () => abort.abort();
  process.once("SIGINT", cancel);
  try {
  await present(async () => {
    const result = opts.reuseExisting ? await api.cursorSdkConnect({ signal: abort.signal, deps: opts.deps }) : await api.cursorSdkLogin(
      (event) => {
        if (event.kind === "cursor-sdk.login-url") {
          try {
            openUrl(event.url);
          } catch {
            // Best-effort convenience; the URL is printed below regardless.
          }
          info("To finish signing in to Cursor, open this link in a browser:");
          info(`  ${event.url}`);
          info("Keep this command running — sign-in completes here automatically.");
          if (canInstallEnterToOpenUrl(input)) {
            cleanupEnterToOpen = installEnterToOpenUrl({ input, url: event.url, openUrl });
          }
        }
      },
      { deps: opts.deps, signal: abort.signal },
    );
    if (!opts.orchestrated) {
      info(`Cursor SDK bound to Cursor user ${result.principalId} (connection ${result.connectionId.slice(0, 10)}…, generation ${result.generation}).`);
      if (result.email) info(`Signed in as ${result.email}.`);
      info(opts.reuseExisting ? "The existing Cursor login is borrowed read-only." : "A separate Raft authorization was saved locally; the shared Cursor SDK login was not changed.");
    }
  });
  } finally {
    cleanupEnterToOpen?.();
    process.removeListener("SIGINT", cancel);
  }
}

/**
 * Verify + bind the already-saved Cursor SDK login without a browser and
 * without minting a new key (the design's default first-use path, made
 * explicit for owners).
 */
export async function runCursorSdkConnect(deps?: CursorRuntimeAuthDeps): Promise<void> {
  const api = createComputerApi(resolveHomeForApi());
  await present(async () => {
    const result = await api.cursorSdkConnect({ deps });
    info(`Cursor bound to Cursor user ${result.principalId} (connection ${result.connectionId.slice(0, 10)}…, generation ${result.generation}).`);
    info("Used the saved Cursor SDK login as-is; nothing was written to it.");
  });
}

export async function runCursorSdkStatus(deps?: CursorRuntimeAuthDeps): Promise<void> {
  const api = createComputerApi(resolveHomeForApi());
  await present(async () => {
    const status = await api.cursorSdkStatus(deps);
    switch (status.status) {
      case "disconnected":
        info("cursor-sdk: disconnected from Raft — this machine explicitly signed out of the Cursor runtime.");
        info("Reconnect with `raft-computer runtime auth connect cursor` (or `login cursor` for a fresh browser sign-in). Background launches will not rebind it.");
        break;
      case "bound":
        info(
          `cursor-sdk: bound to Cursor user ${status.principalId}${status.email ? ` (${status.email})` : ""} ` +
            `— connection ${status.connectionId?.slice(0, 10)}…, generation ${status.generation}.`,
        );
        break;
      case "bound_stale_key":
        info(
          `cursor-sdk: binding exists for Cursor user ${status.principalId}, but the Cursor SDK login changed ` +
            `since it was verified. The next agent start re-verifies it (same user rotates; a different user fails closed).`,
        );
        break;
      case "unbound":
        info("cursor-sdk: a Cursor SDK login exists, but this Raft home is not bound to it yet.");
        info("It will be verified and bound on first use, or run `raft-computer runtime auth connect cursor`.");
        break;
      case "login_missing":
        info("cursor-sdk: no Cursor SDK login found on this machine.");
        info("Run `raft-computer runtime auth login cursor` to sign in with your Cursor account.");
        break;
      case "invalid_store":
        info("cursor-sdk: the Cursor login file is not usable. Run `raft-computer runtime auth login cursor`.");
        break;
    }
    if (status.apiKeyExpiresAtMs) {
      const expiry = new Date(status.apiKeyExpiresAtMs).toISOString();
      info(`Cursor SDK login key expires at ${expiry}.`);
    }
    info(`Credential source: ${status.source} (${status.borrowed ? "borrowed read-only" : "Raft-owned authorization"}). Local logout is not remote key revocation.`);
  });
}

export async function runCursorSdkLogout(deps?: CursorRuntimeAuthDeps): Promise<void> {
  const api = createComputerApi(resolveHomeForApi());
  await present(async () => {
    const result = await api.cursorSdkLogout(deps);
    if (result.status === "cleared") {
      info("Disconnected this machine's Cursor runtime binding.");
      info(`The shared Cursor login (${result.sdkStorePath}) was left untouched — Raft never revokes it.`);
    } else {
      info("No Cursor runtime binding is present (nothing to clear).");
      info(`The shared Cursor login (${result.sdkStorePath}) is untouched.`);
    }
  });
}

// The cursor-sdk commands are machine-scoped (one binding per Raft home),
// so they bind the API to the same home every other command uses.
function resolveHomeForApi(): string {
  return resolveRaftHome();
}

export { formatRaftHomeForDisplay };
