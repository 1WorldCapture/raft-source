import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { TSchema } from "typebox";
import {
  type ManagedMcpCallResult,
  type ManagedMcpRuntimeSnapshot,
  type ManagedMcpRuntimeTool,
} from "@botiverse/raft-shared";

const MANAGED_MCP_HTTP_TIMEOUT_MS = 25_000;

class ManagedMcpHttpError extends Error {
  constructor(message: string, readonly status: number, readonly code: string | null) {
    super(message);
    this.name = "ManagedMcpHttpError";
  }
}
async function requestJson<T>(input: {
  url: URL;
  token: string;
  method?: "GET" | "POST";
  body?: unknown;
  signal?: AbortSignal;
}): Promise<T> {
  const timeout = AbortSignal.timeout(MANAGED_MCP_HTTP_TIMEOUT_MS);
  const signal = input.signal ? AbortSignal.any([input.signal, timeout]) : timeout;
  const response = await fetch(input.url, {
    method: input.method ?? "GET",
    headers: {
      Authorization: `Bearer ${input.token}`,
      "X-Slock-Agent-Active-Capabilities": "mcp",
      ...(input.body === undefined ? {} : { "Content-Type": "application/json" }),
    },
    ...(input.body === undefined ? {} : { body: JSON.stringify(input.body) }),
    signal,
  });
  const payload = await response.json().catch(() => null) as { error?: unknown; code?: unknown } | T | null;
  if (!response.ok) {
    const error = typeof (payload as { error?: unknown } | null)?.error === "string"
      ? (payload as { error: string }).error
      : `HTTP ${response.status}`;
    const code = typeof (payload as { code?: unknown } | null)?.code === "string"
      ? (payload as { code: string }).code
      : null;
    throw new ManagedMcpHttpError(error, response.status, code);
  }
  return payload as T;
}

function isRuntimeSnapshot(value: unknown): value is ManagedMcpRuntimeSnapshot {
  return typeof value === "object"
    && value !== null
    && (value as { catalogVersion?: unknown }).catalogVersion === 1
    && Array.isArray((value as { tools?: unknown }).tools);
}

function resultText(result: ManagedMcpCallResult): string {
  return result.content
    .filter((block): block is Extract<ManagedMcpCallResult["content"][number], { type: "text" }> => block.type === "text")
    .map((block) => block.text)
    .join("\n")
    .slice(0, 4_000) || "Managed MCP tool failed";
}

function buildTool(input: {
  tool: ManagedMcpRuntimeTool;
  endpoint: ManagedMcpEndpoint;
}): ToolDefinition {
  const { tool, endpoint } = input;
  return {
    name: tool.runtimeName,
    label: tool.title || `${tool.serverName}: ${tool.toolName}`,
    description: tool.description || `Call ${tool.toolName} on the managed MCP server ${tool.serverName}.`,
    promptSnippet: `${tool.runtimeName}: ${tool.description || `Call ${tool.toolName} on ${tool.serverName}`}`,
    parameters: tool.inputSchema as TSchema,
    async execute(_toolCallId, params, signal) {
      const result = await callManagedMcpTool(endpoint, tool, params as Record<string, unknown>, signal);
      if (result.isError) throw new Error(resultText(result));
      return {
        content: result.content.map((block) => block.type === "text"
          ? { type: "text" as const, text: block.text }
          : { type: "image" as const, data: block.data, mimeType: block.mimeType }),
        details: {
          managedMcp: true,
          mcpServerId: tool.mcpServerId,
          toolName: tool.toolName,
          ...(result.structuredContent ? { structuredContent: result.structuredContent } : {}),
        },
      };
    },
  };
}

/**
 * Runtime-neutral Managed MCP access, shared by every non-SDK driver bridge.
 * The server decides tool membership from the agent credential; the daemon
 * only presents it.
 */
export interface ManagedMcpEndpoint {
  serverUrl: string;
  agentCredentialKey: string;
}

/** Fetch the tool snapshot assigned to this agent. Throws on any failure. */
export async function fetchManagedMcpToolSnapshot(endpoint: ManagedMcpEndpoint): Promise<ManagedMcpRuntimeTool[]> {
  const snapshot = await requestJson<ManagedMcpRuntimeSnapshot>({
    url: new URL("/internal/agent-api/mcp/tools", endpoint.serverUrl),
    token: endpoint.agentCredentialKey,
  });
  if (!isRuntimeSnapshot(snapshot)) throw new Error("Managed MCP snapshot contract is invalid");
  return snapshot.tools;
}

/** Execute one managed MCP tool call. Throws on transport failure; a logical
 * tool error arrives as `result.isError` and must surface as tool error text. */
export async function callManagedMcpTool(
  endpoint: ManagedMcpEndpoint,
  tool: ManagedMcpRuntimeTool,
  args: Record<string, unknown>,
  signal?: AbortSignal,
): Promise<ManagedMcpCallResult> {
  return requestJson<ManagedMcpCallResult>({
    url: new URL("/internal/agent-api/mcp/call", endpoint.serverUrl),
    token: endpoint.agentCredentialKey,
    method: "POST",
    body: {
      mcpServerId: tool.mcpServerId,
      toolName: tool.toolName,
      arguments: args,
      expectedConfigVersion: tool.configVersion,
      expectedAssignmentVersion: tool.assignmentVersion,
    },
    signal,
  });
}

export function managedMcpHttpErrorDetail(error: unknown): string {
  return error instanceof ManagedMcpHttpError
    ? `${error.code ?? "managed_mcp_http_error"} (${error.status})`
    : error instanceof Error ? error.message.slice(0, 200) : "unknown error";
}

export async function createManagedMcpPiTools(input: {
  serverUrl: string;
  agentCredentialKey: string | null | undefined;
  onWarning?: (message: string) => void;
}): Promise<ToolDefinition[]> {
  if (!input.agentCredentialKey) return [];
  const endpoint: ManagedMcpEndpoint = { serverUrl: input.serverUrl, agentCredentialKey: input.agentCredentialKey };
  try {
    const tools = await fetchManagedMcpToolSnapshot(endpoint);
    return tools.map((tool) => buildTool({ tool, endpoint }));
  } catch (error) {
    input.onWarning?.(`Managed MCP tools unavailable for this session: ${managedMcpHttpErrorDetail(error)}`);
    return [];
  }
}
