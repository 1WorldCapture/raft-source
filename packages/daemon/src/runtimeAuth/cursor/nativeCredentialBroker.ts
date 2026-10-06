import { constants } from "node:fs";
import { lstat, mkdir, open, readFile, readdir, rename, rm } from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import os from "node:os";
import path from "node:path";
import type { RuntimeModelSourceOutcome } from "@botiverse/raft-shared";
import { resolveRaftHome } from "../../raftHome.js";
import { callNativeCursorAuth, CursorAuthorizationError, type NativeAuthCall } from "./nativeAuthClient.js";
import type { NativeAuthReply } from "../../cursorSdk/nativeAuthHost.js";

const BACKEND = "https://api2.cursor.sh";
type Source = "cursor_sdk_store" | "raft_owned" | "owner_environment";
interface Credentials { version: 1; apiKey: string; backendUrl: string; apiKeyExpiresAtMs?: number; createdAtMs: number }
interface Binding {
  version: 2; disabled: boolean; source: Source; principalId: string; connectionId: string;
  generation: number; fingerprint: string; backendUrl: string; verifiedAt: number;
}
export interface NativeBrokerDeps {
  homeDir?: string;
  env?: NodeJS.ProcessEnv;
  auth?: (call: NativeAuthCall) => Promise<NativeAuthReply>;
  now?: () => number;
}
export interface CursorLease {
  apiKey: string; connectionId: string; generation: number; principalId: string; backendUrl: string;
}
const fail = (code: string, message: string): never => { throw new CursorAuthorizationError(`CURSOR_SDK_${code}`, message); };
const fingerprint = (key: string) => createHash("sha256").update(key).digest("hex");
const rootFor = (home: string) => path.join(path.resolve(home), "auth", "providers", "cursor");

