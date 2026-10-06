import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);
import {
  splitDeferredTools
} from "./chunk-YJSEYJSP.js";
import {
  buildCopilotDynamicHeaders,
  hasCopilotVisionInput
} from "./chunk-X3TWBBFJ.js";
import {
  convertResponsesMessages,
  convertResponsesTools,
  processResponsesStream
} from "./chunk-CH6EXN5H.js";
import {
  clampOpenAIPromptCacheKey
} from "./chunk-FBXGR6V7.js";
import "./chunk-57PBJDFG.js";
import {
  OpenAI
} from "./chunk-TQTHZL5T.js";
import {
  getProviderEnvValue
} from "./chunk-J4D24WEI.js";
import "./chunk-T34ZTHKA.js";
import "./chunk-RRL4GVXC.js";
import {
  formatProviderError,
  normalizeProviderError
} from "./chunk-L5NLFPQC.js";
import {
  buildBaseOptions,
  createGrammarToolInputProperties,
  getPiUserAgent
} from "./chunk-CBKCMNE5.js";
import {
  retryProviderRequest
} from "./chunk-SVOXWMTS.js";
import "./chunk-CQ5SN5T3.js";
import {
  headersToRecord
} from "./chunk-S66BGMVK.js";
import {
  clampThinkingLevel
} from "./chunk-63Q43JGI.js";
import {
  AssistantMessageEventStream
} from "./chunk-AJ7VZE7G.js";
import "./chunk-CB5SUWAA.js";

