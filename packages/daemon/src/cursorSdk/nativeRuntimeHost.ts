import { mkdir, open, readFile, rename, rm, lstat } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { AgentOptions, Run, RunResult, SDKAgent, SDKMessage, SettingSource } from "@cursor/sdk";
import {
  CURSOR_SDK_HOST_PROTOCOL_VERSION,
  isCursorSdkHostboundMessage,
  type CursorSdkHostboundMessage,
  type CursorSdkHostToDriverMessage,
  type CursorSdkInitMessage,
  type CursorSdkRunEventPayload,
  type CursorSdkWireError,
} from "./protocol.js";
import { buildModelSelection, deriveModelTiers, type ModelSelection, type ModelTiers, type SdkModelListItem } from "./modelTiers.js";

type Vendor = Pick<typeof import("@cursor/sdk"), "Agent" | "JsonlLocalAgentStore"> & {
  /** Optional so minimal SDK stand-ins (tests) keep working; absent = bare model id. */
  Cursor?: { models: { list(options: { apiKey: string }): Promise<readonly SdkModelListItem[]> } };
};
/** Bound the one models.list lookup so a slow backend cannot stall host init. */
const MODEL_TIERS_LOOKUP_TIMEOUT_MS = 8_000;
export interface NativeCursorHostDeps {
  loadSdk?: () => Promise<Vendor>;
  post(message: CursorSdkHostToDriverMessage): void;
  exit?(code: number): void;
  shutdownMs?: number;
  steerTimeoutMs?: number;
  env?: NodeJS.ProcessEnv;
  lock?: (root: string) => Promise<() => Promise<void>>;
  /** Diagnostics for dropped tier requests (default: stderr). */
  warn?: (message: string) => void;
}

function errorCode(error: unknown): CursorSdkWireError {
  const value = error as { name?: unknown; code?: unknown } | null;
  if (value?.name === "AuthenticationError") return { errorClass: "auth", message: "Cursor authentication failed. Reconnect this computer's Cursor account." };
  if (value?.name === "AgentNotFoundError" || value?.code === "agent_not_found") return { errorClass: "agent_not_found", message: "The saved Cursor SDK conversation is missing. Restore its store or explicitly reset the session." };
  if (value?.name === "AgentBusyError" || value?.name === "UnknownAgentError") return { errorClass: "busy", message: "Cursor rejected a concurrent run; the saved conversation has not been reset." };
  return { errorClass: "host_internal", message: "Cursor SDK operation failed. The existing conversation was preserved." };
}

const envDeny = new Set([
  "CURSOR_API_KEY", "CURSOR_AUTH_TOKEN", "CURSOR_BACKEND_URL", "CURSOR_API_BASE_URL", "CURSOR_WEBSITE_URL",
  "NODE_OPTIONS", "NODE_PATH", "NODE_TLS_REJECT_UNAUTHORIZED", "ELECTRON_RUN_AS_NODE",
]);

function alive(pid: number): boolean {
  if (!Number.isSafeInteger(pid) || pid <= 0) return true;
  try { process.kill(pid, 0); return true; }
  catch (error) { return (error as NodeJS.ErrnoException).code !== "ESRCH"; }
}

/** Exclusive writer, no age-based stealing from a live host. */
export async function acquireNativeHostLock(root: string): Promise<() => Promise<void>> {
  await mkdir(root, { recursive: true, mode: 0o700 });
  const stat = await lstat(root);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("Invalid Cursor state directory");
  const file = path.join(root, "host.lock");
  const token = randomUUID();
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fd = await open(file, "wx", 0o600);
      try { await fd.writeFile(JSON.stringify({ pid: process.pid, token })); await fd.sync(); }
      finally { await fd.close(); }
      return async () => {
        try {
          const owner = JSON.parse(await readFile(file, "utf8"));
          if (owner.pid === process.pid && owner.token === token) await rm(file);
        } catch { /* Missing lock is not proof that another lock belongs to us. */ }
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      const before = await lstat(file);
      if (!before.isFile() || before.isSymbolicLink() || before.size > 4096) throw new Error("Invalid Cursor writer lock");
      let owner: { pid?: number; token?: string };
      try { owner = JSON.parse(await readFile(file, "utf8")); }
      catch { throw new Error("Cursor writer lock is initializing or damaged; refusing to steal it"); }
      if (typeof owner.pid !== "number" || alive(owner.pid)) throw new Error("Cursor conversation already has a live writer");
      // The existing writer is proven dead. Rename before deleting so release
      // never removes a replacement lock. A competing reclaimer fails closed.
      const again = await lstat(file);
      if (again.ino !== before.ino || again.mtimeMs !== before.mtimeMs) throw new Error("Cursor writer lock changed");
      const retired = `${file}.retired-${token}`;
      await rename(file, retired);
      await rm(retired);
    }
  }
  throw new Error("Could not acquire Cursor conversation writer lock");
}

