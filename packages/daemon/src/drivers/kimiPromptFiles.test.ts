import assert from "node:assert/strict";
import { chmod, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "vitest";
import { writeKimiPromptFiles } from "./kimi.js";

const mode = async (file: string) => (await stat(file)).mode & 0o777;

test("kimi prompt + agent files are owner-only on a fresh launch", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "kimi-prompt-"));
  try {
    const { systemPromptPath, agentFilePath } = writeKimiPromptFiles(dir, "standing prompt", false);
    assert.equal(await mode(systemPromptPath), 0o600);
    assert.equal(await mode(agentFilePath), 0o600);
    assert.equal(await readFile(systemPromptPath, "utf8"), "standing prompt");
    assert.match(await readFile(agentFilePath, "utf8"), /system_prompt_path: \.\/\.slock-kimi-system\.md/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("a pre-existing 0644 prompt file is tightened on resume and its content kept", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "kimi-prompt-resume-"));
  try {
    const prompt = path.join(dir, ".slock-kimi-system.md");
    const agent = path.join(dir, ".slock-kimi-agent.yaml");
    await writeFile(prompt, "old prompt", { mode: 0o644 });
    await writeFile(agent, "old", { mode: 0o644 });
    await chmod(prompt, 0o644);
    await chmod(agent, 0o644);
    writeKimiPromptFiles(dir, "new prompt ignored on resume", true);
    assert.equal(await mode(prompt), 0o600);
    assert.equal(await mode(agent), 0o600);
    assert.equal(await readFile(prompt, "utf8"), "old prompt", "resume keeps the existing prompt body");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
