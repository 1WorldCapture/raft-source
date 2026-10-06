import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);
import {
  splitDeferredTools
} from "./chunk-YJSEYJSP.js";
import {
  buildCopilotDynamicHeaders,
  hasCopilotVisionInput
} from "./chunk-X3TWBBFJ.js";
import {
  Anthropic
} from "./chunk-YYCWTW3O.js";
import {
  getProviderEnvValue
} from "./chunk-J4D24WEI.js";
import {
  parseJsonWithRepair,
  parseStreamingJson
} from "./chunk-T34ZTHKA.js";
import "./chunk-RRL4GVXC.js";
import {
  adjustMaxTokensForThinking,
  buildBaseOptions,
  clampMaxTokensToContext,
  getJsonSchemaToolParameters,
  getPiUserAgent,
  resolveJsonSchemaStrictSampling,
  transformMessages
} from "./chunk-CBKCMNE5.js";
import {
  retryProviderRequest
} from "./chunk-SVOXWMTS.js";
import {
  sanitizeSurrogates
} from "./chunk-CQ5SN5T3.js";
import {
  headersToRecord
} from "./chunk-S66BGMVK.js";
import {
  calculateCost
} from "./chunk-63Q43JGI.js";
import {
  AssistantMessageEventStream,
  appendAssistantMessageDiagnostic
} from "./chunk-AJ7VZE7G.js";
import "./chunk-CB5SUWAA.js";

