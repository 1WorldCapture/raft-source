import dns from "node:dns";
import { BlockList, isIP } from "node:net";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { auth, UnauthorizedError, type OAuthClientProvider } from "@modelcontextprotocol/sdk/client/auth.js";
import { StreamableHTTPClientTransport, StreamableHTTPError } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { OAuthError, ServerError, TemporarilyUnavailableError } from "@modelcontextprotocol/sdk/server/auth/errors.js";
import { Agent, fetch as undiciFetch } from "undici";
import {
  clearClockTimeout,
  isPrivateDeploymentMode,
  MANAGED_MCP_MAX_CATALOG_BYTES,
  MANAGED_MCP_MAX_RESULT_BYTES,
  MANAGED_MCP_MAX_TOOLS_PER_SERVER,
  setClockTimeout,
  type ManagedMcpCallResult,
  type ManagedMcpJsonSchema,
  type ManagedMcpResultContent,
  type ManagedMcpToolCatalogEntry,
} from "@botiverse/raft-shared";

const MCP_TIMEOUT_MS = 20_000;
const MCP_MAX_HTTP_RESPONSE_BYTES = 1024 * 1024;
const blockedAddresses = new BlockList();
for (const [network, prefix] of [
  ["0.0.0.0", 8], ["10.0.0.0", 8], ["100.64.0.0", 10], ["127.0.0.0", 8],
  ["169.254.0.0", 16], ["172.16.0.0", 12], ["192.0.0.0", 24], ["192.0.2.0", 24],
  ["192.88.99.0", 24], ["192.168.0.0", 16], ["198.18.0.0", 15], ["198.51.100.0", 24], ["203.0.113.0", 24],
  ["224.0.0.0", 4], ["240.0.0.0", 4],
] as const) blockedAddresses.addSubnet(network, prefix, "ipv4");
for (const [network, prefix] of [
  ["::", 128], ["::1", 128], ["64:ff9b::", 96], ["64:ff9b:1::", 48], ["100::", 64],
  ["2001::", 23], ["2001:db8::", 32], ["2002::", 16], ["3fff::", 20], ["5f00::", 16],
  ["fc00::", 7], ["fe80::", 10], ["ff00::", 8],
] as const) blockedAddresses.addSubnet(network, prefix, "ipv6");

export class ManagedMcpGatewayError extends Error {
  constructor(
    message: string,
    readonly code:
      | "managed_mcp_endpoint_invalid"
      | "managed_mcp_endpoint_blocked"
      | "managed_mcp_unreachable"
      | "managed_mcp_oauth_required"
      | "managed_mcp_catalog_invalid"
      | "managed_mcp_result_too_large"
      | "managed_mcp_result_invalid",
  ) {
    super(message);
    this.name = "ManagedMcpGatewayError";
  }
}

export function normalizeManagedMcpClientError(error: unknown, timedOut: boolean): ManagedMcpGatewayError {
  if (error instanceof ManagedMcpGatewayError) return error;
  const oauthFailureRequiresReconnect = error instanceof UnauthorizedError
    || (error instanceof StreamableHTTPError && (error.code === 401 || error.code === 403))
    || (error instanceof OAuthError && !(error instanceof ServerError) && !(error instanceof TemporarilyUnavailableError));
  if (oauthFailureRequiresReconnect) {
    return new ManagedMcpGatewayError("MCP OAuth authorization expired; reconnect from Settings", "managed_mcp_oauth_required");
  }
  return new ManagedMcpGatewayError(
    timedOut ? "MCP request timed out" : "MCP server could not be reached",
    "managed_mcp_unreachable",
  );
}

function normalizedMappedIpv4(address: string): string {
  return address.toLowerCase().startsWith("::ffff:") ? address.slice(7) : address;
}

// --- Private-deployment allowlist (task #9) ---------------------------------
//
// Private deployments host MCP servers on internal networks the static block
// table rejects by design. An ADMINISTRATOR-configured allowlist
// (RAFT_MANAGED_MCP_ALLOWED_NETWORKS / _ALLOWED_HOSTS) can re-open those in
// private mode ONLY — official deployments ignore the env entirely
// (byte-identical behavior). Hard-blocked ranges (loopback, link-local /
// cloud-metadata, unspecified, multicast) are NEVER re-openable, even when
// the allowlist names them; such entries warn and are ignored.

