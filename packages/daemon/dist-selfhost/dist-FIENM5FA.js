import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);
import {
  ModelRegistry,
  ModelRuntime,
  resolveCliModel
} from "./chunk-5FII4H22.js";
import {
  require_cross_spawn,
  require_which
} from "./chunk-4XCUPN6A.js";
import "./chunk-BOIPMNA7.js";
import "./chunk-IRVB6EBN.js";
import "./chunk-Z4QBTGP2.js";
import "./chunk-DEILRFKY.js";
import "./chunk-NZC4DGJR.js";
import "./chunk-TIEV6RXV.js";
import "./chunk-D7INORDC.js";
import "./chunk-RRL4GVXC.js";
import "./chunk-NGEXVQKU.js";
import {
  array,
  boolean,
  external_exports,
  int,
  intersection,
  literal,
  number,
  object,
  record,
  string,
  union,
  unknown,
  url
} from "./chunk-4UYAMUT4.js";
import {
  __toESM
} from "./chunk-CB5SUWAA.js";

// ../../node_modules/.pnpm/@botiverse+oar@0.0.7_@modelcontextprotocol+sdk@1.29.0_zod@4.3.6__ws@8.20.0_zod@4.3.6/node_modules/@botiverse/oar/dist/registry.js
var RuntimeRegistry = class {
  #runtimes;
  constructor(runtimes2) {
    const indexed = /* @__PURE__ */ new Map();
    for (const runtime of runtimes2) {
      if (indexed.has(runtime.id)) {
        throw new Error(`duplicate runtime id: ${runtime.id}`);
      }
      indexed.set(runtime.id, runtime);
    }
    this.#runtimes = indexed;
  }
  get(id) {
    return this.#runtimes.get(id);
  }
  require(id) {
    const runtime = this.get(id);
    if (runtime === void 0) {
      throw new Error(`unknown runtime: ${id}`);
    }
    return runtime;
  }
  list() {
    return [...this.#runtimes.values()];
  }
};
function createRuntimeRegistry(runtimes2) {
  return new RuntimeRegistry(runtimes2);
}

// ../../node_modules/.pnpm/@botiverse+oar@0.0.7_@modelcontextprotocol+sdk@1.29.0_zod@4.3.6__ws@8.20.0_zod@4.3.6/node_modules/@botiverse/oar/dist/contracts/runtime.js
function defineRuntime(runtime) {
  return runtime;
}

// ../../node_modules/.pnpm/@botiverse+oar@0.0.7_@modelcontextprotocol+sdk@1.29.0_zod@4.3.6__ws@8.20.0_zod@4.3.6/node_modules/@botiverse/oar/dist/runtimes/claude/account-usage.js
import { readFileSync } from "fs";
import { homedir, platform } from "os";
import { join } from "path";

// ../../node_modules/.pnpm/@botiverse+oar@0.0.7_@modelcontextprotocol+sdk@1.29.0_zod@4.3.6__ws@8.20.0_zod@4.3.6/node_modules/@botiverse/oar/dist/shared/executable/resolve.js
var import_which = __toESM(require_which(), 1);
function resolveExecutable(executable) {
  return import_which.default.sync(executable, { nothrow: true });
}

// ../../node_modules/.pnpm/@botiverse+oar@0.0.7_@modelcontextprotocol+sdk@1.29.0_zod@4.3.6__ws@8.20.0_zod@4.3.6/node_modules/@botiverse/oar/dist/shared/executable/run.js
import { execFile } from "child_process";

// ../../node_modules/.pnpm/@botiverse+oar@0.0.7_@modelcontextprotocol+sdk@1.29.0_zod@4.3.6__ws@8.20.0_zod@4.3.6/node_modules/@botiverse/oar/dist/shared/executable/process.js
var import_cross_spawn = __toESM(require_cross_spawn(), 1);
function requiresShell(command, platform2) {
  return platform2 === "win32" && /\.(?:cmd|bat)$/iu.test(command);
}
function spawnLineProcess(command, args, options = {}) {
  const child = (0, import_cross_spawn.default)(command, [...args], {
    ...options.cwd === void 0 ? {} : { cwd: options.cwd },
    env: options.env ?? process.env,
    stdio: ["pipe", "pipe", process.env.OAR_CHILD_STDERR === "inherit" ? "inherit" : "ignore"]
  });
  const { stdin, stdout } = child;
  if (stdin === null || stdout === null) {
    throw new Error("line process stdio must be piped");
  }
  const lineHandlers = [];
  const exitHandlers = [];
  let buffer = "";
  let readingLines = false;
  let ended = false;
  let exitCode = null;
  const { promise: spawned, resolve: spawnOk, reject: spawnFailed } = Promise.withResolvers();
  const { promise: exited, resolve: exitDone } = Promise.withResolvers();
  child.once("spawn", spawnOk);
  const end = (code) => {
    if (ended) {
      return;
    }
    ended = true;
    exitCode = code;
    for (const handler of exitHandlers) {
      handler(code);
    }
    exitDone(code);
  };
  child.on("exit", end);
  child.on("error", (error) => {
    spawnFailed(error);
    end(null);
  });
  const readLines = () => {
    stdout.on("data", (chunk) => {
      buffer += chunk.toString();
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const raw of lines) {
        const line = raw.trim();
        if (line.length > 0) {
          for (const handler of lineHandlers) {
            handler(line);
          }
        }
      }
    });
  };
  return {
    spawned,
    exited,
    stdin,
    stdout,
    write: (text5) => {
      stdin.write(text5);
    },
    onLine(handler) {
      lineHandlers.push(handler);
      if (!readingLines) {
        readingLines = true;
        readLines();
      }
    },
    onExit(handler) {
      if (ended) {
        queueMicrotask(() => {
          handler(exitCode);
        });
      } else {
        exitHandlers.push(handler);
      }
    },
    kill() {
      stdin.end();
      child.kill("SIGTERM");
    }
  };
}

// ../../node_modules/.pnpm/@botiverse+oar@0.0.7_@modelcontextprotocol+sdk@1.29.0_zod@4.3.6__ws@8.20.0_zod@4.3.6/node_modules/@botiverse/oar/dist/shared/executable/run.js
var runExecutable = async (executable, args, options = {}) => {
  const result = await new Promise((resolve) => {
    execFile(executable, [...args], {
      env: options.env,
      timeout: options.timeoutMs ?? 5e3,
      maxBuffer: 2 * 1024 * 1024,
      // Same Windows .cmd-shim rule as spawnLineProcess: modern Node throws
      // EINVAL (synchronously) on shell-less exec of .cmd/.bat.
      shell: requiresShell(executable, process.platform)
    }, (error, stdout, stderr) => {
      const exitCode = error !== null && "code" in error && typeof error.code === "number" ? error.code : null;
      resolve({
        ok: error === null,
        stdout,
        stderr,
        exitCode
      });
    });
  });
  return result;
};

// ../../node_modules/.pnpm/@botiverse+oar@0.0.7_@modelcontextprotocol+sdk@1.29.0_zod@4.3.6__ws@8.20.0_zod@4.3.6/node_modules/@botiverse/oar/dist/shared/executable/version.js
async function readExecutableVersion(executable, timeoutMs) {
  const result = await runExecutable(executable, ["--version"], timeoutMs === void 0 ? {} : { timeoutMs });
  if (!result.ok && result.exitCode === null) {
    throw new Error(`Failed to run ${executable} --version`);
  }
  if (!result.ok) {
    return void 0;
  }
  const line = result.stdout.trim().split(/\r?\n/u)[0];
  return line === void 0 || line.length === 0 ? void 0 : line;
}

// ../../node_modules/.pnpm/@botiverse+oar@0.0.7_@modelcontextprotocol+sdk@1.29.0_zod@4.3.6__ws@8.20.0_zod@4.3.6/node_modules/@botiverse/oar/dist/shared/instant.js
function utcInstantFromDate(value) {
  return Number.isFinite(value.getTime()) ? value.toISOString() : null;
}

// ../../node_modules/.pnpm/@botiverse+oar@0.0.7_@modelcontextprotocol+sdk@1.29.0_zod@4.3.6__ws@8.20.0_zod@4.3.6/node_modules/@botiverse/oar/dist/shared/json.js
function parseJson(text5) {
  try {
    const value = JSON.parse(text5);
    return value;
  } catch {
    return void 0;
  }
}
function asRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? Object.fromEntries(Object.entries(value)) : null;
}
function asNumber(value) {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}
function asEpochInstant(value) {
  const raw = asNumber(value);
  if (raw === null) {
    return null;
  }
  const instant = new Date(raw >= 1e12 ? raw : raw * 1e3);
  return utcInstantFromDate(instant);
}

// ../../node_modules/.pnpm/@botiverse+oar@0.0.7_@modelcontextprotocol+sdk@1.29.0_zod@4.3.6__ws@8.20.0_zod@4.3.6/node_modules/@botiverse/oar/dist/runtimes/claude/account-usage.js
var USAGE_ENDPOINT = "https://api.anthropic.com/api/oauth/usage";
var OAUTH_BETA = "oauth-2025-04-20";
var PROFILE_SCOPE = "user:profile";
function parseStoredOAuth(raw) {
  const oauth = asRecord(asRecord(parseJson(raw))?.claudeAiOauth);
  const accessToken = oauth?.accessToken;
  if (typeof accessToken !== "string" || accessToken.length === 0) {
    return null;
  }
  const scopes = oauth?.scopes;
  const hasProfileScope = Array.isArray(scopes) && scopes.includes(PROFILE_SCOPE);
  return { accessToken, hasProfileScope };
}
function credentialsFilePath() {
  const base = process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), ".claude");
  return join(base, ".credentials.json");
}
async function readStoredOAuth(timeoutMs) {
  try {
    return parseStoredOAuth(readFileSync(credentialsFilePath(), "utf8"));
  } catch {
  }
  if (platform() === "darwin") {
    const keychain = await runExecutable("security", ["find-generic-password", "-w", "-s", "Claude Code-credentials"], { timeoutMs });
    if (keychain.ok) {
      try {
        return parseStoredOAuth(keychain.stdout);
      } catch {
        return null;
      }
    }
  }
  return null;
}
function usageWindowLabel(kind, scope) {
  const modelName = asRecord(scope?.model)?.display_name;
  switch (kind) {
    case "session":
      return "Current session";
    case "weekly_all":
      return "Current week (all models)";
    case "weekly_scoped":
      return typeof modelName === "string" ? `Current week (${modelName})` : "Current week";
    default:
      return typeof kind === "string" && kind.length > 0 ? kind : "Usage limit";
  }
}
async function fetchUsage(accessToken, version, timeoutMs) {
  try {
    return await fetch(USAGE_ENDPOINT, {
      headers: {
        "Authorization": `Bearer ${accessToken}`,
        "anthropic-beta": OAUTH_BETA,
        "Content-Type": "application/json",
        "User-Agent": `claude-code/${version}`
      },
      signal: AbortSignal.timeout(Math.min(timeoutMs, 5e3))
    });
  } catch (error) {
    throw new Error("Failed to reach Claude usage endpoint", { cause: error });
  }
}
function resetInstant(value) {
  if (typeof value !== "string") {
    return null;
  }
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : utcInstantFromDate(date);
}
function projectClaudeUsage(payload, email, plan) {
  const limits = asRecord(payload)?.limits;
  const windows = [];
  let rateLimited = false;
  if (Array.isArray(limits)) {
    for (const entry of limits) {
      const limit = asRecord(entry);
      const percent = asNumber(limit?.percent);
      if (limit === null || percent === null || percent < 0) {
        continue;
      }
      const resetsAt = resetInstant(limit.resets_at);
      windows.push({
        label: usageWindowLabel(limit.kind, asRecord(limit.scope)),
        usedRatio: Number((percent / 100).toFixed(6)),
        ...resetsAt === null ? {} : { resetsAt }
      });
      rateLimited ||= limit.severity === "critical" || percent >= 100;
    }
  }
  if (windows.length === 0) {
    throw new Error("Claude usage endpoint returned no usable windows");
  }
  return {
    kind: "available",
    ...plan === void 0 ? {} : { plan },
    ...email === void 0 ? {} : { email },
    rateLimited,
    windows
  };
}
function claudeAccountPlan(payload) {
  const authStatus = asRecord(payload);
  if (authStatus?.loggedIn !== true || typeof authStatus.subscriptionType !== "string") {
    return void 0;
  }
  const plan = authStatus.subscriptionType.trim();
  return plan.length > 0 ? plan : void 0;
}
function isConfirmedNonSubscriptionLogin(authStatus) {
  if (typeof authStatus.apiKeySource === "string") {
    return true;
  }
  return typeof authStatus.authMethod === "string" && authStatus.authMethod !== "claude.ai";
}
var claudeAccountUsage = async (installation, options = {}) => {
  if (installation.via !== "executable") {
    return { kind: "unsupported" };
  }
  const command = installation.command;
  const timeoutMs = options.timeoutMs ?? 15e3;
  const env = { ...process.env, CLAUDECODE: void 0 };
  const auth = await runExecutable(command, ["auth", "status", "--json"], { env, timeoutMs });
  if (!auth.ok && auth.exitCode === null) {
    throw new Error("Failed to read Claude authentication status");
  }
  const authStatus = asRecord(parseJson(auth.stdout));
  if (!auth.ok || authStatus?.loggedIn === false) {
    return { kind: "reauth_required" };
  }
  const email = authStatus?.loggedIn === true && typeof authStatus.email === "string" ? authStatus.email : void 0;
  const plan = claudeAccountPlan(authStatus);
  if (authStatus?.loggedIn === true && isConfirmedNonSubscriptionLogin(authStatus)) {
    return { kind: "unsupported" };
  }
  const stored = await readStoredOAuth(timeoutMs);
  if (stored === null || !stored.hasProfileScope) {
    return { kind: "reauth_required" };
  }
  const response = await fetchUsage(stored.accessToken, installation.version ?? "0.0.0", timeoutMs);
  if (response.status === 401 || response.status === 403) {
    return { kind: "reauth_required" };
  }
  if (!response.ok) {
    throw new Error(`Claude usage endpoint returned HTTP ${response.status}`);
  }
  const payload = parseJson(await response.text());
  return projectClaudeUsage(payload, email, plan);
};

// ../../node_modules/.pnpm/@botiverse+oar@0.0.7_@modelcontextprotocol+sdk@1.29.0_zod@4.3.6__ws@8.20.0_zod@4.3.6/node_modules/@botiverse/oar/dist/shared/installation.js
import { existsSync } from "fs";
function usable(entry) {
  if (entry.includes("/") || entry.includes("\\")) {
    return existsSync(entry) ? entry : null;
  }
  return resolveExecutable(entry);
}
async function versionSnapshot(command, timeoutMs) {
  const version = await readExecutableVersion(command, timeoutMs);
  return version === void 0 ? { kind: "available", via: "executable", command } : { kind: "available", via: "executable", command, version };
}
function executableInstallation(envVar, command, fallbacks = [], readiness, options = {}) {
  return async () => {
    const pinned = process.env[envVar];
    const entries = pinned !== void 0 && pinned !== "" ? [pinned] : [command, ...typeof fallbacks === "function" ? fallbacks() : fallbacks];
    const found = [];
    for (const entry of entries) {
      const candidate = usable(entry);
      if (candidate !== null && !found.includes(candidate)) {
        found.push(candidate);
      }
    }
    const [first] = found;
    if (first === void 0) {
      return { kind: "not_found" };
    }
    if (readiness === void 0) {
      return versionSnapshot(first, options.versionTimeoutMs);
    }
    for (const candidate of found) {
      const result = await runExecutable(candidate, readiness, options.readinessTimeoutMs === void 0 ? {} : {
        timeoutMs: options.readinessTimeoutMs
      });
      if (!result.ok && result.exitCode === null) {
        throw new Error(`Failed to run ${candidate} ${readiness.join(" ")}`);
      }
      if (result.ok) {
        return versionSnapshot(candidate, options.versionTimeoutMs);
      }
    }
    return { kind: "unsupported", reason: `${readiness.join(" ")} failed` };
  };
}

// ../../node_modules/.pnpm/@botiverse+oar@0.0.7_@modelcontextprotocol+sdk@1.29.0_zod@4.3.6__ws@8.20.0_zod@4.3.6/node_modules/@botiverse/oar/dist/runtimes/claude/installation.js
var claudeInstallation = executableInstallation("OAR_CLAUDE_BIN", "claude");

// ../../node_modules/.pnpm/@botiverse+oar@0.0.7_@modelcontextprotocol+sdk@1.29.0_zod@4.3.6__ws@8.20.0_zod@4.3.6/node_modules/@botiverse/oar/dist/runtimes/claude/session.js
import { randomUUID as randomUUID2 } from "crypto";

// ../../node_modules/.pnpm/@botiverse+oar@0.0.7_@modelcontextprotocol+sdk@1.29.0_zod@4.3.6__ws@8.20.0_zod@4.3.6/node_modules/@botiverse/oar/dist/runtimes/claude/context-usage.js
function claudeContextUsageFromResult(message) {
  const usage = asRecord(message.usage);
  if (usage === null) {
    return null;
  }
  const input = asNumber(usage.input_tokens) ?? 0;
  const cacheRead = asNumber(usage.cache_read_input_tokens) ?? 0;
  const cacheCreate = asNumber(usage.cache_creation_input_tokens) ?? 0;
  const tokens = input + cacheRead + cacheCreate;
  const modelUsage = asRecord(message.modelUsage);
  const firstModel = modelUsage === null ? null : asRecord(Object.values(modelUsage)[0]);
  const contextWindow = firstModel === null ? null : asNumber(firstModel.contextWindow) ?? null;
  const percent = contextWindow === null || contextWindow === 0 ? null : Math.round(tokens / contextWindow * 100);
  return { tokens, contextWindow, percent };
}

// ../../node_modules/.pnpm/@botiverse+oar@0.0.7_@modelcontextprotocol+sdk@1.29.0_zod@4.3.6__ws@8.20.0_zod@4.3.6/node_modules/@botiverse/oar/dist/shared/seal-session.js
function sealSession(adapterSession) {
  const steerOrQueue = async (turn, input) => {
    let reason = "runtime cannot steer";
    if (turn.steer !== void 0) {
      const steered = await turn.steer(input);
      if (steered.kind === "accepted") {
        return { landed: "steered" };
      }
      ({ reason } = steered);
    }
    if (adapterSession.queue !== void 0) {
      await adapterSession.queue.add(input);
      return { landed: "queued" };
    }
    return { landed: "rejected", reason };
  };
  return { ...adapterSession, steerOrQueue };
}

// ../../node_modules/.pnpm/@botiverse+oar@0.0.7_@modelcontextprotocol+sdk@1.29.0_zod@4.3.6__ws@8.20.0_zod@4.3.6/node_modules/@botiverse/oar/dist/shared/session-kernel.js
import { randomUUID } from "crypto";
function createSessionKernel(sessionId = randomUUID()) {
  const observers = /* @__PURE__ */ new Set();
  let seq = 0;
  let activeTurn = null;
  const fanOut = (turnId, body) => {
    const event = {
      sessionId,
      turnId,
      seq,
      receivedAt: Date.now(),
      ...body
    };
    seq += 1;
    for (const observer of observers) {
      try {
        observer(event);
      } catch {
      }
    }
  };
  const begin = () => {
    if (activeTurn !== null && !activeTurn.settled()) {
      return null;
    }
    const id = randomUUID();
    let isSettled = false;
    const { promise: outcome, resolve: resolveOutcome } = Promise.withResolvers();
    const turn = {
      id,
      outcome,
      settled: () => isSettled,
      emit(body) {
        if (!isSettled) {
          fanOut(id, body);
        }
      },
      settle(result) {
        if (!isSettled) {
          fanOut(id, { kind: "turn_ended", outcome: result });
          isSettled = true;
          resolveOutcome(result);
        }
      }
    };
    activeTurn = turn;
    fanOut(id, { kind: "turn_started" });
    return turn;
  };
  return {
    sessionId,
    subscribe(observer) {
      observers.add(observer);
      return () => {
        observers.delete(observer);
      };
    },
    begin,
    active: () => activeTurn !== null && !activeTurn.settled() ? activeTurn : null
  };
}

// ../../node_modules/.pnpm/@botiverse+oar@0.0.7_@modelcontextprotocol+sdk@1.29.0_zod@4.3.6__ws@8.20.0_zod@4.3.6/node_modules/@botiverse/oar/dist/shared/failure-class.js
function classifyFailure(reason) {
  if (/\b401\b|authentication|unauthorized|invalid (?:x-)?api[- ]?key|log(?:ged)? ?in/iu.test(reason)) {
    return "auth";
  }
  if (/\b429\b|rate.?limit|quota|usage limit/iu.test(reason)) {
    return "quota";
  }
  if (/\b400\b|invalid_request/iu.test(reason)) {
    return "invalid_request";
  }
  if (/\b529\b|\b503\b|overloaded/iu.test(reason)) {
    return "overloaded";
  }
  if (/\b\d{3}\b|error/iu.test(reason)) {
    return "provider";
  }
  return "unknown";
}

// ../../node_modules/.pnpm/@botiverse+oar@0.0.7_@modelcontextprotocol+sdk@1.29.0_zod@4.3.6__ws@8.20.0_zod@4.3.6/node_modules/@botiverse/oar/dist/runtimes/claude/projection.js
var initialClaudeProjection = { inTurn: false, abortRequested: false };
function claudePrompted() {
  return { inTurn: true, abortRequested: false };
}
function claudeAbortRequested(state) {
  return { ...state, abortRequested: true };
}
function contentBlocks(message) {
  const inner = asRecord(message.message);
  const content = inner?.content;
  if (!Array.isArray(content)) {
    return [];
  }
  return content.map((block) => asRecord(block)).filter((block) => block !== null);
}
function assistantEvents(message) {
  const out = [];
  for (const block of contentBlocks(message)) {
    switch (String(block.type)) {
      case "text": {
        if (typeof block.text === "string") {
          out.push({ kind: "text_delta", text: block.text });
        }
        break;
      }
      case "thinking": {
        const content = typeof block.thinking === "string" && block.thinking.length > 0 ? { kind: "text", text: block.thinking } : { kind: "empty" };
        out.push({ kind: "reasoning", content });
        break;
      }
      case "redacted_thinking": {
        out.push({ kind: "reasoning", content: { kind: "redacted" } });
        break;
      }
      case "tool_use": {
        const started = {
          kind: "tool_call_started",
          callId: typeof block.id === "string" ? block.id : "unknown",
          tool: typeof block.name === "string" ? block.name : "unknown"
        };
        const input = block.input === void 0 ? void 0 : JSON.stringify(block.input);
        out.push(input === void 0 ? started : { ...started, input });
        break;
      }
      default:
        break;
    }
  }
  return out;
}
function toolResultEvents(message) {
  const out = [];
  for (const block of contentBlocks(message)) {
    if (block.type === "tool_result" && typeof block.tool_use_id === "string") {
      const output = block.content === void 0 ? void 0 : JSON.stringify(block.content);
      out.push(output === void 0 ? { kind: "tool_call_ended", callId: block.tool_use_id } : { kind: "tool_call_ended", callId: block.tool_use_id, output });
    }
  }
  return out;
}
function resultOutcome(state, message) {
  if (state.abortRequested) {
    return { kind: "aborted" };
  }
  if (message.is_error === true) {
    const text5 = typeof message.result === "string" && message.result.length > 0 ? message.result : void 0;
    const subtype = typeof message.subtype === "string" && message.subtype !== "success" ? message.subtype : void 0;
    const reason = text5 ?? subtype ?? "error";
    return { kind: "failed", reason, failure: classifyFailure(reason) };
  }
  return { kind: "completed" };
}
function foldClaudeStdout(state, message) {
  if (message.type === "system" && message.subtype === "init" && !state.inTurn) {
    return { state: { ...state, inTurn: true }, commands: [{ kind: "begin" }] };
  }
  if (!state.inTurn) {
    return { state, commands: [] };
  }
  switch (String(message.type)) {
    case "assistant":
      return { state, commands: assistantEvents(message).map((body) => ({ kind: "emit", body })) };
    case "user":
      return { state, commands: toolResultEvents(message).map((body) => ({ kind: "emit", body })) };
    case "result":
      return {
        state: { inTurn: false, abortRequested: false },
        commands: [{ kind: "settle", outcome: resultOutcome(state, message) }]
      };
    default:
      return { state, commands: [] };
  }
}

// ../../node_modules/.pnpm/@botiverse+oar@0.0.7_@modelcontextprotocol+sdk@1.29.0_zod@4.3.6__ws@8.20.0_zod@4.3.6/node_modules/@botiverse/oar/dist/runtimes/claude/session.js
function userMessage(text5) {
  return `${JSON.stringify({
    type: "user",
    message: { role: "user", content: [{ type: "text", text: text5 }] }
  })}
`;
}
var claudeSession = async (installation, options) => {
  if (installation.via !== "executable") {
    throw new Error("The claude session adapter needs an executable installation");
  }
  const sessionId = options.resume ?? randomUUID2();
  const child = spawnLineProcess(installation.command, [
    "-p",
    "--input-format",
    "stream-json",
    "--output-format",
    "stream-json",
    "--verbose",
    // YOLO by default (repo policy, 2026-08-24): in embedded/SDK use there is
    // no human at an approval prompt — a permission gate is a hang, not
    // safety. Isolation is the sandbox's job, not the approval flow's.
    "--dangerously-skip-permissions",
    ...options.resume === void 0 ? ["--session-id", sessionId] : ["--resume", sessionId],
    ...options.model === void 0 ? [] : ["--model", options.model],
    ...options.systemPrompt === void 0 ? [] : ["--system-prompt", options.systemPrompt],
    ...options.appendSystemPrompt === void 0 ? [] : ["--append-system-prompt", options.appendSystemPrompt]
  ], {
    cwd: options.cwd,
    env: { ...process.env, CLAUDECODE: void 0, ...options.env }
  });
  await child.spawned;
  const kernel = createSessionKernel(sessionId);
  const state = { child, turn: null, projection: initialClaudeProjection, disposed: false };
  let interruptCounter = 0;
  const heldQueue = [];
  let latestContextUsage = null;
  child.onLine((line) => {
    const message = asRecord(parseJson(line));
    if (message === null) {
      return;
    }
    if (message.type === "result") {
      latestContextUsage = claudeContextUsageFromResult(message) ?? latestContextUsage;
    }
    const { state: nextProjection, commands } = foldClaudeStdout(state.projection, message);
    state.projection = nextProjection;
    let settled = false;
    for (const command of commands) {
      switch (command.kind) {
        case "begin":
          state.turn = kernel.begin();
          break;
        case "emit":
          state.turn?.emit(command.body);
          break;
        case "settle":
          state.turn?.settle(command.outcome);
          state.turn = null;
          settled = true;
          break;
        default:
          break;
      }
    }
    if (settled && !state.disposed) {
      const next = heldQueue.shift();
      if (next !== void 0) {
        child.write(userMessage(next));
      }
    }
  });
  child.onExit(() => {
    const active = kernel.active();
    if (active !== null && !state.disposed) {
      active.settle({ kind: "failed", reason: "claude process exited", failure: "runtime_exited" });
    }
  });
  const makeTurn = (turn) => ({
    id: turn.id,
    outcome: turn.outcome,
    abort: async () => {
      if (turn.settled()) {
        return;
      }
      state.projection = claudeAbortRequested(state.projection);
      interruptCounter += 1;
      child.write(`${JSON.stringify({
        type: "control_request",
        request_id: `interrupt-${interruptCounter}`,
        request: { subtype: "interrupt" }
      })}
`);
      await turn.outcome;
    },
    steer: async (input) => {
      await Promise.resolve();
      if (turn.settled()) {
        return { kind: "not_steerable", reason: "turn already ended" };
      }
      child.write(userMessage(input));
      return { kind: "accepted" };
    }
  });
  const session = sealSession({
    id: kernel.sessionId,
    prompt(input) {
      const turn = kernel.begin();
      if (turn === null) {
        return { kind: "busy" };
      }
      state.turn = turn;
      state.projection = claudePrompted();
      child.write(userMessage(input));
      return { kind: "turn", turn: makeTurn(turn) };
    },
    subscribe: (observer) => kernel.subscribe(observer),
    contextUsage: () => latestContextUsage,
    queue: {
      durable: false,
      add: async (input) => {
        await Promise.resolve();
        if (kernel.active() === null) {
          child.write(userMessage(input));
        } else {
          heldQueue.push(input);
        }
      }
    },
    dispose: async () => {
      if (state.disposed) {
        return;
      }
      state.disposed = true;
      kernel.active()?.settle({ kind: "aborted" });
      child.kill();
      await child.exited;
    }
  });
  return session;
};

// ../../node_modules/.pnpm/@botiverse+oar@0.0.7_@modelcontextprotocol+sdk@1.29.0_zod@4.3.6__ws@8.20.0_zod@4.3.6/node_modules/@botiverse/oar/dist/runtimes/claude/index.js
var claudeRuntime = defineRuntime({
  id: "claude",
  installation: claudeInstallation,
  accountUsage: claudeAccountUsage,
  session: claudeSession
});

// ../../node_modules/.pnpm/@botiverse+oar@0.0.7_@modelcontextprotocol+sdk@1.29.0_zod@4.3.6__ws@8.20.0_zod@4.3.6/node_modules/@botiverse/oar/dist/runtimes/codex/app-server-client.js
function startAppServerClient(command, env, configOverrides = {}) {
  const overrideArgs = Object.entries(configOverrides).flatMap(([key, value]) => ["-c", `${key}=${value}`]);
  const child = spawnLineProcess(command, ["app-server", ...overrideArgs, "--listen", "stdio://"], env === void 0 ? {} : { env: { ...process.env, ...env } });
  const pending = /* @__PURE__ */ new Map();
  const notificationHandlers = [];
  let nextId = 1;
  child.onLine((line) => {
    const message = asRecord(parseJson(line));
    if (message === null) {
      return;
    }
    if (typeof message.id === "number" && pending.has(message.id)) {
      const waiter = pending.get(message.id);
      pending.delete(message.id);
      const error = asRecord(message.error);
      if (error !== null) {
        waiter?.reject(new Error(typeof error.message === "string" ? error.message : "app-server error"));
      } else {
        waiter?.resolve(asRecord(message.result) ?? {});
      }
    } else if (typeof message.method === "string") {
      const params = asRecord(message.params) ?? {};
      for (const handler of notificationHandlers) {
        handler(message.method, params);
      }
    }
  });
  child.onExit(() => {
    for (const waiter of pending.values()) {
      waiter.reject(new Error("app-server exited"));
    }
    pending.clear();
  });
  return {
    spawned: child.spawned,
    exited: child.exited,
    async request(method, params) {
      const id = nextId;
      nextId += 1;
      const result = await new Promise((resolve, reject) => {
        pending.set(id, { resolve, reject });
        child.write(`${JSON.stringify({ id, method, params })}
`);
      });
      return result;
    },
    notify(method, params) {
      child.write(`${JSON.stringify({ method, params })}
`);
    },
    onNotification(handler) {
      notificationHandlers.push(handler);
    },
    onExit(handler) {
      child.onExit(handler);
    },
    kill() {
      child.kill();
    }
  };
}

