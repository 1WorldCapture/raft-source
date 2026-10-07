import { createHash } from "node:crypto";
import type { Cursor as CursorClass, SdkLoginResult } from "@cursor/sdk";

type CursorApi = typeof CursorClass;
export interface NativeAuthRequest {
  tag: "raft-cursor-auth-ipc";
  v: 1;
  requestId: string;
  kind: "verify" | "models" | "login" | "shutdown";
  apiKey?: string;
}
export type NativeAuthReply = Record<string, unknown> & { tag: "raft-cursor-auth-ipc"; v: 1; requestId: string; kind: string };

export function isNativeAuthRequest(value: unknown): value is NativeAuthRequest {
  if (!value || typeof value !== "object") return false;
  const v = value as Record<string, unknown>;
  return v.tag === "raft-cursor-auth-ipc" && v.v === 1 && typeof v.requestId === "string" && v.requestId.length <= 128
    && ["verify", "models", "login", "shutdown"].includes(String(v.kind))
    && (v.apiKey === undefined || (typeof v.apiKey === "string" && v.apiKey.length <= 16384));
}

export class NativeCursorAuthHost {
  private readonly signal = new AbortController();
  private busy = false;
  constructor(private readonly deps: {
    cursor(): Promise<CursorApi>;
    post(reply: NativeAuthReply): void;
    close?(): void;
  }) {}

  async receive(request: NativeAuthRequest): Promise<void> {
    const base = { tag: "raft-cursor-auth-ipc" as const, v: 1 as const, requestId: request.requestId };
    if (request.kind === "shutdown") {
      this.signal.abort();
      this.deps.post({ ...base, kind: "shutdown_ack" });
      this.deps.close?.();
      return;
    }
    if (this.busy || this.signal.signal.aborted) {
      this.deps.post({ ...base, kind: "error", code: "busy", message: "Cursor authorization host is busy or closing." });
      return;
    }
    this.busy = true;
    try {
      const cursor = await this.deps.cursor();
      let key = request.apiKey;
      let login: SdkLoginResult | undefined;
      if (request.kind === "login") {
        // Explicit owner action only. Never overwrite the user's shared SDK
        // login. The caller atomically persists this returned key privately.
        login = await cursor.auth.login({
          backendUrl: "https://api2.cursor.sh", websiteUrl: "https://cursor.com",
          openBrowser: false, store: null, signal: this.signal.signal,
          apiKeyName: `Raft Computer ${request.requestId}`,
          onLoginUrl: (url) => { this.deps.post({ ...base, kind: "login_url", url }); },
        });
        key = login.apiKey;
      }
      if (!key || key.length > 16384) throw Object.assign(new Error(), { name: "AuthenticationError" });
      // All calls use the exact private snapshot from the Broker. Neither
      // environment variables nor a concurrently changed auth file can select
      // another identity between verification and model discovery.
      const me = await cursor.me({ apiKey: key });
      if (typeof me.userId !== "number" || !Number.isSafeInteger(me.userId) || me.userId <= 0) {
        this.deps.post({ ...base, kind: "error", code: "account_unsupported", message: "A personal Cursor account is required for this preview." });
        return;
      }
      const identity = {
        principalId: String(me.userId), backendUrl: "https://api2.cursor.sh",
        keyFingerprint: `sha256:${createHash("sha256").update(key).digest("hex").slice(0, 24)}`,
        accountKind: "user", ...(me.userEmail ? { email: me.userEmail } : {}),
      };
      if (request.kind === "models") {
        const models = await cursor.models.list({ apiKey: key });
        this.deps.post({ ...base, kind: "models_result", ...identity,
          models: models.map((model) => ({ id: model.id, label: model.displayName || model.id, isDefault: model.id === "default" })),
        });
      } else {
        this.deps.post({ ...base, kind: "verified", ...identity,
          // This field is legal ONLY on private Node IPC, never UI/status.
          ...(login ? { apiKey: login.apiKey, apiKeyExpiresAtMs: login.apiKeyExpiresAtMs } : {}),
        });
      }
    } catch (error) {
      const name = (error as { name?: string })?.name;
      const code = (error as { code?: unknown })?.code;
      const auth = name === "AuthenticationError" || code === "unauthenticated" || code === 16 || code === 401;
      this.deps.post({ ...base, kind: auth ? "invalid" : "error",
        code: this.signal.signal.aborted ? "cancelled" : auth ? "authentication_failed" : "provider_unavailable",
        errorType: ["NetworkError", "ConfigurationError", "RateLimitError", "AuthenticationError", "TypeError"].includes(String(name)) ? name : "OtherError",
        message: this.signal.signal.aborted ? "Cursor login was cancelled." : auth ? "Cursor rejected the supplied credential." : "Cursor authorization request failed. Retry after checking connectivity or account policy.",
        reason: auth ? "authentication_failed" : "provider_unavailable", keyFingerprint: "sha256:unavailable",
      });
    } finally { this.busy = false; }
  }

  abort(): void { this.signal.abort(); }
}

export function startNativeCursorAuthHost(): void {
  if (!process.send) throw new Error("Cursor auth host requires a private IPC channel");
  for (const name of ["CURSOR_API_KEY", "CURSOR_AUTH_TOKEN", "CURSOR_API_BASE_URL", "CURSOR_BACKEND_URL", "CURSOR_WEBSITE_URL", "NODE_OPTIONS", "NODE_PATH", "NODE_TLS_REJECT_UNAUTHORIZED"]) delete process.env[name];
  // The default REST API and login/RPC backends are distinct. Setting
  // CURSOR_BACKEND_URL=api2.cursor.sh misroutes REST /v1/me. Keep the SDK's
  // paired production defaults; only auth.login gets its scoped backendUrl.
  let vendor: Promise<typeof import("@cursor/sdk")> | undefined;
  const host = new NativeCursorAuthHost({
    cursor: async () => (await (vendor ??= import("@cursor/sdk"))).Cursor,
    post: (reply) => { if (process.connected) process.send?.(reply); },
    close: () => { setImmediate(() => process.exit(0)); },
  });
  process.on("message", (message) => {
    if (isNativeAuthRequest(message)) void host.receive(message);
  });
  process.on("disconnect", () => { host.abort(); process.exit(0); });
  process.on("SIGTERM", () => { host.abort(); process.exit(0); });
  process.on("SIGINT", () => { host.abort(); process.exit(0); });
  process.on("uncaughtException", () => { process.exit(1); });
  process.on("unhandledRejection", () => { process.exit(1); });
  process.send({ tag: "raft-cursor-auth-ipc", v: 1, requestId: "", kind: "ready" });
}