const HARD_BLOCKED_ADDRESSES = new BlockList();
for (const [network, prefix] of [
  ["0.0.0.0", 8], ["127.0.0.0", 8], ["169.254.0.0", 16], ["224.0.0.0", 4],
] as const) HARD_BLOCKED_ADDRESSES.addSubnet(network, prefix, "ipv4");
for (const [network, prefix] of [
  ["::", 128], ["::1", 128], ["fe80::", 10], ["ff00::", 8],
] as const) HARD_BLOCKED_ADDRESSES.addSubnet(network, prefix, "ipv6");

const ALLOWLIST_NETWORKS_ENV = "RAFT_MANAGED_MCP_ALLOWED_NETWORKS";
const ALLOWLIST_HOSTS_ENV = "RAFT_MANAGED_MCP_ALLOWED_HOSTS";

let allowlistCache: { envSnapshot: string; networks: BlockList; hosts: Set<string> } | null = null;

/** Parse the allowlist env once per unique env snapshot. Malformed entries
 *  warn and are skipped — one bad CIDR must not disable the whole list. */
function readPrivateAllowlist(): { networks: BlockList; hosts: Set<string> } | null {
  if (!isPrivateDeploymentMode()) return null;
  const networksRaw = process.env[ALLOWLIST_NETWORKS_ENV]?.trim() ?? "";
  const hostsRaw = process.env[ALLOWLIST_HOSTS_ENV]?.trim() ?? "";
  const envSnapshot = `${networksRaw}\n${hostsRaw}`;
  if (allowlistCache?.envSnapshot === envSnapshot) return allowlistCache;

  const networks = new BlockList();
  for (const entry of networksRaw.split(",").map((item) => item.trim()).filter(Boolean)) {
    const [network, prefixRaw] = entry.split("/");
    const prefix = prefixRaw === undefined ? undefined : Number(prefixRaw);
    const family = network ? isIP(network) : 0;
    const maxPrefix = family === 6 ? 128 : 32;
    if (!network || family === 0 || prefix !== undefined && (!Number.isInteger(prefix) || prefix < 0 || prefix > maxPrefix)) {
      console.warn(`[managed-mcp] ignoring malformed ${ALLOWLIST_NETWORKS_ENV} entry "${entry}"`);
      continue;
    }
    if (HARD_BLOCKED_ADDRESSES.check(network, family === 4 ? "ipv4" : "ipv6")
      || (prefix !== undefined && hardBlockedSubnet(network, prefix))) {
      console.warn(`[managed-mcp] ${ALLOWLIST_NETWORKS_ENV} entry "${entry}" covers a hard-blocked range (loopback / link-local / unspecified / multicast); ignored`);
      continue;
    }
    try {
      if (prefix === undefined) networks.addAddress(network, family === 4 ? "ipv4" : "ipv6");
      else networks.addSubnet(network, prefix, family === 4 ? "ipv4" : "ipv6");
    } catch (error) {
      // Belt-and-braces: the validation above should make this unreachable;
      // a BlockList rejection must never take down the whole gateway.
      console.warn(`[managed-mcp] ignoring ${ALLOWLIST_NETWORKS_ENV} entry "${entry}" rejected by the block list: ${(error as Error).message}`);
    }
  }
  const hosts = new Set(
    hostsRaw.split(",").map((item) => item.trim().toLowerCase().replace(/\.$/u, "")).filter(Boolean),
  );
  allowlistCache = { envSnapshot, networks, hosts };
  return allowlistCache;
}

/**
 * WARNING-ONLY heuristic for "this entry covers a hard-blocked range":
 * checks the subnet's first and last addresses, so a hard-blocked range
 * landing mid-subnet (e.g. 160.0.0.0/3 vs 169.254/16) or compressed IPv6
 * input is NOT detected here and simply won't log the warning. SECURITY is
 * NOT affected: isManagedMcpAddressAllowed checks the hard floor per
 * address, before any allowlist, so those addresses stay blocked regardless.
 */