// ../../node_modules/.pnpm/@botiverse+oar@0.0.7_@modelcontextprotocol+sdk@1.29.0_zod@4.3.6__ws@8.20.0_zod@4.3.6/node_modules/@botiverse/oar/dist/runtimes/codex/account-usage.js
function text(value) {
  if (typeof value !== "string") {
    return void 0;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 && trimmed.length <= 80 ? trimmed : void 0;
}
function windowLabel(value) {
  const minutes = asNumber(value);
  if (minutes === null || minutes <= 0) {
    return "Usage limit";
  }
  if (minutes % (7 * 24 * 60) === 0) {
    const weeks = minutes / (7 * 24 * 60);
    return `${weeks} ${weeks === 1 ? "week" : "weeks"}`;
  }
  if (minutes % (24 * 60) === 0) {
    const days = minutes / (24 * 60);
    return `${days} ${days === 1 ? "day" : "days"}`;
  }
  if (minutes % 60 === 0) {
    const hours = minutes / 60;
    return `${hours} ${hours === 1 ? "hour" : "hours"}`;
  }
  return `${minutes} minutes`;
}
function limitLabel(bucket) {
  const name = text(bucket.limitName);
  if (name !== void 0) {
    return name;
  }
  const id = text(bucket.limitId);
  return id === "codex" ? "Codex" : id;
}
function rateLimitBuckets(historical, indexed) {
  const primaryLimitId = text(historical?.limitId);
  const buckets = historical === null ? [] : [historical];
  if (indexed === null) {
    return buckets;
  }
  for (const [limitId, value] of Object.entries(indexed)) {
    const bucket = asRecord(value);
    if (bucket === null) {
      continue;
    }
    if (primaryLimitId !== void 0 && (primaryLimitId === limitId || primaryLimitId === text(bucket.limitId))) {
      continue;
    }
    buckets.push(bucket);
  }
  return buckets;
}
function projectCodexUsage(result, email) {
  const root = asRecord(result);
  const historical = asRecord(root?.rateLimits);
  const indexed = asRecord(root?.rateLimitsByLimitId);
  const buckets = rateLimitBuckets(historical, indexed);
  const windows = [];
  let rateLimited = false;
  let plan = void 0;
  for (const bucket of buckets) {
    const sourceLabel = limitLabel(bucket);
    plan ??= text(bucket.planType);
    rateLimited ||= bucket.rateLimitReachedType !== null && bucket.rateLimitReachedType !== void 0;
    for (const kind of ["primary", "secondary"]) {
      const candidate = asRecord(bucket[kind]);
      if (candidate === null) {
        continue;
      }
      const usedPercent = asNumber(candidate.usedPercent);
      if (usedPercent === null || usedPercent < 0 || usedPercent > 100) {
        continue;
      }
      const resetsAt = asEpochInstant(candidate.resetsAt);
      const durationLabel = windowLabel(candidate.windowDurationMins);
      windows.push({
        label: sourceLabel === void 0 ? durationLabel : `${sourceLabel} \xB7 ${durationLabel}`,
        usedRatio: Number((usedPercent / 100).toFixed(6)),
        ...resetsAt === null ? {} : { resetsAt }
      });
      rateLimited ||= usedPercent >= 100;
    }
  }
  if (windows.length === 0) {
    throw new Error("Codex returned no usable account usage windows");
  }
  return {
    kind: "available",
    ...plan === void 0 ? {} : { plan },
    ...email === void 0 ? {} : { email },
    rateLimited,
    windows
  };
}
function accountEmail(result) {
  const account = asRecord(asRecord(result)?.account);
  if (account?.type !== "chatgpt" || typeof account.email !== "string") {
    return void 0;
  }
  return account.email;
}
function isNonSubscriptionAccount(result) {
  const root = asRecord(result);
  const account = asRecord(root?.account);
  return account?.type === "apiKey" || account?.type === "amazonBedrock" || root?.requiresOpenaiAuth === false;
}
async function readFromAppServer(command, timeoutMs, startClient = startAppServerClient) {
  const client2 = startClient(command);
  const deadline2 = setTimeout(() => {
    client2.kill();
  }, timeoutMs);
  try {
    await client2.request("initialize", {
      clientInfo: { name: "oar", version: "0.0.0" },
      capabilities: { experimentalApi: true }
    });
    client2.notify("initialized", {});
    let account = void 0;
    try {
      account = await client2.request("account/read", {});
    } catch {
    }
    if (isNonSubscriptionAccount(account)) {
      return { kind: "unsupported" };
    }
    const result = await client2.request("account/rateLimits/read", {});
    return { kind: "ok", result, email: accountEmail(account) };
  } catch (error) {
    const message = error instanceof Error ? error.message : "";
    if (/authentication required/iu.test(message)) {
      return { kind: "reauth_required" };
    }
    if (/method not found|not supported/iu.test(message)) {
      return { kind: "unsupported" };
    }
    return { kind: "error" };
  } finally {
    clearTimeout(deadline2);
    client2.kill();
  }
}
var codexAccountUsage = async (installation, options = {}) => {
  if (installation.via !== "executable") {
    return { kind: "unsupported" };
  }
  const outcome = await readFromAppServer(installation.command, options.timeoutMs ?? 8e3);
  switch (outcome.kind) {
    case "ok":
      return projectCodexUsage(outcome.result, outcome.email);
    case "reauth_required":
      return { kind: "reauth_required" };
    case "unsupported":
      return { kind: "unsupported" };
    case "error":
      break;
  }
  throw new Error("Failed to read Codex account usage");
};

// ../../node_modules/.pnpm/@botiverse+oar@0.0.7_@modelcontextprotocol+sdk@1.29.0_zod@4.3.6__ws@8.20.0_zod@4.3.6/node_modules/@botiverse/oar/dist/runtimes/codex/installation.js
import os from "os";
import path from "path";
var desktopBundles = process.platform === "darwin" ? [
  "/Applications/ChatGPT.app/Contents/Resources/codex",
  "/Applications/Codex.app/Contents/Resources/codex",
  path.join(os.homedir(), "Applications", "ChatGPT.app", "Contents", "Resources", "codex"),
  path.join(os.homedir(), "Applications", "Codex.app", "Contents", "Resources", "codex")
] : [];
var codexInstallation = executableInstallation("OAR_CODEX_BIN", "codex", desktopBundles, ["app-server", "--help"]);

// ../../node_modules/.pnpm/@botiverse+oar@0.0.7_@modelcontextprotocol+sdk@1.29.0_zod@4.3.6__ws@8.20.0_zod@4.3.6/node_modules/@botiverse/oar/dist/runtimes/codex/session.js
import { randomUUID as randomUUID3 } from "crypto";

// ../../node_modules/.pnpm/@botiverse+oar@0.0.7_@modelcontextprotocol+sdk@1.29.0_zod@4.3.6__ws@8.20.0_zod@4.3.6/node_modules/@botiverse/oar/dist/runtimes/codex/context-usage.js
function codexContextUsageFromNotification(params) {
  const total = asRecord(asRecord(params.tokenUsage)?.total);
  if (total === null) {
    return null;
  }
  const tokens = asNumber(total.inputTokens);
  return { tokens: tokens ?? null, contextWindow: null, percent: null };
}

// ../../node_modules/.pnpm/@botiverse+oar@0.0.7_@modelcontextprotocol+sdk@1.29.0_zod@4.3.6__ws@8.20.0_zod@4.3.6/node_modules/@botiverse/oar/dist/runtimes/codex/item-detail.js
function codexItemInput(item) {
  switch (item.type) {
    case "commandExecution":
      return typeof item.command === "string" ? item.command : void 0;
    case "fileChange":
      return Array.isArray(item.changes) ? JSON.stringify(item.changes) : void 0;
    case "mcpToolCall":
      return item.arguments === void 0 ? void 0 : JSON.stringify(item.arguments);
    case "webSearch":
      return typeof item.query === "string" ? item.query : void 0;
    default:
      return void 0;
  }
}
function codexItemOutput(item) {
  switch (item.type) {
    case "commandExecution": {
      const status = typeof item.exitCode === "number" ? `exit ${String(item.exitCode)}` : typeof item.status === "string" ? item.status : void 0;
      const output = typeof item.aggregatedOutput === "string" ? item.aggregatedOutput : void 0;
      return [status, output].filter((part) => part !== void 0 && part.length > 0).join("\n") || void 0;
    }
    case "fileChange":
      return typeof item.status === "string" ? item.status : void 0;
    case "mcpToolCall": {
      const error = asRecord(item.error);
      if (typeof error?.message === "string") {
        return `error: ${error.message}`;
      }
      return item.result === void 0 || item.result === null ? void 0 : JSON.stringify(item.result);
    }
    case "webSearch":
      return Array.isArray(item.results) ? JSON.stringify(item.results) : void 0;
    default:
      return void 0;
  }
}

// ../../node_modules/.pnpm/@botiverse+oar@0.0.7_@modelcontextprotocol+sdk@1.29.0_zod@4.3.6__ws@8.20.0_zod@4.3.6/node_modules/@botiverse/oar/dist/runtimes/codex/reasoning.js
function textParts(value) {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.flatMap((part) => {
    const text5 = asRecord(part)?.text;
    return typeof text5 === "string" && text5.length > 0 ? [text5] : [];
  });
}
function codexReasoningContent(item) {
  if (item?.type !== "reasoning") {
    return null;
  }
  const text5 = [...textParts(item.summary), ...textParts(item.content)].join("\n");
  if (text5.length > 0) {
    return { kind: "text", text: text5 };
  }
  return typeof item.encrypted_content === "string" ? { kind: "redacted" } : { kind: "empty" };
}

// ../../node_modules/.pnpm/@botiverse+oar@0.0.7_@modelcontextprotocol+sdk@1.29.0_zod@4.3.6__ws@8.20.0_zod@4.3.6/node_modules/@botiverse/oar/dist/runtimes/codex/projection.js
var TOOL_ITEM_TYPES = /* @__PURE__ */ new Set(["commandExecution", "fileChange", "mcpToolCall", "webSearch"]);
var initialCodexProjection = { inTurn: false, lastErrorDetail: null };
function codexPrompted(state) {
  return { ...state, inTurn: true };
}
function outcomeFromStatus(status) {
  switch (status) {
    case "interrupted":
      return { kind: "aborted" };
    case "completed":
      return { kind: "completed" };
    default: {
      const reason = typeof status === "string" ? status : "unknown";
      return { kind: "failed", reason, failure: classifyFailure(reason) };
    }
  }
}
function toolEvents(method, item) {
  const itemType = typeof item?.type === "string" ? item.type : "";
  if (!TOOL_ITEM_TYPES.has(itemType)) {
    return [];
  }
  const itemId = typeof item?.id === "string" ? item.id : "unknown";
  if (method === "item/started") {
    const input = item === null ? void 0 : codexItemInput(item);
    return [input === void 0 ? { kind: "tool_call_started", callId: itemId, tool: itemType } : { kind: "tool_call_started", callId: itemId, tool: itemType, input }];
  }
  const output = item === null ? void 0 : codexItemOutput(item);
  return [output === void 0 ? { kind: "tool_call_ended", callId: itemId } : { kind: "tool_call_ended", callId: itemId, output }];
}
function settleOutcome(state, status) {
  const outcome = outcomeFromStatus(status);
  if (outcome.kind === "failed" && state.lastErrorDetail !== null) {
    const reason = `${outcome.reason}: ${state.lastErrorDetail}`;
    return { kind: "failed", reason, failure: classifyFailure(reason) };
  }
  return outcome;
}
function emits(bodies) {
  return bodies.map((body) => ({ kind: "emit", body }));
}
function foldCodexNotification(state, method, params) {
  if (method === "turn/started") {
    return state.inTurn ? { state, commands: [] } : { state: { ...state, inTurn: true }, commands: [{ kind: "begin" }] };
  }
  if (method === "error") {
    const error = asRecord(params.error);
    const message = typeof error?.message === "string" ? error.message : "";
    const details = typeof error?.additionalDetails === "string" ? error.additionalDetails : "";
    const combined = [message, details].filter((part) => part.length > 0).join(" \u2014 ");
    return combined.length > 0 ? { state: { ...state, lastErrorDetail: combined }, commands: [] } : { state, commands: [] };
  }
  if (!state.inTurn) {
    return { state, commands: [] };
  }
  switch (method) {
    case "item/agentMessage/delta":
      return typeof params.delta === "string" ? { state, commands: emits([{ kind: "text_delta", text: params.delta }]) } : { state, commands: [] };
    case "rawResponseItem/completed": {
      const content = codexReasoningContent(asRecord(params.item));
      return content === null ? { state, commands: [] } : { state, commands: emits([{ kind: "reasoning", content }]) };
    }
    case "item/started":
    case "item/completed":
      return { state, commands: emits(toolEvents(method, asRecord(params.item))) };
    case "turn/completed":
      return {
        state: { inTurn: false, lastErrorDetail: null },
        commands: [{ kind: "settle", outcome: settleOutcome(state, asRecord(params.turn)?.status) }]
      };
    default:
      return { state, commands: [] };
  }
}

// ../../node_modules/.pnpm/@botiverse+oar@0.0.7_@modelcontextprotocol+sdk@1.29.0_zod@4.3.6__ws@8.20.0_zod@4.3.6/node_modules/@botiverse/oar/dist/runtimes/codex/session.js
var codexSession = async (installation, options) => {
  if (installation.via !== "executable") {
    throw new Error("The codex session adapter needs an executable installation");
  }
  const sandboxMode = process.env.OAR_CODEX_SANDBOX ?? "danger-full-access";
  const configOverrides = sandboxMode === "inherit" ? {} : { sandbox_mode: `"${sandboxMode}"` };
  const client2 = startAppServerClient(installation.command, options.env, configOverrides);
  await client2.request("initialize", {
    clientInfo: { name: "oar", version: "0.0.0" },
    capabilities: { experimentalApi: true }
  });
  client2.notify("initialized", {});
  const instructionParams = {
    ...options.systemPrompt === void 0 ? {} : { baseInstructions: options.systemPrompt },
    ...options.appendSystemPrompt === void 0 ? {} : { developerInstructions: options.appendSystemPrompt }
  };
  const started = options.resume === void 0 ? await client2.request("thread/start", {
    cwd: options.cwd,
    ...options.model === void 0 ? {} : { model: options.model },
    approvalPolicy: "never",
    // Required in addition to initialize.experimentalApi. This exposes
    // the completed Responses API reasoning item, whose encrypted_content
    // lets us distinguish redaction from genuinely empty reasoning.
    experimentalRawEvents: true,
    ...instructionParams
  }) : await client2.request("thread/resume", {
    threadId: options.resume,
    cwd: options.cwd,
    approvalPolicy: "never",
    ...instructionParams
  });
  const threadId = asRecord(started.thread)?.id;
  if (typeof threadId !== "string") {
    throw new TypeError("codex thread start/resume returned no thread id");
  }
  const kernel = createSessionKernel(threadId);
  let current = null;
  let disposed = false;
  let projection = initialCodexProjection;
  let latestContextUsage = null;
  client2.onNotification((method, params) => {
    if (params.threadId !== threadId) {
      return;
    }
    if (method === "thread/tokenUsage/updated") {
      latestContextUsage = codexContextUsageFromNotification(params) ?? latestContextUsage;
    }
    const { state: nextProjection, commands } = foldCodexNotification(projection, method, params);
    projection = nextProjection;
    for (const command of commands) {
      switch (command.kind) {
        case "begin": {
          const startedTurn = asRecord(params.turn)?.id;
          const kernelTurn = kernel.begin();
          if (kernelTurn !== null && typeof startedTurn === "string") {
            current = { kernelTurn, codexTurnId: Promise.resolve(startedTurn) };
          }
          break;
        }
        case "emit":
          current?.kernelTurn.emit(command.body);
          break;
        case "settle":
          current?.kernelTurn.settle(command.outcome);
          current = null;
          break;
        default:
          break;
      }
    }
  });
  client2.onExit(() => {
    if (!disposed) {
      kernel.active()?.settle({ kind: "failed", reason: "codex app-server exited", failure: "runtime_exited" });
    }
  });
  const makeTurn = (state) => ({
    id: state.kernelTurn.id,
    outcome: state.kernelTurn.outcome,
    abort: async () => {
      if (state.kernelTurn.settled()) {
        return;
      }
      const codexTurnId = await state.codexTurnId;
      if (!state.kernelTurn.settled()) {
        try {
          await client2.request("turn/interrupt", { threadId, turnId: codexTurnId });
        } catch {
        }
        await state.kernelTurn.outcome;
      }
    },
    steer: async (input) => {
      if (state.kernelTurn.settled()) {
        return { kind: "not_steerable", reason: "turn already ended" };
      }
      const codexTurnId = await state.codexTurnId;
      try {
        await client2.request("turn/steer", {
          threadId,
          input: [{ type: "text", text: input }],
          expectedTurnId: codexTurnId
        });
        return { kind: "accepted" };
      } catch (error) {
        return { kind: "not_steerable", reason: error instanceof Error ? error.message : "rejected" };
      }
    }
  });
  const session = sealSession({
    id: kernel.sessionId,
    prompt(input) {
      const kernelTurn = kernel.begin();
      if (kernelTurn === null) {
        return { kind: "busy" };
      }
      const codexTurnId = (async () => {
        const response = await client2.request("turn/start", {
          threadId,
          input: [{ type: "text", text: input }]
        });
        const turnId = asRecord(response.turn)?.id;
        if (typeof turnId !== "string") {
          throw new TypeError("codex turn/start returned no turn id");
        }
        return turnId;
      })();
      void (async () => {
        try {
          await codexTurnId;
        } catch (error) {
          const reason = error instanceof Error ? error.message : "turn/start failed";
          kernelTurn.settle({ kind: "failed", reason, failure: classifyFailure(reason) });
        }
      })();
      const state = { kernelTurn, codexTurnId };
      current = state;
      projection = codexPrompted(projection);
      return { kind: "turn", turn: makeTurn(state) };
    },
    subscribe: (observer) => kernel.subscribe(observer),
    contextUsage: () => latestContextUsage,
    queue: {
      durable: true,
      add: async (input) => {
        await client2.request("thread/queue/add", {
          threadId,
          input: [{ type: "text", text: input }],
          clientUserMessageId: randomUUID3()
        });
      }
    },
    dispose: async () => {
      if (disposed) {
        return;
      }
      disposed = true;
      kernel.active()?.settle({ kind: "aborted" });
      client2.kill();
      await client2.exited;
    }
  });
  return session;
};

// ../../node_modules/.pnpm/@botiverse+oar@0.0.7_@modelcontextprotocol+sdk@1.29.0_zod@4.3.6__ws@8.20.0_zod@4.3.6/node_modules/@botiverse/oar/dist/runtimes/codex/index.js
var codexRuntime = defineRuntime({
  id: "codex",
  installation: codexInstallation,
  accountUsage: codexAccountUsage,
  session: codexSession
});

// ../../node_modules/.pnpm/@agentclientprotocol+sdk@1.4.0_zod@4.3.6/node_modules/@agentclientprotocol/sdk/dist/schema/index.js
var AGENT_METHODS = {
  initialize: "initialize",
  authenticate: "authenticate",
  providers_list: "providers/list",
  providers_set: "providers/set",
  providers_disable: "providers/disable",
  session_new: "session/new",
  session_load: "session/load",
  session_set_mode: "session/set_mode",
  session_set_config_option: "session/set_config_option",
  session_prompt: "session/prompt",
  session_cancel: "session/cancel",
  mcp_message: "mcp/message",
  session_list: "session/list",
  session_delete: "session/delete",
  session_fork: "session/fork",
  session_resume: "session/resume",
  session_close: "session/close",
  logout: "logout",
  nes_start: "nes/start",
  nes_suggest: "nes/suggest",
  nes_accept: "nes/accept",
  nes_reject: "nes/reject",
  nes_close: "nes/close",
  document_did_open: "document/didOpen",
  document_did_change: "document/didChange",
  document_did_close: "document/didClose",
  document_did_save: "document/didSave",
  document_did_focus: "document/didFocus"
};
var CLIENT_METHODS = {
  session_request_permission: "session/request_permission",
  session_update: "session/update",
  fs_write_text_file: "fs/write_text_file",
  fs_read_text_file: "fs/read_text_file",
  terminal_create: "terminal/create",
  terminal_output: "terminal/output",
  terminal_release: "terminal/release",
  terminal_wait_for_exit: "terminal/wait_for_exit",
  terminal_kill: "terminal/kill",
  mcp_connect: "mcp/connect",
  mcp_message: "mcp/message",
  mcp_disconnect: "mcp/disconnect",
  elicitation_create: "elicitation/create",
  elicitation_complete: "elicitation/complete"
};
var PROTOCOL_METHODS = {
  cancel_request: "$/cancel_request"
};
var PROTOCOL_VERSION = 1;

// ../../node_modules/.pnpm/@agentclientprotocol+sdk@1.4.0_zod@4.3.6/node_modules/@agentclientprotocol/sdk/dist/schema-deserialize.js
var skippedItem = /* @__PURE__ */ Symbol("skippedItem");
function defaultOnError(schema, fallback) {
  return schema.catch(fallback);
}
function requiredDefaultOnError(schema, fallback) {
  const schemaWithCatch = schema.catch(fallback);
  return external_exports.unknown().transform((value, context) => {
    if (value !== void 0)
      return schemaWithCatch.parse(value);
    context.addIssue({
      code: "custom",
      message: "Required value is missing"
    });
    return external_exports.NEVER;
  });
}
function stringTag(value, key) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return void 0;
  }
  const tag = value[key];
  return typeof tag === "string" ? tag : void 0;
}
function excludeKnownTags(schema, key, knownTags) {
  return schema.superRefine((value, context) => {
    const tag = stringTag(value, key);
    if (tag !== void 0 && knownTags.includes(tag)) {
      context.addIssue({
        code: "custom",
        path: [key],
        message: `${key} ${JSON.stringify(tag)} is reserved by a known variant, but the value does not match that variant's schema`
      });
    }
  });
}
function preserveCustomPayload(schema, key, knownTags) {
  return external_exports.unknown().transform((value, context) => {
    const result = schema.safeParse(value);
    if (!result.success) {
      for (const issue of result.error.issues) {
        context.addIssue({ ...issue, input: value });
      }
      return external_exports.NEVER;
    }
    const output = result.data;
    const tag = stringTag(value, key);
    if (tag !== void 0 && !knownTags.includes(tag)) {
      const raw = value;
      for (const [property, rawValue] of Object.entries(raw)) {
        if (property === "__proto__")
          continue;
        if (!Object.hasOwn(output, property))
          output[property] = rawValue;
      }
    }
    return output;
  });
}
function vecSkipError(itemSchema) {
  return external_exports.array(itemSchema.catch(skippedItem)).transform((items) => items.filter((item) => item !== skippedItem));
}

