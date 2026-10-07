import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { resolveCursorSdkAssets, verifyCursorSdkAssetsIntegrity } from "../../cursorSdk/assets.js";
import type { NativeAuthReply, NativeAuthRequest } from "../../cursorSdk/nativeAuthHost.js";

export class CursorAuthorizationError extends Error {
  constructor(readonly code: string, message: string) {
    super(message); this.name = "CursorAuthorizationError";
  }
}

export interface NativeAuthCall {
  kind: "verify" | "models" | "login";
  apiKey?: string;
  signal?: AbortSignal;
  onLoginUrl?: (url: string) => void;
}

export function cursorAuthHostEnvironment(base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const key of ["HOME", "USERPROFILE", "PATH", "TMPDIR", "TEMP", "TMP", "SystemRoot", "LANG", "LC_ALL", "HTTPS_PROXY", "https_proxy", "HTTP_PROXY", "http_proxy", "NO_PROXY", "no_proxy", "NODE_EXTRA_CA_CERTS"]) {
    if (base[key]) env[key] = base[key];
  }
  return env;
}

/** Private snapshot in, private result out; no credential-bearing log channel. */
export async function callNativeCursorAuth(input: NativeAuthCall): Promise<NativeAuthReply> {
  if (input.signal?.aborted) throw new CursorAuthorizationError("CURSOR_SDK_ABORTED", "Cursor authorization was cancelled.");
  const assets = resolveCursorSdkAssets();
  const integrity = verifyCursorSdkAssetsIntegrity();
  if (!integrity.ok) throw new CursorAuthorizationError("CURSOR_SDK_ASSET_INTEGRITY", "Cursor runtime files failed integrity verification. Reinstall this Raft preview.");
  const child = spawn(assets.nodePath, [assets.authEntryPath], {
    stdio: ["ignore", "pipe", "pipe", "ipc"], env: cursorAuthHostEnvironment(), windowsHide: true,
  });
  child.stdout?.resume();
  child.stderr?.resume(); // SDK diagnostics may contain login URLs; never forward them.
  const requestId = randomUUID();
  return new Promise<NativeAuthReply>((resolve, reject) => {
    let settled = false;
    let sent = false;
    let killTimer: NodeJS.Timeout | undefined;
    const timer = setTimeout(() => finish(new CursorAuthorizationError(
      input.kind === "login" ? "CURSOR_SDK_LOGIN_OUTCOME_UNKNOWN" : "CURSOR_SDK_AUTH_TIMEOUT",
      input.kind === "login" ? "Cursor login did not complete. A named authorization may have been created; inspect Cursor API keys before retrying." : "Cursor authorization timed out. The bound account was not changed.",
    )), input.kind === "login" ? 10 * 60_000 : 25_000);
    const onAbort = () => finish(new CursorAuthorizationError("CURSOR_SDK_ABORTED", "Cursor authorization was cancelled."));
    function stopChild(): void {
      if (child.connected) {
        try { child.send({ tag: "raft-cursor-auth-ipc", v: 1, requestId: randomUUID(), kind: "shutdown" } satisfies NativeAuthRequest); } catch { /* terminate below */ }
      }
      if (child.exitCode === null && child.signalCode === null) {
        child.kill("SIGTERM");
        killTimer = setTimeout(() => { if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL"); }, 1000);
        killTimer.unref();
      }
    }
    function finish(error?: Error, reply?: NativeAuthReply): void {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      input.signal?.removeEventListener("abort", onAbort);
      stopChild();
      if (error) reject(error); else resolve(reply!);
    }
    child.on("message", (value: unknown) => {
      if (settled || !value || typeof value !== "object") return;
      const frame = value as NativeAuthReply;
      if (frame.tag !== "raft-cursor-auth-ipc" || frame.v !== 1) return;
      if (frame.kind === "ready" && !sent) {
        sent = true;
        try {
          child.send({ tag: "raft-cursor-auth-ipc", v: 1, requestId, kind: input.kind, ...(input.apiKey !== undefined ? { apiKey: input.apiKey } : {}) } satisfies NativeAuthRequest,
            (error) => { if (error) finish(new CursorAuthorizationError("CURSOR_SDK_AUTH_HOST_FAILED", "Cursor authorization IPC failed.")); });
        } catch { finish(new CursorAuthorizationError("CURSOR_SDK_AUTH_HOST_FAILED", "Cursor authorization host could not accept the request.")); }
        return;
      }
      if (frame.requestId !== requestId) return;
      if (frame.kind === "login_url") {
        const url = typeof frame.url === "string" ? frame.url : "";
        try {
          const parsed = new URL(url);
          if (parsed.protocol !== "https:" || parsed.hostname !== "cursor.com" || parsed.pathname !== "/loginDeepControl" || parsed.username || parsed.password || parsed.port || parsed.searchParams.has("verifier")) throw new Error();
          input.onLoginUrl?.(url);
        } catch { finish(new CursorAuthorizationError("CURSOR_SDK_LOGIN_URL_REJECTED", "Cursor returned an invalid login URL.")); }
        return;
      }
      if (frame.kind === "invalid" || frame.kind === "error") {
        const classification = ["NetworkError", "ConfigurationError", "RateLimitError", "AuthenticationError", "TypeError", "OtherError"].includes(String(frame.errorType)) ? String(frame.errorType) : frame.code === "account_unsupported" ? "account_unsupported" : "request_failed";
        finish(new CursorAuthorizationError(frame.kind === "invalid" ? "CURSOR_SDK_LOGIN_INVALID" : "CURSOR_SDK_AUTH_FAILED",
          frame.kind === "invalid" ? "Cursor rejected this connection's credential. Reconnect explicitly; another account was not selected." : `Cursor authorization could not complete (${classification}). Check connectivity and account policy.`));
      } else if (frame.kind === "verified" || frame.kind === "models_result") finish(undefined, frame);
    });
    child.once("error", () => finish(new CursorAuthorizationError("CURSOR_SDK_AUTH_HOST_FAILED", "The verified Cursor authorization host could not start.")));
    child.once("exit", () => { if (killTimer) clearTimeout(killTimer); finish(new CursorAuthorizationError("CURSOR_SDK_AUTH_HOST_FAILED", "The Cursor authorization host exited without a result.")); });
    input.signal?.addEventListener("abort", onAbort, { once: true });
    if (input.signal?.aborted) onAbort();
  });
}