/** SDK stream messages are chunks, not whole transcript snapshots. */
export function nativeMessagePayloads(message: SDKMessage): CursorSdkRunEventPayload[] {
  switch (message.type) {
    case "assistant":
      return message.message.content.flatMap((block) => block.type === "text" ? [{ type: "assistant_text" as const, text: block.text }] : []);
    case "thinking": return [{ type: "assistant_thinking", text: message.text }];
    case "tool_call":
      return message.status === "running"
        ? [{ type: "tool_call", name: message.name, input: message.args ?? {} }]
        : [{ type: "tool_result", name: message.name }];
    case "user": return []; // Echo of a sent/steered prompt is not a new Raft message.
    case "usage": {
      const attrs: Record<string, number> = {};
      for (const [key, value] of Object.entries(message.usage ?? {})) {
        if (typeof value === "number" && Number.isFinite(value)) attrs[key] = value;
      }
      return [{ type: "usage", usageKind: "per_turn", attrs }];
    }
    default: return []; // In particular, SDK status FINISHED is not our turn_end.
  }
}

interface Active {
  localId: string;
  run: Run | null;
  done: Promise<void>;
  pendingSteer: Promise<void> | null;
  suppressSteer: boolean;
}

export class NativeCursorHost {
  private agent: SDKAgent | null = null;
  private init: CursorSdkInitMessage | null = null;
  private selection: ModelSelection | null = null;
  private active: Active | null = null;
  private starting = false;
  private stopping = false;
  private releaseLock: (() => Promise<void>) | null = null;
  private stopPromise: Promise<void> | null = null;
  private readonly secrets = new Set<string>();

  constructor(private readonly deps: NativeCursorHostDeps) {}

  private post(message: CursorSdkHostToDriverMessage): void {
    if (this.stopping && message.kind !== "shutdown_settled") return;
    // Exact-value redaction is independent of vendor key prefixes. Preserve
    // ordinary text formatting; only the credential value itself is removed.
    const encoded = JSON.stringify(message);
    let clean = encoded;
    for (const secret of this.secrets) clean = clean.split(secret).join("[redacted]");
    this.deps.post(JSON.parse(clean) as CursorSdkHostToDriverMessage);
  }

  async receive(message: CursorSdkHostboundMessage): Promise<void> {
    if (message.kind === "stop") { await this.stop(); return; }
    if (this.stopping) return;
    if (message.kind === "init") { await this.initialize(message); return; }
    if (!this.agent || !this.init) {
      this.post({ kind: "attempt_result", attemptId: message.attemptId, result: "failed", error: { errorClass: "protocol", message: "Cursor SDK host is not initialized" } });
      return;
    }
    if (message.kind === "run_submit") { this.submit(message.runId, message.attemptId, message.text); return; }
    await this.steer(message.attemptId, message.text);
  }