function hardBlockedSubnet(network: string, prefix: number): boolean {
  // Narrow guard: only flag prefixes that sit inside hard-blocked space or
  // cover it — exact containment via the block table on both ends.
  const family = isIP(network) === 4 ? "ipv4" : "ipv6";
  if (HARD_BLOCKED_ADDRESSES.check(network, family)) return true;
  // A prefix wider than (containing) a hard-blocked network also covers it;
  // approximate with the table by checking a representative late address.
  const last = subnetLastAddress(network, prefix);
  return last !== null && HARD_BLOCKED_ADDRESSES.check(last, family);
}

function subnetLastAddress(network: string, prefix: number): string | null {
  if (isIP(network) === 4) {
    const parts = network.split(".").map(Number);
    if (parts.length !== 4 || parts.some((n) => Number.isNaN(n))) return null;
    const bits = 32 - prefix;
    const size = bits >= 31 ? 1 : 2 ** bits;
    let value = ((parts[0]! * 256 + parts[1]!) * 256 + parts[2]!) * 256 + parts[3]!;
    value += size - 1;
    return [value >>> 24, (value >>> 16) & 255, (value >>> 8) & 255, value & 255].map((n) => n & 255).join(".");
  }
  // IPv6: expand and add the host range (BigInt for the 128-bit space).
  const groups = network.split(":");
  if (groups.length !== 8) return null; // only fully-expanded forms are configured in practice
  let value = 0n;
  for (const group of groups) value = (value << 16n) + BigInt(parseInt(group || "0", 16));
  const hostBits = 128n - BigInt(prefix);
  value += hostBits >= 127n ? 0n : (1n << hostBits) - 1n;
  const hex = value.toString(16).padStart(32, "0");
  return `${hex.slice(0, 4)}:${hex.slice(4, 8)}:${hex.slice(8, 12)}:${hex.slice(12, 16)}:${hex.slice(16, 20)}:${hex.slice(20, 24)}:${hex.slice(24, 28)}:${hex.slice(28, 32)}`;
}

function allowlistHit(address: string): boolean {
  const allowlist = readPrivateAllowlist();
  if (!allowlist) return false;
  const normalized = normalizedMappedIpv4(address);
  const family = isIP(normalized);
  return family !== 0 && allowlist.networks.check(normalized, family === 4 ? "ipv4" : "ipv6");
}

export function isManagedMcpAddressAllowed(address: string): boolean {
  const normalized = normalizedMappedIpv4(address);
  const family = isIP(normalized);
  if (family === 0) return false;
  // Hard floor first: loopback / link-local (cloud metadata) / unspecified /
  // multicast are never allowlist-reopenable.
  if (HARD_BLOCKED_ADDRESSES.check(normalized, family === 4 ? "ipv4" : "ipv6")) return false;
  // Private-mode administrator allowlist re-opens explicitly trusted ranges.
  if (allowlistHit(normalized)) {
    console.info(`[managed-mcp] address ${normalized} allowed by ${ALLOWLIST_NETWORKS_ENV}`);
    return true;
  }
  // Default posture: the static block table (official behavior unchanged).
  return !blockedAddresses.check(normalized, family === 4 ? "ipv4" : "ipv6");
}

/** Whether the hostname pre-check (suffix blacklist) may be bypassed under
 *  the private allowlist. The IP checks still apply after DNS resolution. */
function allowlistedHostname(hostname: string): boolean {
  const allowlist = readPrivateAllowlist();
  if (!allowlist || hostname === "localhost") return false;
  return allowlist.hosts.has(hostname);
}

function privateAllowlistHint(): string {
  return isPrivateDeploymentMode()
    ? ` If this MCP server lives on your internal network, ask the administrator to add its network to ${ALLOWLIST_NETWORKS_ENV} (loopback, link-local, unspecified and multicast ranges can never be allowed).`
    : "";
}