// ../../node_modules/.pnpm/@agentclientprotocol+sdk@1.4.0_zod@4.3.6/node_modules/@agentclientprotocol/sdk/dist/schema/zod.gen.js
var zRequestId = union([number(), string()]).nullable();
var zSessionId = string();
var zWriteTextFileRequest = object({
  sessionId: zSessionId,
  path: string(),
  content: string(),
  _meta: defaultOnError(record(string(), unknown()).nullish(), () => void 0)
});
var zReadTextFileRequest = object({
  sessionId: zSessionId,
  path: string(),
  line: defaultOnError(int().gte(0).max(4294967295, {
    error: "Invalid value: Expected uint32 to be <= 4294967295"
  }).nullish(), () => void 0),
  limit: defaultOnError(int().gte(0).max(4294967295, {
    error: "Invalid value: Expected uint32 to be <= 4294967295"
  }).nullish(), () => void 0),
  _meta: defaultOnError(record(string(), unknown()).nullish(), () => void 0)
});
var zToolCallId = string();
var zToolKind = union([
  literal("read"),
  literal("edit"),
  literal("delete"),
  literal("move"),
  literal("search"),
  literal("execute"),
  literal("think"),
  literal("fetch"),
  literal("switch_mode"),
  literal("other")
]);
var zToolCallStatus = union([
  literal("pending"),
  literal("in_progress"),
  literal("completed"),
  literal("failed")
]);
var zRole = union([literal("assistant"), literal("user")]);
var zAnnotations = object({
  audience: defaultOnError(vecSkipError(zRole).nullish(), () => void 0),
  lastModified: defaultOnError(string().nullish(), () => void 0),
  priority: defaultOnError(number().nullish(), () => void 0),
  _meta: defaultOnError(record(string(), unknown()).nullish(), () => void 0)
});
var zTextContent = object({
  annotations: defaultOnError(zAnnotations.nullish(), () => void 0),
  text: string(),
  _meta: defaultOnError(record(string(), unknown()).nullish(), () => void 0)
});
var zImageContent = object({
  annotations: defaultOnError(zAnnotations.nullish(), () => void 0),
  data: string(),
  mimeType: string(),
  uri: defaultOnError(string().nullish(), () => void 0),
  _meta: defaultOnError(record(string(), unknown()).nullish(), () => void 0)
});
var zAudioContent = object({
  annotations: defaultOnError(zAnnotations.nullish(), () => void 0),
  data: string(),
  mimeType: string(),
  _meta: defaultOnError(record(string(), unknown()).nullish(), () => void 0)
});
var zResourceLink = object({
  annotations: defaultOnError(zAnnotations.nullish(), () => void 0),
  description: defaultOnError(string().nullish(), () => void 0),
  mimeType: defaultOnError(string().nullish(), () => void 0),
  name: string(),
  size: defaultOnError(number().nullish(), () => void 0),
  title: defaultOnError(string().nullish(), () => void 0),
  uri: string(),
  _meta: defaultOnError(record(string(), unknown()).nullish(), () => void 0)
});
var zTextResourceContents = object({
  mimeType: defaultOnError(string().nullish(), () => void 0),
  text: string(),
  uri: string(),
  _meta: defaultOnError(record(string(), unknown()).nullish(), () => void 0)
});
var zBlobResourceContents = object({
  blob: string(),
  mimeType: defaultOnError(string().nullish(), () => void 0),
  uri: string(),
  _meta: defaultOnError(record(string(), unknown()).nullish(), () => void 0)
});
var zEmbeddedResourceResource = union([
  zTextResourceContents,
  zBlobResourceContents
]);
var zEmbeddedResource = object({
  annotations: defaultOnError(zAnnotations.nullish(), () => void 0),
  resource: zEmbeddedResourceResource,
  _meta: defaultOnError(record(string(), unknown()).nullish(), () => void 0)
});
var zContentBlock = union([
  zTextContent.and(object({
    type: literal("text")
  })),
  zImageContent.and(object({
    type: literal("image")
  })),
  zAudioContent.and(object({
    type: literal("audio")
  })),
  zResourceLink.and(object({
    type: literal("resource_link")
  })),
  zEmbeddedResource.and(object({
    type: literal("resource")
  }))
]);
var zContent = object({
  content: zContentBlock,
  _meta: defaultOnError(record(string(), unknown()).nullish(), () => void 0)
});
var zDiff = object({
  path: string(),
  oldText: defaultOnError(string().nullish(), () => void 0),
  newText: string(),
  _meta: defaultOnError(record(string(), unknown()).nullish(), () => void 0)
});
var zTerminalId = string();
var zTerminal = object({
  terminalId: zTerminalId,
  _meta: defaultOnError(record(string(), unknown()).nullish(), () => void 0)
});
var zToolCallContent = union([
  zContent.and(object({
    type: literal("content")
  })),
  zDiff.and(object({
    type: literal("diff")
  })),
  zTerminal.and(object({
    type: literal("terminal")
  }))
]);
var zToolCallLocation = object({
  path: string(),
  line: defaultOnError(int().gte(0).max(4294967295, {
    error: "Invalid value: Expected uint32 to be <= 4294967295"
  }).nullish(), () => void 0),
  _meta: defaultOnError(record(string(), unknown()).nullish(), () => void 0)
});
var zToolCallUpdate = object({
  toolCallId: zToolCallId,
  kind: defaultOnError(zToolKind.nullish(), () => void 0),
  status: defaultOnError(zToolCallStatus.nullish(), () => void 0),
  title: defaultOnError(string().nullish(), () => void 0),
  name: defaultOnError(string().nullish(), () => void 0),
  content: defaultOnError(vecSkipError(zToolCallContent).nullish(), () => void 0),
  locations: defaultOnError(vecSkipError(zToolCallLocation).nullish(), () => void 0),
  rawInput: defaultOnError(unknown().optional(), () => void 0),
  rawOutput: defaultOnError(unknown().optional(), () => void 0),
  _meta: defaultOnError(record(string(), unknown()).nullish(), () => void 0)
});
var zPermissionOptionId = string();
var zPermissionOptionKind = union([
  literal("allow_once"),
  literal("allow_always"),
  literal("reject_once"),
  literal("reject_always")
]);
var zPermissionOption = object({
  optionId: zPermissionOptionId,
  name: string(),
  kind: zPermissionOptionKind,
  _meta: defaultOnError(record(string(), unknown()).nullish(), () => void 0)
});
var zRequestPermissionRequest = object({
  sessionId: zSessionId,
  toolCall: zToolCallUpdate,
  options: array(zPermissionOption),
  _meta: defaultOnError(record(string(), unknown()).nullish(), () => void 0)
});
var zEnvVariable = object({
  name: string(),
  value: string(),
  _meta: defaultOnError(record(string(), unknown()).nullish(), () => void 0)
});
var zCreateTerminalRequest = object({
  sessionId: zSessionId,
  command: string(),
  args: defaultOnError(vecSkipError(string()).optional(), () => []),
  env: defaultOnError(vecSkipError(zEnvVariable).optional(), () => []),
  cwd: defaultOnError(string().nullish(), () => void 0),
  outputByteLimit: defaultOnError(number().nullish(), () => void 0),
  _meta: defaultOnError(record(string(), unknown()).nullish(), () => void 0)
});
var zTerminalOutputRequest = object({
  sessionId: zSessionId,
  terminalId: zTerminalId,
  _meta: defaultOnError(record(string(), unknown()).nullish(), () => void 0)
});
var zReleaseTerminalRequest = object({
  sessionId: zSessionId,
  terminalId: zTerminalId,
  _meta: defaultOnError(record(string(), unknown()).nullish(), () => void 0)
});
var zWaitForTerminalExitRequest = object({
  sessionId: zSessionId,
  terminalId: zTerminalId,
  _meta: defaultOnError(record(string(), unknown()).nullish(), () => void 0)
});
var zKillTerminalRequest = object({
  sessionId: zSessionId,
  terminalId: zTerminalId,
  _meta: defaultOnError(record(string(), unknown()).nullish(), () => void 0)
});
var zElicitationSessionScope = object({
  sessionId: zSessionId,
  toolCallId: defaultOnError(zToolCallId.nullish(), () => void 0)
});
var zElicitationRequestScope = object({
  requestId: zRequestId
});
var zElicitationSchemaType = literal("object");
var zStringFormat = union([
  literal("email"),
  literal("uri"),
  literal("date"),
  literal("date-time")
]);
var zEnumOption = object({
  const: string(),
  title: string(),
  description: defaultOnError(string().nullish(), () => void 0),
  _meta: defaultOnError(record(string(), unknown()).nullish(), () => void 0)
});
var zStringPropertySchema = object({
  title: defaultOnError(string().nullish(), () => void 0),
  description: defaultOnError(string().nullish(), () => void 0),
  minLength: int().gte(0).max(4294967295, {
    error: "Invalid value: Expected uint32 to be <= 4294967295"
  }).nullish(),
  maxLength: int().gte(0).max(4294967295, {
    error: "Invalid value: Expected uint32 to be <= 4294967295"
  }).nullish(),
  pattern: string().nullish(),
  format: zStringFormat.nullish(),
  default: defaultOnError(string().nullish(), () => void 0),
  enum: array(string()).nullish(),
  oneOf: array(zEnumOption).nullish(),
  _meta: defaultOnError(record(string(), unknown()).nullish(), () => void 0)
});
var zNumberPropertySchema = object({
  title: defaultOnError(string().nullish(), () => void 0),
  description: defaultOnError(string().nullish(), () => void 0),
  minimum: number().nullish(),
  maximum: number().nullish(),
  default: defaultOnError(number().nullish(), () => void 0),
  _meta: defaultOnError(record(string(), unknown()).nullish(), () => void 0)
});
var zIntegerPropertySchema = object({
  title: defaultOnError(string().nullish(), () => void 0),
  description: defaultOnError(string().nullish(), () => void 0),
  minimum: number().nullish(),
  maximum: number().nullish(),
  default: defaultOnError(number().nullish(), () => void 0),
  _meta: defaultOnError(record(string(), unknown()).nullish(), () => void 0)
});
var zBooleanPropertySchema = object({
  title: defaultOnError(string().nullish(), () => void 0),
  description: defaultOnError(string().nullish(), () => void 0),
  default: defaultOnError(boolean().nullish(), () => void 0),
  _meta: defaultOnError(record(string(), unknown()).nullish(), () => void 0)
});
var zStringMultiSelectItems = object({
  enum: array(string()),
  _meta: defaultOnError(record(string(), unknown()).nullish(), () => void 0)
});
var zTitledMultiSelectItems = object({
  anyOf: array(zEnumOption),
  _meta: defaultOnError(record(string(), unknown()).nullish(), () => void 0)
});
var zMultiSelectItems = preserveCustomPayload(union([
  zStringMultiSelectItems.and(object({
    type: literal("string")
  })),
  excludeKnownTags(object({
    type: string()
  }), "type", ["string"]),
  zTitledMultiSelectItems
]), "type", ["string"]);
var zMultiSelectPropertySchema = object({
  title: defaultOnError(string().nullish(), () => void 0),
  description: defaultOnError(string().nullish(), () => void 0),
  minItems: number().nullish(),
  maxItems: number().nullish(),
  items: zMultiSelectItems,
  default: defaultOnError(vecSkipError(string()).nullish(), () => void 0),
  _meta: defaultOnError(record(string(), unknown()).nullish(), () => void 0)
});
var zElicitationPropertySchema = preserveCustomPayload(union([
  zStringPropertySchema.and(object({
    type: literal("string")
  })),
  zNumberPropertySchema.and(object({
    type: literal("number")
  })),
  zIntegerPropertySchema.and(object({
    type: literal("integer")
  })),
  zBooleanPropertySchema.and(object({
    type: literal("boolean")
  })),
  zMultiSelectPropertySchema.and(object({
    type: literal("array")
  })),
  excludeKnownTags(object({
    type: string()
  }), "type", ["array", "boolean", "integer", "number", "string"])
]), "type", ["array", "boolean", "integer", "number", "string"]);
var zElicitationSchema = object({
  type: defaultOnError(zElicitationSchemaType.optional().default("object"), () => "object"),
  title: defaultOnError(string().nullish(), () => void 0),
  properties: record(string(), zElicitationPropertySchema).optional().default({}),
  required: array(string()).nullish(),
  description: defaultOnError(string().nullish(), () => void 0),
  _meta: defaultOnError(record(string(), unknown()).nullish(), () => void 0)
});
var zElicitationFormMode = intersection(union([zElicitationSessionScope, zElicitationRequestScope]), object({
  requestedSchema: zElicitationSchema
}));
var zElicitationId = string();
var zElicitationUrlMode = intersection(union([zElicitationSessionScope, zElicitationRequestScope]), object({
  elicitationId: zElicitationId,
  url: url()
}));
var zCreateElicitationRequest = preserveCustomPayload(intersection(union([
  zElicitationFormMode.and(object({
    mode: literal("form")
  })),
  zElicitationUrlMode.and(object({
    mode: literal("url")
  })),
  excludeKnownTags(intersection(union([zElicitationSessionScope, zElicitationRequestScope]), object({
    mode: string()
  })), "mode", ["form", "url"])
]), object({
  message: string(),
  _meta: defaultOnError(record(string(), unknown()).nullish(), () => void 0)
})), "mode", ["form", "url"]);
var zMcpServerAcpId = string();
var zConnectMcpRequest = object({
  serverId: zMcpServerAcpId,
  _meta: defaultOnError(record(string(), unknown()).nullish(), () => void 0)
});
var zMcpConnectionId = string();
var zMessageMcpRequest = object({
  connectionId: zMcpConnectionId,
  method: string(),
  params: record(string(), unknown()).nullish(),
  _meta: defaultOnError(record(string(), unknown()).nullish(), () => void 0)
});
var zDisconnectMcpRequest = object({
  connectionId: zMcpConnectionId,
  _meta: defaultOnError(record(string(), unknown()).nullish(), () => void 0)
});
var zExtRequest = unknown();
var zAgentRequest = object({
  id: zRequestId,
  method: string(),
  params: union([
    zWriteTextFileRequest,
    zReadTextFileRequest,
    zRequestPermissionRequest,
    zCreateTerminalRequest,
    zTerminalOutputRequest,
    zReleaseTerminalRequest,
    zWaitForTerminalExitRequest,
    zKillTerminalRequest,
    zCreateElicitationRequest,
    zConnectMcpRequest,
    zMessageMcpRequest,
    zDisconnectMcpRequest,
    zExtRequest
  ]).nullish()
});
var zProtocolVersion = int().gte(0).lte(65535);
var zPromptCapabilities = object({
  image: defaultOnError(boolean().optional().default(false), () => false),
  audio: defaultOnError(boolean().optional().default(false), () => false),
  embeddedContext: defaultOnError(boolean().optional().default(false), () => false),
  _meta: defaultOnError(record(string(), unknown()).nullish(), () => void 0)
});
var zMcpCapabilities = object({
  http: defaultOnError(boolean().optional().default(false), () => false),
  sse: defaultOnError(boolean().optional().default(false), () => false),
  acp: defaultOnError(boolean().optional().default(false), () => false),
  _meta: defaultOnError(record(string(), unknown()).nullish(), () => void 0)
});
var zSessionListCapabilities = object({
  _meta: defaultOnError(record(string(), unknown()).nullish(), () => void 0)
});
var zSessionDeleteCapabilities = object({
  _meta: defaultOnError(record(string(), unknown()).nullish(), () => void 0)
});
var zSessionAdditionalDirectoriesCapabilities = object({
  _meta: defaultOnError(record(string(), unknown()).nullish(), () => void 0)
});
var zSessionForkCapabilities = object({
  _meta: defaultOnError(record(string(), unknown()).nullish(), () => void 0)
});
var zSessionResumeCapabilities = object({
  _meta: defaultOnError(record(string(), unknown()).nullish(), () => void 0)
});
var zSessionCloseCapabilities = object({
  _meta: defaultOnError(record(string(), unknown()).nullish(), () => void 0)
});
var zSessionCapabilities = object({
  list: defaultOnError(zSessionListCapabilities.nullish(), () => void 0),
  delete: defaultOnError(zSessionDeleteCapabilities.nullish(), () => void 0),
  additionalDirectories: defaultOnError(zSessionAdditionalDirectoriesCapabilities.nullish(), () => void 0),
  fork: defaultOnError(zSessionForkCapabilities.nullish(), () => void 0),
  resume: defaultOnError(zSessionResumeCapabilities.nullish(), () => void 0),
  close: defaultOnError(zSessionCloseCapabilities.nullish(), () => void 0),
  _meta: defaultOnError(record(string(), unknown()).nullish(), () => void 0)
});
var zLogoutCapabilities = object({
  _meta: defaultOnError(record(string(), unknown()).nullish(), () => void 0)
});
var zAgentAuthCapabilities = object({
  logout: defaultOnError(zLogoutCapabilities.nullish(), () => void 0),
  _meta: defaultOnError(record(string(), unknown()).nullish(), () => void 0)
});
var zProvidersCapabilities = object({
  _meta: defaultOnError(record(string(), unknown()).nullish(), () => void 0)
});
var zNesDocumentDidOpenCapabilities = object({
  _meta: defaultOnError(record(string(), unknown()).nullish(), () => void 0)
});
var zTextDocumentSyncKind = union([
  literal("full"),
  literal("incremental")
]);
var zNesDocumentDidChangeCapabilities = object({
  syncKind: zTextDocumentSyncKind,
  _meta: defaultOnError(record(string(), unknown()).nullish(), () => void 0)
});
var zNesDocumentDidCloseCapabilities = object({
  _meta: defaultOnError(record(string(), unknown()).nullish(), () => void 0)
});
var zNesDocumentDidSaveCapabilities = object({
  _meta: defaultOnError(record(string(), unknown()).nullish(), () => void 0)
});
var zNesDocumentDidFocusCapabilities = object({
  _meta: defaultOnError(record(string(), unknown()).nullish(), () => void 0)
});
var zNesDocumentEventCapabilities = object({
  didOpen: defaultOnError(zNesDocumentDidOpenCapabilities.nullish(), () => void 0),
  didChange: defaultOnError(zNesDocumentDidChangeCapabilities.nullish(), () => void 0),
  didClose: defaultOnError(zNesDocumentDidCloseCapabilities.nullish(), () => void 0),
  didSave: defaultOnError(zNesDocumentDidSaveCapabilities.nullish(), () => void 0),
  didFocus: defaultOnError(zNesDocumentDidFocusCapabilities.nullish(), () => void 0),
  _meta: defaultOnError(record(string(), unknown()).nullish(), () => void 0)
});
var zNesEventCapabilities = object({
  document: defaultOnError(zNesDocumentEventCapabilities.nullish(), () => void 0),
  _meta: defaultOnError(record(string(), unknown()).nullish(), () => void 0)
});
var zNesRecentFilesCapabilities = object({
  maxCount: defaultOnError(int().gte(0).max(4294967295, {
    error: "Invalid value: Expected uint32 to be <= 4294967295"
  }).nullish(), () => void 0),
  _meta: defaultOnError(record(string(), unknown()).nullish(), () => void 0)
});
var zNesRelatedSnippetsCapabilities = object({
  _meta: defaultOnError(record(string(), unknown()).nullish(), () => void 0)
});
var zNesEditHistoryCapabilities = object({
  maxCount: defaultOnError(int().gte(0).max(4294967295, {
    error: "Invalid value: Expected uint32 to be <= 4294967295"
  }).nullish(), () => void 0),
  _meta: defaultOnError(record(string(), unknown()).nullish(), () => void 0)
});
var zNesUserActionsCapabilities = object({
  maxCount: defaultOnError(int().gte(0).max(4294967295, {
    error: "Invalid value: Expected uint32 to be <= 4294967295"
  }).nullish(), () => void 0),
  _meta: defaultOnError(record(string(), unknown()).nullish(), () => void 0)
});
var zNesOpenFilesCapabilities = object({
  _meta: defaultOnError(record(string(), unknown()).nullish(), () => void 0)
});
var zNesDiagnosticsCapabilities = object({
  _meta: defaultOnError(record(string(), unknown()).nullish(), () => void 0)
});
var zNesContextCapabilities = object({
  recentFiles: defaultOnError(zNesRecentFilesCapabilities.nullish(), () => void 0),
  relatedSnippets: defaultOnError(zNesRelatedSnippetsCapabilities.nullish(), () => void 0),
  editHistory: defaultOnError(zNesEditHistoryCapabilities.nullish(), () => void 0),
  userActions: defaultOnError(zNesUserActionsCapabilities.nullish(), () => void 0),
  openFiles: defaultOnError(zNesOpenFilesCapabilities.nullish(), () => void 0),
  diagnostics: defaultOnError(zNesDiagnosticsCapabilities.nullish(), () => void 0),
  _meta: defaultOnError(record(string(), unknown()).nullish(), () => void 0)
});
var zNesCapabilities = object({
  events: defaultOnError(zNesEventCapabilities.nullish(), () => void 0),
  context: defaultOnError(zNesContextCapabilities.nullish(), () => void 0),
  _meta: defaultOnError(record(string(), unknown()).nullish(), () => void 0)
});
var zPositionEncodingKind = union([
  literal("utf-16"),
  literal("utf-32"),
  literal("utf-8")
]);
var zAgentCapabilities = object({
  loadSession: defaultOnError(boolean().optional().default(false), () => false),
  promptCapabilities: defaultOnError(zPromptCapabilities.optional().default({
    image: false,
    audio: false,
    embeddedContext: false
  }), () => ({
    image: false,
    audio: false,
    embeddedContext: false
  })),
  mcpCapabilities: defaultOnError(zMcpCapabilities.optional().default({
    http: false,
    sse: false,
    acp: false
  }), () => ({
    http: false,
    sse: false,
    acp: false
  })),
  sessionCapabilities: defaultOnError(zSessionCapabilities.optional().default({}), () => ({})),
  auth: defaultOnError(zAgentAuthCapabilities.optional().default({}), () => ({})),
  providers: defaultOnError(zProvidersCapabilities.nullish(), () => void 0),
  nes: defaultOnError(zNesCapabilities.nullish(), () => void 0),
  positionEncoding: defaultOnError(zPositionEncodingKind.nullish(), () => void 0),
  _meta: defaultOnError(record(string(), unknown()).nullish(), () => void 0)
});
var zAuthMethodId = string();
var zAuthMethodTerminal = object({
  id: zAuthMethodId,
  name: string(),
  description: defaultOnError(string().nullish(), () => void 0),
  args: defaultOnError(vecSkipError(string()).optional(), () => []),
  env: defaultOnError(record(string(), string()).optional(), () => void 0),
  _meta: defaultOnError(record(string(), unknown()).nullish(), () => void 0)
});
var zAuthMethodAgent = object({
  id: zAuthMethodId,
  name: string(),
  description: defaultOnError(string().nullish(), () => void 0),
  _meta: defaultOnError(record(string(), unknown()).nullish(), () => void 0)
});
var zAuthMethod = union([
  zAuthMethodTerminal.and(object({
    type: literal("terminal")
  })),
  zAuthMethodAgent
]);
var zImplementation = object({
  name: string(),
  title: defaultOnError(string().nullish(), () => void 0),
  version: string(),
  _meta: defaultOnError(record(string(), unknown()).nullish(), () => void 0)
});
var zInitializeResponse = object({
  protocolVersion: zProtocolVersion,
  agentCapabilities: defaultOnError(zAgentCapabilities.optional().default({
    loadSession: false,
    promptCapabilities: {
      image: false,
      audio: false,
      embeddedContext: false
    },
    mcpCapabilities: {
      http: false,
      sse: false,
      acp: false
    },
    sessionCapabilities: {},
    auth: {}
  }), () => ({
    loadSession: false,
    promptCapabilities: {
      image: false,
      audio: false,
      embeddedContext: false
    },
    mcpCapabilities: {
      http: false,
      sse: false,
      acp: false
    },
    sessionCapabilities: {},
    auth: {}
  })),
  authMethods: defaultOnError(vecSkipError(zAuthMethod).optional().default([]), () => []),
  agentInfo: defaultOnError(zImplementation.nullish(), () => void 0),
  _meta: defaultOnError(record(string(), unknown()).nullish(), () => void 0)
});
var zAuthenticateResponse = object({
  _meta: defaultOnError(record(string(), unknown()).nullish(), () => void 0)
});
var zProviderId = string();
var zLlmProtocol = union([
  literal("anthropic"),
  literal("openai"),
  literal("azure"),
  literal("vertex"),
  literal("bedrock"),
  string()
]);
var zProviderCurrentConfig = object({
  apiType: zLlmProtocol,
  baseUrl: string(),
  _meta: defaultOnError(record(string(), unknown()).nullish(), () => void 0)
});
var zProviderInfo = object({
  providerId: zProviderId,
  supported: requiredDefaultOnError(vecSkipError(zLlmProtocol), () => []),
  required: boolean(),
  current: zProviderCurrentConfig.nullish(),
  _meta: defaultOnError(record(string(), unknown()).nullish(), () => void 0)
});
var zListProvidersResponse = object({
  providers: array(zProviderInfo),
  _meta: defaultOnError(record(string(), unknown()).nullish(), () => void 0)
});
var zSetProviderResponse = object({
  _meta: defaultOnError(record(string(), unknown()).nullish(), () => void 0)
});
var zDisableProviderResponse = object({
  _meta: defaultOnError(record(string(), unknown()).nullish(), () => void 0)
});
var zLogoutResponse = object({
  _meta: defaultOnError(record(string(), unknown()).nullish(), () => void 0)
});
var zSessionModeId = string();
var zSessionMode = object({
  id: zSessionModeId,
  name: string(),
  description: defaultOnError(string().nullish(), () => void 0),
  _meta: defaultOnError(record(string(), unknown()).nullish(), () => void 0)
});
var zSessionModeState = object({
  currentModeId: zSessionModeId,
  availableModes: requiredDefaultOnError(vecSkipError(zSessionMode), () => []),
  _meta: defaultOnError(record(string(), unknown()).nullish(), () => void 0)
});
var zSessionConfigId = string();
var zSessionConfigOptionCategory = union([
  literal("mode"),
  literal("model"),
  literal("model_config"),
  literal("thought_level"),
  string()
]);
var zSessionConfigValueId = string();
var zSessionConfigSelectOption = object({
  value: zSessionConfigValueId,
  name: string(),
  description: defaultOnError(string().nullish(), () => void 0),
  _meta: defaultOnError(record(string(), unknown()).nullish(), () => void 0)
});
var zSessionConfigGroupId = string();
var zSessionConfigSelectGroup = object({
  group: zSessionConfigGroupId,
  name: string(),
  options: requiredDefaultOnError(vecSkipError(zSessionConfigSelectOption), () => []),
  _meta: defaultOnError(record(string(), unknown()).nullish(), () => void 0)
});
var zSessionConfigSelectOptions = union([
  array(zSessionConfigSelectOption),
  array(zSessionConfigSelectGroup)
]);
var zSessionConfigSelect = object({
  currentValue: zSessionConfigValueId,
  options: zSessionConfigSelectOptions
});
var zSessionConfigBoolean = object({
  currentValue: boolean()
});
var zSessionConfigOption = intersection(union([
  zSessionConfigSelect.and(object({
    type: literal("select")
  })),
  zSessionConfigBoolean.and(object({
    type: literal("boolean")
  }))
]), object({
  id: zSessionConfigId,
  name: string(),
  description: defaultOnError(string().nullish(), () => void 0),
  category: defaultOnError(zSessionConfigOptionCategory.nullish(), () => void 0),
  _meta: defaultOnError(record(string(), unknown()).nullish(), () => void 0)
}));
var zNewSessionResponse = object({
  sessionId: zSessionId,
  modes: defaultOnError(zSessionModeState.nullish(), () => void 0),
  configOptions: defaultOnError(vecSkipError(zSessionConfigOption).nullish(), () => void 0),
  _meta: defaultOnError(record(string(), unknown()).nullish(), () => void 0)
});
var zLoadSessionResponse = object({
  modes: defaultOnError(zSessionModeState.nullish(), () => void 0),
  configOptions: defaultOnError(vecSkipError(zSessionConfigOption).nullish(), () => void 0),
  _meta: defaultOnError(record(string(), unknown()).nullish(), () => void 0)
});
var zSessionInfo = object({
  sessionId: zSessionId,
  cwd: string(),
  additionalDirectories: defaultOnError(vecSkipError(string()).optional(), () => []),
  title: defaultOnError(string().nullish(), () => void 0),
  updatedAt: defaultOnError(string().nullish(), () => void 0),
  _meta: defaultOnError(record(string(), unknown()).nullish(), () => void 0)
});
var zListSessionsResponse = object({
  sessions: requiredDefaultOnError(vecSkipError(zSessionInfo), () => []),
  nextCursor: defaultOnError(string().nullish(), () => void 0),
  _meta: defaultOnError(record(string(), unknown()).nullish(), () => void 0)
});
var zDeleteSessionResponse = object({
  _meta: defaultOnError(record(string(), unknown()).nullish(), () => void 0)
});
var zForkSessionResponse = object({
  sessionId: zSessionId,
  modes: defaultOnError(zSessionModeState.nullish(), () => void 0),
  configOptions: defaultOnError(vecSkipError(zSessionConfigOption).nullish(), () => void 0),
  _meta: defaultOnError(record(string(), unknown()).nullish(), () => void 0)
});
var zResumeSessionResponse = object({
  modes: defaultOnError(zSessionModeState.nullish(), () => void 0),
  configOptions: defaultOnError(vecSkipError(zSessionConfigOption).nullish(), () => void 0),
  _meta: defaultOnError(record(string(), unknown()).nullish(), () => void 0)
});
var zCloseSessionResponse = object({
  _meta: defaultOnError(record(string(), unknown()).nullish(), () => void 0)
});
var zSetSessionModeResponse = object({
  _meta: defaultOnError(record(string(), unknown()).nullish(), () => void 0)
});
var zSetSessionConfigOptionResponse = object({
  configOptions: requiredDefaultOnError(vecSkipError(zSessionConfigOption), () => []),
  _meta: defaultOnError(record(string(), unknown()).nullish(), () => void 0)
});
var zStopReason = union([
  literal("end_turn"),
  literal("max_tokens"),
  literal("max_turn_requests"),
  literal("refusal"),
  literal("cancelled")
]);
var zUsage = object({
  totalTokens: number(),
  inputTokens: number(),
  outputTokens: number(),
  thoughtTokens: defaultOnError(number().nullish(), () => void 0),
  cachedReadTokens: defaultOnError(number().nullish(), () => void 0),
  cachedWriteTokens: defaultOnError(number().nullish(), () => void 0),
  _meta: defaultOnError(record(string(), unknown()).nullish(), () => void 0)
});
var zPromptResponse = object({
  stopReason: zStopReason,
  usage: defaultOnError(zUsage.nullish(), () => void 0),
  _meta: defaultOnError(record(string(), unknown()).nullish(), () => void 0)
});
var zStartNesResponse = object({
  sessionId: zSessionId,
  _meta: defaultOnError(record(string(), unknown()).nullish(), () => void 0)
});
var zNesSuggestionId = string();
var zPosition = object({
  line: int().gte(0).max(4294967295, {
    error: "Invalid value: Expected uint32 to be <= 4294967295"
  }),
  character: int().gte(0).max(4294967295, {
    error: "Invalid value: Expected uint32 to be <= 4294967295"
  }),
  _meta: defaultOnError(record(string(), unknown()).nullish(), () => void 0)
});
var zRange = object({
  start: zPosition,
  end: zPosition,
  _meta: defaultOnError(record(string(), unknown()).nullish(), () => void 0)
});
var zNesTextEdit = object({
  range: zRange,
  newText: string(),
  _meta: defaultOnError(record(string(), unknown()).nullish(), () => void 0)
});
var zNesEditSuggestion = object({
  id: zNesSuggestionId,
  uri: string(),
  edits: array(zNesTextEdit),
  cursorPosition: defaultOnError(zPosition.nullish(), () => void 0),
  _meta: defaultOnError(record(string(), unknown()).nullish(), () => void 0)
});
var zNesJumpSuggestion = object({
  id: zNesSuggestionId,
  uri: string(),
  position: zPosition,
  _meta: defaultOnError(record(string(), unknown()).nullish(), () => void 0)
});
var zNesRenameSuggestion = object({
  id: zNesSuggestionId,
  uri: string(),
  position: zPosition,
  newName: string(),
  _meta: defaultOnError(record(string(), unknown()).nullish(), () => void 0)
});
var zNesSearchAndReplaceSuggestion = object({
  id: zNesSuggestionId,
  uri: string(),
  search: string(),
  replace: string(),
  isRegex: boolean().nullish(),
  _meta: defaultOnError(record(string(), unknown()).nullish(), () => void 0)
});
var zNesSuggestion = union([
  zNesEditSuggestion.and(object({
    kind: literal("edit")
  })),
  zNesJumpSuggestion.and(object({
    kind: literal("jump")
  })),
  zNesRenameSuggestion.and(object({
    kind: literal("rename")
  })),
  zNesSearchAndReplaceSuggestion.and(object({
    kind: literal("searchAndReplace")
  }))
]);
var zSuggestNesResponse = object({
  suggestions: array(zNesSuggestion),
  _meta: defaultOnError(record(string(), unknown()).nullish(), () => void 0)
});
var zCloseNesResponse = object({
  _meta: defaultOnError(record(string(), unknown()).nullish(), () => void 0)
});
var zExtResponse = unknown();
var zMessageMcpResponse = unknown();
var zErrorCode = union([
  literal(-32700),
  literal(-32600),
  literal(-32601),
  literal(-32602),
  literal(-32603),
  literal(-32800),
  literal(-32e3),
  literal(-32002),
  int().min(-2147483648, {
    error: "Invalid value: Expected int32 to be >= -2147483648"
  }).max(2147483647, {
    error: "Invalid value: Expected int32 to be <= 2147483647"
  })
]);
var zError = object({
  code: zErrorCode,
  message: string(),
  data: defaultOnError(unknown().optional(), () => void 0)
});
var zAgentResponse = union([
  object({
    id: zRequestId,
    result: union([
      zInitializeResponse,
      zAuthenticateResponse,
      zListProvidersResponse,
      zSetProviderResponse,
      zDisableProviderResponse,
      zLogoutResponse,
      zNewSessionResponse,
      zLoadSessionResponse,
      zListSessionsResponse,
      zDeleteSessionResponse,
      zForkSessionResponse,
      zResumeSessionResponse,
      zCloseSessionResponse,
      zSetSessionModeResponse,
      zSetSessionConfigOptionResponse,
      zPromptResponse,
      zStartNesResponse,
      zSuggestNesResponse,
      zCloseNesResponse,
      zExtResponse,
      zMessageMcpResponse
    ])
  }),
  object({
    id: zRequestId,
    error: zError
  })
]);
var zMessageId = string();
var zContentChunk = object({
  content: zContentBlock,
  messageId: defaultOnError(zMessageId.nullish(), () => void 0),
  _meta: defaultOnError(record(string(), unknown()).nullish(), () => void 0)
});
var zToolCall = object({
  toolCallId: zToolCallId,
  title: string(),
  name: defaultOnError(string().nullish(), () => void 0),
  kind: defaultOnError(zToolKind.optional(), () => void 0),
  status: defaultOnError(zToolCallStatus.optional(), () => void 0),
  content: defaultOnError(vecSkipError(zToolCallContent).optional(), () => []),
  locations: defaultOnError(vecSkipError(zToolCallLocation).optional(), () => []),
  rawInput: defaultOnError(unknown().optional(), () => void 0),
  rawOutput: defaultOnError(unknown().optional(), () => void 0),
  _meta: defaultOnError(record(string(), unknown()).nullish(), () => void 0)
});
var zPlanEntryPriority = union([
  literal("high"),
  literal("medium"),
  literal("low")
]);
var zPlanEntryStatus = union([
  literal("pending"),
  literal("in_progress"),
  literal("completed")
]);
var zPlanEntry = object({
  content: string(),
  priority: zPlanEntryPriority,
  status: zPlanEntryStatus,
  _meta: defaultOnError(record(string(), unknown()).nullish(), () => void 0)
});
var zPlan = object({
  entries: requiredDefaultOnError(vecSkipError(zPlanEntry), () => []),
  _meta: defaultOnError(record(string(), unknown()).nullish(), () => void 0)
});
var zPlanId = string();
var zPlanItems = object({
  planId: zPlanId,
  entries: requiredDefaultOnError(vecSkipError(zPlanEntry), () => []),
  _meta: defaultOnError(record(string(), unknown()).nullish(), () => void 0)
});
var zPlanFile = object({
  planId: zPlanId,
  uri: string(),
  _meta: defaultOnError(record(string(), unknown()).nullish(), () => void 0)
});
var zPlanMarkdown = object({
  planId: zPlanId,
  content: string(),
  _meta: defaultOnError(record(string(), unknown()).nullish(), () => void 0)
});
var zPlanUpdateContent = union([
  zPlanItems.and(object({
    type: literal("items")
  })),
  zPlanFile.and(object({
    type: literal("file")
  })),
  zPlanMarkdown.and(object({
    type: literal("markdown")
  }))
]);
var zPlanUpdate = object({
  plan: zPlanUpdateContent,
  _meta: defaultOnError(record(string(), unknown()).nullish(), () => void 0)
});
var zPlanRemoved = object({
  planId: zPlanId,
  _meta: defaultOnError(record(string(), unknown()).nullish(), () => void 0)
});
var zUnstructuredCommandInput = object({
  hint: string(),
  _meta: defaultOnError(record(string(), unknown()).nullish(), () => void 0)
});
var zAvailableCommandInput = zUnstructuredCommandInput;
var zAvailableCommand = object({
  name: string(),
  description: string(),
  input: defaultOnError(zAvailableCommandInput.nullish(), () => void 0),
  _meta: defaultOnError(record(string(), unknown()).nullish(), () => void 0)
});
var zAvailableCommandsUpdate = object({
  availableCommands: requiredDefaultOnError(vecSkipError(zAvailableCommand), () => []),
  _meta: defaultOnError(record(string(), unknown()).nullish(), () => void 0)
});
var zCurrentModeUpdate = object({
  currentModeId: zSessionModeId,
  _meta: defaultOnError(record(string(), unknown()).nullish(), () => void 0)
});
var zConfigOptionUpdate = object({
  configOptions: requiredDefaultOnError(vecSkipError(zSessionConfigOption), () => []),
  _meta: defaultOnError(record(string(), unknown()).nullish(), () => void 0)
});
var zSessionInfoUpdate = object({
  title: defaultOnError(string().nullish(), () => void 0),
  updatedAt: defaultOnError(string().nullish(), () => void 0),
  _meta: defaultOnError(record(string(), unknown()).nullish(), () => void 0)
});
var zCost = object({
  amount: number(),
  currency: string(),
  _meta: defaultOnError(record(string(), unknown()).nullish(), () => void 0)
});
var zUsageUpdate = object({
  used: number(),
  size: number(),
  cost: defaultOnError(zCost.nullish(), () => void 0),
  _meta: defaultOnError(record(string(), unknown()).nullish(), () => void 0)
});
var zCompactionId = string();
var zCompactionStatus = union([
  literal("in_progress"),
  literal("completed"),
  literal("failed"),
  literal("cancelled"),
  string()
]);
var zCompactionUpdate = object({
  compactionId: zCompactionId,
  status: zCompactionStatus,
  summary: defaultOnError(vecSkipError(zContentBlock).nullish(), () => void 0),
  error: defaultOnError(string().nullish(), () => void 0),
  _meta: defaultOnError(record(string(), unknown()).nullish(), () => void 0)
});
var zCompactionSummaryChunk = object({
  compactionId: zCompactionId,
  content: zContentBlock,
  _meta: defaultOnError(record(string(), unknown()).nullish(), () => void 0)
});
var zSessionUpdate = union([
  zContentChunk.and(object({
    sessionUpdate: literal("user_message_chunk")
  })),
  zContentChunk.and(object({
    sessionUpdate: literal("agent_message_chunk")
  })),
  zContentChunk.and(object({
    sessionUpdate: literal("agent_thought_chunk")
  })),
  zToolCall.and(object({
    sessionUpdate: literal("tool_call")
  })),
  zToolCallUpdate.and(object({
    sessionUpdate: literal("tool_call_update")
  })),
  zPlan.and(object({
    sessionUpdate: literal("plan")
  })),
  zPlanUpdate.and(object({
    sessionUpdate: literal("plan_update")
  })),
  zPlanRemoved.and(object({
    sessionUpdate: literal("plan_removed")
  })),
  zAvailableCommandsUpdate.and(object({
    sessionUpdate: literal("available_commands_update")
  })),
  zCurrentModeUpdate.and(object({
    sessionUpdate: literal("current_mode_update")
  })),
  zConfigOptionUpdate.and(object({
    sessionUpdate: literal("config_option_update")
  })),
  zSessionInfoUpdate.and(object({
    sessionUpdate: literal("session_info_update")
  })),
  zUsageUpdate.and(object({
    sessionUpdate: literal("usage_update")
  })),
  zCompactionUpdate.and(object({
    sessionUpdate: literal("compaction_update")
  })),
  zCompactionSummaryChunk.and(object({
    sessionUpdate: literal("compaction_summary_chunk")
  }))
]);
var zSessionNotification = object({
  sessionId: zSessionId,
  update: zSessionUpdate,
  _meta: defaultOnError(record(string(), unknown()).nullish(), () => void 0)
});
var zCompleteElicitationNotification = object({
  elicitationId: zElicitationId,
  _meta: defaultOnError(record(string(), unknown()).nullish(), () => void 0)
});
var zMessageMcpNotification = object({
  connectionId: zMcpConnectionId,
  method: string(),
  params: defaultOnError(record(string(), unknown()).nullish(), () => void 0),
  _meta: defaultOnError(record(string(), unknown()).nullish(), () => void 0)
});
var zExtNotification = unknown();
var zAgentNotification = object({
  method: string(),
  params: union([
    zSessionNotification,
    zCompleteElicitationNotification,
    zMessageMcpNotification,
    zExtNotification
  ]).nullish()
});
var zFileSystemCapabilities = object({
  readTextFile: defaultOnError(boolean().optional().default(false), () => false),
  writeTextFile: defaultOnError(boolean().optional().default(false), () => false),
  _meta: defaultOnError(record(string(), unknown()).nullish(), () => void 0)
});
var zCompactionCapabilities = record(string(), unknown());
var zBooleanConfigOptionCapabilities = object({
  _meta: defaultOnError(record(string(), unknown()).nullish(), () => void 0)
});
var zSessionConfigOptionsCapabilities = object({
  boolean: defaultOnError(zBooleanConfigOptionCapabilities.nullish(), () => void 0),
  _meta: defaultOnError(record(string(), unknown()).nullish(), () => void 0)
});
var zClientSessionCapabilities = object({
  compaction: defaultOnError(zCompactionCapabilities.nullish(), () => void 0),
  configOptions: defaultOnError(zSessionConfigOptionsCapabilities.nullish(), () => void 0),
  _meta: defaultOnError(record(string(), unknown()).nullish(), () => void 0)
});
var zPlanCapabilities = object({
  _meta: defaultOnError(record(string(), unknown()).nullish(), () => void 0)
});
var zAuthCapabilities = object({
  terminal: defaultOnError(boolean().optional().default(false), () => false),
  _meta: defaultOnError(record(string(), unknown()).nullish(), () => void 0)
});
var zElicitationFormCapabilities = object({
  _meta: defaultOnError(record(string(), unknown()).nullish(), () => void 0)
});
var zElicitationUrlCapabilities = object({
  _meta: defaultOnError(record(string(), unknown()).nullish(), () => void 0)
});
var zElicitationCapabilities = object({
  form: defaultOnError(zElicitationFormCapabilities.nullish(), () => void 0),
  url: defaultOnError(zElicitationUrlCapabilities.nullish(), () => void 0),
  _meta: defaultOnError(record(string(), unknown()).nullish(), () => void 0)
});
var zNesJumpCapabilities = object({
  _meta: defaultOnError(record(string(), unknown()).nullish(), () => void 0)
});
var zNesRenameCapabilities = object({
  _meta: defaultOnError(record(string(), unknown()).nullish(), () => void 0)
});
var zNesSearchAndReplaceCapabilities = object({
  _meta: defaultOnError(record(string(), unknown()).nullish(), () => void 0)
});
var zClientNesCapabilities = object({
  jump: defaultOnError(zNesJumpCapabilities.nullish(), () => void 0),
  rename: defaultOnError(zNesRenameCapabilities.nullish(), () => void 0),
  searchAndReplace: defaultOnError(zNesSearchAndReplaceCapabilities.nullish(), () => void 0),
  _meta: defaultOnError(record(string(), unknown()).nullish(), () => void 0)
});
var zClientCapabilities = object({
  fs: defaultOnError(zFileSystemCapabilities.optional().default({ readTextFile: false, writeTextFile: false }), () => ({ readTextFile: false, writeTextFile: false })),
  terminal: defaultOnError(boolean().optional().default(false), () => false),
  session: defaultOnError(zClientSessionCapabilities.nullish(), () => void 0),
  plan: defaultOnError(zPlanCapabilities.nullish(), () => void 0),
  auth: defaultOnError(zAuthCapabilities.optional().default({ terminal: false }), () => ({ terminal: false })),
  elicitation: defaultOnError(zElicitationCapabilities.nullish(), () => void 0),
  nes: defaultOnError(zClientNesCapabilities.nullish(), () => void 0),
  positionEncodings: defaultOnError(vecSkipError(zPositionEncodingKind).optional(), () => []),
  _meta: defaultOnError(record(string(), unknown()).nullish(), () => void 0)
});
var zInitializeRequest = object({
  protocolVersion: zProtocolVersion,
  clientCapabilities: defaultOnError(zClientCapabilities.optional().default({
    fs: { readTextFile: false, writeTextFile: false },
    terminal: false,
    auth: { terminal: false }
  }), () => ({
    fs: { readTextFile: false, writeTextFile: false },
    terminal: false,
    auth: { terminal: false }
  })),
  clientInfo: defaultOnError(zImplementation.nullish(), () => void 0),
  _meta: defaultOnError(record(string(), unknown()).nullish(), () => void 0)
});
var zAuthenticateRequest = object({
  methodId: zAuthMethodId,
  _meta: defaultOnError(record(string(), unknown()).nullish(), () => void 0)
});
var zListProvidersRequest = object({
  _meta: defaultOnError(record(string(), unknown()).nullish(), () => void 0)
});
var zSetProviderRequest = object({
  providerId: zProviderId,
  apiType: zLlmProtocol,
  baseUrl: string(),
  headers: record(string(), string()).optional(),
  _meta: defaultOnError(record(string(), unknown()).nullish(), () => void 0)
});
var zDisableProviderRequest = object({
  providerId: zProviderId,
  _meta: defaultOnError(record(string(), unknown()).nullish(), () => void 0)
});
var zLogoutRequest = object({
  _meta: defaultOnError(record(string(), unknown()).nullish(), () => void 0)
});
var zHttpHeader = object({
  name: string(),
  value: string(),
  _meta: defaultOnError(record(string(), unknown()).nullish(), () => void 0)
});
var zMcpServerHttp = object({
  name: string(),
  url: string(),
  headers: array(zHttpHeader),
  _meta: defaultOnError(record(string(), unknown()).nullish(), () => void 0)
});
var zMcpServerSse = object({
  name: string(),
  url: string(),
  headers: array(zHttpHeader),
  _meta: defaultOnError(record(string(), unknown()).nullish(), () => void 0)
});
var zMcpServerAcp = object({
  name: string(),
  serverId: zMcpServerAcpId,
  _meta: defaultOnError(record(string(), unknown()).nullish(), () => void 0)
});
var zMcpServerStdio = object({
  name: string(),
  command: string(),
  args: array(string()),
  env: array(zEnvVariable),
  _meta: defaultOnError(record(string(), unknown()).nullish(), () => void 0)
});
var zMcpServer = union([
  zMcpServerHttp.and(object({
    type: literal("http")
  })),
  zMcpServerSse.and(object({
    type: literal("sse")
  })),
  zMcpServerAcp.and(object({
    type: literal("acp")
  })),
  zMcpServerStdio
]);
var zNewSessionRequest = object({
  cwd: string(),
  additionalDirectories: defaultOnError(vecSkipError(string()).optional(), () => []),
  mcpServers: requiredDefaultOnError(vecSkipError(zMcpServer), () => []),
  _meta: defaultOnError(record(string(), unknown()).nullish(), () => void 0)
});
var zLoadSessionRequest = object({
  mcpServers: requiredDefaultOnError(vecSkipError(zMcpServer), () => []),
  cwd: string(),
  additionalDirectories: defaultOnError(vecSkipError(string()).optional(), () => []),
  sessionId: zSessionId,
  _meta: defaultOnError(record(string(), unknown()).nullish(), () => void 0)
});
var zListSessionsRequest = object({
  cwd: string().nullish(),
  cursor: string().nullish(),
  _meta: defaultOnError(record(string(), unknown()).nullish(), () => void 0)
});
var zDeleteSessionRequest = object({
  sessionId: zSessionId,
  _meta: defaultOnError(record(string(), unknown()).nullish(), () => void 0)
});
var zForkSessionRequest = object({
  sessionId: zSessionId,
  cwd: string(),
  additionalDirectories: defaultOnError(vecSkipError(string()).optional(), () => []),
  mcpServers: defaultOnError(vecSkipError(zMcpServer).optional(), () => []),
  _meta: defaultOnError(record(string(), unknown()).nullish(), () => void 0)
});
var zResumeSessionRequest = object({
  sessionId: zSessionId,
  cwd: string(),
  additionalDirectories: defaultOnError(vecSkipError(string()).optional(), () => []),
  mcpServers: defaultOnError(vecSkipError(zMcpServer).optional(), () => []),
  _meta: defaultOnError(record(string(), unknown()).nullish(), () => void 0)
});
var zCloseSessionRequest = object({
  sessionId: zSessionId,
  _meta: defaultOnError(record(string(), unknown()).nullish(), () => void 0)
});
var zSetSessionModeRequest = object({
  sessionId: zSessionId,
  modeId: zSessionModeId,
  _meta: defaultOnError(record(string(), unknown()).nullish(), () => void 0)
});
var zSetSessionConfigOptionRequest = intersection(union([
  object({
    value: boolean(),
    type: literal("boolean")
  }),
  object({
    value: zSessionConfigValueId
  })
]), object({
  sessionId: zSessionId,
  configId: zSessionConfigId,
  _meta: defaultOnError(record(string(), unknown()).nullish(), () => void 0)
}));
var zPromptRequest = object({
  sessionId: zSessionId,
  prompt: array(zContentBlock),
  _meta: defaultOnError(record(string(), unknown()).nullish(), () => void 0)
});
var zWorkspaceFolder = object({
  uri: string(),
  name: string(),
  _meta: defaultOnError(record(string(), unknown()).nullish(), () => void 0)
});
var zNesRepository = object({
  name: string(),
  owner: string(),
  remoteUrl: string(),
  _meta: defaultOnError(record(string(), unknown()).nullish(), () => void 0)
});
var zStartNesRequest = object({
  workspaceUri: defaultOnError(string().nullish(), () => void 0),
  workspaceFolders: array(zWorkspaceFolder).nullish(),
  repository: defaultOnError(zNesRepository.nullish(), () => void 0),
  _meta: defaultOnError(record(string(), unknown()).nullish(), () => void 0)
});
var zNesTriggerKind = union([
  literal("automatic"),
  literal("diagnostic"),
  literal("manual")
]);
var zNesRecentFile = object({
  uri: string(),
  languageId: string(),
  text: string(),
  _meta: defaultOnError(record(string(), unknown()).nullish(), () => void 0)
});
var zNesExcerpt = object({
  startLine: int().gte(0).max(4294967295, {
    error: "Invalid value: Expected uint32 to be <= 4294967295"
  }),
  endLine: int().gte(0).max(4294967295, {
    error: "Invalid value: Expected uint32 to be <= 4294967295"
  }),
  text: string(),
  _meta: defaultOnError(record(string(), unknown()).nullish(), () => void 0)
});
var zNesRelatedSnippet = object({
  uri: string(),
  excerpts: array(zNesExcerpt),
  _meta: defaultOnError(record(string(), unknown()).nullish(), () => void 0)
});
var zNesEditHistoryEntry = object({
  uri: string(),
  diff: string(),
  _meta: defaultOnError(record(string(), unknown()).nullish(), () => void 0)
});
var zNesUserAction = object({
  action: string(),
  uri: string(),
  position: zPosition,
  timestampMs: number(),
  _meta: defaultOnError(record(string(), unknown()).nullish(), () => void 0)
});
var zNesOpenFile = object({
  uri: string(),
  languageId: string(),
  visibleRange: defaultOnError(zRange.nullish(), () => void 0),
  lastFocusedMs: defaultOnError(number().nullish(), () => void 0),
  _meta: defaultOnError(record(string(), unknown()).nullish(), () => void 0)
});
var zNesDiagnosticSeverity = union([
  literal("error"),
  literal("warning"),
  literal("information"),
  literal("hint")
]);
var zNesDiagnostic = object({
  uri: string(),
  range: zRange,
  severity: zNesDiagnosticSeverity,
  message: string(),
  _meta: defaultOnError(record(string(), unknown()).nullish(), () => void 0)
});
var zNesSuggestContext = object({
  recentFiles: array(zNesRecentFile).nullish(),
  relatedSnippets: array(zNesRelatedSnippet).nullish(),
  editHistory: array(zNesEditHistoryEntry).nullish(),
  userActions: array(zNesUserAction).nullish(),
  openFiles: array(zNesOpenFile).nullish(),
  diagnostics: array(zNesDiagnostic).nullish(),
  _meta: defaultOnError(record(string(), unknown()).nullish(), () => void 0)
});
var zSuggestNesRequest = object({
  sessionId: zSessionId,
  uri: string(),
  version: number(),
  position: zPosition,
  selection: zRange.nullish(),
  triggerKind: zNesTriggerKind,
  context: zNesSuggestContext.nullish(),
  _meta: defaultOnError(record(string(), unknown()).nullish(), () => void 0)
});
var zCloseNesRequest = object({
  sessionId: zSessionId,
  _meta: defaultOnError(record(string(), unknown()).nullish(), () => void 0)
});
var zClientRequest = object({
  id: zRequestId,
  method: string(),
  params: union([
    zInitializeRequest,
    zAuthenticateRequest,
    zListProvidersRequest,
    zSetProviderRequest,
    zDisableProviderRequest,
    zLogoutRequest,
    zNewSessionRequest,
    zLoadSessionRequest,
    zListSessionsRequest,
    zDeleteSessionRequest,
    zForkSessionRequest,
    zResumeSessionRequest,
    zCloseSessionRequest,
    zSetSessionModeRequest,
    zSetSessionConfigOptionRequest,
    zPromptRequest,
    zStartNesRequest,
    zSuggestNesRequest,
    zCloseNesRequest,
    zMessageMcpRequest,
    zExtRequest
  ]).nullish()
});
var zWriteTextFileResponse = object({
  _meta: defaultOnError(record(string(), unknown()).nullish(), () => void 0)
});
var zReadTextFileResponse = object({
  content: string(),
  _meta: defaultOnError(record(string(), unknown()).nullish(), () => void 0)
});
var zSelectedPermissionOutcome = object({
  optionId: zPermissionOptionId,
  _meta: defaultOnError(record(string(), unknown()).nullish(), () => void 0)
});
var zRequestPermissionOutcome = union([
  object({
    outcome: literal("cancelled")
  }),
  zSelectedPermissionOutcome.and(object({
    outcome: literal("selected")
  }))
]);
var zRequestPermissionResponse = object({
  outcome: zRequestPermissionOutcome,
  _meta: defaultOnError(record(string(), unknown()).nullish(), () => void 0)
});
var zCreateTerminalResponse = object({
  terminalId: zTerminalId,
  _meta: defaultOnError(record(string(), unknown()).nullish(), () => void 0)
});
var zTerminalExitStatus = object({
  exitCode: defaultOnError(int().gte(0).max(4294967295, {
    error: "Invalid value: Expected uint32 to be <= 4294967295"
  }).nullish(), () => void 0),
  signal: defaultOnError(string().nullish(), () => void 0),
  _meta: defaultOnError(record(string(), unknown()).nullish(), () => void 0)
});
var zTerminalOutputResponse = object({
  output: string(),
  truncated: boolean(),
  exitStatus: defaultOnError(zTerminalExitStatus.nullish(), () => void 0),
  _meta: defaultOnError(record(string(), unknown()).nullish(), () => void 0)
});
var zReleaseTerminalResponse = object({
  _meta: defaultOnError(record(string(), unknown()).nullish(), () => void 0)
});
var zWaitForTerminalExitResponse = object({
  exitCode: defaultOnError(int().gte(0).max(4294967295, {
    error: "Invalid value: Expected uint32 to be <= 4294967295"
  }).nullish(), () => void 0),
  signal: defaultOnError(string().nullish(), () => void 0),
  _meta: defaultOnError(record(string(), unknown()).nullish(), () => void 0)
});
var zKillTerminalResponse = object({
  _meta: defaultOnError(record(string(), unknown()).nullish(), () => void 0)
});
var zElicitationContentValue = union([
  string(),
  number(),
  number(),
  boolean(),
  array(string())
]);
var zElicitationAcceptAction = object({
  content: record(string(), zElicitationContentValue).nullish()
});
var zCreateElicitationResponse = preserveCustomPayload(intersection(union([
  zElicitationAcceptAction.and(object({
    action: literal("accept")
  })),
  object({
    action: literal("decline")
  }),
  object({
    action: literal("cancel")
  }),
  excludeKnownTags(object({
    action: string()
  }), "action", ["accept", "cancel", "decline"])
]), object({
  _meta: defaultOnError(record(string(), unknown()).nullish(), () => void 0)
})), "action", ["accept", "cancel", "decline"]);
var zConnectMcpResponse = object({
  connectionId: zMcpConnectionId,
  _meta: defaultOnError(record(string(), unknown()).nullish(), () => void 0)
});
var zDisconnectMcpResponse = object({
  _meta: defaultOnError(record(string(), unknown()).nullish(), () => void 0)
});
var zClientResponse = union([
  object({
    id: zRequestId,
    result: union([
      zWriteTextFileResponse,
      zReadTextFileResponse,
      zRequestPermissionResponse,
      zCreateTerminalResponse,
      zTerminalOutputResponse,
      zReleaseTerminalResponse,
      zWaitForTerminalExitResponse,
      zKillTerminalResponse,
      zCreateElicitationResponse,
      zConnectMcpResponse,
      zDisconnectMcpResponse,
      zMessageMcpResponse,
      zExtResponse
    ])
  }),
  object({
    id: zRequestId,
    error: zError
  })
]);
var zCancelNotification = object({
  sessionId: zSessionId,
  _meta: defaultOnError(record(string(), unknown()).nullish(), () => void 0)
});
var zDidOpenDocumentNotification = object({
  sessionId: zSessionId,
  uri: string(),
  languageId: string(),
  version: number(),
  text: string(),
  _meta: defaultOnError(record(string(), unknown()).nullish(), () => void 0)
});
var zTextDocumentContentChangeEvent = object({
  range: zRange.nullish(),
  text: string(),
  _meta: defaultOnError(record(string(), unknown()).nullish(), () => void 0)
});
var zDidChangeDocumentNotification = object({
  sessionId: zSessionId,
  uri: string(),
  version: number(),
  contentChanges: requiredDefaultOnError(vecSkipError(zTextDocumentContentChangeEvent), () => []),
  _meta: defaultOnError(record(string(), unknown()).nullish(), () => void 0)
});
var zDidCloseDocumentNotification = object({
  sessionId: zSessionId,
  uri: string(),
  _meta: defaultOnError(record(string(), unknown()).nullish(), () => void 0)
});
var zDidSaveDocumentNotification = object({
  sessionId: zSessionId,
  uri: string(),
  _meta: defaultOnError(record(string(), unknown()).nullish(), () => void 0)
});
var zDidFocusDocumentNotification = object({
  sessionId: zSessionId,
  uri: string(),
  version: number(),
  position: zPosition,
  visibleRange: zRange,
  _meta: defaultOnError(record(string(), unknown()).nullish(), () => void 0)
});
var zAcceptNesNotification = object({
  sessionId: zSessionId,
  id: zNesSuggestionId,
  _meta: defaultOnError(record(string(), unknown()).nullish(), () => void 0)
});
var zNesRejectReason = union([
  literal("rejected"),
  literal("ignored"),
  literal("replaced"),
  literal("cancelled")
]);
var zRejectNesNotification = object({
  sessionId: zSessionId,
  id: zNesSuggestionId,
  reason: defaultOnError(zNesRejectReason.nullish(), () => void 0),
  _meta: defaultOnError(record(string(), unknown()).nullish(), () => void 0)
});
var zClientNotification = object({
  method: string(),
  params: union([
    zCancelNotification,
    zDidOpenDocumentNotification,
    zDidChangeDocumentNotification,
    zDidCloseDocumentNotification,
    zDidSaveDocumentNotification,
    zDidFocusDocumentNotification,
    zAcceptNesNotification,
    zRejectNesNotification,
    zMessageMcpNotification,
    zExtNotification
  ]).nullish()
});
var zCancelRequestNotification = object({
  requestId: zRequestId,
  _meta: defaultOnError(record(string(), unknown()).nullish(), () => void 0)
});