  private async initialize(input: CursorSdkInitMessage): Promise<void> {
    if (this.starting || this.agent) return;
    this.starting = true;
    try {
      if (input.protocolVersion !== CURSOR_SDK_HOST_PROTOCOL_VERSION || !input.auth?.apiKey || input.auth.backendUrl !== "https://api2.cursor.sh") {
        throw new Error("Invalid Cursor host initialization");
      }
      this.secrets.add(input.auth.apiKey);
      const env = this.deps.env ?? process.env;
      for (const key of envDeny) delete env[key];
      for (const [key, value] of Object.entries(input.env)) {
        if (!envDeny.has(key) && !key.startsWith("RAFT_CURSOR_") && typeof value === "string") env[key] = value;
      }
      // Keep the vendor's distinct production REST and RPC/login routes.
      // An api2.cursor.sh override breaks Cursor.me()/model REST operations.
      this.releaseLock = await (this.deps.lock ?? acquireNativeHostLock)(input.hostDataDir);
      const vendor = await (this.deps.loadSdk ?? (() => import("@cursor/sdk")))();
      if (this.stopping) return;
      // "project" is load-bearing: the driver mounts the Raft standing
      // prompt as a project rule (.cursor/rules/raft-agent.mdc) on every
      // launch; without the project setting source the agent would never
      // load it.
      const settings: SettingSource[] = ["project", "user", "team", "mdm", "plugins"];
      const selection = await this.resolveModelSelection(vendor, input.auth.apiKey, input.runOptions);
      this.selection = selection;
      const options: AgentOptions = {
        apiKey: input.auth.apiKey,
        model: selection,
        local: {
          cwd: input.workspaceRoot,
          store: new vendor.JsonlLocalAgentStore(path.join(input.hostDataDir, "store")),
          settingSources: settings,
        },
        mcpServers: input.runOptions.mcpServers,
      };
      // A missing checkpoint is actionable; it is not permission to silently
      // create a different conversation. CLI ids are never passed here.
      const agent = input.sessionId
        ? await vendor.Agent.resume(input.sessionId, options)
        : await vendor.Agent.create(options);
      if (this.stopping) { await agent[Symbol.asyncDispose](); return; }
      this.agent = agent;
      this.init = { ...input, auth: null, env: {} }; // Do not retain an IPC init frame with the key.
      this.post({ kind: "init_result", ok: true, sessionId: agent.agentId });
    } catch (error) {
      await this.releaseLock?.();
      this.releaseLock = null;
      this.post({ kind: "init_result", ok: false, sessionId: null, error: errorCode(error) });
    } finally { this.starting = false; }
  }