export function validateManagedMcpEndpoint(raw: string): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new ManagedMcpGatewayError("MCP endpoint must be a valid URL", "managed_mcp_endpoint_invalid");
  }
  if (url.protocol !== "https:" || url.username || url.password || url.hash) {
    throw new ManagedMcpGatewayError("MCP endpoint must be an HTTPS URL without credentials or a fragment", "managed_mcp_endpoint_invalid");
  }
  const hostname = url.hostname.toLowerCase().replace(/\.$/u, "").replace(/^\[|\]$/gu, "");
  const suffixBlocked = hostname === "localhost" || hostname.endsWith(".localhost") || hostname.endsWith(".local") || hostname.endsWith(".internal");
  if (!hostname || (suffixBlocked && !allowlistedHostname(hostname))) {
    throw new ManagedMcpGatewayError(`MCP endpoint host is not allowed.${privateAllowlistHint()}`, "managed_mcp_endpoint_blocked");
  }
  if (isIP(hostname) && !isManagedMcpAddressAllowed(hostname)) {
    throw new ManagedMcpGatewayError(`MCP endpoint address is not allowed.${privateAllowlistHint()}`, "managed_mcp_endpoint_blocked");
  }
  return url;
}

/** Exported for the task-#9 filter-semantics tests: only judgment-passing
 *  addresses may reach the connection layer. */
export async function safeLookup(
  hostname: string,
  options: dns.LookupOneOptions | dns.LookupAllOptions,
  callback: (err: NodeJS.ErrnoException | null, address: string | dns.LookupAddress[], family?: number) => void,
): Promise<void> {
  try {
    const resolved = await dns.promises.lookup(hostname, { all: true, verbatim: true });
    // Task #9 filter semantics (PM review): only addresses that PASS the
    // judgment reach the connection layer — a mixed resolution
    // [allowed, blocked] must never let the connection fall onto the blocked
    // address; an all-blocked resolution is refused outright.
    const addresses = resolved.filter(({ address }) => isManagedMcpAddressAllowed(address));
    if (addresses.length === 0) {
      callback(Object.assign(new Error(`MCP endpoint resolved to a blocked address.${privateAllowlistHint()}`), { code: "EACCES" }), "", 0);
      return;
    }
    if ("all" in options && options.all) {
      callback(null, addresses);
      return;
    }
    const requestedFamily = "family" in options && typeof options.family === "number" ? options.family : 0;
    const selected = addresses.find((item) => requestedFamily === 0 || item.family === requestedFamily) ?? addresses[0]!;
    callback(null, selected.address, selected.family);
  } catch (error) {
    callback(error as NodeJS.ErrnoException, "", 0);
  }
}

export function createSafeFetch(): { fetch: typeof globalThis.fetch; close: () => Promise<void> } {
  const dispatcher = new Agent({
    connect: { lookup: safeLookup as never },
    headersTimeout: MCP_TIMEOUT_MS,
    bodyTimeout: MCP_TIMEOUT_MS,
    maxResponseSize: MCP_MAX_HTTP_RESPONSE_BYTES,
  });
  const fetch = ((input: URL | RequestInfo, init?: RequestInit) => {
    const rawUrl = input instanceof URL ? input.toString() : typeof input === "string" ? input : input.url;
    validateManagedMcpEndpoint(rawUrl);
    return undiciFetch(input as never, {
      ...(init ?? {}),
      redirect: "error",
      dispatcher,
    } as never) as unknown as Promise<Response>;
  }) as unknown as typeof globalThis.fetch;
  return { fetch, close: () => dispatcher.close() };
}

function normalizeInputSchema(value: unknown): ManagedMcpJsonSchema {
  if (typeof value !== "object" || value === null || Array.isArray(value) || (value as { type?: unknown }).type !== "object") {
    throw new ManagedMcpGatewayError("MCP tool inputSchema must be an object schema", "managed_mcp_catalog_invalid");
  }
  return value as ManagedMcpJsonSchema;
}