// ../../node_modules/.pnpm/@agentclientprotocol+sdk@1.4.0_zod@4.3.6/node_modules/@agentclientprotocol/sdk/dist/jsonrpc.js
var CANCEL_REQUEST_METHOD = "$/cancel_request";
function isRequestMessage(value) {
  return isJsonRpcEnvelope(value) && "id" in value && typeof value["method"] === "string" && isJsonRpcId(value["id"]);
}
function isResponseMessage(value) {
  if (!isJsonRpcEnvelope(value) || "method" in value) {
    return false;
  }
  if (!("id" in value) || !isJsonRpcId(value["id"])) {
    return false;
  }
  const hasResult = Object.hasOwn(value, "result");
  const hasError = Object.hasOwn(value, "error");
  if (hasResult === hasError) {
    return false;
  }
  return !hasError || isErrorResponse(value["error"]);
}
function isNotificationMessage(value) {
  return isJsonRpcEnvelope(value) && !("id" in value) && typeof value["method"] === "string";
}
function isRecord(value) {
  return typeof value === "object" && value !== null;
}
function isJsonRpcEnvelope(value) {
  return isRecord(value) && value["jsonrpc"] === "2.0";
}
function isJsonRpcId(value) {
  return value === null || typeof value === "string" || typeof value === "number" && Number.isFinite(value);
}
function isResponseShapedMessage(value) {
  return isRecord(value) && !("method" in value) && ("id" in value || "result" in value || "error" in value);
}
function isResponseBatch(batch) {
  let hasValidCall = false;
  let hasValidResponse = false;
  let hasCallShape = false;
  let hasResponseShape = false;
  for (const entry of batch) {
    hasValidCall ||= isRequestMessage(entry) || isNotificationMessage(entry);
    hasValidResponse ||= isResponseMessage(entry);
    if (!isRecord(entry)) {
      continue;
    }
    hasCallShape ||= "method" in entry;
    hasResponseShape ||= "result" in entry || "error" in entry;
  }
  if (hasValidCall) {
    return false;
  }
  if (hasValidResponse) {
    return true;
  }
  return hasResponseShape && !hasCallShape;
}
function cancelRequestId(params) {
  if (!isRecord(params) || !isJsonRpcId(params["requestId"])) {
    return void 0;
  }
  return params["requestId"];
}
function isErrorResponse(value) {
  return isRecord(value) && typeof value["code"] === "number" && Number.isInteger(value["code"]) && typeof value["message"] === "string";
}
var Handled = {
  /**
   * Marks a message as handled.
   */
  yes() {
    return { handled: true };
  },
  /**
   * Leaves a message unhandled so later handlers can process it.
   */
  no(message, retry = false) {
    return { handled: false, message, retry };
  }
};
function rejectedPromise(error) {
  const promise = Promise.reject(error);
  promise.catch(() => {
  });
  return promise;
}
function errorDetails(error) {
  if (error instanceof Error) {
    return error.message;
  }
  if (typeof error === "object" && error != null && "message" in error && typeof error.message === "string") {
    return error.message;
  }
  return void 0;
}
function isZodError(error) {
  return typeof error === "object" && error !== null && "name" in error && error.name === "ZodError" && "issues" in error && Array.isArray(error.issues) && "format" in error && typeof error.format === "function";
}
function errorToResult(error) {
  if (error instanceof RequestError) {
    return error.toResult();
  }
  if (isZodError(error)) {
    return RequestError.invalidParams(error.format()).toResult();
  }
  const details = errorDetails(error);
  try {
    return RequestError.internalError(details ? JSON.parse(details) : {}).toResult();
  } catch {
    return RequestError.internalError({ details }).toResult();
  }
}
function requestCancelledError(reason) {
  if (reason instanceof RequestError && reason.code === -32800) {
    return reason;
  }
  return RequestError.requestCancelled(reason);
}
function errorToRequestResult(error, signal) {
  const requestCancelled = abortErrorToRequestCancelled(error, signal);
  return requestCancelled ? requestCancelled.toResult() : errorToResult(error);
}
function abortErrorToRequestCancelled(error, signal) {
  if (!signal.aborted || !isAbortError(error)) {
    return void 0;
  }
  return requestCancelledError(signal.reason);
}
function isAbortError(error) {
  if (typeof error !== "object" || error === null) {
    return false;
  }
  const maybeAbortError = error;
  return maybeAbortError.name === "AbortError" || maybeAbortError.code === "ABORT_ERR";
}
var RequestResponder = class {
  id;
  sendResult;
  signal;
  finishRequest;
  didRespond = false;
  constructor(id, sendResult, signal = new AbortController().signal, finishRequest) {
    this.id = id;
    this.sendResult = sendResult;
    this.signal = signal;
    this.finishRequest = finishRequest;
  }
  /**
   * Whether this request has already received a response.
   */
  get responded() {
    return this.didRespond;
  }
  /**
   * Sends a successful JSON-RPC response.
   */
  respond(response) {
    return this.respondWithResult({ result: response ?? null });
  }
  /**
   * Sends an error JSON-RPC response.
   */
  respondWithError(error) {
    const errorResponse = error instanceof RequestError ? error.toErrorResponse() : error;
    return this.respondWithResult({ error: errorResponse });
  }
  /**
   * Sends a complete JSON-RPC result payload.
   */
  respondWithResult(result) {
    if (this.didRespond) {
      return rejectedPromise(new Error("JSON-RPC request already responded"));
    }
    this.didRespond = true;
    return this.sendResult(result).finally(() => {
      this.finishRequest?.();
    });
  }
};
var requestBatchSizes = /* @__PURE__ */ new WeakMap();
var HandlerRegistration = class {
  disposeHandler;
  active = true;
  constructor(disposeHandler) {
    this.disposeHandler = disposeHandler;
  }
  /**
   * Unregisters the associated handler.
   */
  dispose() {
    if (!this.active) {
      return;
    }
    this.active = false;
    this.disposeHandler();
  }
  /**
   * Supports explicit resource management with `using`.
   */
  [Symbol.dispose]() {
    this.dispose();
  }
  /**
   * Returns this registration for call sites that intentionally keep it active.
   */
  runIndefinitely() {
    return this;
  }
};
var ConnectionContext = class {
  connection;
  constructor(connection) {
    this.connection = connection;
  }
  /**
   * Sends a request over the connection.
   */
  sendRequest(method, params, mapResponse, options) {
    return this.connection.sendRequest(method, params, mapResponse, options);
  }
  /**
   * Sends a notification over the connection.
   */
  sendNotification(method, params) {
    return this.connection.sendNotification(method, params);
  }
  /**
   * Sends a non-empty JSON-RPC batch in one transport message.
   */
  sendBatch(entries) {
    return this.connection.sendBatch(entries);
  }
  /**
   * Sends a protocol-level request cancellation notification.
   */
  sendCancelRequest(requestId) {
    return this.connection.sendCancelRequest(requestId);
  }
  /**
   * Registers a handler that can be disposed independently.
   */
  addDynamicHandler(handler) {
    return this.connection.addDynamicHandler(handler);
  }
  /**
   * AbortSignal that aborts when the connection closes.
   */
  get signal() {
    return this.connection.signal;
  }
  /**
   * Promise that resolves when the connection closes.
   */
  get closed() {
    return this.connection.closed;
  }
};
var Connection = class {
  pendingResponses = /* @__PURE__ */ new Map();
  incomingRequests = /* @__PURE__ */ new Map();
  nextRequestId = 0;
  staticHandlers = [];
  dynamicHandlers = /* @__PURE__ */ new Set();
  stream;
  writeQueue = Promise.resolve();
  abortController = new AbortController();
  closedPromise;
  retryQueue = [];
  context = new ConnectionContext(this);
  receiveReader;
  allowBatches = true;
  constructor(requestHandlerOrStream, notificationHandlerOrHandlers, streamOrOptions, options) {
    if (typeof requestHandlerOrStream === "function") {
      const requestHandler = requestHandlerOrStream;
      const notificationHandler = notificationHandlerOrHandlers;
      const stream2 = streamOrOptions;
      this.initialize(stream2, [
        ...options?.handlers ?? [],
        this.legacyHandler(requestHandler, notificationHandler)
      ], options);
      return;
    }
    const stream = requestHandlerOrStream;
    const handlers = notificationHandlerOrHandlers;
    const connectionOptions = streamOrOptions;
    this.initialize(stream, [...connectionOptions?.handlers ?? [], ...handlers], connectionOptions);
  }
  /**
   * Creates a builder for configuring a handler-based connection.
   */
  static builder() {
    return new ConnectionBuilder();
  }
  /**
   * Runs an operation while the connection is open, then closes the connection.
   *
   * If the stream closes before `op` settles, the returned promise rejects with
   * the connection close reason.
   */
  runUntil(op) {
    let opSettled = false;
    const opPromise = Promise.resolve().then(() => op(this.context)).finally(() => {
      opSettled = true;
    });
    const closedPromise = this.closed.then(() => {
      if (opSettled) {
        return new Promise(() => {
        });
      }
      throw this.closedReason();
    });
    return Promise.race([opPromise, closedPromise]).finally(() => {
      opSettled = true;
      this.close();
    });
  }
  /**
   * Adds a handler after the connection has started.
   *
   * Any messages queued with `Handled.no(message, true)` are retried after the
   * handler is added.
   */
  addDynamicHandler(handler) {
    this.dynamicHandlers.add(handler);
    if (this.retryQueue.length > 0) {
      for (const message of this.retryQueue.splice(0)) {
        void this.processIncomingMessage(message).catch((error) => this.close(error));
      }
    }
    return new HandlerRegistration(() => {
      this.dynamicHandlers.delete(handler);
    });
  }
  /**
   * AbortSignal that aborts when the connection closes.
   */
  get signal() {
    return this.abortController.signal;
  }
  /**
   * Promise that resolves when the connection closes.
   */
  get closed() {
    return this.closedPromise;
  }
  /** @internal */
  getContext() {
    return this.context;
  }
  /**
   * Sends a JSON-RPC request.
   *
   * `mapResponse` can convert the raw result before the returned promise
   * resolves.
   */
  sendRequest(method, params, mapResponse, options = {}) {
    if (this.abortController.signal.aborted) {
      return rejectedPromise(this.closedReason());
    }
    const request = this.prepareRequest(method, params, mapResponse, options);
    const requestSent = this.sendWireMessage(request.message);
    void requestSent.catch(() => {
    });
    if (options.cancellationSignal?.aborted) {
      request.cancel();
    }
    return request.response;
  }
  /**
   * Sends a non-empty JSON-RPC batch in one transport message.
   *
   * Requests and notifications are processed independently by the peer. The
   * returned tuple preserves the input order: request entries resolve to their
   * mapped response, while notification entries resolve to `undefined`.
   */
  sendBatch(entries) {
    if (this.abortController.signal.aborted) {
      return rejectedPromise(this.closedReason());
    }
    if (!this.allowBatches) {
      return rejectedPromise(new TypeError("JSON-RPC batches are not supported on this connection"));
    }
    if (entries.length === 0) {
      return rejectedPromise(new TypeError("JSON-RPC batch must contain at least one entry"));
    }
    const messages = [];
    const cancellations = [];
    const outputs = [];
    for (const entry of entries) {
      if (entry.kind === "notification") {
        messages.push({
          jsonrpc: "2.0",
          method: entry.method,
          params: entry.params
        });
        outputs.push(Promise.resolve(void 0));
        continue;
      }
      const request = this.prepareRequest(entry.method, entry.params, entry.mapResponse, entry.options);
      messages.push(request.message);
      outputs.push(request.response);
      cancellations.push({
        signal: entry.options?.cancellationSignal,
        cancel: request.cancel
      });
    }
    const batch = messages;
    const batchSent = this.sendWireMessage(batch);
    for (const cancellation of cancellations) {
      if (cancellation.signal?.aborted) {
        cancellation.cancel();
      }
    }
    const response = Promise.all([batchSent, ...outputs]).then(([, ...resolved]) => resolved);
    response.catch(() => {
    });
    return response;
  }
  /**
   * Sends a protocol-level request cancellation notification.
   */
  sendCancelRequest(requestId) {
    return this.sendNotification(CANCEL_REQUEST_METHOD, { requestId });
  }
  /**
   * Sends a JSON-RPC notification.
   */
  sendNotification(method, params) {
    if (this.abortController.signal.aborted) {
      return rejectedPromise(this.closedReason());
    }
    return this.sendWireMessage({ jsonrpc: "2.0", method, params });
  }
  prepareRequest(method, params, mapResponse, options = {}) {
    const id = this.nextRequestId++;
    let cancel = () => {
    };
    const response = new Promise((resolve, reject) => {
      const pendingResponse = {
        resolve: (value) => {
          try {
            resolve(mapResponse ? mapResponse(value) : value);
          } catch (error) {
            reject(error);
          }
        },
        reject
      };
      cancel = () => {
        if (pendingResponse.cancellationSent) {
          return;
        }
        pendingResponse.cancellationSent = true;
        pendingResponse.cleanup?.();
        void this.sendCancelRequest(id).catch(() => {
        });
      };
      options.cancellationSignal?.addEventListener("abort", cancel, {
        once: true
      });
      pendingResponse.cleanup = () => {
        options.cancellationSignal?.removeEventListener("abort", cancel);
      };
      this.pendingResponses.set(id, pendingResponse);
    });
    response.catch(() => {
    });
    return {
      message: { jsonrpc: "2.0", id, method, params },
      response,
      cancel: () => cancel()
    };
  }
  /**
   * Closes the connection and rejects pending requests.
   */
  close(error) {
    if (this.abortController.signal.aborted) {
      return;
    }
    const closeError = error ?? new Error("ACP connection closed");
    this.abortController.abort(closeError);
    for (const pendingResponse of this.pendingResponses.values()) {
      pendingResponse.cleanup?.();
      pendingResponse.reject(closeError);
    }
    this.pendingResponses.clear();
    for (const controller of this.incomingRequests.values()) {
      controller.abort(closeError);
    }
    this.incomingRequests.clear();
    void this.receiveReader?.cancel(closeError).catch(() => {
    });
  }
  initialize(stream, handlers, options) {
    this.stream = stream;
    this.staticHandlers = handlers;
    this.allowBatches = options?.allowBatches ?? true;
    this.closedPromise = new Promise((resolve) => {
      this.abortController.signal.addEventListener("abort", () => resolve());
    });
    void this.receive();
  }
  legacyHandler(requestHandler, notificationHandler) {
    return {
      handleMessage: async (message, cx) => {
        if (message.kind === "request") {
          const result = await requestHandler(message.method, message.params, cx);
          await message.responder.respond(result);
        } else {
          await notificationHandler(message.method, message.params, cx);
        }
        return Handled.yes();
      }
    };
  }
  async receive() {
    let closeError = void 0;
    try {
      const reader = this.stream.readable.getReader();
      this.receiveReader = reader;
      try {
        while (!this.abortController.signal.aborted) {
          const { value: message, done } = await reader.read();
          if (this.abortController.signal.aborted) {
            break;
          }
          if (done) {
            break;
          }
          this.receiveWireMessage(message);
        }
      } finally {
        if (this.receiveReader === reader) {
          this.receiveReader = void 0;
        }
        reader.releaseLock();
      }
    } catch (error) {
      closeError = error;
    } finally {
      this.close(closeError);
    }
  }
  receiveWireMessage(message) {
    if (Array.isArray(message)) {
      if (!this.allowBatches) {
        this.close(new TypeError("JSON-RPC batches are not supported on this connection"));
        return;
      }
      this.receiveBatch(message);
      return;
    }
    if (!isRequestMessage(message) && !isNotificationMessage(message) && !isResponseShapedMessage(message)) {
      void this.sendWireMessage(protocolErrorResponse(RequestError.invalidRequest(message))).catch(() => {
      });
      return;
    }
    this.receiveMessage(message);
  }
  receiveBatch(batch) {
    if (batch.length === 0) {
      void this.sendWireMessage(protocolErrorResponse(RequestError.invalidRequest(batch))).catch(() => {
      });
      return;
    }
    const responseBatch = isResponseBatch(batch);
    const responseCount = responseBatch ? 0 : batch.reduce((count, message) => count + (isNotificationMessage(message) ? 0 : 1), 0);
    let remaining = responseCount;
    let remainingNotifications = batch.reduce((count, message) => count + (isNotificationMessage(message) ? 1 : 0), 0);
    let responseSent = false;
    const responses = [];
    const sendResponsesIfReady = async () => {
      if (responseSent || remaining !== 0 || remainingNotifications !== 0 || responses.length === 0) {
        return;
      }
      responseSent = true;
      await this.sendWireMessage(responses);
    };
    const collectResponse = async (response) => {
      responses.push(response);
      remaining -= 1;
      await sendResponsesIfReady();
    };
    for (const message of batch) {
      if (responseBatch) {
        if (isResponseShapedMessage(message)) {
          this.receiveMessage(message);
        }
        continue;
      }
      if (!isRequestMessage(message) && !isNotificationMessage(message)) {
        void collectResponse(protocolErrorResponse(RequestError.invalidRequest(message))).catch(() => {
        });
        continue;
      }
      const processing = this.receiveMessage(message, isRequestMessage(message) ? collectResponse : void 0, batch.length);
      if (isNotificationMessage(message)) {
        void processing.finally(() => {
          remainingNotifications -= 1;
          void sendResponsesIfReady().catch((error) => this.close(error));
        });
      }
    }
  }
  receiveMessage(message, sendResponse, batchSize) {
    if (this.abortController.signal.aborted) {
      return Promise.resolve();
    }
    if (!isRecord(message)) {
      console.error("Invalid message", { message });
      return Promise.resolve();
    }
    if ("method" in message) {
      if (!("id" in message)) {
        this.handleProtocolNotification(message);
      }
      return this.processIncomingMessage(this.toIncomingMessage(message, sendResponse, batchSize)).catch((error) => this.close(error));
    } else if ("id" in message) {
      this.handleResponse(message);
    } else {
      console.error("Invalid message", { message });
    }
    return Promise.resolve();
  }
  async processIncomingMessage(message) {
    if (this.abortController.signal.aborted) {
      return;
    }
    let current = message;
    let retry = false;
    try {
      for (const handler of [
        ...this.staticHandlers,
        ...this.dynamicHandlers.values()
      ]) {
        if (this.abortController.signal.aborted) {
          return;
        }
        const result = await handler.handleMessage(current, this.context) ?? {
          handled: true
        };
        if (result.handled) {
          return;
        }
        current = result.message ?? current;
        retry = retry || Boolean(result.retry);
      }
      if (retry) {
        this.retryQueue.push(current);
      } else if (current.kind === "request") {
        await current.responder.respondWithError(RequestError.methodNotFound(current.method));
      }
    } catch (error) {
      if (this.abortController.signal.aborted) {
        return;
      }
      if (current.kind === "request" && !current.responder.responded) {
        await current.responder.respondWithResult(errorToRequestResult(error, current.responder.signal));
      } else {
        const response = errorToResult(error);
        if ("error" in response) {
          console.error("Error handling notification", message.raw, response.error);
        }
      }
    }
  }
  toIncomingMessage(message, sendResponse, batchSize) {
    if ("id" in message) {
      const abortController = new AbortController();
      this.incomingRequests.set(message.id, abortController);
      const finishRequest = () => {
        if (this.incomingRequests.get(message.id) === abortController) {
          this.incomingRequests.delete(message.id);
        }
      };
      const responder = new RequestResponder(message.id, (result) => {
        const response = {
          jsonrpc: "2.0",
          id: message.id,
          ...result
        };
        return sendResponse ? sendResponse(response) : this.sendWireMessage(response);
      }, abortController.signal, finishRequest);
      if (batchSize !== void 0) {
        requestBatchSizes.set(responder, batchSize);
      }
      return {
        kind: "request",
        method: message.method,
        params: message.params,
        raw: message,
        signal: abortController.signal,
        responder
      };
    }
    return {
      kind: "notification",
      method: message.method,
      params: message.params,
      raw: message
    };
  }
  handleResponse(response) {
    const pendingResponse = this.pendingResponses.get(response.id);
    if (pendingResponse) {
      this.pendingResponses.delete(response.id);
      pendingResponse.cleanup?.();
      if (!isResponseMessage(response)) {
        pendingResponse.reject(RequestError.invalidRequest(response));
      } else if ("result" in response) {
        pendingResponse.resolve(response.result);
      } else {
        const { code, message, data } = response.error;
        pendingResponse.reject(new RequestError(code, message, data));
      }
    } else {
      console.error("Got response to unknown request", response.id);
    }
  }
  handleProtocolNotification(message) {
    if (message.method !== CANCEL_REQUEST_METHOD) {
      return;
    }
    const requestId = cancelRequestId(message.params);
    if (requestId === void 0) {
      return;
    }
    const controller = this.incomingRequests.get(requestId);
    if (!controller || controller.signal.aborted) {
      return;
    }
    controller.abort(RequestError.requestCancelled({ requestId }));
  }
  closedReason() {
    return this.abortController.signal.reason ?? new Error("ACP connection closed");
  }
  async sendWireMessage(message) {
    if (this.abortController.signal.aborted) {
      return rejectedPromise(this.closedReason());
    }
    this.writeQueue = this.writeQueue.then(async () => {
      if (this.abortController.signal.aborted) {
        throw this.closedReason();
      }
      const writer = this.stream.writable.getWriter();
      try {
        await writer.write(message);
      } finally {
        writer.releaseLock();
      }
    }).catch((error) => {
      this.close(error);
      throw error;
    });
    return this.writeQueue;
  }
};
var ConnectionBuilder = class {
  handlers = [];
  connectionName;
  /**
   * Sets a diagnostic name used by handlers created from this builder.
   */
  name(name) {
    this.connectionName = name;
    return this;
  }
  /**
   * Adds a raw JSON-RPC handler to the handler chain.
   */
  withHandler(handler) {
    this.handlers.push(handler);
    return this;
  }
  /**
   * Adds a handler that can inspect every incoming request or notification.
   *
   * Observer callbacks that return void pass the message through to later
   * handlers. Return `Handled.yes()` to stop dispatch explicitly.
   */
  onReceiveMessage(handler) {
    return this.withHandler({
      handleMessage: async (message, cx) => await handler(message, cx) ?? Handled.no(message),
      describe: () => this.connectionName ?? "onReceiveMessage"
    });
  }
  /**
   * Adds a typed request handler for one method.
   */
  onReceiveRequest(method, parse, handler) {
    return this.withHandler({
      handleMessage: async (message, cx) => {
        if (message.kind !== "request" || message.method !== method) {
          return Handled.no(message);
        }
        const request = parse(message.params);
        return await handler(request, message.responder, cx) ?? Handled.yes();
      },
      describe: () => `${this.connectionName ?? "request"}:${method}`
    });
  }
  /**
   * Adds a typed notification handler for one method.
   */
  onReceiveNotification(method, parse, handler) {
    return this.withHandler({
      handleMessage: async (message, cx) => {
        if (message.kind !== "notification" || message.method !== method) {
          return Handled.no(message);
        }
        const notification = parse(message.params);
        return await handler(notification, cx) ?? Handled.yes();
      },
      describe: () => `${this.connectionName ?? "notification"}:${method}`
    });
  }
  /**
   * Connects the configured handlers to a stream.
   */
  connect(stream, options) {
    return new Connection(stream, this.handlers, options);
  }
  /**
   * Connects to a stream for the lifetime of `op`, then closes the connection.
   */
  connectWith(stream, op, options) {
    return this.connect(stream, options).runUntil(op);
  }
};
var RequestError = class _RequestError extends Error {
  code;
  /**
   * Additional JSON-RPC error data.
   */
  data;
  constructor(code, message, data) {
    super(message);
    this.code = code;
    this.name = "RequestError";
    this.data = data;
  }
  /**
   * Invalid JSON was received by the server. An error occurred on the server while parsing the JSON text.
   */
  static parseError(data, additionalMessage) {
    return new _RequestError(-32700, `Parse error${additionalMessage ? `: ${additionalMessage}` : ""}`, data);
  }
  /**
   * The JSON sent is not a valid Request object.
   */
  static invalidRequest(data, additionalMessage) {
    return new _RequestError(-32600, `Invalid request${additionalMessage ? `: ${additionalMessage}` : ""}`, data);
  }
  /**
   * The method does not exist / is not available.
   */
  static methodNotFound(method) {
    return new _RequestError(-32601, `"Method not found": ${method}`, {
      method
    });
  }
  /**
   * Invalid method parameter(s).
   */
  static invalidParams(data, additionalMessage) {
    return new _RequestError(-32602, `Invalid params${additionalMessage ? `: ${additionalMessage}` : ""}`, data);
  }
  /**
   * Internal JSON-RPC error.
   */
  static internalError(data, additionalMessage) {
    return new _RequestError(-32603, `Internal error${additionalMessage ? `: ${additionalMessage}` : ""}`, data);
  }
  /**
   * Execution of the request was aborted.
   */
  static requestCancelled(data, additionalMessage) {
    return new _RequestError(-32800, `Request cancelled${additionalMessage ? `: ${additionalMessage}` : ""}`, data);
  }
  /**
   * Authentication required.
   */
  static authRequired(data, additionalMessage) {
    return new _RequestError(-32e3, `Authentication required${additionalMessage ? `: ${additionalMessage}` : ""}`, data);
  }
  /**
   * Resource, such as a file, was not found
   */
  static resourceNotFound(uri) {
    return new _RequestError(-32002, `Resource not found${uri ? `: ${uri}` : ""}`, uri && { uri });
  }
  /**
   * Converts this error to a JSON-RPC result object.
   */
  toResult() {
    return {
      error: {
        code: this.code,
        message: this.message,
        data: this.data
      }
    };
  }
  /**
   * Converts this error to a JSON-RPC error response payload.
   */
  toErrorResponse() {
    return {
      code: this.code,
      message: this.message,
      data: this.data
    };
  }
};
function protocolErrorResponse(error) {
  return {
    jsonrpc: "2.0",
    id: null,
    error: error.toErrorResponse()
  };
}

