import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "vitest";

/**
 * The Kimi, pi, OAR and MCP SDKs cost ~330MB of resident memory when loaded.
 * A daemon must not load them just to boot, detect runtimes and report ready;
 * they belong to the first launch/usage read that actually needs them.
 */
const HEAVY_PACKAGES = [
  "@cursor/sdk",
  "@botiverse/kimi-code-sdk",
  "@botiverse/oar",
  "@earendil-works/pi-coding-agent",
  "@earendil-works/pi-ai",
  "@modelcontextprotocol/sdk",
];

test("importing the daemon core and detecting runtimes loads none of the heavy SDKs", () => {
  const daemonRoot = fileURLToPath(new URL("..", import.meta.url));
  const coreUrl = new URL("./core.ts", import.meta.url).href;
  const dir = mkdtempSync(path.join(os.tmpdir(), "lazy-sdk-"));
  try {
    const record = path.join(dir, "resolved.txt");
    const hooks = path.join(dir, "hooks.mjs");
    const register = path.join(dir, "register.mjs");
    const probe = path.join(dir, "probe.mjs");
    writeFileSync(hooks, `
import { appendFileSync } from "node:fs";
const HEAVY = ${JSON.stringify(HEAVY_PACKAGES)};
export async function resolve(specifier, context, next) {
  if (HEAVY.some((pkg) => specifier === pkg || specifier.startsWith(pkg + "/"))) {
    appendFileSync(${JSON.stringify(record)}, specifier + "\\n");
  }
  return next(specifier, context);
}
`);
    writeFileSync(register, `import { register } from "node:module"; register(${JSON.stringify(new URL(`file://${hooks}`).href)});`);
    writeFileSync(probe, `
const core = await import(${JSON.stringify(coreUrl)});
core.detectRuntimes();
console.log("probe-done");
`);
    const result = spawnSync(
      process.execPath,
      ["--import", "tsx", "--import", register, probe],
      { cwd: daemonRoot, encoding: "utf8", timeout: 120_000, env: { ...process.env, RAFT_HOME: path.join(dir, "home") } },
    );
    assert.equal(result.status, 0, `probe failed: ${result.stderr}`);
    assert.match(result.stdout, /probe-done/);
    const loaded = existsSync(record) ? readFileSync(record, "utf8").trim().split("\n").filter(Boolean) : [];
    assert.deepEqual(loaded, [], `heavy SDKs were loaded at startup: ${loaded.join(", ")}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
