import assert from "node:assert/strict";
import test from "node:test";
import {
  getCreatableRuntimeOptions,
  getDefaultModel,
  getExistingAgentRuntimeOptions,
  getStaticRuntimeModelSourceSet,
  hasStaticRuntimeModelSource,
  hydrateRuntimeConfig,
  parseRuntimeConfig,
  REASONING_EFFORT_RUNTIMES,
  RUNTIME_FAST_MODE_RUNTIMES,
  RUNTIMES,
  runtimeAvailabilitySuffix,
  runtimeConfigToLaunchFields,
  stripControlledRuntimeEnvVars,
} from "./index.js";

test("Cursor SDK is a Computer-provided runtime and the legacy Cursor CLI runtime is gone", () => {
  const sdk = RUNTIMES.find((runtime) => runtime.id === "cursor-sdk");
  assert.ok(sdk);
  assert.equal(sdk.binary, "");
  assert.equal(RUNTIMES.some((runtime) => runtime.id === "cursor"), false);
  assert.deepEqual(runtimeAvailabilitySuffix(sdk, []), { kind: "updateComputer" });
  assert.deepEqual(runtimeAvailabilitySuffix(sdk, ["cursor-sdk"]), { kind: "none" });
  assert.ok(getCreatableRuntimeOptions().some((runtime) => runtime.id === "cursor-sdk"));
  assert.equal(getCreatableRuntimeOptions().some((runtime) => runtime.id === "cursor"), false);
  assert.equal(getExistingAgentRuntimeOptions("cursor-sdk").some((runtime) => runtime.id === "cursor"), false);
});

test("Cursor SDK default seeds a model but never supplies a selectable offline catalog", () => {
  assert.equal(getDefaultModel("cursor-sdk"), "default");
  assert.equal(hasStaticRuntimeModelSource("cursor-sdk"), false);
  assert.equal(getStaticRuntimeModelSourceSet("cursor-sdk"), undefined);
});

test("Cursor SDK preserves host-discovered model ids", () => {
  const raw = {
    version: 1,
    runtime: "cursor-sdk",
    model: { kind: "preset", id: "account-discovered-model" },
    mode: { kind: "default" },
    reasoningEffort: null,
    envVars: null,
  };
  const parsed = parseRuntimeConfig({ runtime: "cursor-sdk", runtimeConfig: raw });
  assert.equal(parsed.ok, true);
  assert.equal(runtimeConfigToLaunchFields(parsed.config).model, "account-discovered-model");
});

test("Cursor SDK remote config cannot select credentials, backend or runtime assets", () => {
  const envVars = {
    CURSOR_API_KEY: "fixture-only",
    CURSOR_AUTH_TOKEN: "fixture-only",
    CURSOR_BACKEND_URL: "https://untrusted.invalid",
    CURSOR_API_BASE_URL: "https://untrusted.invalid",
    CURSOR_WEBSITE_URL: "https://untrusted.invalid",
    RAFT_CURSOR_SDK_ASSETS: "/untrusted/host",
    NODE_OPTIONS: "--require /untrusted/preload.cjs",
    NODE_PATH: "/untrusted/modules",
    NODE_TLS_REJECT_UNAUTHORIZED: "0",
    TEAM_FLAG: "enabled",
  };
  assert.deepEqual(stripControlledRuntimeEnvVars("cursor-sdk", envVars), { TEAM_FLAG: "enabled" });
  assert.equal(envVars.CURSOR_API_KEY, "fixture-only", "caller-owned env object is not mutated");
  assert.deepEqual(stripControlledRuntimeEnvVars("cursor", envVars), envVars, "legacy runtime remains unchanged");
  const hydrated = hydrateRuntimeConfig({ runtime: "cursor-sdk", model: "default", envVars });
  assert.deepEqual(runtimeConfigToLaunchFields(hydrated).envVars, { TEAM_FLAG: "enabled" });
});

test("Cursor SDK accepts reasoning effort and fast mode through the shared launch contract", () => {
  const parsed = parseRuntimeConfig({
    runtime: "cursor-sdk",
    runtimeConfig: {
      version: 1, runtime: "cursor-sdk", model: { kind: "preset", id: "claude-opus-5-5" },
      mode: { kind: "fast" }, reasoningEffort: "xhigh", envVars: null,
    },
  });
  assert.equal(parsed.ok, true);
  if (!parsed.ok) return;
  const fields = runtimeConfigToLaunchFields(parsed.config);
  assert.equal(fields.reasoningEffort, "xhigh");
  assert.deepEqual(fields.mode, { kind: "fast" });
  assert.equal(fields.model, "claude-opus-5-5");
  assert.ok(REASONING_EFFORT_RUNTIMES.has("cursor-sdk"));
  assert.ok(RUNTIME_FAST_MODE_RUNTIMES.has("cursor-sdk"));
  // The legacy Cursor CLI runtime keeps rejecting both.
  const legacy = parseRuntimeConfig({
    runtime: "cursor",
    runtimeConfig: { version: 1, runtime: "cursor", model: { kind: "preset", id: "composer-2" }, mode: { kind: "fast" }, reasoningEffort: null, envVars: null },
  });
  assert.equal(legacy.ok, false);
  assert.equal(REASONING_EFFORT_RUNTIMES.has("cursor"), false);
});