export function normalizeManagedMcpToolCatalog(tools: unknown[]): ManagedMcpToolCatalogEntry[] {
  if (tools.length > MANAGED_MCP_MAX_TOOLS_PER_SERVER) {
    throw new ManagedMcpGatewayError("MCP server exposes too many tools", "managed_mcp_catalog_invalid");
  }
  const names = new Set<string>();
  const normalized = tools.map((raw) => {
    if (typeof raw !== "object" || raw === null) {
      throw new ManagedMcpGatewayError("MCP tool catalog is invalid", "managed_mcp_catalog_invalid");
    }
    const tool = raw as Record<string, unknown>;
    if (
      typeof tool.name !== "string"
      || !tool.name.trim()
      || tool.name !== tool.name.trim()
      || tool.name.length > 128
      || names.has(tool.name)
    ) {
      throw new ManagedMcpGatewayError("MCP tool names must be non-empty and unique", "managed_mcp_catalog_invalid");
    }
    names.add(tool.name);
    return {
      name: tool.name,
      ...(typeof tool.title === "string" ? { title: tool.title.slice(0, 200) } : {}),
      ...(typeof tool.description === "string" ? { description: tool.description.slice(0, 4_000) } : {}),
      inputSchema: normalizeInputSchema(tool.inputSchema),
      ...(typeof tool.annotations === "object" && tool.annotations !== null ? {
        annotations: Object.fromEntries(
          ["readOnlyHint", "destructiveHint", "idempotentHint", "openWorldHint"]
            .filter((key) => typeof (tool.annotations as Record<string, unknown>)[key] === "boolean")
            .map((key) => [key, (tool.annotations as Record<string, boolean>)[key]]),
        ) as ManagedMcpToolCatalogEntry["annotations"],
      } : {}),
    };
  });
  if (Buffer.byteLength(JSON.stringify(normalized), "utf8") > MANAGED_MCP_MAX_CATALOG_BYTES) {
    throw new ManagedMcpGatewayError("MCP tool catalog exceeds the size limit", "managed_mcp_catalog_invalid");
  }
  return normalized;
}

