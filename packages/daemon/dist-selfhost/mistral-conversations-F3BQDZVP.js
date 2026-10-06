import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);
import {
  shortHash
} from "./chunk-57PBJDFG.js";
import {
  parseStreamingJson
} from "./chunk-T34ZTHKA.js";
import "./chunk-RRL4GVXC.js";
import {
  buildBaseOptions,
  getJsonSchemaToolParameters,
  getPiUserAgent,
  resolveJsonSchemaStrictSampling,
  transformMessages
} from "./chunk-CBKCMNE5.js";
import {
  sanitizeSurrogates
} from "./chunk-CQ5SN5T3.js";
import {
  headersToRecord
} from "./chunk-S66BGMVK.js";
import {
  calculateCost,
  clampThinkingLevel
} from "./chunk-63Q43JGI.js";
import {
  AssistantMessageEventStream
} from "./chunk-AJ7VZE7G.js";
import "./chunk-CB5SUWAA.js";

// ../../node_modules/.pnpm/@earendil-works+pi-ai@0.85.1_@modelcontextprotocol+sdk@1.29.0_zod@4.3.6__ws@8.20.0_zod@4.3.6/node_modules/@earendil-works/pi-ai/dist/api/mistral-conversations.js
var MISTRAL_TOOL_CALL_ID_LENGTH = 9;
var MAX_MISTRAL_ERROR_BODY_CHARS = 4e3;
var stream = (model, context, options) => {
  const stream2 = new AssistantMessageEventStream();
  (async () => {
    const output = createOutput(model);
    try {
      const apiKey = options?.apiKey;
      if (!apiKey) {
        throw new Error(`No API key for provider: ${model.provider}`);
      }
      const normalizeMistralToolCallId = createMistralToolCallIdNormalizer();
      const transformedMessages = transformMessages(context.messages, model, (id) => normalizeMistralToolCallId(id));
      let payload = buildChatPayload(model, context, transformedMessages, options);
      const nextPayload = await options?.onPayload?.(payload, model);
      if (nextPayload !== void 0) {
        payload = nextPayload;
      }
      const mistralStream = await requestMistralStream(model, payload, apiKey, options);
      stream2.push({ type: "start", partial: output });
      await consumeChatStream(model, output, stream2, mistralStream);
      if (options?.signal?.aborted) {
        throw new Error("Request was aborted");
      }
      if (output.stopReason === "pending") {
        throw new Error("Mistral stream ended without a finish reason");
      }
      if (output.stopReason === "aborted" || output.stopReason === "error") {
        throw new Error(output.errorMessage || "An unknown error occurred");
      }
      stream2.push({ type: "done", reason: output.stopReason, message: output });
      stream2.end();
    } catch (error) {
      for (const block of output.content) {
        delete block.partialArgs;
      }
      output.stopReason = options?.signal?.aborted ? "aborted" : "error";
      output.errorMessage = formatMistralError(error);
      stream2.push({ type: "error", reason: output.stopReason, error: output });
      stream2.end();
    }
  })();
  return stream2;
};
var streamSimple = (model, context, options) => {
  const apiKey = options?.apiKey;
  if (!apiKey) {
    throw new Error(`No API key for provider: ${model.provider}`);
  }
  const base = {
    ...buildBaseOptions(model, context, options, apiKey),
    toolChoice: options?.toolChoice
  };
  const clampedReasoning = options?.reasoning ? clampThinkingLevel(model, options.reasoning) : void 0;
  const reasoning = clampedReasoning === "off" ? void 0 : clampedReasoning;
  const shouldUseReasoning = model.reasoning && reasoning !== void 0;
  return stream(model, context, {
    ...base,
    promptMode: shouldUseReasoning && usesPromptModeReasoning(model) ? "reasoning" : void 0,
    reasoningEffort: shouldUseReasoning && usesReasoningEffort(model) ? mapReasoningEffort(model, reasoning) : void 0
  });
};
function createOutput(model) {
  return {
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
}
function createMistralToolCallIdNormalizer() {
  const idMap = /* @__PURE__ */ new Map();
  const reverseMap = /* @__PURE__ */ new Map();
  return (id) => {
    const existing = idMap.get(id);
    if (existing)
      return existing;
    let attempt = 0;
    while (true) {
      const candidate = deriveMistralToolCallId(id, attempt);
      const owner = reverseMap.get(candidate);
      if (!owner || owner === id) {
        idMap.set(id, candidate);
        reverseMap.set(candidate, id);
        return candidate;
      }
      attempt++;
    }
  };
}
function deriveMistralToolCallId(id, attempt) {
  const normalized = id.replace(/[^a-zA-Z0-9]/g, "");
  if (attempt === 0 && normalized.length === MISTRAL_TOOL_CALL_ID_LENGTH)
    return normalized;
  const seedBase = normalized || id;
  const seed = attempt === 0 ? seedBase : `${seedBase}:${attempt}`;
  return shortHash(seed).replace(/[^a-zA-Z0-9]/g, "").slice(0, MISTRAL_TOOL_CALL_ID_LENGTH);
}
function formatMistralError(error) {
  if (error instanceof Error) {
    const httpError = error;
    const statusCode = typeof httpError.statusCode === "number" ? httpError.statusCode : void 0;
    const bodyText = typeof httpError.body === "string" ? httpError.body.trim() : void 0;
    if (statusCode !== void 0 && bodyText) {
      return `Mistral API error (${statusCode}): ${truncateErrorText(bodyText, MAX_MISTRAL_ERROR_BODY_CHARS)}`;
    }
    if (statusCode !== void 0)
      return `Mistral API error (${statusCode}): ${error.message}`;
    return error.message;
  }
  return safeJsonStringify(error);
}
function truncateErrorText(text, maxChars) {
  if (text.length <= maxChars)
    return text;
  return `${text.slice(0, maxChars)}... [truncated ${text.length - maxChars} chars]`;
}
function safeJsonStringify(value) {
  try {
    const serialized = JSON.stringify(value);
    return serialized === void 0 ? String(value) : serialized;
  } catch {
    return String(value);
  }
}
async function requestMistralStream(model, payload, apiKey, options) {
  const baseUrl = new URL(model.baseUrl);
  baseUrl.pathname = `${baseUrl.pathname.replace(/\/+$/u, "")}/`;
  const url = new URL("v1/chat/completions", baseUrl);
  const headers = buildMistralHeaders(model, apiKey, options);
  const timeoutSignal = AbortSignal.timeout(options?.timeoutMs ?? 6e4);
  const signal = options?.signal ? AbortSignal.any([options.signal, timeoutSignal]) : timeoutSignal;
  const response = await (options?.fetch ?? globalThis.fetch)(url, {
    method: "POST",
    headers,
    body: JSON.stringify(toMistralWirePayload(payload)),
    signal
  });
  await options?.onResponse?.({ status: response.status, headers: headersToRecord(response.headers) }, model);
  if (!response.ok) {
    const body = await response.text();
    throw new MistralHttpError(response.status, body, response.statusText);
  }
  if (!response.body) {
    throw new Error("Mistral response has no body");
  }
  return readMistralEvents(response.body, signal);
}
var MistralHttpError = class extends Error {
  statusCode;
  body;
  constructor(statusCode, body, statusText) {
    super(statusText || `Request failed with status ${statusCode}`);
    this.name = "MistralHttpError";
    this.statusCode = statusCode;
    this.body = body;
  }
};
function buildMistralHeaders(model, apiKey, options) {
  const headers = new Headers({
    "User-Agent": getPiUserAgent(),
    accept: "text/event-stream",
    authorization: `Bearer ${apiKey}`,
    "content-type": "application/json"
  });
  applyMistralHeaderOverrides(headers, model.headers);
  applyMistralHeaderOverrides(headers, options?.headers);
  const hasExplicitAffinity = hasMistralHeaderOverride(model.headers, "x-affinity") || hasMistralHeaderOverride(options?.headers, "x-affinity");
  if (shouldUsePromptCaching(options) && !hasExplicitAffinity) {
    headers.set("x-affinity", options.sessionId);
  }
  return headers;
}
function applyMistralHeaderOverrides(headers, overrides) {
  if (!overrides)
    return;
  for (const [name, value] of Object.entries(overrides)) {
    if (value === null)
      headers.delete(name);
    else
      headers.set(name, value);
  }
}
function hasMistralHeaderOverride(overrides, target) {
  return !!overrides && Object.keys(overrides).some((name) => name.toLowerCase() === target);
}
function toMistralWirePayload(payload) {
  const wirePayload = { ...payload };
  for (const [source, target] of [
    ["topP", "top_p"],
    ["maxTokens", "max_tokens"],
    ["randomSeed", "random_seed"],
    ["responseFormat", "response_format"],
    ["toolChoice", "tool_choice"],
    ["presencePenalty", "presence_penalty"],
    ["frequencyPenalty", "frequency_penalty"],
    ["parallelToolCalls", "parallel_tool_calls"],
    ["reasoningEffort", "reasoning_effort"],
    ["promptMode", "prompt_mode"],
    ["promptCacheKey", "prompt_cache_key"],
    ["safePrompt", "safe_prompt"]
  ]) {
    remapMistralProperty(wirePayload, source, target);
  }
  wirePayload.messages = payload.messages.map((message) => toMistralWireMessage(message));
  const responseFormat = wirePayload.response_format;
  if (isMistralRecord(responseFormat)) {
    const wireResponseFormat = { ...responseFormat };
    remapMistralProperty(wireResponseFormat, "jsonSchema", "json_schema");
    const jsonSchema = wireResponseFormat.json_schema;
    if (isMistralRecord(jsonSchema)) {
      const wireJsonSchema = { ...jsonSchema };
      remapMistralProperty(wireJsonSchema, "schemaDefinition", "schema");
      wireResponseFormat.json_schema = wireJsonSchema;
    }
    wirePayload.response_format = wireResponseFormat;
  }
  return wirePayload;
}
function toMistralWireMessage(message) {
  const wireMessage = { ...message };
  remapMistralProperty(wireMessage, "toolCalls", "tool_calls");
  remapMistralProperty(wireMessage, "toolCallId", "tool_call_id");
  if (Array.isArray(message.content)) {
    wireMessage.content = message.content.map((chunk) => toMistralWireContentChunk(chunk));
  }
  return wireMessage;
}
function toMistralWireContentChunk(chunk) {
  const wireChunk = { ...chunk };
  for (const [source, target] of [
    ["imageUrl", "image_url"],
    ["documentUrl", "document_url"],
    ["documentName", "document_name"],
    ["fileId", "file_id"],
    ["referenceIds", "reference_ids"],
    ["inputAudio", "input_audio"]
  ]) {
    remapMistralProperty(wireChunk, source, target);
  }
  return wireChunk;
}
function remapMistralProperty(record, source, target) {
  if (!(source in record))
    return;
  record[target] = record[source];
  delete record[source];
}
function isMistralRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
var MISTRAL_STREAM_DONE = /* @__PURE__ */ Symbol("mistral-stream-done");
async function* readMistralEvents(body, signal) {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  const onAbort = () => {
    void reader.cancel().catch(() => {
    });
  };
  signal.addEventListener("abort", onAbort, { once: true });
  try {
    while (true) {
      if (signal.aborted)
        throw signal.reason;
      const { done, value } = await reader.read();
      if (signal.aborted)
        throw signal.reason;
      buffer += done ? decoder.decode() : decoder.decode(value, { stream: true });
      let boundary = findMistralEventBoundary(buffer);
      while (boundary) {
        const event = parseMistralEvent(buffer.slice(0, boundary.index));
        buffer = buffer.slice(boundary.index + boundary.length);
        if (event === MISTRAL_STREAM_DONE)
          return;
        if (event)
          yield event;
        boundary = findMistralEventBoundary(buffer);
      }
      if (done)
        break;
    }
    if (buffer.trim()) {
      const event = parseMistralEvent(buffer);
      if (event !== MISTRAL_STREAM_DONE && event)
        yield event;
    }
  } finally {
    signal.removeEventListener("abort", onAbort);
    try {
      await reader.cancel();
    } catch {
    }
    try {
      reader.releaseLock();
    } catch {
    }
  }
}
function findMistralEventBoundary(buffer) {
  const match = /\r\n\r\n|\r\n\r|\r\n\n|\r\r\n|\n\r\n|\r\r|\n\r|\n\n/u.exec(buffer);
  return match?.index === void 0 ? void 0 : { index: match.index, length: match[0].length };
}
function parseMistralEvent(raw) {
  const data = raw.split(/\r\n|\r|\n/u).filter((line) => line.startsWith("data:")).map((line) => line.slice(5).trimStart()).join("\n").trim();
  if (!data)
    return void 0;
  if (data === "[DONE]")
    return MISTRAL_STREAM_DONE;
  const parsed = JSON.parse(data);
  if (!isMistralRecord(parsed) || !Array.isArray(parsed.choices)) {
    throw new Error("Invalid Mistral streaming event");
  }
  return { data: parsed };
}
function buildChatPayload(model, context, messages, options) {
  const payload = {
    model: model.id,
    stream: true,
    messages: toChatMessages(messages, model.input.includes("image"))
  };
  if (context.tools?.length)
    payload.tools = toFunctionTools(context.tools);
  if (options?.temperature !== void 0)
    payload.temperature = options.temperature;
  if (options?.maxTokens !== void 0)
    payload.maxTokens = options.maxTokens;
  if (options?.toolChoice)
    payload.toolChoice = mapToolChoice(options.toolChoice);
  if (options?.promptMode)
    payload.promptMode = options.promptMode;
  if (options?.reasoningEffort)
    payload.reasoningEffort = options.reasoningEffort;
  if (shouldUsePromptCaching(options))
    payload.promptCacheKey = options.sessionId;
  if (context.systemPrompt) {
    payload.messages.unshift({
      role: "system",
      content: sanitizeSurrogates(context.systemPrompt)
    });
  }
  return payload;
}
function shouldUsePromptCaching(options) {
  return options?.cacheRetention !== "none" && !!options?.sessionId;
}
function getMistralCachedPromptTokens(usage, promptTokens) {
  const rawUsage = usage;
  const rawCachedTokens = rawUsage.promptTokensDetails?.cachedTokens ?? rawUsage.prompt_tokens_details?.cached_tokens ?? rawUsage.promptTokenDetails?.cachedTokens ?? rawUsage.prompt_token_details?.cached_tokens ?? rawUsage.numCachedTokens ?? rawUsage.num_cached_tokens ?? 0;
  const cachedTokens = typeof rawCachedTokens === "number" && Number.isFinite(rawCachedTokens) ? rawCachedTokens : 0;
  return Math.min(promptTokens, Math.max(0, cachedTokens));
}
async function consumeChatStream(model, output, stream2, mistralStream) {
  let currentBlock = null;
  const blocks = output.content;
  const blockIndex = () => blocks.length - 1;
  const toolBlocksByKey = /* @__PURE__ */ new Map();
  const finishCurrentBlock = (block) => {
    if (!block)
      return;
    if (block.type === "text") {
      stream2.push({
        type: "text_end",
        contentIndex: blockIndex(),
        content: block.text,
        partial: output
      });
      return;
    }
    if (block.type === "thinking") {
      stream2.push({
        type: "thinking_end",
        contentIndex: blockIndex(),
        content: block.thinking,
        partial: output
      });
    }
  };
  for await (const event of mistralStream) {
    const chunk = event.data;
    output.responseId ||= chunk.id;
    if (chunk.usage) {
      const promptTokens = chunk.usage.prompt_tokens || 0;
      const cachedPromptTokens = getMistralCachedPromptTokens(chunk.usage, promptTokens);
      output.usage.input = Math.max(0, promptTokens - cachedPromptTokens);
      output.usage.output = chunk.usage.completion_tokens || 0;
      output.usage.cacheRead = cachedPromptTokens;
      output.usage.cacheWrite = 0;
      output.usage.totalTokens = chunk.usage.total_tokens || output.usage.input + output.usage.output + output.usage.cacheRead + output.usage.cacheWrite;
      calculateCost(model, output.usage);
    }
    const choice = chunk.choices[0];
    if (!choice)
      continue;
    if (choice.finish_reason) {
      output.rawStopReason = choice.finish_reason;
      const stopReasonResult = mapChatStopReason(choice.finish_reason);
      output.stopReason = stopReasonResult.stopReason;
      if (stopReasonResult.errorMessage) {
        output.errorMessage = stopReasonResult.errorMessage;
      }
    }
    const delta = choice.delta;
    if (delta.content !== null && delta.content !== void 0) {
      const contentItems = typeof delta.content === "string" ? [delta.content] : delta.content;
      for (const item of contentItems) {
        if (typeof item === "string") {
          const textDelta = sanitizeSurrogates(item);
          if (!currentBlock || currentBlock.type !== "text") {
            finishCurrentBlock(currentBlock);
            currentBlock = { type: "text", text: "" };
            output.content.push(currentBlock);
            stream2.push({ type: "text_start", contentIndex: blockIndex(), partial: output });
          }
          currentBlock.text += textDelta;
          stream2.push({
            type: "text_delta",
            contentIndex: blockIndex(),
            delta: textDelta,
            partial: output
          });
          continue;
        }
        if (item.type === "thinking") {
          const deltaText = (item.thinking ?? []).map((part) => part.text ?? "").filter((text) => text.length > 0).join("");
          const thinkingDelta = sanitizeSurrogates(deltaText);
          if (!thinkingDelta)
            continue;
          if (!currentBlock || currentBlock.type !== "thinking") {
            finishCurrentBlock(currentBlock);
            currentBlock = { type: "thinking", thinking: "" };
            output.content.push(currentBlock);
            stream2.push({ type: "thinking_start", contentIndex: blockIndex(), partial: output });
          }
          currentBlock.thinking += thinkingDelta;
          stream2.push({
            type: "thinking_delta",
            contentIndex: blockIndex(),
            delta: thinkingDelta,
            partial: output
          });
          continue;
        }
        if (item.type === "text") {
          const textDelta = sanitizeSurrogates(item.text ?? "");
          if (!currentBlock || currentBlock.type !== "text") {
            finishCurrentBlock(currentBlock);
            currentBlock = { type: "text", text: "" };
            output.content.push(currentBlock);
            stream2.push({ type: "text_start", contentIndex: blockIndex(), partial: output });
          }
          currentBlock.text += textDelta;
          stream2.push({
            type: "text_delta",
            contentIndex: blockIndex(),
            delta: textDelta,
            partial: output
          });
        }
      }
    }
    const toolCalls = delta.tool_calls || [];
    for (const toolCall of toolCalls) {
      if (currentBlock) {
        finishCurrentBlock(currentBlock);
        currentBlock = null;
      }
      const callId = toolCall.id && toolCall.id !== "null" ? toolCall.id : deriveMistralToolCallId(`toolcall:${toolCall.index ?? 0}`, 0);
      const key = toolCall.index ?? callId;
      const existingIndex = toolBlocksByKey.get(key);
      let block;
      if (existingIndex !== void 0) {
        const existing = output.content[existingIndex];
        if (existing?.type === "toolCall") {
          block = existing;
        }
      }
      if (!block) {
        block = {
          type: "toolCall",
          id: callId,
          name: toolCall.function.name,
          arguments: {},
          partialArgs: ""
        };
        output.content.push(block);
        toolBlocksByKey.set(key, output.content.length - 1);
        stream2.push({ type: "toolcall_start", contentIndex: output.content.length - 1, partial: output });
      }
      const argsDelta = typeof toolCall.function.arguments === "string" ? toolCall.function.arguments : JSON.stringify(toolCall.function.arguments || {});
      block.partialArgs = (block.partialArgs || "") + argsDelta;
      block.arguments = parseStreamingJson(block.partialArgs);
      stream2.push({
        type: "toolcall_delta",
        contentIndex: toolBlocksByKey.get(key),
        delta: argsDelta,
        partial: output
      });
    }
  }
  finishCurrentBlock(currentBlock);
  for (const index of toolBlocksByKey.values()) {
    const block = output.content[index];
    if (block.type !== "toolCall")
      continue;
    const toolBlock = block;
    toolBlock.arguments = parseStreamingJson(toolBlock.partialArgs);
    delete toolBlock.partialArgs;
    stream2.push({
      type: "toolcall_end",
      contentIndex: index,
      toolCall: toolBlock,
      partial: output
    });
  }
}
function toFunctionTools(tools) {
  return tools.map((tool) => {
    const strict = resolveJsonSchemaStrictSampling(tool, true);
    return {
      type: "function",
      function: {
        name: tool.name,
        description: tool.description,
        parameters: stripSymbolKeys(getJsonSchemaToolParameters(tool, strict)),
        strict: strict ?? false
      }
    };
  });
}
function stripSymbolKeys(value) {
  if (Array.isArray(value)) {
    return value.map((item) => stripSymbolKeys(item));
  }
  if (value && typeof value === "object") {
    const result = {};
    for (const [key, entry] of Object.entries(value)) {
      result[key] = stripSymbolKeys(entry);
    }
    return result;
  }
  return value;
}
function toChatMessages(messages, supportsImages) {
  const result = [];
  for (const msg of messages) {
    if (msg.role === "user") {
      if (typeof msg.content === "string") {
        result.push({ role: "user", content: sanitizeSurrogates(msg.content) });
        continue;
      }
      const hadImages = msg.content.some((item) => item.type === "image");
      const content = msg.content.filter((item) => item.type === "text" || supportsImages).map((item) => {
        if (item.type === "text")
          return { type: "text", text: sanitizeSurrogates(item.text) };
        return { type: "image_url", imageUrl: `data:${item.mimeType};base64,${item.data}` };
      });
      if (content.length > 0) {
        result.push({ role: "user", content });
        continue;
      }
      if (hadImages && !supportsImages) {
        result.push({ role: "user", content: "(image omitted: model does not support images)" });
      }
      continue;
    }
    if (msg.role === "assistant") {
      const contentParts = [];
      const toolCalls = [];
      for (const block of msg.content) {
        if (block.type === "text") {
          if (block.text.trim().length > 0) {
            contentParts.push({ type: "text", text: sanitizeSurrogates(block.text) });
          }
          continue;
        }
        if (block.type === "thinking") {
          if (block.thinking.trim().length > 0) {
            contentParts.push({
              type: "thinking",
              thinking: [{ type: "text", text: sanitizeSurrogates(block.thinking) }]
            });
          }
          continue;
        }
        toolCalls.push({
          id: block.id,
          type: "function",
          function: { name: block.name, arguments: JSON.stringify(block.arguments || {}) },
          index: 0
        });
      }
      const assistantMessage = { role: "assistant", prefix: false };
      if (contentParts.length > 0)
        assistantMessage.content = contentParts;
      if (toolCalls.length > 0)
        assistantMessage.toolCalls = toolCalls;
      if (contentParts.length > 0 || toolCalls.length > 0)
        result.push(assistantMessage);
      continue;
    }
    const toolContent = [];
    const textResult = msg.content.filter((part) => part.type === "text").map((part) => part.type === "text" ? sanitizeSurrogates(part.text) : "").join("\n");
    const hasImages = msg.content.some((part) => part.type === "image");
    const toolText = buildToolResultText(textResult, hasImages, supportsImages, msg.isError);
    toolContent.push({ type: "text", text: toolText });
    for (const part of msg.content) {
      if (!supportsImages)
        continue;
      if (part.type !== "image")
        continue;
      toolContent.push({
        type: "image_url",
        imageUrl: `data:${part.mimeType};base64,${part.data}`
      });
    }
    result.push({
      role: "tool",
      toolCallId: msg.toolCallId,
      name: msg.toolName,
      content: toolContent
    });
  }
  return result;
}
function buildToolResultText(text, hasImages, supportsImages, isError) {
  const trimmed = text.trim();
  const errorPrefix = isError ? "[tool error] " : "";
  if (trimmed.length > 0) {
    const imageSuffix = hasImages && !supportsImages ? "\n[tool image omitted: model does not support images]" : "";
    return `${errorPrefix}${trimmed}${imageSuffix}`;
  }
  if (hasImages) {
    if (supportsImages) {
      return isError ? "[tool error] (see attached image)" : "(see attached image)";
    }
    return isError ? "[tool error] (image omitted: model does not support images)" : "(image omitted: model does not support images)";
  }
  return isError ? "[tool error] (no tool output)" : "(no tool output)";
}
function usesReasoningEffort(model) {
  return model.id === "mistral-small-2603" || model.id === "mistral-small-latest" || model.id === "mistral-medium-3.5";
}
function usesPromptModeReasoning(model) {
  return model.reasoning && !usesReasoningEffort(model);
}
function mapReasoningEffort(model, level) {
  return model.thinkingLevelMap?.[level] ?? "high";
}
function mapToolChoice(choice) {
  if (!choice)
    return void 0;
  if (choice === "auto" || choice === "none" || choice === "any" || choice === "required") {
    return choice;
  }
  return {
    type: "function",
    function: { name: choice.function.name }
  };
}
function mapChatStopReason(reason) {
  if (reason === null)
    return { stopReason: "stop" };
  switch (reason) {
    case "stop":
      return { stopReason: "stop" };
    case "length":
    case "model_length":
      return { stopReason: "length" };
    case "tool_calls":
      return { stopReason: "toolUse" };
    case "error":
      return { stopReason: "error", errorMessage: "Provider stopped with: error" };
    default:
      return { stopReason: "error", errorMessage: `Provider stopped with: ${reason}` };
  }
}
export {
  stream,
  streamSimple
};
