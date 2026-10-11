import { mkdir, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { expect, test } from "vitest";
import { AgentProcessManager } from "./agentProcessManager.js";

async function exists(target: string): Promise<boolean> {
  return stat(target).then(() => true, () => false);
}

test("resetWorkspace removes one agent's workspace and refuses names that would reach the data dir or beyond", async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "raft-reset-workspace-"));
  const manager = new AgentProcessManager(() => {}, "sk_machine_test", {
    dataDir, slockHome: dataDir, runtimeSessionHomeDir: dataDir,
    daemonVersion: "1.0.1-test", computerVersion: "2.0.1-test",
    serverUrl: "https://raft.example.test",
  });
  try {
    const keepA = path.join(dataDir, "agent-a");
    const keepB = path.join(dataDir, "agent-b");
    await mkdir(keepA);
    await mkdir(keepB);
    await writeFile(path.join(keepA, "MEMORY.md"), "a");
    await writeFile(path.join(keepB, "MEMORY.md"), "b");
    for (const bad of [".", "", "..", "../x", "nested/x", "agent-a/..", "./agent-a"]) {
      await manager.resetWorkspace(bad);
      expect(await exists(path.join(keepA, "MEMORY.md")), `after ${JSON.stringify(bad)}`).toBe(true);
      expect(await exists(path.join(keepB, "MEMORY.md")), `after ${JSON.stringify(bad)}`).toBe(true);
    }
    // A legitimate reset still removes exactly that agent's directory.
    await manager.resetWorkspace("agent-a");
    expect(await exists(keepA)).toBe(false);
    expect(await exists(path.join(keepB, "MEMORY.md"))).toBe(true);
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});