function normalizeCallResult(raw: unknown): ManagedMcpCallResult {
  if (typeof raw !== "object" || raw === null || !Array.isArray((raw as { content?: unknown }).content)) {
    throw new ManagedMcpGatewayError("MCP tool returned an invalid result", "managed_mcp_result_invalid");
  }
  const result = raw as { content: unknown[]; isError?: unknown; structuredContent?: unknown };
  const content: ManagedMcpResultContent[] = result.content.map((item) => {
    if (typeof item !== "object" || item === null) {
      throw new ManagedMcpGatewayError("MCP tool returned unsupported content", "managed_mcp_result_invalid");
    }
    const block = item as Record<string, unknown>;
    if (block.type === "text" && typeof block.text === "string") return { type: "text", text: block.text };
    if (
      block.type === "image"
      && typeof block.data === "string"
      && /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(block.data)
      && typeof block.mimeType === "string"
      && /^image\/[A-Za-z0-9!#$&^_.+-]{1,100}$/u.test(block.mimeType)
    ) {
      return { type: "image", data: block.data, mimeType: block.mimeType };
    }
    throw new ManagedMcpGatewayError("MCP tool returned unsupported content", "managed_mcp_result_invalid");
  });
  const normalized: ManagedMcpCallResult = {
    content,
    isError: result.isError === true,
    ...(typeof result.structuredContent === "object" && result.structuredContent !== null && !Array.isArray(result.structuredContent)
      ? { structuredContent: result.structuredContent as Record<string, unknown> }
      : {}),
  };
  if (Buffer.byteLength(JSON.stringify(normalized), "utf8") > MANAGED_MCP_MAX_RESULT_BYTES) {
    throw new ManagedMcpGatewayError("MCP tool result exceeds the size limit", "managed_mcp_result_too_large");
  }
  return normalized;
}

async function withClient<T>(
  endpoint: string,
  headers: Record<string, string>,
  operation: (client: Client, signal: AbortSignal) => Promise<T>,
  authProvider?: OAuthClientProvider,
): Promise<T> {
  const url = validateManagedMcpEndpoint(endpoint);
  const controller = new AbortController();
  const timeout = setClockTimeout(() => controller.abort(), MCP_TIMEOUT_MS);
  const client = new Client({ name: "raft-managed-mcp", version: "1.0.0" });
  const safeFetch = createSafeFetch();
  try {
    const transport = new StreamableHTTPClientTransport(url, {
      fetch: safeFetch.fetch,
      ...(Object.keys(headers).length > 0 ? { requestInit: { headers } } : {}),
      ...(authProvider ? { authProvider } : {}),
      reconnectionOptions: { maxRetries: 0, initialReconnectionDelay: 1_000, maxReconnectionDelay: 1_000, reconnectionDelayGrowFactor: 1 },
    });
    await client.connect(transport, { signal: controller.signal, timeout: MCP_TIMEOUT_MS });
    return await operation(client, controller.signal);
  } catch (error) {
    throw normalizeManagedMcpClientError(error, controller.signal.aborted);
  } finally {
    clearClockTimeout(timeout);
    await client.close().catch(() => undefined);
    await safeFetch.close().catch(() => undefined);
  }
}

export async function listManagedMcpTools(endpoint: string, headers: Record<string, string>): Promise<ManagedMcpToolCatalogEntry[]> {
  return withClient(endpoint, headers, async (client, signal) => {
    const result = await client.listTools(undefined, { signal, timeout: MCP_TIMEOUT_MS });
    return normalizeManagedMcpToolCatalog(result.tools);
  });
}

export async function startManagedMcpOAuth(
  endpoint: string,
  provider: OAuthClientProvider,
): Promise<"AUTHORIZED" | "REDIRECT"> {
  const url = validateManagedMcpEndpoint(endpoint);
  const safeFetch = createSafeFetch();
  try {
    return await auth(provider, { serverUrl: url, fetchFn: safeFetch.fetch });
  } catch (error) {
    throw new ManagedMcpGatewayError(
      error instanceof Error ? `MCP OAuth setup failed: ${error.message}` : "MCP OAuth setup failed",
      "managed_mcp_unreachable",
    );
  } finally {
    await safeFetch.close().catch(() => undefined);
  }
}

export async function completeManagedMcpOAuth(
  endpoint: string,
  provider: OAuthClientProvider,
  authorizationCode: string,
): Promise<void> {
  const url = validateManagedMcpEndpoint(endpoint);
  const safeFetch = createSafeFetch();
  try {
    const result = await auth(provider, { serverUrl: url, authorizationCode, fetchFn: safeFetch.fetch });
    if (result !== "AUTHORIZED") {
      throw new ManagedMcpGatewayError("MCP OAuth did not complete", "managed_mcp_oauth_required");
    }
  } catch (error) {
    if (error instanceof ManagedMcpGatewayError) throw error;
    throw new ManagedMcpGatewayError(
      error instanceof Error ? `MCP OAuth token exchange failed: ${error.message}` : "MCP OAuth token exchange failed",
      "managed_mcp_unreachable",
    );
  } finally {
    await safeFetch.close().catch(() => undefined);
  }
}

export async function listManagedMcpOAuthTools(
  endpoint: string,
  provider: OAuthClientProvider,
): Promise<ManagedMcpToolCatalogEntry[]> {
  return withClient(endpoint, {}, async (client, signal) => {
    const result = await client.listTools(undefined, { signal, timeout: MCP_TIMEOUT_MS });
    return normalizeManagedMcpToolCatalog(result.tools);
  }, provider);
}

export async function callManagedMcpTool(input: {
  endpoint: string;
  headers: Record<string, string>;
  name: string;
  arguments: Record<string, unknown>;
}): Promise<ManagedMcpCallResult> {
  return withClient(input.endpoint, input.headers, async (client, signal) => normalizeCallResult(
    await client.callTool({ name: input.name, arguments: input.arguments }, undefined, { signal, timeout: MCP_TIMEOUT_MS }),
  ));
}

export async function callManagedMcpOAuthTool(input: {
  endpoint: string;
  provider: OAuthClientProvider;
  name: string;
  arguments: Record<string, unknown>;
}): Promise<ManagedMcpCallResult> {
  return withClient(input.endpoint, {}, async (client, signal) => normalizeCallResult(
    await client.callTool({ name: input.name, arguments: input.arguments }, undefined, { signal, timeout: MCP_TIMEOUT_MS }),
  ), input.provider);
}