// ../../node_modules/.pnpm/@agentclientprotocol+sdk@1.4.0_zod@4.3.6/node_modules/@agentclientprotocol/sdk/dist/line-buffer.js
var newline = 10;
var LineBuffer = class {
  /** Bytes of the current (incomplete) line, carried across chunks. */
  #pending = [];
  /**
   * Consumes a chunk, returning each complete line without its trailing
   * newline.
   */
  push(chunk) {
    const lines = [];
    let start = 0;
    let newlineIndex = chunk.indexOf(newline, start);
    while (newlineIndex !== -1) {
      lines.push(this.#takeLine(chunk.subarray(start, newlineIndex)));
      start = newlineIndex + 1;
      newlineIndex = chunk.indexOf(newline, start);
    }
    if (start < chunk.byteLength) {
      this.#pending.push(start === 0 ? chunk : new Uint8Array(chunk.subarray(start)));
    }
    return lines;
  }
  /**
   * Returns the trailing unterminated line and resets the buffer, or
   * undefined if no bytes are buffered.
   */
  flush() {
    if (this.#pending.length === 0) {
      return void 0;
    }
    return this.#takeLine(new Uint8Array(0));
  }
  #takeLine(tail) {
    if (this.#pending.length === 0) {
      return tail;
    }
    let total = tail.byteLength;
    for (const part of this.#pending) {
      total += part.byteLength;
    }
    const line = new Uint8Array(total);
    let offset = 0;
    for (const part of this.#pending) {
      line.set(part, offset);
      offset += part.byteLength;
    }
    line.set(tail, offset);
    this.#pending = [];
    return line;
  }
};

// ../../node_modules/.pnpm/@agentclientprotocol+sdk@1.4.0_zod@4.3.6/node_modules/@agentclientprotocol/sdk/dist/stream.js
function ndJsonStream(output, input) {
  const textEncoder = new TextEncoder();
  const textDecoder = new TextDecoder();
  let cancelled = false;
  let inputReader;
  let outputWrite = Promise.resolve();
  const writeJson = (message) => {
    const content = JSON.stringify(message) + "\n";
    const write = outputWrite.then(async () => {
      const writer = output.getWriter();
      try {
        await writer.write(textEncoder.encode(content));
      } finally {
        writer.releaseLock();
      }
    });
    outputWrite = write.catch(() => {
    });
    return write;
  };
  const readable = new ReadableStream({
    async start(controller) {
      const lines = new LineBuffer();
      const enqueueLine = async (lineBytes) => {
        const trimmedLine = textDecoder.decode(lineBytes).trim();
        if (!trimmedLine) {
          return;
        }
        let message;
        try {
          message = JSON.parse(trimmedLine);
        } catch {
          await writeJson(protocolErrorResponse(RequestError.parseError()));
          return;
        }
        if (isRecord(message) || Array.isArray(message)) {
          controller.enqueue(message);
        } else {
          await writeJson(protocolErrorResponse(RequestError.invalidRequest(message)));
        }
      };
      const reader = input.getReader();
      inputReader = reader;
      try {
        while (true) {
          const { value, done } = await reader.read();
          if (cancelled) {
            return;
          }
          if (done) {
            break;
          }
          if (!value) {
            continue;
          }
          for (const line of lines.push(value)) {
            await enqueueLine(line);
            if (cancelled) {
              return;
            }
          }
        }
        if (cancelled) {
          return;
        }
        const lastLine = lines.flush();
        if (lastLine) {
          await enqueueLine(lastLine);
        }
      } catch (err) {
        if (cancelled) {
          return;
        }
        controller.error(err);
        return;
      } finally {
        if (inputReader === reader) {
          inputReader = void 0;
        }
        reader.releaseLock();
      }
      if (cancelled) {
        return;
      }
      controller.close();
    },
    cancel(reason) {
      cancelled = true;
      return inputReader?.cancel(reason);
    }
  });
  const writable = new WritableStream({
    write(message) {
      return writeJson(message);
    }
  });
  return { readable, writable };
}

// ../../node_modules/.pnpm/@agentclientprotocol+sdk@1.4.0_zod@4.3.6/node_modules/@agentclientprotocol/sdk/dist/schema/guards.gen.js
var zGuardCreateElicitationRequestForm = zElicitationFormMode.and(object({ mode: literal("form") })).and(object({ message: string() }));
var zGuardCreateElicitationRequestUrl = zElicitationUrlMode.and(object({ mode: literal("url") })).and(object({ message: string() }));
var zGuardCreateElicitationRequestCustom = union([zElicitationSessionScope, zElicitationRequestScope]).and(object({ message: string() }));
var zGuardElicitationPropertySchemaString = zStringPropertySchema.and(object({ type: literal("string") }));
var zGuardElicitationPropertySchemaNumber = zNumberPropertySchema.and(object({ type: literal("number") }));
var zGuardElicitationPropertySchemaInteger = zIntegerPropertySchema.and(object({ type: literal("integer") }));
var zGuardElicitationPropertySchemaBoolean = zBooleanPropertySchema.and(object({ type: literal("boolean") }));
var zGuardElicitationPropertySchemaArray = zMultiSelectPropertySchema.and(object({ type: literal("array") }));
var zGuardMultiSelectItemsString = zStringMultiSelectItems.and(object({ type: literal("string") }));
var zGuardCreateElicitationResponseAccept = zElicitationAcceptAction.and(object({ action: literal("accept") }));
var zGuardCreateElicitationResponseDecline = object({
  action: literal("decline")
});
var zGuardCreateElicitationResponseCancel = object({
  action: literal("cancel")
});