async function protectedJson(file: string): Promise<unknown | undefined> {
  let fd;
  try {
    fd = await open(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    const s = await fd.stat();
    if (!s.isFile() || s.size > 65536 || (process.getuid && s.uid !== process.getuid()) || (process.platform !== "win32" && (s.mode & 0o077) !== 0)) {
      fail("STORE_PERMISSIONS", "Cursor credential storage is not a private owner-only regular file.");
    }
    const body = await fd.readFile("utf8");
    try { return JSON.parse(body); } catch { fail("STORE_INVALID", "Cursor credential storage contains invalid JSON."); }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    if (error instanceof CursorAuthorizationError) throw error;
    fail("STORE_UNREADABLE", "Cursor credential storage cannot be read safely. Check local file ownership and access.");
  } finally { await fd?.close(); }
}

async function privateDirectory(root: string): Promise<void> {
  await mkdir(root, { recursive: true, mode: 0o700 });
  const s = await lstat(root);
  if (!s.isDirectory() || s.isSymbolicLink() || (process.getuid && s.uid !== process.getuid()) || (process.platform !== "win32" && (s.mode & 0o077) !== 0)) {
    fail("STORE_PERMISSIONS", "Raft Cursor authorization directory must be a private owner-owned directory.");
  }
}

async function atomicJson(file: string, data: unknown): Promise<void> {
  const root = path.dirname(file); await privateDirectory(root);
  const temporary = path.join(root, `.write-${randomUUID()}`);
  const fd = await open(temporary, "wx", 0o600);
  try { await fd.writeFile(JSON.stringify(data)); await fd.sync(); }
  finally { await fd.close(); }
  try { await rename(temporary, file); }
  finally { await rm(temporary, { force: true }); }
}

function parseCredentials(value: unknown, now: number): Credentials {
  const v = value as Partial<Credentials> | undefined;
  if (!v || v.version !== 1 || typeof v.apiKey !== "string" || !v.apiKey.trim() || v.apiKey.length > 16384 || v.backendUrl !== BACKEND) {
    return fail("LOGIN_MISSING", "No supported Cursor SDK login is available. Use Cursor SDK → Connect / Sign In.");
  }
  if (v.apiKeyExpiresAtMs !== undefined && (!Number.isFinite(v.apiKeyExpiresAtMs) || v.apiKeyExpiresAtMs <= now)) fail("LOGIN_EXPIRED", "The selected Cursor authorization has expired. Reconnect explicitly.");
  return { version: 1, apiKey: v.apiKey, backendUrl: BACKEND, apiKeyExpiresAtMs: v.apiKeyExpiresAtMs, createdAtMs: typeof v.createdAtMs === "number" ? v.createdAtMs : now };
}

async function readBinding(root: string): Promise<Binding | undefined> {
  const raw = await protectedJson(path.join(root, "binding.json"));
  if (raw === undefined) return;
  const b = raw as Partial<Binding>;
  if (b.version !== 2 || typeof b.disabled !== "boolean" || !["cursor_sdk_store", "raft_owned", "owner_environment"].includes(String(b.source)) || !/^\d+$/.test(String(b.principalId)) || !Number.isSafeInteger(b.generation) || typeof b.connectionId !== "string" || typeof b.fingerprint !== "string" || b.backendUrl !== BACKEND) fail("BINDING_INVALID", "The Raft Cursor connection record is invalid. Reconnect from the local owner controls.");
  return b as Binding;
}

async function acquire(root: string, signal?: AbortSignal): Promise<() => Promise<void>> {
  await privateDirectory(root);
  const file = path.join(root, "operation.lock");
  const deadline = Date.now() + 15_000;
  while (true) {
    if (signal?.aborted) fail("ABORTED", "Cursor authorization was cancelled.");
    try {
      const fd = await open(file, "wx", 0o600);
      const token = randomUUID();
      await fd.writeFile(JSON.stringify({ pid: process.pid, token })); await fd.close();
      return async () => {
        const owner = await protectedJson(file) as { token?: string } | undefined;
        if (owner?.token === token) await rm(file, { force: true });
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      // Do not steal a live login or an initializing lock. A crashed-owner
      // record can be recovered by explicit owner diagnostics, never age alone.
      if (Date.now() >= deadline) fail("AUTH_BUSY", "Another Cursor authorization operation holds the local lock. Finish it, or recover a crashed owner before retrying.");
      await new Promise<void>((resolve) => setTimeout(resolve, 100));
    }
  }
}

async function sourceCredentials(root: string, source: Source, deps: NativeBrokerDeps, connectionId?: string): Promise<Credentials> {
  const now = deps.now?.() ?? Date.now();
  if (source === "owner_environment") {
    return parseCredentials({ version: 1, backendUrl: BACKEND, apiKey: (deps.env ?? process.env).CURSOR_API_KEY, createdAtMs: now }, now);
  }
  if (source === "raft_owned" && (!connectionId || !/^cursor-[a-zA-Z0-9-]+$/.test(connectionId))) fail("BINDING_INVALID", "Cursor connection identifier is invalid.");
  const file = source === "raft_owned" ? path.join(root, `credential-${connectionId}.json`) : path.join(deps.homeDir ?? os.homedir(), ".cursor", "sdk", "auth.json");
  return parseCredentials(await protectedJson(file), now);
}

function verifiedPrincipal(reply: NativeAuthReply): string {
  if (reply.kind !== "verified" || typeof reply.principalId !== "string" || !/^[1-9]\d*$/.test(reply.principalId) || reply.backendUrl !== BACKEND) fail("IDENTITY_UNVERIFIED", "Cursor did not verify a supported account identity.");
  return reply.principalId as string;
}

async function bindExisting(input: { slockHome: string; signal?: AbortSignal }, deps: NativeBrokerDeps, explicit: boolean): Promise<CursorLease> {
  const root = rootFor(input.slockHome);
  const unlock = await acquire(root, input.signal);
  try {
    const previous = await readBinding(root);
    if (previous?.disabled && !explicit) fail("DISCONNECTED", "Cursor was explicitly disconnected from Raft. Reconnect from the local Cursor SDK menu.");
    const source = previous?.source ?? ((deps.env ?? process.env).CURSOR_API_KEY !== undefined ? "owner_environment" : "cursor_sdk_store");
    const credentials = await sourceCredentials(root, source, deps, previous?.connectionId);
    const reply = await (deps.auth ?? callNativeCursorAuth)({ kind: "verify", apiKey: credentials.apiKey, signal: input.signal });
    const principalId = verifiedPrincipal(reply);
    if (previous && previous.principalId !== "0" && principalId !== previous.principalId) fail("IDENTITY_MISMATCH", "The saved Cursor login belongs to another account. Choose Browser Sign-In explicitly to change the Raft connection.");
    if (input.signal?.aborted) fail("ABORTED", "Cursor authorization was cancelled.");
    const fp = fingerprint(credentials.apiKey);
    const binding: Binding = {
      version: 2, disabled: false, source, principalId, backendUrl: BACKEND,
      connectionId: previous?.connectionId ?? `cursor-${randomUUID()}`,
      generation: previous ? previous.generation + (fp === previous.fingerprint ? 0 : 1) : 1,
      fingerprint: fp, verifiedAt: deps.now?.() ?? Date.now(),
    };
    await atomicJson(path.join(root, "binding.json"), binding);
    return { apiKey: credentials.apiKey, connectionId: binding.connectionId, generation: binding.generation, principalId, backendUrl: BACKEND };
  } finally { await unlock(); }
}

export function resolveCursorCredentialLease(input: { slockHome: string; serverId?: string; signal?: AbortSignal }, deps: NativeBrokerDeps = {}): Promise<CursorLease> {
  return bindExisting(input, deps, false);
}

export async function connectExistingCursorSdkOwner(input: { slockHome: string; signal?: AbortSignal }, deps: NativeBrokerDeps = {}) {
  const { apiKey: _private, ...result } = await bindExisting(input, deps, true);
  return { ...result, email: null };
}

export async function detectCursorSdkModels(input: { slockHome?: string; signal?: AbortSignal } = {}, deps: NativeBrokerDeps = {}): Promise<RuntimeModelSourceOutcome> {
  try {
    const lease = await resolveCursorCredentialLease({ slockHome: input.slockHome ?? resolveRaftHome(), signal: input.signal }, deps);
    const reply = await (deps.auth ?? callNativeCursorAuth)({ kind: "models", apiKey: lease.apiKey, signal: input.signal });
    if (reply.principalId !== lease.principalId || !Array.isArray(reply.models)) return { kind: "error", retryable: false };
    const models = reply.models.flatMap((v: unknown) => {
      const row = v as { id?: unknown; label?: unknown };
      return typeof row?.id === "string" && row.id.length > 0 && row.id.length <= 256
        ? [{ id: row.id, label: typeof row.label === "string" ? row.label : row.id, verified: "launchable" as const }] : [];
    });
    return models.length ? { kind: "live", value: { models, default: models.find((m) => m.id === "default")?.id ?? models[0].id } } : { kind: "error", retryable: true };
  } catch (error) {
    return { kind: "error", retryable: !(error instanceof CursorAuthorizationError && /LOGIN|IDENTITY|DISCONNECTED|BINDING/.test(error.code)) };
  }
}

export async function loginCursorSdkOwner(
  input: { slockHome: string },
  options: { signal?: AbortSignal; onEvent?: (event: { kind: "login-url"; url: string }) => void } = {},
  deps: NativeBrokerDeps = {},
) {
  const root = rootFor(input.slockHome); const unlock = await acquire(root, options.signal);
  try {
    await assertNoLiveCursorHosts(input.slockHome);
    const reply = await (deps.auth ?? callNativeCursorAuth)({ kind: "login", signal: options.signal, onLoginUrl: (url) => options.onEvent?.({ kind: "login-url", url }) });
    const principalId = verifiedPrincipal(reply);
    const now = deps.now?.() ?? Date.now();
    const credentials = parseCredentials({ version: 1, backendUrl: BACKEND, apiKey: reply.apiKey, apiKeyExpiresAtMs: reply.apiKeyExpiresAtMs, createdAtMs: now }, now);
    const previous = await readBinding(root);
    const binding: Binding = { version: 2, disabled: false, source: "raft_owned", principalId, backendUrl: BACKEND, connectionId: `cursor-${randomUUID()}`, generation: (previous?.generation ?? 0) + 1, fingerprint: fingerprint(credentials.apiKey), verifiedAt: now };
    try {
      if (options.signal?.aborted) fail("ABORTED", "Cursor login was cancelled after authorization. Inspect the named Raft key in Cursor before retrying.");
      await atomicJson(path.join(root, `credential-${binding.connectionId}.json`), credentials);
      await atomicJson(path.join(root, "binding.json"), binding);
    } catch {
      fail("LOGIN_PERSIST_FAILED", "Cursor created a Raft authorization but it could not be saved locally. Inspect and revoke that named key in Cursor before retrying.");
    }
    return { principalId, connectionId: binding.connectionId, generation: binding.generation, backendUrl: BACKEND, email: null };
  } finally { await unlock(); }
}

export async function getCursorSdkAuthStatus(input: { slockHome: string }, deps: NativeBrokerDeps = {}) {
  const root = rootFor(input.slockHome);
  try {
    const binding = await readBinding(root);
    if (binding?.disabled) return { status: "disconnected" as const, source: binding.source, borrowed: binding.source !== "raft_owned" };
    const source = binding?.source ?? ((deps.env ?? process.env).CURSOR_API_KEY !== undefined ? "owner_environment" : "cursor_sdk_store");
    const credentials = await sourceCredentials(root, source, deps, binding?.connectionId);
    return {
      status: binding ? fingerprint(credentials.apiKey) === binding.fingerprint ? "bound" as const : "bound_stale_key" as const : "unbound" as const,
      source, borrowed: source !== "raft_owned", principalId: binding?.principalId, connectionId: binding?.connectionId,
      generation: binding?.generation, backendUrl: BACKEND, apiKeyExpiresAtMs: credentials.apiKeyExpiresAtMs,
    };
  } catch (error) {
    return { status: error instanceof CursorAuthorizationError && /MISSING|EXPIRED/.test(error.code) ? "login_missing" as const : "invalid_store" as const,
      source: "cursor_sdk_store" as const, borrowed: true };
  }
}

export async function assertNoLiveCursorHosts(home: string): Promise<void> {
  const root = path.join(home, "cursor-sdk-host");
  let names: string[];
  try { names = await readdir(root); } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return; throw error; }
  for (const name of names) {
    let body = "";
    try { body = await readFile(path.join(root, name, "host.lock"), "utf8"); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") continue; fail("ACTIVE_HOST_UNKNOWN", "Could not verify whether a Cursor SDK Agent is still running."); }
    let pid = 0;
    try { pid = Number(JSON.parse(body).pid); }
    catch { fail("ACTIVE_HOST_UNKNOWN", "Cursor SDK runtime cleanup is not verified. Stop active Agents before changing authorization."); }
    if (!Number.isSafeInteger(pid) || pid <= 0) fail("ACTIVE_HOST_UNKNOWN", "Cursor host ownership is not verifiable. Stop or recover the runtime before changing authorization.");
    try { process.kill(pid, 0); fail("ACTIVE_HOSTS", "Stop active Cursor SDK Agents before changing or disconnecting their authorization."); }
    catch (error) { if (error instanceof CursorAuthorizationError || (error as NodeJS.ErrnoException).code !== "ESRCH") throw error; }
  }
}

export async function logoutCursorSdkOwner(input: { slockHome: string }, _deps: NativeBrokerDeps = {}) {
  const root = rootFor(input.slockHome); const unlock = await acquire(root);
  try {
    await assertNoLiveCursorHosts(input.slockHome);
    const binding = await readBinding(root);
    await atomicJson(path.join(root, "binding.json"), binding ? { ...binding, disabled: true } : {
      version: 2, disabled: true, source: "cursor_sdk_store", principalId: "0", connectionId: `cursor-${randomUUID()}`, generation: 1, fingerprint: "", backendUrl: BACKEND, verifiedAt: 0,
    });
    return { status: binding ? "cleared" as const : "not-bound" as const, sdkLoginPreserved: true as const, sdkStorePath: "shared Cursor login unchanged" };
  } finally { await unlock(); }
}