  /**
   * ModelSelection for create, resume AND every send: the model id plus the
   * agent's reasoning effort / fast switch translated to this model's own SDK
   * parameters (see modelTiers.ts). One models.list lookup per host start; when
   * it is unavailable or fails the selection is the bare model id, exactly as
   * before tiers existed.
   */
  private async resolveModelSelection(
    vendor: Vendor,
    apiKey: string,
    runOptions: CursorSdkInitMessage["runOptions"],
  ): Promise<ModelSelection> {
    const modelId = runOptions.model || "default";
    const warn = this.deps.warn ?? ((message: string) => { process.stderr.write(`${message}\n`); });
    let tiers: ModelTiers | null = null;
    const list = vendor.Cursor?.models?.list;
    if (list) {
      let timer: NodeJS.Timeout | undefined;
      try {
        const items = await Promise.race([
          list.call(vendor.Cursor!.models, { apiKey }),
          new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("timeout")), MODEL_TIERS_LOOKUP_TIMEOUT_MS); }),
        ]);
        const item = items.find((candidate) => candidate.id === modelId);
        if (item) tiers = deriveModelTiers(item);
        else warn(`cursor-sdk: model "${modelId}" not in the models list; sending it without tiers`);
      } catch {
        warn(`cursor-sdk: model tiers lookup failed for "${modelId}"; sending it without tiers`);
      } finally { if (timer) clearTimeout(timer); }
    }
    return buildModelSelection(modelId, tiers, { reasoningEffort: runOptions.reasoningEffort, fast: runOptions.fast }, warn);
  }

  private submit(localId: string, attemptId: string | null, text: string): void {
    if (this.active) {
      this.post({ kind: "attempt_result", attemptId, result: "revert" });
      return;
    }
    const active: Active = { localId, run: null, done: Promise.resolve(), pendingSteer: null, suppressSteer: false };
    this.active = active;
    active.done = this.execute(active, attemptId, text);
  }

  private async execute(active: Active, attemptId: string | null, text: string): Promise<void> {
    let result: RunResult | null = null;
    let failure: CursorSdkWireError | undefined;
    try {
      const agent = this.agent!;
      const run = await agent.send(text, { model: this.selection ?? { id: this.init!.runOptions.model || "default" }, mcpServers: this.init!.runOptions.mcpServers });
      active.run = run;
      if (this.stopping) { await run.cancel(); return; }
      this.post({ kind: "attempt_result", attemptId, result: "complete_delivered" });
      const consume = (async () => {
        for await (const message of run.stream()) {
          if (this.active !== active || this.stopping) continue;
          for (const payload of nativeMessagePayloads(message)) this.post({ kind: "run_event", payload });
        }
      })();
      const terminal = run.wait();
      // allSettled observes both promises even if one fails; a stream rejection
      // never abandons an unhandled wait promise or releases the run early.
      const [drained, waited] = await Promise.allSettled([consume, terminal]);
      if (waited.status === "fulfilled") result = waited.value;
      else failure = errorCode(waited.reason);
      if (drained.status === "rejected") failure = errorCode(drained.reason);
      await active.pendingSteer;
      if (result?.status === "error") failure ??= { errorClass: "host_internal", message: "Cursor SDK run ended with an error." };
    } catch (error) {
      failure = errorCode(error);
      if (!active.run) this.post({ kind: "attempt_result", attemptId, result: "failed", error: failure });
    } finally {
      if (this.active === active) {
        this.active = null;
        this.post({ kind: "run_settled", runId: active.localId,
          finishReason: failure ? "error" : result?.status === "cancelled" ? "aborted" : "completed",
          ...(failure ? { error: failure } : {}),
        });
      }
    }
  }

  private async steer(attemptId: string | null, text: string): Promise<void> {
    const active = this.active;
    const run = active?.run;
    if (!active || !run || active.pendingSteer || active.suppressSteer || typeof run.steer !== "function") {
      this.post({ kind: "attempt_result", attemptId, result: "revert" });
      return;
    }
    const pending = (async () => {
      try {
        const outcome = await run.steer!(text);
        if (this.active !== active || this.stopping) return;
        if (outcome === "complete_delivered") this.post({ kind: "attempt_result", attemptId, result: "complete_delivered" });
        else {
          active.suppressSteer = true;
          this.post({ kind: "attempt_result", attemptId, result: "revert" });
        }
      } catch (error) {
        active.suppressSteer = true;
        if (this.active === active && !this.stopping) {
          this.post({ kind: "attempt_result", attemptId, result: "failed", error: errorCode(error) });
        }
      }
    })();
    let timer: NodeJS.Timeout | undefined;
    // The parent attempt timer owns the 'unknown' outcome. The host must also
    // release its terminal join if the vendor ACK never settles, without
    // fabricating a revert and without permitting a second steer.
    const bounded = Promise.race([
      pending,
      new Promise<void>((resolve) => { timer = setTimeout(() => { active.suppressSteer = true; resolve(); }, this.deps.steerTimeoutMs ?? 15_000); }),
    ]);
    active.pendingSteer = bounded;
    try { await bounded; } finally { if (timer) clearTimeout(timer); if (active.pendingSteer === bounded) active.pendingSteer = null; }
  }

  stop(): Promise<void> {
    if (this.stopPromise) return this.stopPromise;
    this.stopping = true;
    this.stopPromise = this.shutdown();
    return this.stopPromise;
  }

  private async shutdown(): Promise<void> {
    let timer: NodeJS.Timeout | undefined;
    const cleanup = (async () => {
      await this.active?.run?.cancel();
      // asyncDispose, unlike close(), waits for SDK disposal. Parent still
      // owns process-group termination for deadline/unknown child cleanup.
      if (this.agent) await this.agent[Symbol.asyncDispose]();
      await this.active?.done;
      await this.releaseLock?.();
      this.releaseLock = null;
      return "clean" as const;
    })().catch(() => "deadline" as const);
    const deadline = new Promise<"deadline">((resolve) => { timer = setTimeout(() => resolve("deadline"), this.deps.shutdownMs ?? 5000); });
    const outcome = await Promise.race([cleanup, deadline]);
    if (timer) clearTimeout(timer);
    this.deps.post({ kind: "shutdown_settled", outcome });
    this.secrets.clear();
    this.deps.exit?.(outcome === "clean" ? 0 : 1);
  }
}

export function startNativeCursorHost(): void {
  if (!process.send) throw new Error("Cursor SDK host requires a private IPC channel");
  const host = new NativeCursorHost({
    post: (message) => { if (process.connected) process.send?.(message); },
    exit: (code) => { setImmediate(() => process.exit(code)); },
  });
  process.on("message", (value) => {
    // Reject oversized frames without echoing their contents.
    if (JSON.stringify(value).length > 2_000_000 || !isCursorSdkHostboundMessage(value)) return;
    void host.receive(value).catch(() => { void host.stop(); });
  });
  process.on("disconnect", () => { void host.stop(); });
  process.on("SIGTERM", () => { void host.stop(); });
  process.on("SIGINT", () => { void host.stop(); });
  process.on("uncaughtException", () => { void host.stop(); });
  process.on("unhandledRejection", () => { void host.stop(); });
  process.send({ kind: "host_ready", protocolVersion: CURSOR_SDK_HOST_PROTOCOL_VERSION });
}