// ../../node_modules/.pnpm/@agentclientprotocol+sdk@1.4.0_zod@4.3.6/node_modules/@agentclientprotocol/sdk/dist/acp.js
function ndJsonStream2(output, input) {
  return ndJsonStream(output, input);
}
function emptyObjectResponse(response) {
  return response ?? {};
}
function isStream(value) {
  return typeof value === "object" && value !== null && "readable" in value && "writable" in value;
}
function memoryStreamPair() {
  const leftToRight = new TransformStream();
  const rightToLeft = new TransformStream();
  return [
    {
      readable: rightToLeft.readable,
      writable: leftToRight.writable
    },
    {
      readable: leftToRight.readable,
      writable: rightToLeft.writable
    }
  ];
}
var methods = {
  agent: {
    initialize: AGENT_METHODS.initialize,
    authenticate: AGENT_METHODS.authenticate,
    logout: AGENT_METHODS.logout,
    providers: {
      list: AGENT_METHODS.providers_list,
      set: AGENT_METHODS.providers_set,
      disable: AGENT_METHODS.providers_disable
    },
    session: {
      new: AGENT_METHODS.session_new,
      load: AGENT_METHODS.session_load,
      list: AGENT_METHODS.session_list,
      delete: AGENT_METHODS.session_delete,
      fork: AGENT_METHODS.session_fork,
      resume: AGENT_METHODS.session_resume,
      close: AGENT_METHODS.session_close,
      setMode: AGENT_METHODS.session_set_mode,
      setConfigOption: AGENT_METHODS.session_set_config_option,
      prompt: AGENT_METHODS.session_prompt,
      cancel: AGENT_METHODS.session_cancel
    },
    nes: {
      start: AGENT_METHODS.nes_start,
      suggest: AGENT_METHODS.nes_suggest,
      accept: AGENT_METHODS.nes_accept,
      reject: AGENT_METHODS.nes_reject,
      close: AGENT_METHODS.nes_close
    },
    document: {
      didOpen: AGENT_METHODS.document_did_open,
      didChange: AGENT_METHODS.document_did_change,
      didClose: AGENT_METHODS.document_did_close,
      didSave: AGENT_METHODS.document_did_save,
      didFocus: AGENT_METHODS.document_did_focus
    }
  },
  client: {
    session: {
      requestPermission: CLIENT_METHODS.session_request_permission,
      update: CLIENT_METHODS.session_update
    },
    fs: {
      writeTextFile: CLIENT_METHODS.fs_write_text_file,
      readTextFile: CLIENT_METHODS.fs_read_text_file
    },
    terminal: {
      create: CLIENT_METHODS.terminal_create,
      output: CLIENT_METHODS.terminal_output,
      release: CLIENT_METHODS.terminal_release,
      waitForExit: CLIENT_METHODS.terminal_wait_for_exit,
      kill: CLIENT_METHODS.terminal_kill
    },
    elicitation: {
      create: CLIENT_METHODS.elicitation_create,
      complete: CLIENT_METHODS.elicitation_complete
    }
  },
  protocol: {
    cancelRequest: PROTOCOL_METHODS.cancel_request
  }
};
var startActiveSession = /* @__PURE__ */ Symbol("startActiveSession");
var AcpContext = class {
  cx;
  currentRequestId;
  /** @internal */
  constructor(cx, currentRequestId) {
    this.cx = cx;
    this.currentRequestId = currentRequestId;
  }
  /**
   * JSON-RPC id of the request currently being handled.
   *
   * This is `undefined` for notification handlers and for contexts created
   * outside an inbound request, such as `connect(...)` and `connectWith(...)`.
   */
  get requestId() {
    return this.currentRequestId;
  }
  /** @internal */
  get connectionContext() {
    return this.cx;
  }
  /** @internal */
  sendRequest(method, params, mapResponse, options) {
    return this.cx.sendRequest(method, params, mapResponse, options);
  }
  /** @internal */
  sendNotification(method, params) {
    return this.cx.sendNotification(method, params);
  }
  /** @internal */
  addDynamicHandler(handler) {
    return this.cx.addDynamicHandler(handler);
  }
};
var AgentContext = class _AgentContext extends AcpContext {
  constructor(cx, requestId) {
    super(cx, requestId);
  }
  /** @internal */
  static create(cx, requestId) {
    return new _AgentContext(cx, requestId);
  }
  request(method, params, options) {
    const spec = clientRequestSpecsByMethod[method];
    return this.sendRequest(method, params, spec?.mapResponse, options);
  }
  notify(method, params) {
    return this.sendNotification(method, params);
  }
};
var ClientContext = class _ClientContext extends AcpContext {
  constructor(cx, requestId) {
    super(cx, requestId);
  }
  /** @internal */
  static create(cx, requestId) {
    return new _ClientContext(cx, requestId);
  }
  /** @internal */
  [startActiveSession](params, options) {
    return this.sendRequest(AGENT_METHODS.session_new, params, (response) => this.attachSession(response), options);
  }
  buildSession(cwdOrRequest) {
    if (typeof cwdOrRequest === "string") {
      return SessionBuilder.create(this, {
        cwd: cwdOrRequest,
        mcpServers: []
      });
    }
    return SessionBuilder.create(this, cwdOrRequest);
  }
  /**
   * Builds active-session helpers around a `session/new` response.
   */
  attachSession(response) {
    const updates = new AsyncQueue();
    const closeSignal = this.connectionContext.signal;
    const failUpdatesOnClose = () => {
      updates.fail(closeSignal.reason ?? new Error("ACP connection closed"));
    };
    if (closeSignal.aborted) {
      failUpdatesOnClose();
    } else {
      closeSignal.addEventListener("abort", failUpdatesOnClose);
    }
    const sessionRegistration = sessionUpdateRouter(this.connectionContext).attach(response, updates);
    const closeRegistration = new HandlerRegistration(() => {
      closeSignal.removeEventListener("abort", failUpdatesOnClose);
    });
    return ActiveSession.create(this, response, updates, [
      sessionRegistration,
      closeRegistration
    ]);
  }
  request(method, params, options) {
    const spec = agentRequestSpecsByMethod[method];
    return this.sendRequest(method, params, spec?.mapResponse, options);
  }
  notify(method, params) {
    return this.sendNotification(method, params);
  }
};
var AcpConnectionHandle = class {
  connection;
  constructor(connection) {
    this.connection = connection;
  }
  get signal() {
    return this.connection.signal;
  }
  get closed() {
    return this.connection.closed;
  }
  close(error) {
    this.connection.close(error);
  }
};
var AgentConnectionHandle = class extends AcpConnectionHandle {
  connectHandlers;
  client;
  didStartConnectHandlers = false;
  constructor(connection, connectHandlers = []) {
    super(connection);
    this.connectHandlers = connectHandlers;
    this.client = AgentContext.create(connection.getContext());
  }
  /** @internal */
  startConnectHandlers() {
    if (this.didStartConnectHandlers) {
      return;
    }
    this.didStartConnectHandlers = true;
    runConnectHandlers(this, this.connectHandlers);
  }
};
var ClientConnectionHandle = class extends AcpConnectionHandle {
  connectHandlers;
  agent;
  didStartConnectHandlers = false;
  constructor(connection, connectHandlers = []) {
    super(connection);
    this.connectHandlers = connectHandlers;
    this.agent = ClientContext.create(connection.getContext());
  }
  /** @internal */
  startConnectHandlers() {
    if (this.didStartConnectHandlers) {
      return;
    }
    this.didStartConnectHandlers = true;
    runConnectHandlers(this, this.connectHandlers);
  }
};
function agentConnection(connection, connectHandlers = []) {
  return new AgentConnectionHandle(connection, connectHandlers);
}
function clientConnection(connection, connectHandlers = []) {
  return new ClientConnectionHandle(connection, connectHandlers);
}
var AsyncQueue = class {
  values = [];
  waiters = [];
  failed = false;
  failure;
  enqueue(value) {
    if (this.failed) {
      return;
    }
    const waiter = this.waiters.shift();
    if (waiter) {
      waiter.resolve(value);
    } else {
      this.values.push({ kind: "value", value });
    }
  }
  reject(error) {
    if (this.failed) {
      return;
    }
    if (this.waiters.length > 0) {
      for (const waiter of this.waiters.splice(0)) {
        waiter.reject(error);
      }
      return;
    }
    this.values.push({ kind: "error", error });
  }
  clearErrors() {
    this.values = this.values.filter((entry) => entry.kind === "value");
  }
  fail(error) {
    if (this.failed) {
      return;
    }
    this.failed = true;
    this.failure = error;
    for (const waiter of this.waiters.splice(0)) {
      waiter.reject(error);
    }
  }
  next() {
    if (this.values.length > 0) {
      const entry = this.values.shift();
      if (entry.kind === "error") {
        return Promise.reject(entry.error);
      }
      return Promise.resolve(entry.value);
    }
    if (this.failed) {
      return Promise.reject(this.failure);
    }
    return new Promise((resolve, reject) => {
      this.waiters.push({ resolve, reject });
    });
  }
};
function cloneNewSessionRequest(request) {
  return {
    ...request,
    additionalDirectories: request.additionalDirectories ? [...request.additionalDirectories] : void 0,
    mcpServers: [...request.mcpServers]
  };
}
var SessionBuilder = class _SessionBuilder {
  cx;
  request;
  constructor(cx, request) {
    this.cx = cx;
    this.request = cloneNewSessionRequest(request);
  }
  /** @internal */
  static create(cx, request) {
    return new _SessionBuilder(cx, request);
  }
  /**
   * Returns the `session/new` request that will be sent.
   *
   * The returned object is a defensive copy, so mutating it does not change the
   * builder.
   */
  toRequest() {
    return cloneNewSessionRequest(this.request);
  }
  /**
   * Replaces the additional workspace roots for this session.
   *
   * `additionalDirectories` expand the session's file-system scope without
   * changing `cwd`. Each path should be absolute.
   */
  withAdditionalDirectories(additionalDirectories) {
    this.request = {
      ...this.request,
      additionalDirectories: [...additionalDirectories]
    };
    return this;
  }
  /**
   * Adds one MCP server to the `session/new` request.
   */
  withMcpServer(mcpServer) {
    this.request = {
      ...this.request,
      mcpServers: [...this.request.mcpServers, mcpServer]
    };
    return this;
  }
  /**
   * Starts the session and returns an `ActiveSession` for prompting and reading
   * updates.
   *
   * Call `dispose()` on the returned session when you no longer need update
   * routing, or use `withSession(...)` to scope disposal automatically.
   */
  async start(options) {
    return this.cx[startActiveSession](this.toRequest(), options);
  }
  /**
   * Starts the session, runs `op`, and disposes the active-session update
   * routing when `op` finishes or throws.
   */
  async withSession(op) {
    const session = await this.start();
    try {
      return await op(session);
    } finally {
      session.dispose();
    }
  }
};
var ActiveSession = class _ActiveSession {
  cx;
  sessionResponse;
  updates;
  registrations;
  constructor(cx, sessionResponse, updates, registrations) {
    this.cx = cx;
    this.sessionResponse = sessionResponse;
    this.updates = updates;
    this.registrations = registrations;
  }
  /** @internal */
  static create(cx, sessionResponse, updates, registrations) {
    return new _ActiveSession(cx, sessionResponse, updates, registrations);
  }
  /**
   * Session ID returned by `session/new`.
   */
  get sessionId() {
    return this.sessionResponse.sessionId;
  }
  /**
   * Mode state returned when the session was created, if the agent provided it.
   */
  get modes() {
    return this.sessionResponse.modes;
  }
  /**
   * Metadata returned when the session was created.
   */
  get meta() {
    return this.sessionResponse._meta;
  }
  /**
   * Full response returned by `session/new`.
   */
  get newSessionResponse() {
    return this.sessionResponse;
  }
  /**
   * Sends a prompt to this session.
   *
   * Strings are converted to one text content block. A single content block is
   * wrapped in an array. The returned promise resolves with the final
   * `PromptResponse`, and the same completion is also queued as a `stop`
   * message for `nextUpdate()`.
   */
  prompt(prompt, options) {
    this.updates.clearErrors();
    const response = this.cx.request(AGENT_METHODS.session_prompt, {
      sessionId: this.sessionId,
      prompt: this.promptBlocks(prompt)
    }, options);
    void response.then((value) => {
      this.updates.enqueue({
        kind: "stop",
        response: value,
        stopReason: value.stopReason
      });
    }, (error) => {
      this.updates.reject(error);
    });
    return response;
  }
  /**
   * Reads the next update or stop message for this session.
   */
  nextUpdate() {
    return this.updates.next();
  }
  /**
   * Reads text chunks until the current prompt turn stops.
   *
   * Only `agent_message_chunk` updates with text content are appended. Other
   * update types are ignored by this helper; use `nextUpdate()` when you need
   * tool calls, plans, or the final `PromptResponse`.
   */
  async readText() {
    let output = "";
    for (; ; ) {
      const message = await this.nextUpdate();
      if (message.kind === "stop") {
        return output;
      }
      const { update } = message;
      if (update.sessionUpdate === "agent_message_chunk" && update.content.type === "text") {
        output += update.content.text;
      }
    }
  }
  /**
   * Stops routing updates to this active-session helper.
   *
   * This does not close the ACP session on the agent. Use `ClientContext`
   * session lifecycle methods when the protocol session itself should be closed
   * or deleted.
   */
  dispose() {
    for (const registration of this.registrations.splice(0)) {
      registration.dispose();
    }
    this.updates.fail(new Error("Active session disposed"));
  }
  /**
   * Supports explicit resource management with `using`.
   */
  [Symbol.dispose]() {
    this.dispose();
  }
  promptBlocks(prompt) {
    if (typeof prompt === "string") {
      return [{ type: "text", text: prompt }];
    }
    if (Array.isArray(prompt)) {
      return prompt;
    }
    return [prompt];
  }
};
function parseParams(parser, params) {
  if (!parser) {
    return params;
  }
  if (typeof parser === "function") {
    return parser(params);
  }
  return parser.parse(params);
}
function requestSpec(method, params, mapResponse) {
  return { method, params, mapResponse };
}
function notificationSpec(method, params) {
  return { method, params };
}
function registerAppRequest(builder, spec, context, handler) {
  builder.onReceiveRequest(spec.method, (params) => parseParams(spec.params, params), async (params, responder, cx) => {
    const response = await handler(context(params, cx, responder.signal, responder.id));
    await responder.respond(spec.mapResponse ? spec.mapResponse(response) : response);
  });
}
function registerAppNotification(builder, spec, context, handler) {
  builder.onReceiveNotification(spec.method, (params) => parseParams(spec.params, params), (params, cx) => handler(context(params, cx, cx.signal)));
}
function specsByMethod(specs) {
  const byMethod = {};
  for (const spec of Object.values(specs)) {
    byMethod[spec.method] = spec;
  }
  return byMethod;
}
var agentRequestSpecs = {
  initialize: requestSpec(AGENT_METHODS.initialize, zInitializeRequest),
  newSession: requestSpec(AGENT_METHODS.session_new, zNewSessionRequest),
  loadSession: requestSpec(AGENT_METHODS.session_load, zLoadSessionRequest, emptyObjectResponse),
  unstable_forkSession: requestSpec(AGENT_METHODS.session_fork, zForkSessionRequest),
  listSessions: requestSpec(AGENT_METHODS.session_list, zListSessionsRequest),
  deleteSession: requestSpec(AGENT_METHODS.session_delete, zDeleteSessionRequest, emptyObjectResponse),
  resumeSession: requestSpec(AGENT_METHODS.session_resume, zResumeSessionRequest),
  closeSession: requestSpec(AGENT_METHODS.session_close, zCloseSessionRequest, emptyObjectResponse),
  setSessionMode: requestSpec(AGENT_METHODS.session_set_mode, zSetSessionModeRequest, emptyObjectResponse),
  setSessionConfigOption: requestSpec(AGENT_METHODS.session_set_config_option, zSetSessionConfigOptionRequest),
  authenticate: requestSpec(AGENT_METHODS.authenticate, zAuthenticateRequest, emptyObjectResponse),
  unstable_listProviders: requestSpec(AGENT_METHODS.providers_list, zListProvidersRequest),
  unstable_setProvider: requestSpec(AGENT_METHODS.providers_set, zSetProviderRequest, emptyObjectResponse),
  unstable_disableProvider: requestSpec(AGENT_METHODS.providers_disable, zDisableProviderRequest, emptyObjectResponse),
  logout: requestSpec(AGENT_METHODS.logout, zLogoutRequest, emptyObjectResponse),
  prompt: requestSpec(AGENT_METHODS.session_prompt, zPromptRequest),
  unstable_startNes: requestSpec(AGENT_METHODS.nes_start, zStartNesRequest),
  unstable_suggestNes: requestSpec(AGENT_METHODS.nes_suggest, zSuggestNesRequest),
  unstable_closeNes: requestSpec(AGENT_METHODS.nes_close, zCloseNesRequest, emptyObjectResponse)
};
var agentNotificationSpecs = {
  cancel: notificationSpec(AGENT_METHODS.session_cancel, zCancelNotification),
  unstable_didOpenDocument: notificationSpec(AGENT_METHODS.document_did_open, zDidOpenDocumentNotification),
  unstable_didChangeDocument: notificationSpec(AGENT_METHODS.document_did_change, zDidChangeDocumentNotification),
  unstable_didCloseDocument: notificationSpec(AGENT_METHODS.document_did_close, zDidCloseDocumentNotification),
  unstable_didSaveDocument: notificationSpec(AGENT_METHODS.document_did_save, zDidSaveDocumentNotification),
  unstable_didFocusDocument: notificationSpec(AGENT_METHODS.document_did_focus, zDidFocusDocumentNotification),
  unstable_acceptNes: notificationSpec(AGENT_METHODS.nes_accept, zAcceptNesNotification),
  unstable_rejectNes: notificationSpec(AGENT_METHODS.nes_reject, zRejectNesNotification)
};
var clientRequestSpecs = {
  requestPermission: requestSpec(CLIENT_METHODS.session_request_permission, zRequestPermissionRequest),
  writeTextFile: requestSpec(CLIENT_METHODS.fs_write_text_file, zWriteTextFileRequest, emptyObjectResponse),
  readTextFile: requestSpec(CLIENT_METHODS.fs_read_text_file, zReadTextFileRequest),
  createTerminal: requestSpec(CLIENT_METHODS.terminal_create, zCreateTerminalRequest),
  terminalOutput: requestSpec(CLIENT_METHODS.terminal_output, zTerminalOutputRequest),
  releaseTerminal: requestSpec(CLIENT_METHODS.terminal_release, zReleaseTerminalRequest, emptyObjectResponse),
  waitForTerminalExit: requestSpec(CLIENT_METHODS.terminal_wait_for_exit, zWaitForTerminalExitRequest),
  killTerminal: requestSpec(CLIENT_METHODS.terminal_kill, zKillTerminalRequest, emptyObjectResponse),
  createElicitation: requestSpec(CLIENT_METHODS.elicitation_create, zCreateElicitationRequest)
};
var clientNotificationSpecs = {
  sessionUpdate: notificationSpec(CLIENT_METHODS.session_update, zSessionNotification),
  completeElicitation: notificationSpec(CLIENT_METHODS.elicitation_complete, zCompleteElicitationNotification)
};
var agentRequestSpecsByMethod = specsByMethod(agentRequestSpecs);
var agentNotificationSpecsByMethod = specsByMethod(agentNotificationSpecs);
var clientRequestSpecsByMethod = specsByMethod(clientRequestSpecs);
var clientNotificationSpecsByMethod = specsByMethod(clientNotificationSpecs);
function agentRequestContext(params, client2, signal, requestId) {
  return {
    params,
    requestId,
    signal,
    client: client2
  };
}
function agentNotificationContext(params, client2, signal) {
  return {
    params,
    signal,
    client: client2
  };
}
function clientRequestContext(params, agent, signal, requestId) {
  return {
    params,
    requestId,
    signal,
    agent
  };
}
function clientNotificationContext(params, agent, signal) {
  return {
    params,
    signal,
    agent
  };
}
var SessionUpdateRouter = class {
  activeSessions = /* @__PURE__ */ new Map();
  handleMessage(message) {
    if (message.kind !== "notification" || message.method !== CLIENT_METHODS.session_update) {
      return Handled.no(message);
    }
    const notification = zSessionNotification.parse(message.params);
    const update = {
      kind: "session_update",
      notification,
      update: notification.update
    };
    const activeSessions = this.activeSessions.get(notification.sessionId);
    if (activeSessions && activeSessions.size > 0) {
      for (const session of activeSessions) {
        session.enqueue(update);
      }
    }
    return Handled.no(message);
  }
  attach(response, updates) {
    const sessions = this.activeSessions.get(response.sessionId) ?? /* @__PURE__ */ new Set();
    sessions.add(updates);
    this.activeSessions.set(response.sessionId, sessions);
    return new HandlerRegistration(() => {
      sessions.delete(updates);
      if (sessions.size === 0) {
        this.activeSessions.delete(response.sessionId);
      }
    });
  }
};
var sessionUpdateRouters = /* @__PURE__ */ new WeakMap();
function sessionUpdateRouter(cx) {
  let router = sessionUpdateRouters.get(cx);
  if (!router) {
    router = new SessionUpdateRouter();
    sessionUpdateRouters.set(cx, router);
  }
  return router;
}
function runConnectHandlers(connection, handlers) {
  for (const handler of handlers) {
    let result;
    try {
      result = handler(connection);
    } catch (error) {
      connection.close(error);
      throw error;
    }
    void Promise.resolve(result).catch((error) => {
      connection.close(error);
    });
  }
}
var appBuilder = /* @__PURE__ */ Symbol("appBuilder");
var runAgentConnectHandlers = /* @__PURE__ */ Symbol("runAgentConnectHandlers");
var runClientConnectHandlers = /* @__PURE__ */ Symbol("runClientConnectHandlers");
var stableConnectionOptions = { allowBatches: false };
var AgentApp = class {
  builder = Connection.builder();
  connectHandlers = [];
  constructor(options = {}) {
    if (options.name) {
      this.builder.name(options.name);
    }
  }
  /** @internal */
  [appBuilder]() {
    return this.builder;
  }
  /** @internal */
  [runAgentConnectHandlers](connection) {
    runConnectHandlers(connection, this.connectHandlers);
  }
  connect(target, options = {}) {
    return this.connectConnection(target, options).connection;
  }
  connectWith(target, op) {
    const { rawConnection, connection } = this.connectConnection(target);
    return rawConnection.runUntil(() => op(connection.client));
  }
  /**
   * Registers a handler that runs when this agent app opens a connection.
   *
   * Use this for connection-scoped work that needs to call client-side ACP
   * methods outside an inbound request handler.
   */
  onConnect(handler) {
    this.connectHandlers.push(handler);
    return this;
  }
  onRequest(method, handlerOrParams, handler) {
    if (handler) {
      return this.request({ method, params: handlerOrParams }, handler);
    }
    const spec = agentRequestSpecsByMethod[method];
    if (!spec) {
      throw new Error(`Unknown ACP request method '${method}'. Pass a params parser for custom methods.`);
    }
    return this.request(spec, handlerOrParams);
  }
  onNotification(method, handlerOrParams, handler) {
    if (handler) {
      return this.notification({ method, params: handlerOrParams }, handler);
    }
    const spec = agentNotificationSpecsByMethod[method];
    if (!spec) {
      throw new Error(`Unknown ACP notification method '${method}'. Pass a params parser for custom methods.`);
    }
    return this.notification(spec, handlerOrParams);
  }
  request(spec, handler) {
    registerAppRequest(this.builder, spec, (params, cx, signal, requestId) => agentRequestContext(params, AgentContext.create(cx, requestId), signal, requestId), handler);
    return this;
  }
  notification(spec, handler) {
    registerAppNotification(this.builder, spec, (params, cx, signal) => agentNotificationContext(params, AgentContext.create(cx), signal), handler);
    return this;
  }
  connectConnection(target, options = {}) {
    if (isStream(target)) {
      const state2 = this.openStreamConnection(target);
      if (!options.deferConnectHandlers) {
        this[runAgentConnectHandlers](state2.connection);
      }
      return state2;
    }
    const [thisStream, peerStream] = memoryStreamPair();
    const peerRawConnection = target[appBuilder]().connect(peerStream, stableConnectionOptions);
    const peerConnection = clientConnection(peerRawConnection);
    const state = this.openStreamConnection(thisStream);
    void state.rawConnection.closed.then(() => peerConnection.close());
    void peerRawConnection.closed.then(() => state.connection.close());
    try {
      target[runClientConnectHandlers](peerConnection);
      this[runAgentConnectHandlers](state.connection);
    } catch (error) {
      peerConnection.close(error);
      state.connection.close(error);
      throw error;
    }
    return state;
  }
  openStreamConnection(stream) {
    const rawConnection = this.builder.connect(stream, stableConnectionOptions);
    return {
      rawConnection,
      connection: agentConnection(rawConnection, this.connectHandlers)
    };
  }
};
function client(options) {
  return new ClientApp(options);
}
var ClientApp = class {
  builder = Connection.builder();
  connectHandlers = [];
  constructor(options = {}) {
    if (options.name) {
      this.builder.name(options.name);
    }
    this.builder.withHandler({
      handleMessage: (message, cx) => sessionUpdateRouter(cx).handleMessage(message),
      describe: () => "client-session-update-router"
    });
  }
  /** @internal */
  [appBuilder]() {
    return this.builder;
  }
  /** @internal */
  [runClientConnectHandlers](connection) {
    runConnectHandlers(connection, this.connectHandlers);
  }
  connect(target) {
    return this.connectConnection(target).connection;
  }
  connectWith(target, op) {
    const { rawConnection, connection } = this.connectConnection(target);
    return rawConnection.runUntil(() => op(connection.agent));
  }
  /**
   * Registers a handler that runs when this client app opens a connection.
   *
   * Use this for connection-scoped work that needs to call agent-side ACP
   * methods outside an inbound request handler.
   */
  onConnect(handler) {
    this.connectHandlers.push(handler);
    return this;
  }
  onRequest(method, handlerOrParams, handler) {
    if (handler) {
      return this.request({ method, params: handlerOrParams }, handler);
    }
    const spec = clientRequestSpecsByMethod[method];
    if (!spec) {
      throw new Error(`Unknown ACP request method '${method}'. Pass a params parser for custom methods.`);
    }
    return this.request(spec, handlerOrParams);
  }
  onNotification(method, handlerOrParams, handler) {
    if (handler) {
      return this.notification({ method, params: handlerOrParams }, handler);
    }
    const spec = clientNotificationSpecsByMethod[method];
    if (!spec) {
      throw new Error(`Unknown ACP notification method '${method}'. Pass a params parser for custom methods.`);
    }
    return this.notification(spec, handlerOrParams);
  }
  request(spec, handler) {
    registerAppRequest(this.builder, spec, (params, cx, signal, requestId) => clientRequestContext(params, ClientContext.create(cx, requestId), signal, requestId), handler);
    return this;
  }
  notification(spec, handler) {
    registerAppNotification(this.builder, spec, (params, cx, signal) => clientNotificationContext(params, ClientContext.create(cx), signal), handler);
    return this;
  }
  connectConnection(target) {
    if (isStream(target)) {
      const state2 = this.openStreamConnection(target);
      this[runClientConnectHandlers](state2.connection);
      return state2;
    }
    const [thisStream, peerStream] = memoryStreamPair();
    const peerRawConnection = target[appBuilder]().connect(peerStream, stableConnectionOptions);
    const peerConnection = agentConnection(peerRawConnection);
    const state = this.openStreamConnection(thisStream);
    void state.rawConnection.closed.then(() => peerConnection.close());
    void peerRawConnection.closed.then(() => state.connection.close());
    try {
      target[runAgentConnectHandlers](peerConnection);
      this[runClientConnectHandlers](state.connection);
    } catch (error) {
      peerConnection.close(error);
      state.connection.close(error);
      throw error;
    }
    return state;
  }
  openStreamConnection(stream) {
    const rawConnection = this.builder.connect(stream, stableConnectionOptions);
    return {
      rawConnection,
      connection: clientConnection(rawConnection, this.connectHandlers)
    };
  }
};
var legacyAgentRequestMethods = /* @__PURE__ */ new Set([
  AGENT_METHODS.initialize,
  AGENT_METHODS.authenticate,
  AGENT_METHODS.providers_list,
  AGENT_METHODS.providers_set,
  AGENT_METHODS.providers_disable,
  AGENT_METHODS.session_new,
  AGENT_METHODS.session_load,
  AGENT_METHODS.session_set_mode,
  AGENT_METHODS.session_set_config_option,
  AGENT_METHODS.session_prompt,
  AGENT_METHODS.session_list,
  AGENT_METHODS.session_delete,
  AGENT_METHODS.session_fork,
  AGENT_METHODS.session_resume,
  AGENT_METHODS.session_close,
  AGENT_METHODS.logout,
  AGENT_METHODS.nes_start,
  AGENT_METHODS.nes_suggest,
  AGENT_METHODS.nes_close
]);
var legacyAgentNotificationMethods = /* @__PURE__ */ new Set([
  AGENT_METHODS.session_cancel,
  AGENT_METHODS.nes_accept,
  AGENT_METHODS.nes_reject,
  AGENT_METHODS.document_did_open,
  AGENT_METHODS.document_did_change,
  AGENT_METHODS.document_did_close,
  AGENT_METHODS.document_did_save,
  AGENT_METHODS.document_did_focus
]);
var legacyClientRequestMethods = /* @__PURE__ */ new Set([
  CLIENT_METHODS.session_request_permission,
  CLIENT_METHODS.fs_write_text_file,
  CLIENT_METHODS.fs_read_text_file,
  CLIENT_METHODS.terminal_create,
  CLIENT_METHODS.terminal_output,
  CLIENT_METHODS.terminal_release,
  CLIENT_METHODS.terminal_wait_for_exit,
  CLIENT_METHODS.terminal_kill,
  CLIENT_METHODS.elicitation_create
]);
var legacyClientNotificationMethods = /* @__PURE__ */ new Set([
  CLIENT_METHODS.session_update,
  CLIENT_METHODS.elicitation_complete
]);

// ../../node_modules/.pnpm/@botiverse+oar@0.0.7_@modelcontextprotocol+sdk@1.29.0_zod@4.3.6__ws@8.20.0_zod@4.3.6/node_modules/@botiverse/oar/dist/shared/acp/process.js
import { Readable, Writable } from "stream";

// ../../node_modules/.pnpm/@botiverse+oar@0.0.7_@modelcontextprotocol+sdk@1.29.0_zod@4.3.6__ws@8.20.0_zod@4.3.6/node_modules/@botiverse/oar/dist/shared/acp/errors.js
var AcpError = class extends Error {
  kind;
  exitCode;
  method;
  timeoutMs;
  constructor(kind, message, fields = {}) {
    super(message);
    this.name = "AcpError";
    this.kind = kind;
    this.exitCode = fields.exitCode ?? null;
    this.method = fields.method ?? null;
    this.timeoutMs = fields.timeoutMs ?? null;
  }
};
function acpRequestTimeoutError(method, timeoutMs) {
  return new AcpError("timeout", `ACP request ${method} timed out after ${timeoutMs}ms`, {
    method,
    timeoutMs
  });
}
function acpProcessExitedError(exitCode) {
  return new AcpError("process_exited", exitCode === null ? "ACP process exited" : `ACP process exited with code ${exitCode}`, { exitCode });
}

// ../../node_modules/.pnpm/@botiverse+oar@0.0.7_@modelcontextprotocol+sdk@1.29.0_zod@4.3.6__ws@8.20.0_zod@4.3.6/node_modules/@botiverse/oar/dist/shared/acp/process.js
function deadline(method, timeoutMs, controller) {
  const { promise, reject } = Promise.withResolvers();
  const timer = setTimeout(() => {
    controller.abort();
    reject(acpRequestTimeoutError(method, timeoutMs));
  }, timeoutMs);
  timer.unref();
  return { promise, timer };
}
function processClosed(process2) {
  return process2.closed;
}
async function withAcpDeadline(process2, method, timeoutMs, send) {
  await process2.spawned;
  if (processClosed(process2)) {
    throw acpProcessExitedError(process2.exitCode);
  }
  const controller = timeoutMs === null ? void 0 : new AbortController();
  const limit = timeoutMs === null || controller === void 0 ? void 0 : deadline(method, timeoutMs, controller);
  try {
    const request = send(controller === void 0 ? void 0 : { cancellationSignal: controller.signal });
    return await (limit === void 0 ? request : Promise.race([request, limit.promise]));
  } catch (error) {
    if (error instanceof AcpError && error.kind === "timeout") {
      throw error;
    }
    if (processClosed(process2)) {
      await process2.exited;
      throw acpProcessExitedError(process2.exitCode);
    }
    throw error;
  } finally {
    if (limit !== void 0) {
      clearTimeout(limit.timer);
    }
  }
}
function startAcpProcess(command, args, app, options = {}) {
  const child = spawnLineProcess(command, args, options);
  const output = Writable.toWeb(child.stdin);
  const input = Readable.toWeb(child.stdout);
  const connection = app.connect(ndJsonStream2(output, input));
  let ended = false;
  let exitCode = null;
  child.onExit((code) => {
    ended = true;
    exitCode = code;
    connection.close(acpProcessExitedError(code));
  });
  return {
    connection,
    spawned: child.spawned,
    exited: child.exited,
    get closed() {
      return ended || connection.signal.aborted;
    },
    get exitCode() {
      return exitCode;
    },
    kill() {
      if (!ended) {
        connection.close(acpProcessExitedError(null));
        child.kill();
      }
    }
  };
}

// ../../node_modules/.pnpm/@botiverse+oar@0.0.7_@modelcontextprotocol+sdk@1.29.0_zod@4.3.6__ws@8.20.0_zod@4.3.6/node_modules/@botiverse/oar/dist/shared/acp/profile.js
function hasAcpCapability(value) {
  return value === true || asRecord(value) !== null;
}
function responseRecord(method, value) {
  const response = asRecord(value);
  if (response === null) {
    throw new TypeError(`ACP ${method} returned a non-object response`);
  }
  return response;
}
async function promptAcp(process2, sessionId, input, extraParams = {}) {
  const method = methods.agent.session.prompt;
  const response = await withAcpDeadline(process2, method, null, (requestOptions) => process2.connection.agent.request(method, {
    sessionId,
    prompt: [{ type: "text", text: input }],
    ...extraParams
  }, requestOptions));
  await new Promise((resolve) => {
    setImmediate(resolve);
  });
  return responseRecord(method, response);
}
async function closeAcpSession(process2, sessionId) {
  const method = methods.agent.session.close;
  await withAcpDeadline(process2, method, 2e3, (requestOptions) => process2.connection.agent.request(method, { sessionId }, requestOptions));
}
async function initialize(process2, profile, options) {
  const meta = profile.initializeMeta?.(options);
  const method = methods.agent.initialize;
  const initialized = await withAcpDeadline(process2, method, profile.requestTimeoutMs ?? 15e3, (requestOptions) => process2.connection.agent.request(method, {
    protocolVersion: PROTOCOL_VERSION,
    clientCapabilities: {
      fs: { readTextFile: false, writeTextFile: false },
      terminal: true
    },
    clientInfo: { name: "oar", version: "0.0.0" },
    ...meta === void 0 ? {} : { _meta: meta }
  }, requestOptions));
  const response = responseRecord(method, initialized);
  const authMethod = profile.selectAuthMethod?.(response);
  if (authMethod !== void 0) {
    const authenticate = methods.agent.authenticate;
    await withAcpDeadline(process2, authenticate, profile.requestTimeoutMs ?? 15e3, (requestOptions) => process2.connection.agent.request(authenticate, { methodId: authMethod }, requestOptions));
  }
  return response;
}
async function createOrResume(process2, profile, initialized, options, meta) {
  const baseParams = {
    cwd: options.cwd,
    mcpServers: [],
    ...meta === void 0 ? {} : { _meta: meta }
  };
  const capabilities = asRecord(initialized.agentCapabilities);
  const sessionCapabilities = asRecord(capabilities?.sessionCapabilities);
  const timeoutMs = profile.requestTimeoutMs ?? 15e3;
  if (options.resume !== void 0) {
    const sessionId2 = options.resume;
    const params = { ...baseParams, sessionId: sessionId2 };
    let method2 = void 0;
    if (hasAcpCapability(sessionCapabilities?.resume)) {
      method2 = methods.agent.session.resume;
    } else if (capabilities?.loadSession === true) {
      method2 = methods.agent.session.load;
    }
    if (method2 === void 0) {
      throw new Error("ACP runtime does not support session resume");
    }
    const resumed = await withAcpDeadline(process2, method2, timeoutMs, (requestOptions) => process2.connection.agent.request(method2, params, requestOptions));
    return { response: responseRecord(method2, resumed), sessionId: sessionId2 };
  }
  const method = methods.agent.session.new;
  const created = await withAcpDeadline(process2, method, timeoutMs, (requestOptions) => process2.connection.agent.request(method, baseParams, requestOptions));
  const response = responseRecord(method, created);
  const sessionId = response.sessionId;
  if (typeof sessionId !== "string" || sessionId.length === 0) {
    throw new TypeError("ACP session/new returned no session id");
  }
  return { response, sessionId };
}
async function openAcpSession(process2, profile, options) {
  const initialized = await initialize(process2, profile, options);
  const opened = await createOrResume(process2, profile, initialized, options, profile.sessionMeta?.(options));
  if (options.model !== void 0) {
    await withAcpDeadline(process2, "session/set_model", profile.requestTimeoutMs ?? 15e3, (requestOptions) => process2.connection.agent.request("session/set_model", { sessionId: opened.sessionId, modelId: options.model }, requestOptions));
  }
  const configure = profile.configureSession;
  if (configure !== void 0) {
    await withAcpDeadline(process2, "session/configure", profile.requestTimeoutMs ?? 15e3, (requestOptions) => configure({
      connection: process2.connection,
      sessionId: opened.sessionId,
      response: opened.response,
      options,
      ...requestOptions === void 0 ? {} : { requestOptions }
    }));
  }
  return { initialized, ...opened };
}

// ../../node_modules/.pnpm/@botiverse+oar@0.0.7_@modelcontextprotocol+sdk@1.29.0_zod@4.3.6__ws@8.20.0_zod@4.3.6/node_modules/@botiverse/oar/dist/shared/acp/projection.js
function createAcpProjectionState() {
  return { tools: /* @__PURE__ */ new Map() };
}
function textContent(value) {
  const content = asRecord(value);
  if (content !== null && typeof content.text === "string") {
    return content.text;
  }
  if (Array.isArray(value)) {
    const parts = value.map((item) => textContent(item)).filter((item) => item !== null);
    return parts.length === 0 ? null : parts.join("\n");
  }
  return null;
}
function truncate(value) {
  return value.length > 1e4 ? `${value.slice(0, 1e4)}\u2026` : value;
}
function detail(value) {
  if (typeof value === "string") {
    return truncate(value);
  }
  if (value === void 0 || value === null) {
    return void 0;
  }
  const text5 = textContent(value);
  if (text5 !== null) {
    return truncate(text5);
  }
  try {
    return truncate(JSON.stringify(value));
  } catch {
    return void 0;
  }
}
function toolName(update) {
  if (typeof update.name === "string") {
    return update.name;
  }
  if (typeof update.toolName === "string") {
    return update.toolName;
  }
  if (typeof update.kind === "string") {
    return update.kind;
  }
  return typeof update.title === "string" ? update.title : "tool";
}
function projectTool(state, update) {
  const callId = typeof update.toolCallId === "string" ? update.toolCallId : null;
  if (callId === null) {
    return [];
  }
  const bodies = [];
  let tool = state.tools.get(callId);
  if (tool === void 0) {
    tool = { callId, ended: false };
    state.tools.set(callId, tool);
    const input = detail(update.rawInput);
    bodies.push({
      kind: "tool_call_started",
      callId,
      tool: toolName(update),
      ...input === void 0 ? {} : { input }
    });
  }
  const terminal = update.status === "completed" || update.status === "failed" || update.status === "cancelled";
  if (!tool.ended && terminal) {
    tool.ended = true;
    const output = detail(update.rawOutput) ?? detail(update.content);
    bodies.push({
      kind: "tool_call_ended",
      callId,
      ...output === void 0 ? {} : { output }
    });
  }
  return bodies;
}
function usageFromUpdate(update) {
  const tokens = asNumber(update.used);
  const contextWindow = asNumber(update.size);
  if (tokens === null && contextWindow === null) {
    return null;
  }
  const percent = tokens === null || contextWindow === null || contextWindow === 0 ? null : Math.round(tokens / contextWindow * 100);
  return { tokens, contextWindow, percent };
}
function reasoningBody(value) {
  const text5 = textContent(value);
  return {
    kind: "reasoning",
    content: text5 === null ? { kind: "redacted" } : text5.length === 0 ? { kind: "empty" } : { kind: "text", text: text5 }
  };
}
function projectAcpUpdate(state, update) {
  switch (update.sessionUpdate) {
    case "usage_update": {
      const contextUsage = usageFromUpdate(update);
      return contextUsage === null ? { bodies: [] } : { bodies: [], contextUsage };
    }
    case "agent_message_chunk": {
      const text5 = textContent(update.content);
      return text5 === null || text5.length === 0 ? { bodies: [] } : { bodies: [{ kind: "text_delta", text: text5 }] };
    }
    case "agent_thought_chunk":
      return { bodies: [reasoningBody(update.content)] };
    case "tool_call":
    case "tool_call_update":
      return { bodies: projectTool(state, update) };
    default:
      return { bodies: [] };
  }
}
function finishAcpTools(state) {
  const bodies = [];
  for (const tool of state.tools.values()) {
    if (!tool.ended) {
      tool.ended = true;
      bodies.push({ kind: "tool_call_ended", callId: tool.callId });
    }
  }
  return bodies;
}
function defaultAcpPromptOutcome(response) {
  return response.stopReason === "cancelled" ? { kind: "aborted" } : { kind: "completed" };
}
function acpFailureOutcome(error) {
  const reason = error instanceof Error ? error.message : "ACP prompt failed";
  return {
    kind: "failed",
    reason,
    failure: error instanceof AcpError && error.kind === "process_exited" ? "runtime_exited" : classifyFailure(reason)
  };
}
function acpRuntimeExitedOutcome(code) {
  return {
    kind: "failed",
    reason: code === null ? "ACP process exited" : `ACP process exited with code ${code}`,
    failure: "runtime_exited"
  };
}