// ../../node_modules/.pnpm/@earendil-works+pi-ai@0.85.1_@modelcontextprotocol+sdk@1.29.0_zod@4.3.6__ws@8.20.0_zod@4.3.6/node_modules/@earendil-works/pi-ai/dist/api/anthropic-messages.js
function resolveCacheRetention(cacheRetention, env) {
  if (cacheRetention) {
    return cacheRetention;
  }
  if (getProviderEnvValue("PI_CACHE_RETENTION", env) === "long") {
    return "long";
  }
  return "short";
}
function getCacheControl(model, cacheRetention, env) {
  const retention = resolveCacheRetention(cacheRetention, env);
  if (retention === "none") {
    return { retention };
  }
  const ttl = retention === "long" && getAnthropicCompat(model).supportsLongCacheRetention ? "1h" : void 0;
  return {
    retention,
    cacheControl: { type: "ephemeral", ...ttl && { ttl } }
  };
}
var claudeCodeVersion = "2.1.251";
var claudeCodeTools = [
  "Read",
  "Write",
  "Edit",
  "Bash",
  "Grep",
  "Glob",
  "AskUserQuestion",
  "EnterPlanMode",
  "ExitPlanMode",
  "KillShell",
  "NotebookEdit",
  "Skill",
  "Task",
  "TaskOutput",
  "TodoWrite",
  "WebFetch",
  "WebSearch"
];
var ccToolLookup = new Map(claudeCodeTools.map((t) => [t.toLowerCase(), t]));
var toClaudeCodeName = (name) => ccToolLookup.get(name.toLowerCase()) ?? name;
var fromClaudeCodeName = (name, tools) => {
  if (tools && tools.length > 0) {
    const lowerName = name.toLowerCase();
    const matchedTool = tools.find((tool) => tool.name.toLowerCase() === lowerName);
    if (matchedTool)
      return matchedTool.name;
  }
  return name;
};
function convertContentBlocks(content) {
  const hasImages = content.some((c) => c.type === "image");
  if (!hasImages) {
    return sanitizeSurrogates(content.map((c) => c.text).join("\n"));
  }
  const blocks = content.map((block) => {
    if (block.type === "text") {
      return {
        type: "text",
        text: sanitizeSurrogates(block.text)
      };
    }
    return {
      type: "image",
      source: {
        type: "base64",
        media_type: block.mimeType,
        data: block.data
      }
    };
  });
  const hasText = blocks.some((b) => b.type === "text");
  if (!hasText) {
    blocks.unshift({
      type: "text",
      text: "(see attached image)"
    });
  }
  return blocks;
}
var FINE_GRAINED_TOOL_STREAMING_BETA = "fine-grained-tool-streaming-2025-05-14";
var INTERLEAVED_THINKING_BETA = "interleaved-thinking-2025-05-14";
var SERVER_SIDE_FALLBACK_BETA = "server-side-fallback-2026-07-01";
var MID_CONVERSATION_OUTPUT_CONFIG_BETA = "mid-conversation-output-config-2026-07-01";
var THINKING_BINDING_CONTROLS_BETA = "thinking-binding-controls-2026-08-01";
function shouldUseServerSideFallbackBeta(model) {
  return (model.compat?.allowedFallbackModels?.length ?? 0) > 0;
}
function getAnthropicCompat(model) {
  return {
    supportsEagerToolInputStreaming: model.compat?.supportsEagerToolInputStreaming ?? true,
    supportsLongCacheRetention: model.compat?.supportsLongCacheRetention ?? true,
    sendSessionAffinityHeaders: model.compat?.sendSessionAffinityHeaders ?? false,
    supportsCacheControlOnTools: model.compat?.supportsCacheControlOnTools ?? true,
    supportsTemperature: model.compat?.supportsTemperature ?? true,
    allowEmptySignature: model.compat?.allowEmptySignature ?? false,
    supportsStrictTools: model.compat?.supportsStrictTools ?? false,
    supportsToolReferences: model.compat?.supportsToolReferences ?? defaultSupportsToolReferences(model)
  };
}
function defaultSupportsToolReferences(model) {
  if (model.provider !== "anthropic" || model.id.includes("haiku"))
    return false;
  const version = model.id.match(/^claude-(?:opus|sonnet|fable)-(\d+)(?:-(\d+))?(?:-|$)/);
  if (!version)
    return false;
  const major = Number(version[1]);
  const minor = version[2] && version[2].length < 8 ? Number(version[2]) : 0;
  return major > 4 || major === 4 && minor >= 5;
}
function mergeHeaders(...headerSources) {
  const merged = {};
  for (const headers of headerSources) {
    if (headers) {
      Object.assign(merged, headers);
    }
  }
  return merged;
}
function mergeClientHeaders(...headerSources) {
  return mergeHeaders({ "User-Agent": getPiUserAgent() }, ...headerSources);
}
function hasHeader(headers, name) {
  if (!headers)
    return false;
  const expected = name.toLowerCase();
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === expected && value !== null && value.trim().length > 0)
      return true;
  }
  return false;
}
function assertRequestAuth(provider, apiKey, headers) {
  if (apiKey)
    return;
  if (hasHeader(headers, "authorization") || hasHeader(headers, "x-api-key") || hasHeader(headers, "cf-aig-authorization")) {
    return;
  }
  throw new Error(`No API key for provider: ${provider}`);
}
var ANTHROPIC_MESSAGE_EVENTS = /* @__PURE__ */ new Set([
  "message_start",
  "message_delta",
  "message_stop",
  "content_block_start",
  "content_block_delta",
  "content_block_stop"
]);
function flushSseEvent(state) {
  if (!state.event && state.data.length === 0) {
    return null;
  }
  const event = {
    event: state.event,
    data: state.data.join("\n"),
    raw: [...state.raw]
  };
  state.event = null;
  state.data = [];
  state.raw = [];
  return event;
}
function decodeSseLine(line, state) {
  if (line === "") {
    return flushSseEvent(state);
  }
  state.raw.push(line);
  if (line.startsWith(":")) {
    return null;
  }
  const delimiterIndex = line.indexOf(":");
  const fieldName = delimiterIndex === -1 ? line : line.slice(0, delimiterIndex);
  let value = delimiterIndex === -1 ? "" : line.slice(delimiterIndex + 1);
  if (value.startsWith(" ")) {
    value = value.slice(1);
  }
  if (fieldName === "event") {
    state.event = value;
  } else if (fieldName === "data") {
    state.data.push(value);
  }
  return null;
}
function nextLineBreakIndex(text) {
  const carriageReturnIndex = text.indexOf("\r");
  const newlineIndex = text.indexOf("\n");
  if (carriageReturnIndex === -1) {
    return newlineIndex;
  }
  if (newlineIndex === -1) {
    return carriageReturnIndex;
  }
  return Math.min(carriageReturnIndex, newlineIndex);
}
function consumeLine(text) {
  const lineBreakIndex = nextLineBreakIndex(text);
  if (lineBreakIndex === -1) {
    return null;
  }
  let nextIndex = lineBreakIndex + 1;
  if (text[lineBreakIndex] === "\r" && text[nextIndex] === "\n") {
    nextIndex += 1;
  }
  return {
    line: text.slice(0, lineBreakIndex),
    rest: text.slice(nextIndex)
  };
}
async function* iterateSseMessages(body, signal) {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  const state = { event: null, data: [], raw: [] };
  let buffer = "";
  try {
    while (true) {
      if (signal?.aborted) {
        throw new Error("Request was aborted");
      }
      const { value, done } = await reader.read();
      if (done) {
        break;
      }
      buffer += decoder.decode(value, { stream: true });
      let consumed2 = consumeLine(buffer);
      while (consumed2) {
        buffer = consumed2.rest;
        const event = decodeSseLine(consumed2.line, state);
        if (event) {
          yield event;
        }
        consumed2 = consumeLine(buffer);
      }
    }
    buffer += decoder.decode();
    let consumed = consumeLine(buffer);
    while (consumed) {
      buffer = consumed.rest;
      const event = decodeSseLine(consumed.line, state);
      if (event) {
        yield event;
      }
      consumed = consumeLine(buffer);
    }
    if (buffer.length > 0) {
      const event = decodeSseLine(buffer, state);
      if (event) {
        yield event;
      }
    }
    const trailingEvent = flushSseEvent(state);
    if (trailingEvent) {
      yield trailingEvent;
    }
  } finally {
    reader.releaseLock();
  }
}
async function* iterateAnthropicEvents(response, signal) {
  if (!response.body) {
    throw new Error("Attempted to iterate over an Anthropic response with no body");
  }
  let sawMessageStart = false;
  let sawMessageEnd = false;
  for await (const sse of iterateSseMessages(response.body, signal)) {
    if (sse.event === "error") {
      throw new Error(sse.data);
    }
    if (!ANTHROPIC_MESSAGE_EVENTS.has(sse.event ?? "")) {
      continue;
    }
    try {
      const event = parseJsonWithRepair(sse.data);
      if (event.type === "message_start") {
        sawMessageStart = true;
      } else if (event.type === "message_stop") {
        sawMessageEnd = true;
      }
      yield event;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`Could not parse Anthropic SSE event ${sse.event}: ${message}; data=${sse.data}; raw=${sse.raw.join("\\n")}`);
    }
  }
  if (sawMessageStart && !sawMessageEnd) {
    throw new Error("Anthropic stream ended before message_stop");
  }
}
var stream = (model, context, options) => {
  const stream2 = new AssistantMessageEventStream();
  (async () => {
    const providerThinkingLevel = model.compat?.supportsMidConvoEffort ? options?.effort ?? "high" : void 0;
    const output = {
      role: "assistant",
      content: [],
      api: model.api,
      provider: model.provider,
      model: model.id,
      ...providerThinkingLevel === void 0 ? {} : { providerThinkingLevel },
      usage: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 }
      },
      stopReason: "pending",
      timestamp: Date.now()
    };
    try {
      let client;
      let isOAuth;
      let usageModel = model;
      let inputTransformations;
      if (options?.client) {
        client = options.client;
        isOAuth = false;
      } else {
        const apiKey = options?.apiKey;
        assertRequestAuth(model.provider, apiKey, options?.headers);
        let copilotDynamicHeaders;
        if (model.provider === "github-copilot") {
          const hasImages = hasCopilotVisionInput(context.messages);
          copilotDynamicHeaders = buildCopilotDynamicHeaders({
            messages: context.messages,
            hasImages
          });
        }
        const cacheRetention = resolveCacheRetention(options?.cacheRetention, options?.env);
        const cacheSessionId = cacheRetention === "none" ? void 0 : options?.sessionId;
        const created = createClient(model, apiKey, options?.headers, options?.fetch, copilotDynamicHeaders, cacheSessionId);
        client = created.client;
        isOAuth = created.isOAuthToken;
      }
      let params = buildParams(model, context, isOAuth, options);
      const nextParams = await options?.onPayload?.(params, model);
      if (nextParams !== void 0) {
        params = { ...nextParams, stream: true };
      }
      const requestOptions = {
        ...options?.signal ? { signal: options.signal } : {},
        ...options?.timeoutMs !== void 0 ? { timeout: options.timeoutMs } : {},
        maxRetries: 0
      };
      const response = await retryProviderRequest(() => client.beta.messages.create(params, requestOptions).asResponse(), {
        maxRetries: options?.maxRetries,
        maxRetryDelayMs: options?.maxRetryDelayMs,
        signal: options?.signal
      });
      await options?.onResponse?.({ status: response.status, headers: headersToRecord(response.headers) }, model);
      stream2.push({ type: "start", partial: output });
      const blocks = output.content;
      for await (const event of iterateAnthropicEvents(response, options?.signal)) {
        if (event.type === "message_start") {
          output.responseId = event.message.id;
          const transformations = event.message.input_transformations;
          if (Array.isArray(transformations))
            inputTransformations = transformations;
          output.model = event.message.model;
          const fallbackCost = output.model === model.id ? void 0 : model.compat?.allowedFallbackModels?.find((fallback) => fallback.provider === model.provider && fallback.model === output.model)?.cost;
          usageModel = fallbackCost ? { ...model, id: output.model, cost: fallbackCost } : model;
          output.usage.input = event.message.usage.input_tokens || 0;
          output.usage.output = event.message.usage.output_tokens || 0;
          output.usage.cacheRead = event.message.usage.cache_read_input_tokens || 0;
          output.usage.cacheWrite = event.message.usage.cache_creation_input_tokens || 0;
          output.usage.cacheWrite1h = event.message.usage.cache_creation?.ephemeral_1h_input_tokens || 0;
          output.usage.totalTokens = output.usage.input + output.usage.output + output.usage.cacheRead + output.usage.cacheWrite;
          calculateCost(usageModel, output.usage);
        } else if (event.type === "content_block_start") {
          if (event.content_block.type === "fallback") {
            if (output.content.length > 0) {
              throw new Error("Anthropic performed an unsupported mid-output model fallback");
            }
            continue;
          }
          if (event.content_block.type === "text") {
            const block = {
              type: "text",
              text: event.content_block.text ?? "",
              index: event.index
            };
            output.content.push(block);
            stream2.push({ type: "text_start", contentIndex: output.content.length - 1, partial: output });
          } else if (event.content_block.type === "thinking") {
            const block = {
              type: "thinking",
              thinking: event.content_block.thinking ?? "",
              thinkingSignature: event.content_block.signature ?? "",
              index: event.index
            };
            output.content.push(block);
            stream2.push({ type: "thinking_start", contentIndex: output.content.length - 1, partial: output });
          } else if (event.content_block.type === "redacted_thinking") {
            const block = {
              type: "thinking",
              thinking: "[Reasoning redacted]",
              thinkingSignature: event.content_block.data,
              redacted: true,
              index: event.index
            };
            output.content.push(block);
            stream2.push({ type: "thinking_start", contentIndex: output.content.length - 1, partial: output });
          } else if (event.content_block.type === "tool_use") {
            const block = {
              type: "toolCall",
              id: event.content_block.id,
              name: isOAuth ? fromClaudeCodeName(event.content_block.name, context.tools) : event.content_block.name,
              arguments: event.content_block.input ?? {},
              partialJson: "",
              index: event.index
            };
            output.content.push(block);
            stream2.push({ type: "toolcall_start", contentIndex: output.content.length - 1, partial: output });
          }
        } else if (event.type === "content_block_delta") {
          if (event.delta.type === "text_delta") {
            const index = blocks.findIndex((b) => b.index === event.index);
            const block = blocks[index];
            if (block && block.type === "text") {
              block.text += event.delta.text;
              stream2.push({
                type: "text_delta",
                contentIndex: index,
                delta: event.delta.text,
                partial: output
              });
            }
          } else if (event.delta.type === "thinking_delta") {
            const index = blocks.findIndex((b) => b.index === event.index);
            const block = blocks[index];
            if (block && block.type === "thinking") {
              block.thinking += event.delta.thinking;
              stream2.push({
                type: "thinking_delta",
                contentIndex: index,
                delta: event.delta.thinking,
                partial: output
              });
            }
          } else if (event.delta.type === "input_json_delta") {
            const index = blocks.findIndex((b) => b.index === event.index);
            const block = blocks[index];
            if (block && block.type === "toolCall") {
              block.partialJson += event.delta.partial_json;
              block.arguments = parseStreamingJson(block.partialJson);
              stream2.push({
                type: "toolcall_delta",
                contentIndex: index,
                delta: event.delta.partial_json,
                partial: output
              });
            }
          } else if (event.delta.type === "signature_delta") {
            const index = blocks.findIndex((b) => b.index === event.index);
            const block = blocks[index];
            if (block && block.type === "thinking") {
              block.thinkingSignature = block.thinkingSignature || "";
              block.thinkingSignature += event.delta.signature;
            }
          }
        } else if (event.type === "content_block_stop") {
          const index = blocks.findIndex((b) => b.index === event.index);
          const block = blocks[index];
          if (block) {
            delete block.index;
            if (block.type === "text") {
              stream2.push({
                type: "text_end",
                contentIndex: index,
                content: block.text,
                partial: output
              });
            } else if (block.type === "thinking") {
              stream2.push({
                type: "thinking_end",
                contentIndex: index,
                content: block.thinking,
                partial: output
              });
            } else if (block.type === "toolCall") {
              block.arguments = parseStreamingJson(block.partialJson);
              delete block.partialJson;
              stream2.push({
                type: "toolcall_end",
                contentIndex: index,
                toolCall: block,
                partial: output
              });
            }
          }
        } else if (event.type === "message_delta") {
          const transformations = event.input_transformations;
          if (Array.isArray(transformations))
            inputTransformations = transformations;
          if (event.delta.stop_reason) {
            output.rawStopReason = event.delta.stop_reason;
            const stopReasonResult = mapStopReason(event.delta.stop_reason, event.delta.stop_details);
            output.stopReason = stopReasonResult.stopReason;
            if (stopReasonResult.errorMessage) {
              output.errorMessage = stopReasonResult.errorMessage;
            }
          }
          if (event.usage) {
            if (event.usage.input_tokens != null) {
              output.usage.input = event.usage.input_tokens;
            }
            if (event.usage.output_tokens != null) {
              output.usage.output = event.usage.output_tokens;
            }
            if (event.usage.cache_read_input_tokens != null) {
              output.usage.cacheRead = event.usage.cache_read_input_tokens;
            }
            if (event.usage.cache_creation_input_tokens != null) {
              output.usage.cacheWrite = event.usage.cache_creation_input_tokens;
            }
            const thinkingTokens = event.usage.output_tokens_details?.thinking_tokens;
            if (thinkingTokens != null) {
              output.usage.reasoning = thinkingTokens;
            }
          }
          output.usage.totalTokens = output.usage.input + output.usage.output + output.usage.cacheRead + output.usage.cacheWrite;
          calculateCost(usageModel, output.usage);
        }
      }
      if (options?.signal?.aborted) {
        throw new Error("Request was aborted");
      }
      if (output.stopReason === "pending") {
        throw new Error("Anthropic stream ended without a stop reason");
      }
      if (output.stopReason === "aborted" || output.stopReason === "error") {
        throw new Error(output.errorMessage || "An unknown error occurred");
      }
      if (inputTransformations && inputTransformations.length > 0) {
        appendAssistantMessageDiagnostic(output, {
          type: "anthropic_input_transformations",
          timestamp: Date.now(),
          details: {
            transformations: inputTransformations.map((transformation) => ({
              type: transformation.type ?? void 0,
              path: transformation.path ?? void 0,
              reason: transformation.reason ?? void 0
            }))
          }
        });
      }
      stream2.push({ type: "done", reason: output.stopReason, message: output });
      stream2.end();
    } catch (error) {
      for (const block of output.content) {
        delete block.index;
        delete block.partialJson;
      }
      output.stopReason = options?.signal?.aborted ? "aborted" : "error";
      output.errorMessage = error instanceof Error ? error.message : JSON.stringify(error);
      stream2.push({ type: "error", reason: output.stopReason, error: output });
      stream2.end();
    }
  })();
  return stream2;
};
function mapThinkingLevelToEffort(model, level) {
  const mapped = level ? model.thinkingLevelMap?.[level] : void 0;
  if (typeof mapped === "string")
    return mapped;
  switch (level) {
    case "minimal":
    case "low":
      return "low";
    case "medium":
      return "medium";
    case "high":
      return "high";
    default:
      return "high";
  }
}
var streamSimple = (model, context, options) => {
  assertRequestAuth(model.provider, options?.apiKey, options?.headers);
  const base = {
    ...buildBaseOptions(model, context, options, options?.apiKey),
    toolChoice: options?.toolChoice
  };
  if (!options?.reasoning) {
    return stream(model, context, {
      ...base,
      thinkingEnabled: false
    });
  }
  if (model.compat?.forceAdaptiveThinking === true) {
    const effort = mapThinkingLevelToEffort(model, options.reasoning);
    return stream(model, context, {
      ...base,
      thinkingEnabled: true,
      effort
    });
  }
  const adjusted = adjustMaxTokensForThinking(base.maxTokens, model.maxTokens, options.reasoning, options.thinkingBudgets);
  const maxTokens = clampMaxTokensToContext(model, context, adjusted.maxTokens);
  return stream(model, context, {
    ...base,
    maxTokens,
    thinkingEnabled: true,
    thinkingBudgetTokens: Math.min(adjusted.thinkingBudget, Math.max(0, maxTokens - 1024))
  });
};
function isOAuthToken(apiKey) {
  return apiKey.includes("sk-ant-oat");
}
function createClient(model, apiKey, optionsHeaders, fetch, dynamicHeaders, sessionId) {
  if (model.provider === "github-copilot") {
    const client2 = new Anthropic({
      apiKey: null,
      authToken: apiKey ?? null,
      baseURL: model.baseUrl,
      dangerouslyAllowBrowser: true,
      fetch,
      defaultHeaders: mergeClientHeaders({
        accept: "application/json",
        "anthropic-dangerous-direct-browser-access": "true"
      }, model.headers, dynamicHeaders, optionsHeaders)
    });
    return { client: client2, isOAuthToken: false };
  }
  if (apiKey && isOAuthToken(apiKey)) {
    const client2 = new Anthropic({
      apiKey: null,
      authToken: apiKey,
      baseURL: model.baseUrl,
      dangerouslyAllowBrowser: true,
      fetch,
      defaultHeaders: mergeClientHeaders({
        accept: "application/json",
        "anthropic-dangerous-direct-browser-access": "true",
        "user-agent": `claude-cli/${claudeCodeVersion}`,
        "x-app": "cli"
      }, model.headers, optionsHeaders)
    });
    return { client: client2, isOAuthToken: true };
  }
  const sessionAffinityHeaders = sessionId && getAnthropicCompat(model).sendSessionAffinityHeaders ? { "x-session-affinity": sessionId } : {};
  const defaultHeaders = mergeClientHeaders({
    accept: "application/json",
    "anthropic-dangerous-direct-browser-access": "true"
  }, sessionAffinityHeaders, model.headers, optionsHeaders);
  const client = new Anthropic({
    apiKey: apiKey ?? null,
    authToken: null,
    baseURL: model.baseUrl,
    dangerouslyAllowBrowser: true,
    fetch,
    defaultHeaders
  });
  return { client, isOAuthToken: false };
}
function getBetaFeatures(model, context, isOAuthToken2, options) {
  let configuredFeatures;
  for (const headers of [model.headers, options?.headers]) {
    for (const [name, value] of Object.entries(headers ?? {})) {
      if (name.toLowerCase() === "anthropic-beta")
        configuredFeatures = value;
    }
  }
  if (configuredFeatures === null)
    return [];
  if (configuredFeatures !== void 0) {
    return [
      ...new Set(configuredFeatures.split(",").map((feature) => feature.trim()).filter((feature) => feature.length > 0))
    ];
  }
  const features = [];
  if (isOAuthToken2)
    features.push("claude-code-20250219", "oauth-2025-04-20");
  if (shouldUseFineGrainedToolStreamingBeta(model, context))
    features.push(FINE_GRAINED_TOOL_STREAMING_BETA);
  if (model.reasoning && options?.thinkingEnabled === true && (options.interleavedThinking ?? true) && model.compat?.forceAdaptiveThinking !== true) {
    features.push(INTERLEAVED_THINKING_BETA);
  }
  if (shouldUseServerSideFallbackBeta(model))
    features.push(SERVER_SIDE_FALLBACK_BETA);
  if (model.compat?.supportsMidConvoEffort === true) {
    features.push(MID_CONVERSATION_OUTPUT_CONFIG_BETA, THINKING_BINDING_CONTROLS_BETA);
  }
  return [...new Set(features)];
}
function buildParams(model, context, isOAuthToken2, options) {
  const { cacheControl } = getCacheControl(model, options?.cacheRetention, options?.env);
  const compat = getAnthropicCompat(model);
  const transformedMessages = transformMessages(context.messages, model, normalizeToolCallId);
  const normalizeToolName = isOAuthToken2 ? toClaudeCodeName : (name) => name;
  const toolPlacement = splitDeferredTools({ ...context, messages: transformedMessages }, compat.supportsToolReferences, normalizeToolName);
  let immediateTools = toolPlacement.immediate;
  let deferredTools = [...toolPlacement.deferred.values()];
  if (immediateTools.length === 0 && deferredTools.length > 0) {
    immediateTools = deferredTools;
    deferredTools = [];
  }
  const deferredToolNames = new Set(deferredTools.map((tool) => normalizeToolName(tool.name)));
  const converted = convertMessages(transformedMessages, isOAuthToken2, cacheControl, compat.allowEmptySignature, deferredToolNames, normalizeToolName, model.compat?.supportsMidConvoEffort === true ? model.provider : void 0);
  const activeEffort = options?.effort ?? "high";
  const betaFeatures = getBetaFeatures(model, context, isOAuthToken2, options);
  const params = {
    model: model.id,
    messages: model.compat?.supportsMidConvoEffort === true ? insertThinkingLevelMessages(converted, activeEffort) : converted.messages,
    max_tokens: options?.maxTokens ?? model.maxTokens,
    stream: true,
    ...betaFeatures.length > 0 ? { betas: betaFeatures } : {}
  };
  if (isOAuthToken2) {
    params.system = [
      {
        type: "text",
        text: "You are Claude Code, Anthropic's official CLI for Claude.",
        ...cacheControl ? { cache_control: cacheControl } : {}
      }
    ];
    if (context.systemPrompt) {
      params.system.push({
        type: "text",
        text: sanitizeSurrogates(context.systemPrompt),
        ...cacheControl ? { cache_control: cacheControl } : {}
      });
    }
  } else if (context.systemPrompt) {
    params.system = [
      {
        type: "text",
        text: sanitizeSurrogates(context.systemPrompt),
        ...cacheControl ? { cache_control: cacheControl } : {}
      }
    ];
  }
  if (options?.temperature !== void 0 && !options?.thinkingEnabled && model.compat?.supportsMidConvoEffort !== true && compat.supportsTemperature) {
    params.temperature = options.temperature;
  }
  if (immediateTools.length > 0 || deferredTools.length > 0) {
    params.tools = [
      ...convertTools(immediateTools, isOAuthToken2, compat.supportsEagerToolInputStreaming, compat.supportsStrictTools, compat.supportsCacheControlOnTools ? cacheControl : void 0),
      ...convertTools(deferredTools, isOAuthToken2, compat.supportsEagerToolInputStreaming, compat.supportsStrictTools, void 0, true)
    ];
  }
  if (model.compat?.supportsMidConvoEffort === true) {
    params.thinking = {
      type: "adaptive",
      display: options?.thinkingDisplay ?? "summarized",
      block_binding: { prefix_mismatch_behavior: "drop_block" }
    };
    params.output_config = { effort: "high" };
  } else if (model.reasoning) {
    if (options?.thinkingEnabled) {
      const display = options.thinkingDisplay ?? "summarized";
      if (model.compat?.forceAdaptiveThinking === true) {
        params.thinking = { type: "adaptive", display };
        if (options.effort) {
          params.output_config = { effort: options.effort };
        }
      } else {
        params.thinking = {
          type: "enabled",
          budget_tokens: options.thinkingBudgetTokens || 1024,
          display
        };
      }
    } else if (options?.thinkingEnabled === false && model.thinkingLevelMap?.off !== null) {
      params.thinking = { type: "disabled" };
    }
  }
  if (options?.metadata) {
    const userId = options.metadata.user_id;
    if (typeof userId === "string") {
      params.metadata = { user_id: userId };
    }
  }
  if (options?.toolChoice) {
    if (typeof options.toolChoice === "string") {
      params.tool_choice = { type: options.toolChoice };
    } else {
      params.tool_choice = options.toolChoice;
    }
  }
  const allowedFallbackModels = model.compat?.allowedFallbackModels;
  if (allowedFallbackModels && allowedFallbackModels.length > 0) {
    params.fallbacks = allowedFallbackModels.map((fallback) => ({ model: fallback.model }));
  }
  return params;
}
function normalizeToolCallId(id) {
  return id.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 64);
}
function convertToolResult(msg, isOAuthToken2, deferredToolNames, loadedToolNames, normalizeToolName) {
  const references = [];
  for (const name of msg.addedToolNames ?? []) {
    const normalizedName = normalizeToolName(name);
    if (!deferredToolNames.has(normalizedName) || loadedToolNames.has(normalizedName))
      continue;
    loadedToolNames.add(normalizedName);
    references.push({
      type: "tool_reference",
      tool_name: isOAuthToken2 ? toClaudeCodeName(name) : name
    });
  }
  const convertedContent = convertContentBlocks(msg.content);
  return {
    toolResult: {
      type: "tool_result",
      tool_use_id: msg.toolCallId,
      content: references.length > 0 ? references : convertedContent,
      is_error: msg.isError
    },
    siblingContent: references.length === 0 ? [] : typeof convertedContent === "string" ? [{ type: "text", text: convertedContent }] : convertedContent
  };
}
function convertMessages(transformedMessages, isOAuthToken2, cacheControl, allowEmptySignature = false, deferredToolNames = /* @__PURE__ */ new Set(), normalizeToolName = (name) => name, managedProvider) {
  const params = [];
  const assistantLevels = /* @__PURE__ */ new Map();
  const loadedToolNames = /* @__PURE__ */ new Set();
  for (let i = 0; i < transformedMessages.length; i++) {
    const msg = transformedMessages[i];
    if (msg.role === "user") {
      if (typeof msg.content === "string") {
        if (msg.content.trim().length > 0) {
          params.push({
            role: "user",
            content: sanitizeSurrogates(msg.content)
          });
        }
      } else {
        const blocks = msg.content.map((item) => {
          if (item.type === "text") {
            return {
              type: "text",
              text: sanitizeSurrogates(item.text)
            };
          } else {
            return {
              type: "image",
              source: {
                type: "base64",
                media_type: item.mimeType,
                data: item.data
              }
            };
          }
        });
        const filteredBlocks = blocks.filter((b) => {
          if (b.type === "text") {
            return b.text.trim().length > 0;
          }
          return true;
        });
        if (filteredBlocks.length === 0)
          continue;
        params.push({
          role: "user",
          content: filteredBlocks
        });
      }
    } else if (msg.role === "assistant") {
      const blocks = [];
      for (const block of msg.content) {
        if (block.type === "text") {
          if (block.text.trim().length === 0)
            continue;
          blocks.push({
            type: "text",
            text: sanitizeSurrogates(block.text)
          });
        } else if (block.type === "thinking") {
          if (block.redacted) {
            blocks.push({
              type: "redacted_thinking",
              data: block.thinkingSignature
            });
            continue;
          }
          const thinkingSignature = block.thinkingSignature;
          const hasThinkingSignature = !!thinkingSignature && thinkingSignature.trim().length > 0;
          if (block.thinking.trim().length === 0 && !hasThinkingSignature)
            continue;
          if (!hasThinkingSignature) {
            blocks.push(allowEmptySignature ? {
              type: "thinking",
              thinking: sanitizeSurrogates(block.thinking),
              signature: ""
            } : {
              type: "text",
              text: sanitizeSurrogates(block.thinking)
            });
          } else {
            blocks.push({
              type: "thinking",
              thinking: sanitizeSurrogates(block.thinking),
              signature: thinkingSignature
            });
          }
        } else if (block.type === "toolCall") {
          blocks.push({
            type: "tool_use",
            id: block.id,
            name: isOAuthToken2 ? toClaudeCodeName(block.name) : block.name,
            input: block.arguments ?? {}
          });
        }
      }
      if (blocks.length === 0)
        continue;
      const messageIndex = params.length;
      params.push({
        role: "assistant",
        content: blocks
      });
      if (managedProvider !== void 0 && msg.api === "anthropic-messages" && msg.provider === managedProvider && isAnthropicEffort(msg.providerThinkingLevel)) {
        assistantLevels.set(messageIndex, msg.providerThinkingLevel);
      }
    } else if (msg.role === "toolResult") {
      const toolResults = [];
      const siblingContent = [];
      let j = i;
      while (j < transformedMessages.length && transformedMessages[j].role === "toolResult") {
        const converted = convertToolResult(transformedMessages[j], isOAuthToken2, deferredToolNames, loadedToolNames, normalizeToolName);
        toolResults.push(converted.toolResult);
        siblingContent.push(...converted.siblingContent);
        j++;
      }
      i = j - 1;
      params.push({
        role: "user",
        content: [...toolResults, ...siblingContent]
      });
    }
  }
  if (cacheControl && params.length > 0) {
    const lastMessage = params[params.length - 1];
    if (lastMessage.role === "user") {
      if (Array.isArray(lastMessage.content)) {
        const lastBlock = lastMessage.content[lastMessage.content.length - 1];
        if (lastBlock && (lastBlock.type === "text" || lastBlock.type === "image" || lastBlock.type === "tool_result")) {
          lastBlock.cache_control = cacheControl;
        }
      } else if (typeof lastMessage.content === "string") {
        lastMessage.content = [
          {
            type: "text",
            text: lastMessage.content,
            cache_control: cacheControl
          }
        ];
      }
    }
  }
  return { messages: params, assistantLevels };
}
function isAnthropicEffort(value) {
  return value === "low" || value === "medium" || value === "high" || value === "xhigh" || value === "max";
}
function insertThinkingLevelMessages(converted, activeEffort) {
  const messages = [];
  for (let index = 0; index < converted.messages.length; index++) {
    const historicalEffort = converted.assistantLevels.get(index);
    if (historicalEffort !== void 0) {
      messages.push({ role: "system", content: [], output_config: { effort: historicalEffort } });
    }
    messages.push(converted.messages[index]);
  }
  messages.push({ role: "system", content: [], output_config: { effort: activeEffort } });
  return messages;
}
function shouldUseFineGrainedToolStreamingBeta(model, context) {
  return !!context.tools?.length && !getAnthropicCompat(model).supportsEagerToolInputStreaming;
}
function convertTools(tools, isOAuthToken2, supportsEagerToolInputStreaming, supportsStrictTools, cacheControl, deferLoading = false) {
  if (!tools)
    return [];
  return tools.map((tool, index) => {
    const strict = resolveJsonSchemaStrictSampling(tool, supportsStrictTools);
    const parameters = getJsonSchemaToolParameters(tool, strict);
    const schema = parameters;
    const legacyInputSchema = {
      type: "object",
      properties: schema.properties ?? {},
      required: schema.required ?? []
    };
    const inputSchema = strict === true ? {
      ...parameters,
      ...legacyInputSchema
    } : legacyInputSchema;
    return {
      name: isOAuthToken2 ? toClaudeCodeName(tool.name) : tool.name,
      description: tool.description,
      ...supportsEagerToolInputStreaming ? { eager_input_streaming: true } : {},
      ...strict === true ? { strict: true } : {},
      input_schema: inputSchema,
      ...deferLoading ? { defer_loading: true } : {},
      ...cacheControl && index === tools.length - 1 ? { cache_control: cacheControl } : {}
    };
  });
}
function mapStopReason(reason, stopDetails) {
  switch (reason) {
    case "end_turn":
      return { stopReason: "stop" };
    case "max_tokens":
      return { stopReason: "length" };
    case "tool_use":
      return { stopReason: "toolUse" };
    case "refusal":
      return {
        stopReason: "error",
        errorMessage: stopDetails?.explanation || `The model refused to complete the request`
      };
    case "pause_turn":
      return { stopReason: "stop" };
    case "stop_sequence":
      return { stopReason: "stop" };
    // We don't supply stop sequences, so this should never happen
    case "sensitive":
      return { stopReason: "error", errorMessage: "Provider stopped with: sensitive" };
    default:
      throw new Error(`Unhandled stop reason: ${reason}`);
  }
}
export {
  stream,
  streamSimple
};
