import { mkdir, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { AgentProcessManager } from "./agentProcessManager.js";

const AGENT = "8d44e2f2-4752-4ddf-b4b4-1226da8cf3aa";
let home: string;
let manager: AgentProcessManager;

beforeEach(async () => {
  home = await mkdtemp(path.join(os.tmpdir(), "raft-manager-purge-"));
  manager = new AgentProcessManager(() => {}, "sk_machine_test", {
    dataDir: path.join(home, "agents"), slockHome: home, runtimeSessionHomeDir: home,
    daemonVersion: "1.0.1-test", computerVersion: "2.0.1-test", serverUrl: "https://raft.example.test",
  });
});
afterEach(async () => { await rm(home, { recursive: true, force: true }); });

const exists = (p: string) => stat(p).then(() => true, () => false);
async function seedAgentDirs() {
  await mkdir(path.join(home, "agents", AGENT), { recursive: true });
  await writeFile(path.join(home, "agents", AGENT, "MEMORY.md"), "m");
  await mkdir(path.join(home, "cli-transport", AGENT), { recursive: true });
}
const internals = () => manager as unknown as { agents: Map<string, unknown> };

test("stopped agent: directories move to trash after the stop completed", async () => {
  await seedAgentDirs();
  const order: string[] = [];
  vi.spyOn(manager, "stopAgent").mockImplementation(async (_id, options) => {
    order.push(`stop(wait=${options?.wait})`);
    expect(await exists(path.join(home, "agents", AGENT))).toBe(true); // nothing moved before the stop
  });
  expect(await manager.purgeAgentLocalState(AGENT)).toBe("purged");
  expect(order).toEqual(["stop(wait=true)"]);
  expect(await exists(path.join(home, "agents", AGENT))).toBe(false);
  expect(await exists(path.join(home, "cli-transport", AGENT))).toBe(false);
});

test("runtime child still alive after the stop: refused_running and nothing is moved", async () => {
  await seedAgentDirs();
  internals().agents.set(AGENT, { runtime: { isAlive: () => true } });
  vi.spyOn(manager, "stopAgent").mockImplementation(async () => { internals().agents.delete(AGENT); });
  expect(await manager.purgeAgentLocalState(AGENT)).toBe("refused_running");
  expect(await exists(path.join(home, "agents", AGENT, "MEMORY.md"))).toBe(true);
  expect(await exists(path.join(home, "trash"))).toBe(false);
});

test("agent restarted while the purge was stopping it: refused_running", async () => {
  await seedAgentDirs();
  vi.spyOn(manager, "stopAgent").mockImplementation(async () => { internals().agents.set(AGENT, { runtime: { isAlive: () => false } }); });
  expect(await manager.purgeAgentLocalState(AGENT)).toBe("refused_running");
  expect(await exists(path.join(home, "agents", AGENT))).toBe(true);
});

test("a dead runtime handle does not block the purge", async () => {
  await seedAgentDirs();
  internals().agents.set(AGENT, { runtime: { isAlive: () => false } });
  vi.spyOn(manager, "stopAgent").mockImplementation(async () => { internals().agents.delete(AGENT); });
  expect(await manager.purgeAgentLocalState(AGENT)).toBe("purged");
});

test("invalid ids and absent directories", async () => {
  const stop = vi.spyOn(manager, "stopAgent").mockResolvedValue(undefined);
  expect(await manager.purgeAgentLocalState("../agents")).toBe("invalid_agent_id");
  expect(stop).not.toHaveBeenCalled();
  expect(await manager.purgeAgentLocalState(AGENT)).toBe("nothing_to_purge");
});