// ../../node_modules/.pnpm/@botiverse+oar@0.0.7_@modelcontextprotocol+sdk@1.29.0_zod@4.3.6__ws@8.20.0_zod@4.3.6/node_modules/@botiverse/oar/dist/shared/acp/terminal.js
var import_cross_spawn2 = __toESM(require_cross_spawn(), 1);
import { randomUUID as randomUUID4 } from "crypto";
import path2 from "path";
import { StringDecoder } from "string_decoder";
var DEFAULT_OUTPUT_LIMIT = 4 * 1024 * 1024;
var MAX_OUTPUT_LIMIT = 16 * 1024 * 1024;
function allowPermission(request) {
  const selected = request.options.find((option) => option.kind === "allow_always") ?? request.options.find((option) => option.kind === "allow_once");
  return selected === void 0 ? { outcome: { outcome: "cancelled" } } : { outcome: { outcome: "selected", optionId: selected.optionId } };
}
function createAcpClientApp(terminal, update) {
  return client({ name: "oar" }).onRequest(methods.client.session.requestPermission, ({ params }) => allowPermission(params)).onRequest(methods.client.terminal.create, ({ params }) => terminal.create(params)).onRequest(methods.client.terminal.output, ({ params }) => terminal.output(params)).onRequest(methods.client.terminal.waitForExit, ({ params }) => terminal.waitForExit(params)).onRequest(methods.client.terminal.kill, ({ params }) => terminal.kill(params)).onRequest(methods.client.terminal.release, ({ params }) => terminal.release(params)).onNotification(methods.client.session.update, ({ params }) => {
    update(params);
  });
}
function invalid(message) {
  throw RequestError.invalidParams(void 0, message);
}
function outputLimit(value) {
  if (value === void 0 || value === null) {
    return DEFAULT_OUTPUT_LIMIT;
  }
  if (!Number.isFinite(value) || value < 0) {
    invalid("ACP terminal outputByteLimit must be finite and nonnegative");
  }
  return Math.min(Math.floor(value), MAX_OUTPUT_LIMIT);
}
function tailAtCharacterBoundary(value, limit) {
  const encoded = Buffer.from(value);
  if (encoded.byteLength <= limit) {
    return value;
  }
  let start = encoded.byteLength - limit;
  while (start < encoded.byteLength) {
    const byte = encoded[start];
    if (byte === void 0 || (byte & 192) !== 128) {
      break;
    }
    start += 1;
  }
  return encoded.subarray(start).toString("utf8");
}
function appendOutput(state, text5) {
  if (text5.length === 0) {
    return;
  }
  const combined = `${state.output}${text5}`;
  if (Buffer.byteLength(combined) > state.outputLimit) {
    state.truncated = true;
    state.output = tailAtCharacterBoundary(combined, state.outputLimit);
  } else {
    state.output = combined;
  }
}
function terminalFor(terminals, params) {
  const terminal = terminals.get(params.terminalId);
  if (terminal === void 0 || terminal.sessionId !== params.sessionId) {
    invalid(`Unknown ACP terminal: ${params.terminalId}`);
  }
  return terminal;
}
async function stopTerminal(state) {
  if (state.exitStatus === null) {
    state.child.kill("SIGKILL");
  }
  await state.exited;
}
function createAcpTerminalHost(cwd, environment, options = {}) {
  const terminals = /* @__PURE__ */ new Map();
  const create = async (params) => {
    if (params.command.length === 0) {
      invalid("ACP terminal request requires command");
    }
    if (params.cwd !== void 0 && params.cwd !== null && !path2.isAbsolute(params.cwd)) {
      invalid("ACP terminal cwd must be an absolute path");
    }
    const terminalId = randomUUID4();
    const child = (0, import_cross_spawn2.default)(params.command, params.args ?? [], {
      cwd: params.cwd ?? cwd,
      env: {
        ...environment,
        ...Object.fromEntries((params.env ?? []).map(({ name, value }) => [name, value]))
      },
      shell: options.shellCommand === true && params.args === void 0,
      stdio: ["ignore", "pipe", "pipe"]
    });
    const { stdout, stderr } = child;
    if (stdout === null || stderr === null) {
      child.kill("SIGKILL");
      throw RequestError.internalError(void 0, "ACP terminal process has no output streams");
    }
    const { promise: spawned, resolve: resolveSpawned, reject: rejectSpawned } = Promise.withResolvers();
    const { promise: exited, resolve: resolveExited } = Promise.withResolvers();
    const state = {
      child,
      exited,
      sessionId: params.sessionId,
      stderrDecoder: new StringDecoder("utf8"),
      stdoutDecoder: new StringDecoder("utf8"),
      terminalId,
      outputLimit: outputLimit(params.outputByteLimit),
      exitStatus: null,
      output: "",
      truncated: false
    };
    terminals.set(terminalId, state);
    stdout.on("data", (chunk) => {
      appendOutput(state, state.stdoutDecoder.write(Buffer.from(chunk)));
    });
    stderr.on("data", (chunk) => {
      appendOutput(state, state.stderrDecoder.write(Buffer.from(chunk)));
    });
    const finish = (status) => {
      if (state.exitStatus !== null) {
        return;
      }
      appendOutput(state, state.stdoutDecoder.end());
      appendOutput(state, state.stderrDecoder.end());
      state.exitStatus = status;
      resolveExited(status);
    };
    child.once("spawn", resolveSpawned);
    child.once("close", (exitCode, signal) => {
      finish({ exitCode, signal });
    });
    child.once("error", (error) => {
      rejectSpawned(error);
      finish({ exitCode: null, signal: null });
    });
    try {
      await spawned;
    } catch (error) {
      terminals.delete(terminalId);
      throw RequestError.internalError(void 0, error instanceof Error ? error.message : "Failed to create ACP terminal");
    }
    return { terminalId };
  };
  const output = (params) => {
    const state = terminalFor(terminals, params);
    return {
      output: state.output,
      truncated: state.truncated,
      ...state.exitStatus === null ? {} : { exitStatus: state.exitStatus }
    };
  };
  const waitForExit = async (params) => ({
    ...await terminalFor(terminals, params).exited
  });
  const kill = (params) => {
    const state = terminalFor(terminals, params);
    if (state.exitStatus === null) {
      state.child.kill("SIGTERM");
    }
    return {};
  };
  const release = async (params) => {
    const state = terminalFor(terminals, params);
    terminals.delete(state.terminalId);
    await stopTerminal(state);
    return {};
  };
  return {
    create,
    output,
    waitForExit,
    kill,
    release,
    async dispose() {
      const active = [...terminals.values()];
      terminals.clear();
      await Promise.all(active.map(async (state) => {
        await stopTerminal(state);
      }));
    }
  };
}

// ../../node_modules/.pnpm/@botiverse+oar@0.0.7_@modelcontextprotocol+sdk@1.29.0_zod@4.3.6__ws@8.20.0_zod@4.3.6/node_modules/@botiverse/oar/dist/shared/acp/session.js
function ignoreUpdate(_notification) {
}
function acpSession(profile) {
  return async (installation, options) => {
    if (installation.via !== "executable") {
      throw new Error("ACP runtimes require an executable installation");
    }
    profile.validateOptions?.(options);
    const args = typeof profile.args === "function" ? profile.args(options) : profile.args;
    const environment = { ...process.env, ...options.env };
    const terminalHost = createAcpTerminalHost(options.cwd, environment, {
      shellCommand: profile.terminalShellCommand === true
    });
    let receiveUpdate = ignoreUpdate;
    const runtime = startAcpProcess(installation.command, args, createAcpClientApp(terminalHost, (notification) => {
      receiveUpdate(notification);
    }), {
      cwd: options.cwd,
      env: environment
    });
    const opened = await openAcpSession(runtime, profile, options).catch(async (error) => {
      runtime.kill();
      await runtime.exited;
      await terminalHost.dispose();
      throw error;
    });
    const capabilities = asRecord(opened.initialized.agentCapabilities);
    const sessionCapabilities = asRecord(capabilities?.sessionCapabilities);
    const supportsClose = hasAcpCapability(sessionCapabilities?.close);
    const kernel = createSessionKernel(opened.sessionId);
    const held = [];
    let active = null;
    let contextUsage = null;
    let nextRequest = 0;
    let disposed = false;
    let dead = false;
    const settle = (state, outcome) => {
      if (state.kernelTurn.settled()) {
        return;
      }
      for (const body of finishAcpTools(state.projection)) {
        state.kernelTurn.emit(body);
      }
      state.kernelTurn.settle(outcome);
      if (active === state) {
        active = null;
      }
      queueMicrotask(drainHeld);
    };
    const failHeld = () => {
      while (held.length > 0) {
        held.shift();
        kernel.begin()?.settle({
          kind: "failed",
          reason: "ACP process exited before queued input could run",
          failure: "runtime_exited"
        });
      }
    };
    receiveUpdate = (notification) => {
      if (notification.sessionId !== opened.sessionId) {
        return;
      }
      const update = asRecord(notification.update);
      if (update === null) {
        return;
      }
      const state = active;
      const projected = projectAcpUpdate(state?.projection ?? createAcpProjectionState(), update);
      contextUsage = projected.contextUsage ?? contextUsage;
      if (state !== null && !state.kernelTurn.settled()) {
        for (const body of projected.bodies) {
          state.kernelTurn.emit(body);
        }
      }
    };
    const finishRequest = (state, requestNumber, outcome) => {
      if (state.kernelTurn.settled()) {
        return;
      }
      state.pending.delete(requestNumber);
      state.outcomes.set(requestNumber, outcome);
      if (state.pending.size === 0) {
        settle(state, state.outcomes.get(state.latestRequest) ?? outcome);
      }
    };
    const startVendorPrompt = (state, input, extraParams = {}) => {
      nextRequest += 1;
      const requestNumber = nextRequest;
      state.latestRequest = requestNumber;
      state.pending.add(requestNumber);
      void (async () => {
        try {
          const result = await promptAcp(runtime, opened.sessionId, input, extraParams);
          contextUsage = profile.promptContextUsage?.(result) ?? contextUsage;
          finishRequest(state, requestNumber, profile.promptOutcome?.(result) ?? defaultAcpPromptOutcome(result));
        } catch (error) {
          const outcome = state.abortRequested && !(error instanceof AcpError && error.kind === "process_exited") ? { kind: "aborted" } : acpFailureOutcome(error);
          finishRequest(state, requestNumber, outcome);
        }
      })();
    };
    const makeTurn = (state) => {
      const steerParams = profile.steerParams;
      return {
        id: state.kernelTurn.id,
        outcome: state.kernelTurn.outcome,
        abort: async () => {
          if (state.kernelTurn.settled()) {
            return;
          }
          if (!state.abortRequested) {
            state.abortRequested = true;
            try {
              await runtime.connection.agent.notify(methods.agent.session.cancel, { sessionId: opened.sessionId });
            } catch (error) {
              settle(state, acpFailureOutcome(error));
            }
          }
          const timeoutMs = profile.abortTimeoutMs ?? 1e4;
          const fallback = setTimeout(() => {
            if (!state.kernelTurn.settled()) {
              dead = true;
              settle(state, { kind: "aborted" });
              runtime.kill();
            }
          }, timeoutMs);
          fallback.unref();
          await state.kernelTurn.outcome;
          clearTimeout(fallback);
        },
        ...steerParams === void 0 ? {} : {
          steer: async (input) => {
            await runtime.spawned;
            if (state.kernelTurn.settled() || active !== state) {
              return {
                kind: "not_steerable",
                reason: "turn already ended"
              };
            }
            if (runtime.closed) {
              throw acpProcessExitedError(runtime.exitCode);
            }
            startVendorPrompt(state, input, steerParams(input));
            return { kind: "accepted" };
          }
        }
      };
    };
    const beginInput = (input) => {
      const kernelTurn = kernel.begin();
      if (kernelTurn === null) {
        return null;
      }
      const state = {
        kernelTurn,
        outcomes: /* @__PURE__ */ new Map(),
        pending: /* @__PURE__ */ new Set(),
        projection: createAcpProjectionState(),
        abortRequested: false,
        latestRequest: 0
      };
      active = state;
      if (dead || runtime.closed) {
        settle(state, acpRuntimeExitedOutcome(null));
      } else {
        startVendorPrompt(state, input);
      }
      return makeTurn(state);
    };
    function drainHeld() {
      if (disposed || active !== null) {
        return;
      }
      if (dead || runtime.closed) {
        failHeld();
        return;
      }
      const input = held.shift();
      if (input !== void 0) {
        beginInput(input);
      }
    }
    const onRuntimeExit = (code) => {
      void terminalHost.dispose();
      if (disposed) {
        return;
      }
      dead = true;
      if (active !== null) {
        settle(active, acpRuntimeExitedOutcome(code));
      }
      failHeld();
    };
    void runtime.exited.then(onRuntimeExit);
    return sealSession({
      id: kernel.sessionId,
      prompt(input) {
        const next = beginInput(input);
        return next === null ? { kind: "busy" } : { kind: "turn", turn: next };
      },
      subscribe: (observer) => kernel.subscribe(observer),
      contextUsage: () => contextUsage,
      queue: {
        durable: false,
        add: async (input) => {
          await runtime.spawned;
          if (disposed || dead || runtime.closed) {
            throw acpProcessExitedError(runtime.exitCode);
          }
          held.push(input);
          queueMicrotask(drainHeld);
        }
      },
      dispose: async () => {
        if (disposed) {
          return;
        }
        disposed = true;
        held.splice(0);
        if (active !== null && !active.kernelTurn.settled()) {
          try {
            await runtime.connection.agent.notify(methods.agent.session.cancel, { sessionId: opened.sessionId });
          } catch {
          }
          settle(active, { kind: "aborted" });
        }
        if (supportsClose && !runtime.closed) {
          await closeAcpSession(runtime, opened.sessionId).catch(() => {
          });
        }
        runtime.kill();
        await runtime.exited;
        await terminalHost.dispose();
      }
    });
  };
}

// ../../node_modules/.pnpm/@botiverse+oar@0.0.7_@modelcontextprotocol+sdk@1.29.0_zod@4.3.6__ws@8.20.0_zod@4.3.6/node_modules/@botiverse/oar/dist/runtimes/grok/session.js
function authMethodIds(initialized) {
  return (Array.isArray(initialized.authMethods) ? initialized.authMethods : []).map((method) => asRecord(method)).map((method) => method?.id).filter((id) => typeof id === "string");
}
function selectGrokAuthMethod(initialized) {
  const ids = authMethodIds(initialized);
  const preferred = asRecord(initialized._meta)?.defaultAuthMethodId;
  if (typeof preferred === "string" && ids.includes(preferred)) {
    return preferred;
  }
  return ids.includes("cached_token") ? "cached_token" : void 0;
}
function grokInitializeMeta(options) {
  return {
    clientIdentifier: "oar",
    clientType: "generic",
    startupHints: {
      nonInteractive: true,
      skipGitStatus: true,
      skipProjectLayout: true
    },
    ...options.systemPrompt === void 0 ? {} : { systemPromptOverride: options.systemPrompt },
    ...options.appendSystemPrompt === void 0 ? {} : { rules: options.appendSystemPrompt }
  };
}
function firstNumber(record2, names) {
  for (const name of names) {
    const value = asNumber(record2?.[name]);
    if (value !== null) {
      return value;
    }
  }
  return null;
}
function grokContextUsage(response) {
  const meta = asRecord(response._meta);
  const tokens = firstNumber(meta, ["totalTokens", "contextTokens"]);
  const contextWindow = firstNumber(meta, ["contextWindow", "context_window", "maxContextTokens"]);
  if (tokens === null && contextWindow === null) {
    return null;
  }
  const percent = tokens === null || contextWindow === null || contextWindow === 0 ? null : Math.round(tokens / contextWindow * 100);
  return { tokens, contextWindow, percent };
}
var grokAcpProfile = {
  args: ["agent", "--always-approve", "--no-leader", "stdio"],
  terminalShellCommand: true,
  initializeMeta: grokInitializeMeta,
  sessionMeta: () => ({ yoloMode: true }),
  selectAuthMethod: selectGrokAuthMethod,
  steerParams: () => ({ _meta: { sendNow: true } }),
  promptContextUsage: grokContextUsage
};
var grokSession = acpSession(grokAcpProfile);

// ../../node_modules/.pnpm/@botiverse+oar@0.0.7_@modelcontextprotocol+sdk@1.29.0_zod@4.3.6__ws@8.20.0_zod@4.3.6/node_modules/@botiverse/oar/dist/runtimes/grok/account-usage.js
function centValue(value) {
  return asNumber(asRecord(value)?.val);
}
function resetInstant2(value) {
  if (typeof value !== "string") {
    return void 0;
  }
  return utcInstantFromDate(new Date(value)) ?? void 0;
}
function periodLabel(value) {
  if (typeof value !== "string") {
    return "Included usage";
  }
  const normalized = value.replace(/^USAGE_PERIOD_TYPE_/u, "").toLowerCase();
  return `${normalized.charAt(0).toUpperCase()}${normalized.slice(1)} included usage`;
}
function grokAccountEmail(result) {
  const email = asRecord(result)?.email;
  if (typeof email !== "string") {
    return void 0;
  }
  const trimmed = email.trim();
  return trimmed.length > 0 ? trimmed : void 0;
}
function projectGrokUsage(result, email) {
  const root = asRecord(result);
  const config = asRecord(root?.config);
  if (config === null) {
    return { kind: "unsupported" };
  }
  const explicitPercent = asNumber(config.creditUsagePercent);
  const used = centValue(config.used);
  const limit = centValue(config.monthlyLimit);
  const usedPercent = explicitPercent ?? (used !== null && limit !== null && limit > 0 ? used / limit * 100 : null);
  if (usedPercent === null || usedPercent < 0) {
    throw new Error("Grok returned no usable account usage percentage");
  }
  const period = asRecord(config.currentPeriod);
  const resetsAt = resetInstant2(period?.end ?? config.billingPeriodEnd);
  const prepaidBalance = Math.abs(centValue(config.prepaidBalance) ?? 0);
  const onDemandCap = centValue(config.onDemandCap) ?? 0;
  const legacyOnDemandUsed = used !== null && limit !== null ? Math.max(0, used - limit) : 0;
  const onDemandUsed = centValue(config.onDemandUsed) ?? legacyOnDemandUsed;
  const onDemandRatio = onDemandCap > 0 ? Math.max(0, Math.min(1, onDemandUsed / onDemandCap)) : null;
  const windows = [{
    label: periodLabel(period?.type),
    usedRatio: Number(Math.min(1, usedPercent / 100).toFixed(6)),
    ...resetsAt === void 0 ? {} : { resetsAt }
  }, ...onDemandRatio === null ? [] : [{
    label: "Pay-as-you-go",
    usedRatio: Number(onDemandRatio.toFixed(6)),
    ...resetsAt === void 0 ? {} : { resetsAt }
  }]];
  const rawPlan = root?.subscription_tier ?? root?.subscriptionTier;
  const plan = typeof rawPlan === "string" && rawPlan.trim().length > 0 ? rawPlan.trim() : void 0;
  const rateLimited = usedPercent >= 100 && prepaidBalance === 0 && (onDemandRatio === null || onDemandRatio >= 1);
  return {
    kind: "available",
    ...plan === void 0 ? {} : { plan },
    ...email === void 0 ? {} : { email },
    rateLimited,
    windows
  };
}
async function readBilling(command, timeoutMs) {
  const runtime = startAcpProcess(command, ["agent", "--always-approve", "--no-leader", "stdio"], client({ name: "oar" }), { env: process.env });
  try {
    const initialize2 = methods.agent.initialize;
    const response = await withAcpDeadline(runtime, initialize2, timeoutMs, (requestOptions) => runtime.connection.agent.request(initialize2, {
      protocolVersion: PROTOCOL_VERSION,
      clientCapabilities: {
        fs: { readTextFile: false, writeTextFile: false },
        terminal: false
      },
      clientInfo: { name: "oar", version: "0.0.0" },
      _meta: grokInitializeMeta({ cwd: process.cwd() })
    }, requestOptions));
    const initialized = asRecord(response) ?? {};
    const method = selectGrokAuthMethod(initialized);
    if (method !== void 0) {
      const authenticate = methods.agent.authenticate;
      await withAcpDeadline(runtime, authenticate, timeoutMs, (requestOptions) => runtime.connection.agent.request(authenticate, { methodId: method }, requestOptions));
    }
    const billing = await withAcpDeadline(runtime, "_x.ai/billing", timeoutMs, (requestOptions) => runtime.connection.agent.request("_x.ai/billing", {}, requestOptions));
    let email = void 0;
    try {
      const authInfo = await withAcpDeadline(runtime, "_x.ai/auth/info", timeoutMs, (requestOptions) => runtime.connection.agent.request("_x.ai/auth/info", {}, requestOptions));
      email = grokAccountEmail(authInfo);
    } catch {
      email = void 0;
    }
    return { billing, ...email === void 0 ? {} : { email } };
  } finally {
    runtime.kill();
    await runtime.exited;
  }
}
var grokAccountUsage = async (installation, options = {}) => {
  if (installation.via !== "executable") {
    return { kind: "unsupported" };
  }
  try {
    const payload = await readBilling(installation.command, options.timeoutMs ?? 1e4);
    return projectGrokUsage(payload.billing, payload.email);
  } catch (error) {
    if (error instanceof RequestError) {
      if (error.code === -32601) {
        return { kind: "unsupported" };
      }
      if (error.code === -32e3 || /auth(?:entication)?|log(?:ged)? ?in/iu.test(error.message)) {
        return { kind: "reauth_required" };
      }
    }
    throw new Error("Failed to read Grok account usage", { cause: error });
  }
};

// ../../node_modules/.pnpm/@botiverse+oar@0.0.7_@modelcontextprotocol+sdk@1.29.0_zod@4.3.6__ws@8.20.0_zod@4.3.6/node_modules/@botiverse/oar/dist/runtimes/grok/installation.js
import { homedir as homedir2 } from "os";
import path3 from "path";
function grokInstalledExecutableCandidates(platform2 = process.platform, home = homedir2(), env = process.env) {
  const paths = platform2 === "win32" ? path3.win32 : path3.posix;
  const executable = platform2 === "win32" ? "grok.exe" : "grok";
  return [
    ...env.GROK_BIN_DIR === void 0 || env.GROK_BIN_DIR === "" ? [] : [paths.join(env.GROK_BIN_DIR, executable)],
    ...env.GROK_HOME === void 0 || env.GROK_HOME === "" ? [] : [paths.join(env.GROK_HOME, "bin", executable)],
    paths.join(home, ".grok", "bin", executable)
  ];
}
var grokInstallation = executableInstallation("OAR_GROK_BIN", "grok", grokInstalledExecutableCandidates, ["agent", "stdio", "--help"]);

// ../../node_modules/.pnpm/@botiverse+oar@0.0.7_@modelcontextprotocol+sdk@1.29.0_zod@4.3.6__ws@8.20.0_zod@4.3.6/node_modules/@botiverse/oar/dist/runtimes/grok/index.js
var grokRuntime = defineRuntime({
  id: "grok",
  installation: grokInstallation,
  accountUsage: grokAccountUsage,
  session: grokSession
});