// ../../node_modules/.pnpm/@earendil-works+pi-ai@0.85.1_@modelcontextprotocol+sdk@1.29.0_zod@4.3.6__ws@8.20.0_zod@4.3.6/node_modules/@earendil-works/pi-ai/dist/api/openai-responses.js
var OPENAI_TOOL_CALL_PROVIDERS = /* @__PURE__ */ new Set(["openai", "openai-codex", "opencode"]);
var OPENAI_RESPONSES_MIN_OUTPUT_TOKENS = 16;
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
function getClientApiKey(provider, apiKey, headers) {
  if (apiKey)
    return apiKey;
  if (hasHeader(headers, "authorization") || hasHeader(headers, "cf-aig-authorization"))
    return "unused";
  throw new Error(`No API key for provider: ${provider}`);
}
function detectSessionAffinityFormat(model) {
  return model.provider === "openrouter" || model.baseUrl.includes("openrouter.ai") ? "openrouter" : "openai";
}
function resolveCacheRetention(cacheRetention, env) {
  if (cacheRetention) {
    return cacheRetention;
  }
  if (getProviderEnvValue("PI_CACHE_RETENTION", env) === "long") {
    return "long";
  }
  return "short";
}
function getCompat(model) {
  return {
    supportsDeveloperRole: model.compat?.supportsDeveloperRole ?? true,
    sessionAffinityFormat: model.compat?.sessionAffinityFormat ?? detectSessionAffinityFormat(model),
    supportsLongCacheRetention: model.compat?.supportsLongCacheRetention ?? true,
    supportsStrictMode: model.compat?.supportsStrictMode ?? false,
    supportsOpenAIGrammarTools: model.compat?.supportsOpenAIGrammarTools ?? false,
    supportsAdditionalTools: model.compat?.supportsAdditionalTools ?? false,
    supportsToolSearch: model.compat?.supportsToolSearch ?? false,
    supportsExplicitPromptCacheMode: model.compat?.supportsExplicitPromptCacheMode ?? false,
    supportsMaxOutputTokens: model.compat?.supportsMaxOutputTokens ?? true
  };
}
function getPromptCacheRetention(compat, cacheRetention) {
  return cacheRetention === "long" && compat.supportsLongCacheRetention && !compat.supportsExplicitPromptCacheMode ? "24h" : void 0;
}
function getPromptCacheOptions(compat, cacheRetention) {
  if (!compat.supportsExplicitPromptCacheMode)
    return void 0;
  if (cacheRetention === "none")
    return { mode: "explicit" };
  if (cacheRetention === "long" && compat.supportsLongCacheRetention)
    return { ttl: "30m" };
  return void 0;
}
function formatOpenAIResponsesError(error) {
  return formatProviderError(normalizeProviderError(error), "OpenAI API error");
}
var stream = (model, context, options) => {
  const stream2 = new AssistantMessageEventStream();
  (async () => {
    const output = {
      role: "assistant",
      content: [],
      api: model.api,
      provider: model.provider,
      model: model.id,
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
      const apiKey = getClientApiKey(model.provider, options?.apiKey, options?.headers);
      const cacheRetention = resolveCacheRetention(options?.cacheRetention, options?.env);
      const cacheSessionId = cacheRetention === "none" ? void 0 : options?.sessionId;
      const compat = getCompat(model);
      const grammarToolInputProperties = createGrammarToolInputProperties(context.tools, compat.supportsOpenAIGrammarTools);
      const client = createClient(model, context, apiKey, options?.headers, options?.fetch, cacheSessionId);
      let params = buildParams(model, context, options, compat, grammarToolInputProperties);
      const nextParams = await options?.onPayload?.(params, model);
      if (nextParams !== void 0) {
        params = nextParams;
      }
      const requestOptions = {
        ...options?.signal ? { signal: options.signal } : {},
        ...options?.timeoutMs !== void 0 ? { timeout: options.timeoutMs } : {},
        maxRetries: 0
      };
      const { data: openaiStream, response } = await retryProviderRequest(() => client.responses.create(params, requestOptions).withResponse(), {
        maxRetries: options?.maxRetries,
        maxRetryDelayMs: options?.maxRetryDelayMs,
        signal: options?.signal
      });
      await options?.onResponse?.({ status: response.status, headers: headersToRecord(response.headers) }, model);
      stream2.push({ type: "start", partial: output });
      await processResponsesStream(openaiStream, output, stream2, model, {
        serviceTier: options?.serviceTier,
        grammarToolInputProperties,
        applyServiceTierPricing: (usage, serviceTier) => applyServiceTierPricing(usage, serviceTier, model)
      });
      if (options?.signal?.aborted) {
        throw new Error("Request was aborted");
      }
      if (output.stopReason === "pending") {
        throw new Error("OpenAI Responses stream ended without a stop reason");
      }
      if (output.stopReason === "aborted" || output.stopReason === "error") {
        throw new Error(output.errorMessage || "An unknown error occurred");
      }
      stream2.push({ type: "done", reason: output.stopReason, message: output });
      stream2.end();
    } catch (error) {
      for (const block of output.content) {
        delete block.index;
        delete block.partialJson;
        delete block.customInput;
      }
      output.stopReason = options?.signal?.aborted ? "aborted" : "error";
      output.errorMessage = formatOpenAIResponsesError(error);
      stream2.push({ type: "error", reason: output.stopReason, error: output });
      stream2.end();
    }
  })();
  return stream2;
};
var streamSimple = (model, context, options) => {
  getClientApiKey(model.provider, options?.apiKey, options?.headers);
  const base = {
    ...buildBaseOptions(model, context, options, options?.apiKey),
    toolChoice: options?.toolChoice
  };
  const clampedReasoning = options?.reasoning ? clampThinkingLevel(model, options.reasoning) : void 0;
  const reasoningEffort = clampedReasoning === "off" ? void 0 : clampedReasoning;
  return stream(model, context, {
    ...base,
    reasoningEffort
  });
};
function createClient(model, context, apiKey, optionsHeaders, fetch, sessionId) {
  const compat = getCompat(model);
  const headers = { "User-Agent": getPiUserAgent(), ...model.headers };
  if (model.provider === "github-copilot") {
    const hasImages = hasCopilotVisionInput(context.messages);
    const copilotHeaders = buildCopilotDynamicHeaders({
      messages: context.messages,
      hasImages
    });
    Object.assign(headers, copilotHeaders);
  }
  if (sessionId) {
    if (compat.sessionAffinityFormat === "openrouter") {
      headers["x-session-id"] = sessionId;
    } else {
      if (compat.sessionAffinityFormat === "openai") {
        headers.session_id = sessionId;
      }
      headers["x-client-request-id"] = sessionId;
    }
  }
  if (optionsHeaders) {
    Object.assign(headers, optionsHeaders);
  }
  return new OpenAI({
    apiKey,
    baseURL: model.baseUrl,
    dangerouslyAllowBrowser: true,
    fetch,
    defaultHeaders: headers
  });
}
function buildParams(model, context, options, compat = getCompat(model), grammarToolInputProperties = createGrammarToolInputProperties(context.tools, compat.supportsOpenAIGrammarTools)) {
  const deferredToolsMode = compat.supportsAdditionalTools ? "additional-tools" : compat.supportsToolSearch ? "tool-search" : void 0;
  const toolPlacement = splitDeferredTools(context, deferredToolsMode !== void 0);
  const messages = convertResponsesMessages(model, context, OPENAI_TOOL_CALL_PROVIDERS, {
    grammarToolInputProperties,
    deferredTools: toolPlacement.deferred,
    deferredToolsMode,
    toolOptions: {
      supportsStrictMode: compat.supportsStrictMode,
      supportsOpenAIGrammarTools: compat.supportsOpenAIGrammarTools
    }
  });
  const cacheRetention = resolveCacheRetention(options?.cacheRetention, options?.env);
  const params = {
    model: model.id,
    input: messages,
    stream: true,
    prompt_cache_key: cacheRetention === "none" ? void 0 : clampOpenAIPromptCacheKey(options?.sessionId),
    prompt_cache_retention: getPromptCacheRetention(compat, cacheRetention),
    prompt_cache_options: getPromptCacheOptions(compat, cacheRetention),
    store: false
  };
  if (options?.maxTokens && compat.supportsMaxOutputTokens) {
    params.max_output_tokens = Math.max(options.maxTokens, OPENAI_RESPONSES_MIN_OUTPUT_TOKENS);
  }
  if (options?.temperature !== void 0) {
    params.temperature = options?.temperature;
  }
  if (options?.serviceTier !== void 0) {
    params.service_tier = options.serviceTier;
  }
  if (toolPlacement.immediate.length > 0) {
    params.tools = convertResponsesTools(toolPlacement.immediate, {
      supportsStrictMode: compat.supportsStrictMode,
      supportsOpenAIGrammarTools: compat.supportsOpenAIGrammarTools
    });
  }
  if (options?.toolChoice !== void 0) {
    params.tool_choice = options.toolChoice;
  }
  if (model.reasoning) {
    if (options?.reasoningEffort || options?.reasoningSummary) {
      const effort = options?.reasoningEffort ? model.thinkingLevelMap?.[options.reasoningEffort] ?? options.reasoningEffort : "medium";
      params.reasoning = {
        effort,
        summary: options?.reasoningSummary || "auto"
      };
      params.include = ["reasoning.encrypted_content"];
    } else if (model.provider !== "github-copilot" && model.thinkingLevelMap?.off !== null) {
      params.reasoning = {
        effort: model.thinkingLevelMap?.off ?? "none"
      };
    }
    if (model.provider === "xai")
      params.include = ["reasoning.encrypted_content"];
  }
  if (options?.samplingParams) {
    Object.assign(params, options.samplingParams);
  }
  return params;
}
function getServiceTierCostMultiplier(model, serviceTier) {
  switch (serviceTier) {
    case "flex":
      return 0.5;
    case "priority":
      return model.id === "gpt-5.5" ? 2.5 : 2;
    default:
      return 1;
  }
}
function applyServiceTierPricing(usage, serviceTier, model) {
  const multiplier = getServiceTierCostMultiplier(model, serviceTier);
  if (multiplier === 1)
    return;
  usage.cost.input *= multiplier;
  usage.cost.output *= multiplier;
  usage.cost.cacheRead *= multiplier;
  usage.cost.cacheWrite *= multiplier;
  usage.cost.total = usage.cost.input + usage.cost.output + usage.cost.cacheRead + usage.cost.cacheWrite;
}
export {
  stream,
  streamSimple
};
