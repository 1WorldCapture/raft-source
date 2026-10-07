import assert from "node:assert/strict";
import test from "node:test";
import {
  buildRuntimeConfig,
  runtimeApiUrlUnsupportedCopy,
  runtimeApiUrlUnsupportedCopyMessageId,
  supportsRuntimeApiUrl,
  supportsRuntimeCustomModelName,
  supportsRuntimeFastMode,
} from "../src/utils/runtimeConfigForm.js";

test("Cursor SDK picker keeps the selected live model and local-auth boundary", () => {
  assert.equal(supportsRuntimeApiUrl("cursor-sdk"), false);
  assert.equal(supportsRuntimeCustomModelName("cursor-sdk"), true);
  assert.equal(supportsRuntimeFastMode("cursor-sdk"), false);
  assert.equal(runtimeApiUrlUnsupportedCopy("cursor-sdk"), null);
  assert.equal(
    runtimeApiUrlUnsupportedCopyMessageId("cursor-sdk"),
    "agent.runtimeConfig.cursorSdkApiUrlUnsupported",
  );
  const config = buildRuntimeConfig({
    runtime: "cursor-sdk",
    model: "account-live-model",
    customModelMode: false,
    providerApiUrl: "https://ignored.invalid",
    providerApiKey: "fixture-only",
    envVars: { CURSOR_API_KEY: "fixture-only", TEAM_FLAG: "1" },
  });
  assert.equal(config.runtime, "cursor-sdk");
  assert.deepEqual(config.model, { kind: "preset", id: "account-live-model" });
  assert.equal(config.provider, undefined);
  assert.deepEqual(config.envVars, { TEAM_FLAG: "1" });
});