// ../../node_modules/.pnpm/@botiverse+oar@0.0.7_@modelcontextprotocol+sdk@1.29.0_zod@4.3.6__ws@8.20.0_zod@4.3.6/node_modules/@botiverse/oar/dist/runtimes/kimi/auth-config.js
import { createHash } from "crypto";
import { homedir as homedir3 } from "os";
import { basename, join as join2 } from "path";
var MANAGED_PROVIDER = "managed:kimi-code";
var DEFAULT_BASE_URL = "https://api.kimi.com/coding/v1";
var DEFAULT_OAUTH_HOST = "https://auth.kimi.com";
var DEFAULT_OAUTH_KEY = "oauth/kimi-code";
function text2(value) {
  if (typeof value !== "string") {
    return void 0;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : void 0;
}
function normalizedEndpoint(value) {
  return value.trim().replace(/\/+$/u, "");
}
function oauthKey(oauthHost, baseUrl) {
  const normalizedHost = normalizedEndpoint(oauthHost);
  const normalizedBase = normalizedEndpoint(baseUrl);
  if (normalizedHost === DEFAULT_OAUTH_HOST && normalizedBase === DEFAULT_BASE_URL) {
    return DEFAULT_OAUTH_KEY;
  }
  const digest = createHash("sha256").update(JSON.stringify({ oauthHost: normalizedHost, baseUrl: normalizedBase })).digest("hex").slice(0, 16);
  return `oauth/kimi-code-env-${digest}`;
}
function storageName(key) {
  const prefix = "oauth/";
  const candidate = key.startsWith(prefix) ? key.slice(prefix.length) : key;
  if (candidate.length === 0 || candidate.startsWith(".") || basename(candidate) !== candidate) {
    throw new Error("Kimi returned an invalid OAuth credential key");
  }
  return candidate;
}
function kimiRemainingMs(deadline2) {
  const remaining = deadline2 - Date.now();
  if (remaining <= 0) {
    throw new Error("Kimi account usage timed out");
  }
  return remaining;
}
async function resolveKimiAuth(command, deadline2) {
  const result = await runExecutable(command, ["provider", "list", "--json"], {
    env: process.env,
    timeoutMs: kimiRemainingMs(deadline2)
  });
  if (!result.ok) {
    return null;
  }
  const root = asRecord(parseJson(result.stdout));
  const provider = asRecord(asRecord(root?.providers)?.[MANAGED_PROVIDER]);
  if (provider === null || provider.type !== "kimi") {
    return null;
  }
  const configuredOAuth = asRecord(provider.oauth);
  const envBaseUrl = text2(process.env.KIMI_CODE_BASE_URL);
  const envOAuthHost = text2(process.env.KIMI_CODE_OAUTH_HOST ?? process.env.KIMI_OAUTH_HOST);
  const hasEnvironmentOverride = envBaseUrl !== void 0 || envOAuthHost !== void 0;
  const baseUrl = normalizedEndpoint(envBaseUrl ?? text2(provider.baseUrl) ?? DEFAULT_BASE_URL);
  const oauthHost = normalizedEndpoint(envOAuthHost ?? text2(configuredOAuth?.oauthHost) ?? DEFAULT_OAUTH_HOST);
  const expectedKey = oauthKey(oauthHost, baseUrl);
  const configuredKey = text2(configuredOAuth?.key);
  const selectedKey = !hasEnvironmentOverride && configuredKey === expectedKey ? configuredKey : expectedKey;
  const configuredStorage = text2(configuredOAuth?.storage);
  const selectedStorage = !hasEnvironmentOverride && configuredKey === expectedKey && configuredStorage !== void 0 && configuredStorage !== "file" ? "other" : "file";
  const home = text2(process.env.KIMI_CODE_HOME) ?? join2(homedir3(), ".kimi-code");
  const selectedStorageName = storageName(selectedKey);
  return {
    baseUrl,
    oauthHost,
    storage: selectedStorage,
    storageName: selectedStorageName,
    home,
    credentialPath: join2(home, "credentials", `${selectedStorageName}.json`)
  };
}

// ../../node_modules/.pnpm/@botiverse+oar@0.0.7_@modelcontextprotocol+sdk@1.29.0_zod@4.3.6__ws@8.20.0_zod@4.3.6/node_modules/@botiverse/oar/dist/runtimes/kimi/oauth-token.js
import { readFile } from "fs/promises";
var KimiReauthError = class extends Error {
  constructor(message) {
    super(message);
    this.name = "KimiReauthError";
  }
};
function text3(value) {
  if (typeof value !== "string") {
    return void 0;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : void 0;
}
async function storedKimiAccessToken(auth) {
  const accessToken = await readAccessToken(auth.credentialPath);
  if (accessToken === void 0) {
    throw new KimiReauthError("No Kimi OAuth token is stored");
  }
  return accessToken;
}
async function readAccessToken(path5) {
  try {
    const raw = await readFile(path5, "utf8");
    return text3(asRecord(parseJson(raw))?.access_token);
  } catch {
    return void 0;
  }
}

// ../../node_modules/.pnpm/@botiverse+oar@0.0.7_@modelcontextprotocol+sdk@1.29.0_zod@4.3.6__ws@8.20.0_zod@4.3.6/node_modules/@botiverse/oar/dist/runtimes/kimi/account-usage.js
function text4(value) {
  if (typeof value !== "string") {
    return void 0;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : void 0;
}
function numeric(value) {
  if (typeof value === "string") {
    const parsed2 = Number(value);
    return Number.isFinite(parsed2) ? Math.trunc(parsed2) : null;
  }
  const parsed = asNumber(value);
  return parsed === null ? null : Math.trunc(parsed);
}
function resetInstant3(value) {
  if (typeof value !== "string") {
    return void 0;
  }
  return utcInstantFromDate(new Date(value)) ?? void 0;
}
function usageUnit(value) {
  switch (value) {
    case "TIME_UNIT_MINUTE":
      return "minute";
    case "TIME_UNIT_HOUR":
      return "hour";
    case "TIME_UNIT_DAY":
      return "day";
    case "TIME_UNIT_WEEK":
      return "week";
    default:
      return void 0;
  }
}
function usageWindow(value) {
  const record2 = asRecord(value);
  const duration = numeric(record2?.duration);
  const unit = usageUnit(record2?.timeUnit);
  if (duration === null || duration <= 0 || unit === void 0) {
    return void 0;
  }
  if (unit === "minute" && duration >= 60 && duration % 60 === 0) {
    return { duration: duration / 60, unit: "hour" };
  }
  return { duration, unit };
}
function usageRow(value, extra = {}) {
  const record2 = asRecord(value);
  const used = numeric(record2?.used);
  const limit = numeric(record2?.limit);
  if (used === null && limit === null) {
    return null;
  }
  const name = extra.name ?? text4(record2?.name);
  const resetsAt = resetInstant3(record2?.resetTime);
  return {
    ...name === void 0 ? {} : { name },
    ...extra.window === void 0 ? {} : { window: extra.window },
    used: used ?? 0,
    limit: limit ?? 0,
    ...resetsAt === void 0 ? {} : { resetsAt }
  };
}
function usageLabel(row) {
  const window = row.window;
  if (window !== void 0) {
    if (window.unit === "week") {
      return "Weekly limit";
    }
    return `${window.duration}${window.unit.charAt(0)} limit`;
  }
  return row.name ?? "Limit";
}
function projectWindow(row) {
  if (row.limit <= 0 || row.used < 0) {
    return null;
  }
  return {
    label: usageLabel(row),
    usedRatio: Number(Math.max(0, Math.min(1, row.used / row.limit)).toFixed(6)),
    ...row.resetsAt === void 0 ? {} : { resetsAt: row.resetsAt }
  };
}
function moneyCents(value) {
  const cents = numeric(asRecord(value)?.priceInCents);
  return cents === null || cents < 0 ? null : cents;
}
function boosterWallet(value) {
  const record2 = asRecord(value);
  const balance = asRecord(record2?.balance);
  const total = numeric(balance?.amount);
  if (balance?.type !== "BOOSTER" || total === null || total <= 0) {
    return null;
  }
  const amountLeft = numeric(balance.amountLeft) ?? 0;
  const limit = record2?.monthlyChargeLimitEnabled === true ? moneyCents(record2.monthlyChargeLimit) : null;
  return {
    balance: Math.max(0, amountLeft),
    monthlyLimit: limit !== null && limit > 0 ? limit : null,
    monthlyUsed: moneyCents(record2?.monthlyUsed) ?? 0
  };
}
function kimiAccountEmail(payload) {
  const profile = asRecord(payload);
  return text4(profile?.user_id) === void 0 ? void 0 : text4(profile?.email);
}
function kimiAccountPlan(payload) {
  const profile = asRecord(payload);
  return text4(profile?.user_id) === void 0 ? void 0 : text4(profile?.user_level_name);
}
function projectKimiUsage(payload, email, plan) {
  const root = asRecord(payload);
  const rows = [];
  const summary = usageRow(root?.usage, { window: { duration: 1, unit: "week" } });
  if (summary !== null) {
    rows.push(summary);
  }
  const limits = root?.limits;
  if (Array.isArray(limits)) {
    for (const value of limits) {
      const limit = asRecord(value);
      const name = text4(limit?.name);
      const window = usageWindow(limit?.window);
      const row = usageRow(limit?.detail, {
        ...name === void 0 ? {} : { name },
        ...window === void 0 ? {} : { window }
      });
      if (row !== null) {
        rows.push(row);
      }
    }
  }
  const windows = rows.map((row) => projectWindow(row)).filter((window) => window !== null);
  const extraUsage = boosterWallet(root?.boosterWallet);
  if (extraUsage?.monthlyLimit !== null && extraUsage?.monthlyLimit !== void 0) {
    windows.push({
      label: "Extra Usage monthly limit",
      usedRatio: Number(Math.min(1, extraUsage.monthlyUsed / extraUsage.monthlyLimit).toFixed(6))
    });
  }
  const extraUsageHeadroom = extraUsage !== null && extraUsage.balance > 0 && (extraUsage.monthlyLimit === null || extraUsage.monthlyUsed < extraUsage.monthlyLimit);
  return {
    kind: "available",
    ...plan === void 0 ? {} : { plan },
    ...email === void 0 ? {} : { email },
    rateLimited: rows.some((row) => projectWindow(row)?.usedRatio === 1) && !extraUsageHeadroom,
    windows
  };
}
async function fetchUsage2(auth, accessToken, deadline2) {
  try {
    return await fetch(`${auth.baseUrl}/usages`, {
      headers: {
        "Authorization": `Bearer ${accessToken}`,
        "Accept": "application/json"
      },
      signal: AbortSignal.timeout(kimiRemainingMs(deadline2))
    });
  } catch (error) {
    throw new Error("Failed to reach Kimi usage endpoint", { cause: error });
  }
}
async function fetchAccountIdentity(auth, accessToken, deadline2) {
  try {
    const response = await fetch(`${auth.baseUrl}/me`, {
      headers: {
        "Authorization": `Bearer ${accessToken}`,
        "Accept": "application/json"
      },
      signal: AbortSignal.timeout(kimiRemainingMs(deadline2))
    });
    if (!response.ok) {
      return {};
    }
    const profile = parseJson(await response.text());
    const email = kimiAccountEmail(profile);
    const plan = kimiAccountPlan(profile);
    return {
      ...email === void 0 ? {} : { email },
      ...plan === void 0 ? {} : { plan }
    };
  } catch {
    return {};
  }
}
var kimiAccountUsage = async (installation, options = {}) => {
  if (installation.via !== "executable") {
    return { kind: "unsupported" };
  }
  const deadline2 = Date.now() + (options.timeoutMs ?? 3e4);
  const auth = await resolveKimiAuth(installation.command, deadline2);
  if (auth === null || auth.storage !== "file") {
    return { kind: "unsupported" };
  }
  try {
    const accessToken = await storedKimiAccessToken(auth);
    const [response, identity] = await Promise.all([
      fetchUsage2(auth, accessToken, deadline2),
      fetchAccountIdentity(auth, accessToken, deadline2)
    ]);
    if (response.status === 401 || response.status === 403) {
      return { kind: "reauth_required" };
    }
    if (response.status === 404) {
      return { kind: "unsupported" };
    }
    if (!response.ok) {
      throw new Error(`Kimi usage endpoint returned HTTP ${response.status}`);
    }
    return projectKimiUsage(parseJson(await response.text()), identity.email, identity.plan);
  } catch (error) {
    if (error instanceof KimiReauthError) {
      return { kind: "reauth_required" };
    }
    throw new Error("Failed to read Kimi account usage", { cause: error });
  }
};

// ../../node_modules/.pnpm/@botiverse+oar@0.0.7_@modelcontextprotocol+sdk@1.29.0_zod@4.3.6__ws@8.20.0_zod@4.3.6/node_modules/@botiverse/oar/dist/runtimes/kimi/installation.js
import { homedir as homedir4 } from "os";
import path4 from "path";
function kimiInstalledExecutableCandidates(platform2 = process.platform, home = homedir4(), env = process.env) {
  const paths = platform2 === "win32" ? path4.win32 : path4.posix;
  const executable = platform2 === "win32" ? "kimi.exe" : "kimi";
  return [
    ...env.KIMI_INSTALL_DIR === void 0 || env.KIMI_INSTALL_DIR === "" ? [] : [paths.join(env.KIMI_INSTALL_DIR, "bin", executable)],
    paths.join(home, ".kimi-code", "bin", executable),
    // Retain the previous command name only as the last compatibility fallback.
    "kimi-code"
  ];
}
var kimiInstallation = executableInstallation("OAR_KIMI_BIN", "kimi", kimiInstalledExecutableCandidates, ["acp", "--help"], { readinessTimeoutMs: 3e4, versionTimeoutMs: 3e4 });

// ../../node_modules/.pnpm/@botiverse+oar@0.0.7_@modelcontextprotocol+sdk@1.29.0_zod@4.3.6__ws@8.20.0_zod@4.3.6/node_modules/@botiverse/oar/dist/runtimes/kimi/session.js
function selectKimiAuthMethod(initialized) {
  const methods2 = Array.isArray(initialized.authMethods) ? initialized.authMethods : [];
  return methods2.map((method) => asRecord(method)).some((method) => method?.id === "login") ? "login" : void 0;
}
function supportsKimiYolo(response) {
  const modes = asRecord(response.modes);
  const availableModes = Array.isArray(modes?.availableModes) ? modes.availableModes : [];
  if (availableModes.map((mode2) => asRecord(mode2)).some((mode2) => mode2?.id === "yolo")) {
    return true;
  }
  const options = Array.isArray(response.configOptions) ? response.configOptions : [];
  const mode = options.map((option) => asRecord(option)).find((option) => option?.id === "mode");
  const values = Array.isArray(mode?.options) ? mode.options : [];
  return values.map((value) => asRecord(value)).some((option) => option?.value === "yolo");
}
function validateKimiOptions(options) {
  if (options.systemPrompt !== void 0 || options.appendSystemPrompt !== void 0) {
    throw new Error("Kimi ACP does not expose a system prompt override");
  }
}
var kimiAcpProfile = {
  args: ["acp"],
  requestTimeoutMs: 3e4,
  selectAuthMethod: selectKimiAuthMethod,
  validateOptions: validateKimiOptions,
  configureSession: async ({ connection, sessionId, response, requestOptions }) => {
    if (supportsKimiYolo(response)) {
      await connection.agent.request("session/set_mode", { sessionId, modeId: "yolo" }, requestOptions);
    }
  }
};
var kimiSession = acpSession(kimiAcpProfile);

// ../../node_modules/.pnpm/@botiverse+oar@0.0.7_@modelcontextprotocol+sdk@1.29.0_zod@4.3.6__ws@8.20.0_zod@4.3.6/node_modules/@botiverse/oar/dist/runtimes/kimi/index.js
var kimiRuntime = defineRuntime({
  id: "kimi",
  installation: kimiInstallation,
  accountUsage: kimiAccountUsage,
  session: kimiSession
});

// ../../node_modules/.pnpm/@botiverse+oar@0.0.7_@modelcontextprotocol+sdk@1.29.0_zod@4.3.6__ws@8.20.0_zod@4.3.6/node_modules/@botiverse/oar/dist/runtimes/pi/installation.js
var SDK_PACKAGE = "@earendil-works/pi-coding-agent";
async function sdkLoads() {
  try {
    await import(SDK_PACKAGE);
    return true;
  } catch {
    return false;
  }
}
var piInstallation = async () => {
  const resolvable = (() => {
    try {
      import.meta.resolve(SDK_PACKAGE);
      return true;
    } catch {
      return false;
    }
  })();
  if (resolvable || await sdkLoads()) {
    return { kind: "available", via: "bundled" };
  }
  return { kind: "not_found" };
};

// ../../node_modules/.pnpm/@botiverse+oar@0.0.7_@modelcontextprotocol+sdk@1.29.0_zod@4.3.6__ws@8.20.0_zod@4.3.6/node_modules/@botiverse/oar/dist/runtimes/pi/projection.js
var initialPiProjection = {
  inTurn: false,
  adopted: false,
  abortRequested: false,
  reasoningHadText: false,
  providerError: void 0
};
function piPrompted() {
  return { ...initialPiProjection, inTurn: true };
}
function piAbortRequested(state) {
  return { ...state, abortRequested: true };
}
function piSettledOutcome(state) {
  if (state.abortRequested) {
    return { kind: "aborted" };
  }
  if (state.providerError !== void 0) {
    return { kind: "failed", reason: state.providerError, failure: classifyFailure(state.providerError) };
  }
  return { kind: "completed" };
}
var drop = (state) => ({ state, commands: [] });
var emit = (state, body) => ({ state, commands: [{ kind: "emit", body }] });
function foldMessageUpdate(state, inner) {
  switch (inner.type) {
    case "text_delta":
      return emit(state, { kind: "text_delta", text: inner.delta });
    case "thinking_delta":
      return inner.delta.length > 0 ? emit({ ...state, reasoningHadText: true }, { kind: "reasoning", content: { kind: "text", text: inner.delta } }) : drop(state);
    case "error":
      return drop({ ...state, providerError: inner.error.errorMessage ?? inner.reason });
    case "thinking_start":
      return drop({ ...state, reasoningHadText: false });
    case "thinking_end":
      return state.reasoningHadText ? drop(state) : emit(state, { kind: "reasoning", content: { kind: "empty" } });
    // Explicitly dropped: block boundaries and toolcall framing carry no v1
    // turn event (toolcalls arrive via the outer tool_execution_* events).
    case "start":
    case "done":
    case "text_start":
    case "text_end":
    case "toolcall_start":
    case "toolcall_delta":
    case "toolcall_end":
      return drop(state);
  }
  return drop(state);
}
function foldPiEvent(state, event) {
  if (event.type === "agent_start") {
    return state.inTurn ? drop(state) : { state: { ...piPrompted(), adopted: true }, commands: [{ kind: "begin" }] };
  }
  if (!state.inTurn) {
    return drop(state);
  }
  switch (event.type) {
    case "agent_end":
      return state.adopted ? { state: initialPiProjection, commands: [{ kind: "settle", outcome: piSettledOutcome(state) }] } : { state: { ...state, inTurn: false }, commands: [] };
    case "message_update":
      return foldMessageUpdate(state, event.assistantMessageEvent);
    case "tool_execution_start":
      return emit(state, { kind: "tool_call_started", callId: event.toolCallId, tool: event.toolName });
    case "tool_execution_end":
      return emit(state, { kind: "tool_call_ended", callId: event.toolCallId });
    case "turn_end":
      return event.message.role === "assistant" && event.message.stopReason === "error" ? drop({ ...state, providerError: event.message.errorMessage ?? "provider error" }) : drop(state);
    // Explicitly dropped: session-scoped events with no turn mapping in v1 (an
    // exhaustive switch makes a NEW pi event type a compile error, forcing a
    // conscious mapped-or-dropped decision on each future addition).
    case "agent_settled":
    case "turn_start":
    case "message_start":
    case "message_end":
    case "tool_execution_update":
    case "bash_execution_update":
    case "compaction_start":
    case "compaction_end":
    case "queue_update":
    case "entry_appended":
    case "session_info_changed":
    case "thinking_level_changed":
    case "auto_retry_start":
    case "auto_retry_end":
    case "summarization_retry_scheduled":
    case "summarization_retry_attempt_start":
    case "summarization_retry_finished":
      return drop(state);
  }
  return drop(state);
}

// ../../node_modules/.pnpm/@botiverse+oar@0.0.7_@modelcontextprotocol+sdk@1.29.0_zod@4.3.6__ws@8.20.0_zod@4.3.6/node_modules/@botiverse/oar/dist/runtimes/pi/session.js
async function piEnvBashTool(cwd, overlay) {
  const sdk = await import("./dist-2TFDXX4L.js");
  return sdk.defineTool(sdk.createBashToolDefinition(cwd, {
    spawnHook: (context) => ({ ...context, env: { ...context.env, ...overlay } })
  }));
}
var piSession = async (installation, options) => {
  if (installation.via !== "bundled") {
    throw new Error("The pi session adapter needs the bundled sdk installation");
  }
  if (options.resume !== void 0) {
    throw new Error("pi session resume is not implemented yet");
  }
  const sdk = await import("./dist-2TFDXX4L.js");
  const overlay = options.env;
  const agentDir = process.env.OAR_PI_AGENT_DIR;
  new sdk.ProjectTrustStore(agentDir ?? sdk.getAgentDir()).set(options.cwd, true);
  const wantsSystemPrompt = options.systemPrompt !== void 0 || options.appendSystemPrompt !== void 0;
  const resourceLoader = wantsSystemPrompt ? new sdk.DefaultResourceLoader({
    cwd: options.cwd,
    agentDir: agentDir ?? sdk.getAgentDir(),
    ...options.systemPrompt === void 0 ? {} : { systemPrompt: options.systemPrompt },
    ...options.appendSystemPrompt === void 0 ? {} : { appendSystemPrompt: [options.appendSystemPrompt] }
  }) : void 0;
  await resourceLoader?.reload();
  const { session: piAgentSession } = await sdk.createAgentSession({
    cwd: options.cwd,
    ...agentDir === void 0 ? {} : { agentDir },
    ...resourceLoader === void 0 ? {} : { resourceLoader },
    ...overlay === void 0 ? {} : { customTools: [await piEnvBashTool(options.cwd, overlay)] }
  });
  const kernel = createSessionKernel(piAgentSession.sessionId);
  let currentTurn = null;
  let projection = initialPiProjection;
  let disposed = false;
  const held = [];
  const drainHeld = () => {
    if (disposed || kernel.active() !== null) {
      return;
    }
    const next = held.shift();
    if (next === void 0) {
      return;
    }
    void (async () => {
      try {
        await piAgentSession.prompt(next);
      } catch (error) {
        const reason = error instanceof Error ? error.message : "queued prompt failed";
        kernel.begin()?.settle({ kind: "failed", reason, failure: classifyFailure(reason) });
      }
    })();
  };
  piAgentSession.subscribe((event) => {
    const { state: nextProjection, commands } = foldPiEvent(projection, event);
    projection = nextProjection;
    for (const command of commands) {
      switch (command.kind) {
        case "begin":
          currentTurn = kernel.begin();
          break;
        case "emit":
          currentTurn?.emit(command.body);
          break;
        case "settle":
          currentTurn?.settle(command.outcome);
          currentTurn = null;
          drainHeld();
          break;
        default:
          break;
      }
    }
  });
  const makeTurn = (turn) => ({
    id: turn.id,
    outcome: turn.outcome,
    abort: async () => {
      if (turn.settled()) {
        return;
      }
      projection = piAbortRequested(projection);
      await piAgentSession.abort();
      await turn.outcome;
    },
    steer: async (input) => {
      if (turn.settled()) {
        return { kind: "not_steerable", reason: "turn already ended" };
      }
      await piAgentSession.steer(input);
      return { kind: "accepted" };
    }
  });
  const session = sealSession({
    id: kernel.sessionId,
    prompt(input) {
      const turn = kernel.begin();
      if (turn === null) {
        return { kind: "busy" };
      }
      currentTurn = turn;
      projection = piPrompted();
      void (async () => {
        try {
          await piAgentSession.prompt(input);
          turn.settle(piSettledOutcome(projection));
        } catch (error) {
          const reason = error instanceof Error ? error.message : "pi prompt failed";
          turn.settle({ kind: "failed", reason, failure: classifyFailure(reason) });
        }
        projection = initialPiProjection;
        currentTurn = null;
        drainHeld();
      })();
      return { kind: "turn", turn: makeTurn(turn) };
    },
    subscribe: (observer) => kernel.subscribe(observer),
    contextUsage: () => {
      const usage = piAgentSession.getContextUsage();
      return usage === void 0 ? null : { tokens: usage.tokens, contextWindow: usage.contextWindow, percent: usage.percent };
    },
    queue: {
      durable: false,
      add: async (input) => {
        await Promise.resolve();
        held.push(input);
        drainHeld();
      }
    },
    dispose: async () => {
      if (disposed) {
        return;
      }
      disposed = true;
      const active = kernel.active();
      if (active !== null) {
        await piAgentSession.abort();
        active.settle({ kind: "aborted" });
      }
      piAgentSession.dispose();
    }
  });
  return session;
};

// ../../node_modules/.pnpm/@botiverse+oar@0.0.7_@modelcontextprotocol+sdk@1.29.0_zod@4.3.6__ws@8.20.0_zod@4.3.6/node_modules/@botiverse/oar/dist/runtimes/pi/index.js
var piRuntime = defineRuntime({
  id: "pi",
  installation: piInstallation,
  session: piSession
});

// ../../node_modules/.pnpm/@botiverse+oar@0.0.7_@modelcontextprotocol+sdk@1.29.0_zod@4.3.6__ws@8.20.0_zod@4.3.6/node_modules/@botiverse/oar/dist/voyage.js
import { closeSync, openSync, writeSync } from "fs";
var VOYAGE_FORMAT = "oar-voyage/1";
function headerLine(header) {
  return JSON.stringify({
    kind: "header",
    format: VOYAGE_FORMAT,
    runtime: header.runtime,
    ...header.model === void 0 ? {} : { model: header.model },
    cwd: header.cwd,
    sessionId: header.sessionId,
    startedAt: header.startedAt,
    recorder: header.recorder
  });
}
function submissionLine(at, via, text5) {
  return JSON.stringify({ kind: "submission", at, via, text: text5 });
}
function eventLine(event) {
  return JSON.stringify({ kind: "event", event });
}
function endLine(at, reason) {
  return JSON.stringify({ kind: "end", at, reason });
}
function openVoyage(path5, header) {
  const fd = openSync(path5, "w");
  const write = (line) => {
    writeSync(fd, `${line}
`);
  };
  write(headerLine(header));
  return {
    submission(via, text5) {
      write(submissionLine(Date.now(), via, text5));
    },
    event(event) {
      write(eventLine(event));
    },
    end(reason) {
      write(endLine(Date.now(), reason));
      closeSync(fd);
    }
  };
}

// ../../node_modules/.pnpm/@botiverse+oar@0.0.7_@modelcontextprotocol+sdk@1.29.0_zod@4.3.6__ws@8.20.0_zod@4.3.6/node_modules/@botiverse/oar/dist/observe/aggregate-events.js
function textOf(event) {
  if (event.kind === "text_delta") {
    return event.text;
  }
  return event.kind === "reasoning" && event.content.kind === "text" ? event.content.text : null;
}
function withText(event, text5) {
  if (event.kind === "reasoning") {
    return { ...event, content: { kind: "text", text: text5 } };
  }
  if (event.kind === "text_delta") {
    return { ...event, text: text5 };
  }
  return event;
}
function aggregateDeltas(observer, options = {}) {
  let held = null;
  let holdTimer = null;
  const flush = () => {
    if (holdTimer !== null) {
      clearTimeout(holdTimer);
      holdTimer = null;
    }
    if (held !== null) {
      const event = held;
      held = null;
      observer(event);
    }
  };
  const armHoldTimer = () => {
    if (options.maxHoldMs === void 0) {
      return;
    }
    if (holdTimer !== null) {
      clearTimeout(holdTimer);
    }
    holdTimer = setTimeout(flush, options.maxHoldMs);
  };
  return (event) => {
    const text5 = textOf(event);
    if (text5 !== null) {
      const previousText = held === null ? null : textOf(held);
      if (held !== null && previousText !== null && held.kind === event.kind && held.turnId === event.turnId) {
        held = withText(event, `${previousText}${text5}`);
        armHoldTimer();
        return;
      }
      flush();
      held = event;
      armHoldTimer();
      return;
    }
    flush();
    observer(event);
  };
}

// ../../node_modules/.pnpm/@botiverse+oar@0.0.7_@modelcontextprotocol+sdk@1.29.0_zod@4.3.6__ws@8.20.0_zod@4.3.6/node_modules/@botiverse/oar/dist/observe/agent-status.js
var initialStatus = { kind: "idle" };
function running(event, phase) {
  return { kind: "running", turnId: event.turnId, phase, lastEventAt: event.receivedAt };
}
function reduceStatus(previous, event) {
  switch (event.kind) {
    case "turn_started":
      return running(event, "waiting_model");
    case "reasoning":
      return running(event, "thinking");
    case "text_delta":
      return running(event, "responding");
    case "tool_call_started":
      return running(event, { tool: event.tool, callId: event.callId });
    case "tool_call_ended":
      return running(event, "waiting_model");
    case "turn_ended":
      return { kind: "idle", lastTurnOutcome: event.outcome };
    default:
      return previous;
  }
}
function stallOf(status, nowMs, thresholdMs) {
  if (status.kind !== "running") {
    return null;
  }
  const silentForMs = nowMs - status.lastEventAt;
  return silentForMs >= thresholdMs ? { turnId: status.turnId, silentForMs } : null;
}

// ../../node_modules/.pnpm/@botiverse+oar@0.0.7_@modelcontextprotocol+sdk@1.29.0_zod@4.3.6__ws@8.20.0_zod@4.3.6/node_modules/@botiverse/oar/dist/observe/stall-observer.js
function observeStalls(session, options) {
  let status = initialStatus;
  let lastEventKind = "";
  let timer = null;
  const disarm = () => {
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
  };
  const arm = () => {
    disarm();
    timer = setTimeout(() => {
      const stall = stallOf(status, Date.now(), options.stallAfterMs);
      if (stall !== null) {
        options.onStall({ ...stall, lastEventKind });
      }
    }, options.stallAfterMs);
  };
  const unsubscribe = session.subscribe((event) => {
    status = reduceStatus(status, event);
    lastEventKind = event.kind;
    if (status.kind === "running") {
      arm();
    } else {
      disarm();
    }
  });
  return () => {
    disarm();
    unsubscribe();
  };
}

// ../../node_modules/.pnpm/@botiverse+oar@0.0.7_@modelcontextprotocol+sdk@1.29.0_zod@4.3.6__ws@8.20.0_zod@4.3.6/node_modules/@botiverse/oar/dist/observe/observe-agent.js
function observeAgent(session, options) {
  const now = options.now ?? (() => Date.now());
  const listeners = /* @__PURE__ */ new Set();
  let status = initialStatus;
  let lastStalled = false;
  const view = () => ({ status, stall: stallOf(status, now(), options.stallAfterMs) });
  const push = () => {
    const current = view();
    lastStalled = current.stall !== null;
    for (const listener of listeners) {
      try {
        listener(current);
      } catch {
      }
    }
  };
  const unsubscribe = session.subscribe((event) => {
    status = reduceStatus(status, event);
    push();
  });
  const ticker = setInterval(() => {
    const stalledNow = stallOf(status, now(), options.stallAfterMs) !== null;
    if (stalledNow !== lastStalled) {
      push();
    }
  }, options.tickMs ?? 1e3);
  return {
    subscribe(listener) {
      listeners.add(listener);
      listener(view());
      return () => {
        listeners.delete(listener);
      };
    },
    dispose() {
      clearInterval(ticker);
      unsubscribe();
      listeners.clear();
    }
  };
}
function simpleStateOf(view) {
  if (view.stall !== null) {
    return "stuck";
  }
  if (view.status.kind === "running") {
    return "busy";
  }
  return view.status.lastTurnOutcome?.kind === "failed" ? "error" : "idle";
}

// ../../node_modules/.pnpm/@botiverse+oar@0.0.7_@modelcontextprotocol+sdk@1.29.0_zod@4.3.6__ws@8.20.0_zod@4.3.6/node_modules/@botiverse/oar/dist/observe/tool-activity.js
var BY_RUNTIME = {
  claude: {
    Bash: "run_command",
    Read: "read_file",
    Edit: "edit_file",
    Write: "edit_file",
    NotebookEdit: "edit_file",
    Grep: "search",
    Glob: "search",
    WebFetch: "web",
    WebSearch: "web"
  },
  codex: {
    commandExecution: "run_command",
    fileChange: "edit_file",
    webSearch: "web",
    mcpToolCall: "mcp"
  },
  pi: {
    bash: "run_command",
    read: "read_file",
    ls: "read_file",
    edit: "edit_file",
    write: "edit_file",
    grep: "search",
    find: "search"
  }
};
function kindOf(runtimeId, tool) {
  const runtime = runtimeId.replace(/-aimock$/u, "");
  const direct = BY_RUNTIME[runtime]?.[tool];
  if (direct !== void 0) {
    return direct;
  }
  if (tool.startsWith("mcp__")) {
    return "mcp";
  }
  return "other";
}
var FIRST_STRING_KEYS = ["command", "cmd", "path", "file_path", "filePath", "file", "pattern", "query", "url"];
function detailOf(inputJson) {
  if (inputJson === void 0) {
    return void 0;
  }
  const input = asRecord(parseJson(inputJson));
  if (input === null) {
    return void 0;
  }
  for (const key of FIRST_STRING_KEYS) {
    const value = input[key];
    if (typeof value === "string" && value.length > 0) {
      return value;
    }
    if (Array.isArray(value)) {
      const last = value.at(-1);
      if (typeof last === "string" && last.length > 0) {
        return last;
      }
    }
  }
  return void 0;
}
function classifyTool(runtimeId, tool, inputJson) {
  const kind = kindOf(runtimeId, tool);
  const detail2 = detailOf(inputJson) ?? (kind === "other" ? tool : void 0);
  return detail2 === void 0 ? { kind } : { kind, detail: detail2 };
}
var LABELS = {
  run_command: { running: "Running command", done: "Ran command", failed: "Command failed" },
  read_file: { running: "Reading file", done: "Read file", failed: "Read failed" },
  edit_file: { running: "Editing file", done: "Edited file", failed: "Edit failed" },
  search: { running: "Searching", done: "Searched", failed: "Search failed" },
  web: { running: "Searching the web", done: "Searched the web", failed: "Web request failed" },
  mcp: { running: "Using a tool", done: "Used a tool", failed: "Tool failed" },
  other: { running: "Working", done: "Done", failed: "Failed" }
};
function toolActionLabel(kind, state) {
  return LABELS[kind][state];
}

// ../../node_modules/.pnpm/@botiverse+oar@0.0.7_@modelcontextprotocol+sdk@1.29.0_zod@4.3.6__ws@8.20.0_zod@4.3.6/node_modules/@botiverse/oar/dist/runtimes/pi/auth.js
function toLoginEvent(event) {
  switch (event.type) {
    case "auth_url":
      return {
        kind: "auth_url",
        url: event.url,
        ...event.instructions === void 0 ? {} : { instructions: event.instructions }
      };
    case "device_code":
      return {
        kind: "device_code",
        userCode: event.userCode,
        verificationUri: event.verificationUri,
        ...event.intervalSeconds === void 0 ? {} : { intervalSeconds: event.intervalSeconds },
        ...event.expiresInSeconds === void 0 ? {} : { expiresInSeconds: event.expiresInSeconds }
      };
    case "info":
    case "progress":
      return { kind: "info", message: event.message };
  }
  throw new Error("unhandled Pi auth event");
}
function toLoginPrompt(prompt) {
  if (prompt.type === "select") {
    return {
      kind: "select",
      message: prompt.message,
      options: prompt.options.map((option) => ({
        id: option.id,
        label: option.label,
        ...option.description === void 0 ? {} : { description: option.description }
      }))
    };
  }
  return {
    kind: prompt.type,
    message: prompt.message,
    ...prompt.placeholder === void 0 ? {} : { placeholder: prompt.placeholder }
  };
}
function toPiInteraction(interaction) {
  return {
    ...interaction.signal === void 0 ? {} : { signal: interaction.signal },
    notify: (event) => {
      interaction.onEvent(toLoginEvent(event));
    },
    prompt: async (prompt) => {
      const answer = await interaction.prompt(toLoginPrompt(prompt));
      return answer;
    }
  };
}
function fixedAnswerInteraction(answer) {
  return {
    onEvent: () => {
    },
    prompt: async () => {
      await Promise.resolve();
      return answer;
    }
  };
}
var PiProviderAuth = class {
  #runtime;
  constructor(runtime) {
    this.#runtime = runtime;
  }
  async #statusOf(providerId) {
    const check = await this.#runtime.checkAuth(providerId);
    if (check === void 0) {
      return { providerId, configured: false };
    }
    const status = this.#runtime.getProviderAuthStatus(providerId);
    const label = status.label ?? check.source;
    return {
      providerId,
      configured: true,
      method: check.type === "oauth" ? "oauth" : "api_key",
      ...label === void 0 ? {} : { label },
      subscription: this.#runtime.isUsingSubscription(providerId)
    };
  }
  async listProviders() {
    const credentials = await this.#runtime.listCredentials();
    return Promise.all(credentials.map(async (credential) => {
      const status = await this.#statusOf(credential.providerId);
      return status;
    }));
  }
  async status(providerId) {
    const status = await this.#statusOf(providerId);
    return status;
  }
  async login(providerId, method, interaction) {
    const authType = method;
    await this.#runtime.login(providerId, authType, toPiInteraction(interaction));
    const status = await this.#statusOf(providerId);
    return status;
  }
  async setApiKey(providerId, apiKey) {
    const authType = "api_key";
    await this.#runtime.login(providerId, authType, toPiInteraction(fixedAnswerInteraction(apiKey)));
  }
  async logout(providerId) {
    await this.#runtime.logout(providerId);
  }
};
async function createPiProviderAuth(options = {}) {
  const runtime = await ModelRuntime.create({
    ...options.authPath === void 0 ? {} : { authPath: options.authPath },
    allowModelNetwork: false,
    refreshOnCreate: false
  });
  return new PiProviderAuth(runtime);
}

// ../../node_modules/.pnpm/@botiverse+oar@0.0.7_@modelcontextprotocol+sdk@1.29.0_zod@4.3.6__ws@8.20.0_zod@4.3.6/node_modules/@botiverse/oar/dist/runtimes/pi/catalog.js
function toCatalogModel(model) {
  return {
    id: model.id,
    providerId: model.provider,
    wire: model.api,
    baseUrl: model.baseUrl,
    contextWindow: model.contextWindow,
    maxTokens: model.maxTokens,
    reasoning: model.reasoning,
    input: [...model.input]
  };
}
var PiModelCatalog = class {
  #runtime;
  #registry;
  constructor(runtime) {
    this.#runtime = runtime;
    this.#registry = new ModelRegistry(runtime);
  }
  providers() {
    const ids = new Set(this.#registry.getAll().map((model) => model.provider));
    return [...ids].map((id) => ({
      id,
      name: this.#registry.getProviderDisplayName(id),
      configured: this.#registry.getProviderAuthStatus(id).configured
    }));
  }
  models(providerId) {
    const all = this.#registry.getAll();
    const scoped = providerId === void 0 ? all : all.filter((model) => model.provider === providerId);
    return scoped.map((model) => toCatalogModel(model));
  }
  defaultModel(providerId) {
    const resolved = resolveCliModel({ modelRuntime: this.#runtime, cliProvider: providerId });
    if (resolved.model !== void 0) {
      return resolved.model.id;
    }
    return this.#registry.getAll().find((model) => model.provider === providerId)?.id;
  }
  async refresh(options = {}) {
    const result = await this.#registry.refresh({
      allowNetwork: options.allowNetwork ?? true,
      ...options.providers === void 0 ? {} : { providers: options.providers },
      ...options.signal === void 0 ? {} : { signal: options.signal }
    });
    const errors = /* @__PURE__ */ new Map();
    for (const [providerId, error] of result.errors) {
      errors.set(providerId, error.message);
    }
    return { aborted: result.aborted, errors };
  }
};
async function createPiModelCatalog(options = {}) {
  const runtime = await ModelRuntime.create({
    ...options.authPath === void 0 ? {} : { authPath: options.authPath },
    ...options.modelsPath === void 0 ? {} : { modelsPath: options.modelsPath },
    refreshOnCreate: false
  });
  return new PiModelCatalog(runtime);
}

// ../../node_modules/.pnpm/@botiverse+oar@0.0.7_@modelcontextprotocol+sdk@1.29.0_zod@4.3.6__ws@8.20.0_zod@4.3.6/node_modules/@botiverse/oar/dist/index.js
var runtimes = new RuntimeRegistry([
  claudeRuntime,
  codexRuntime,
  grokRuntime,
  kimiRuntime,
  piRuntime
]);
export {
  RuntimeRegistry,
  VOYAGE_FORMAT,
  aggregateDeltas,
  classifyTool,
  claudeInstallation,
  claudeRuntime,
  claudeSession,
  codexInstallation,
  codexRuntime,
  codexSession,
  createPiModelCatalog,
  createPiProviderAuth,
  createRuntimeRegistry,
  defineRuntime,
  endLine,
  eventLine,
  grokInstallation,
  grokRuntime,
  grokSession,
  headerLine,
  initialStatus,
  kimiInstallation,
  kimiRuntime,
  kimiSession,
  observeAgent,
  observeStalls,
  openVoyage,
  piInstallation,
  piRuntime,
  piSession,
  reduceStatus,
  runtimes,
  simpleStateOf,
  stallOf,
  submissionLine,
  toolActionLabel,
  utcInstantFromDate
};
