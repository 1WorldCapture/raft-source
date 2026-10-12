import assert from "node:assert/strict";
import { test } from "vitest";
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  RECOMMENDED_MEMORY_MD_BYTES,
  applyStartupMemoryBlock,
  buildStartupMemoryBlock,
  resolveStartupMemoryBlockConfig,
} from "./startupMemoryBlock.js";
import { asAxSurfaceText, type AgentConfig } from "@botiverse/raft-shared";

function workspaceWithMemory(content: string | null): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), "memory-block-"));
  if (content !== null) writeFileSync(path.join(dir, "MEMORY.md"), content);
  return dir;
}

test("the block runs only with the server flag; env can turn it off but never on; per-agent env beats process env", () => {
  assert.equal(resolveStartupMemoryBlockConfig(undefined, null, {}).enabled, false, "older server: no field means off");
  assert.equal(resolveStartupMemoryBlockConfig(false, null, {}).enabled, false);
  assert.equal(resolveStartupMemoryBlockConfig(false, { RAFT_STARTUP_MEMORY_BLOCK: "1" }, { RAFT_STARTUP_MEMORY_BLOCK: "1" }).enabled, false, "env cannot turn it on");

  const defaults = resolveStartupMemoryBlockConfig(true, null, {});
  assert.equal(defaults.enabled, true);
  assert.equal(resolveStartupMemoryBlockConfig(true, null, { RAFT_STARTUP_MEMORY_BLOCK: "0" }).enabled, false);
  assert.equal(defaults.budgetTokens, 4_000);

  const fromProcess = resolveStartupMemoryBlockConfig(true, null, { RAFT_STARTUP_MEMORY_BLOCK: "1", RAFT_STARTUP_MEMORY_BLOCK_TOKENS: "2000" });
  assert.equal(fromProcess.enabled, true);
  assert.equal(fromProcess.budgetTokens, 2_000);

  const agentWins = resolveStartupMemoryBlockConfig(
    true,
    { RAFT_STARTUP_MEMORY_BLOCK: "0" },
    { RAFT_STARTUP_MEMORY_BLOCK: "1" },
  );
  assert.equal(agentWins.enabled, false);
});

test("missing, empty, and whitespace-only MEMORY.md yield no block", async () => {
  assert.equal(await buildStartupMemoryBlock({ workspacePath: workspaceWithMemory(null) }), null);
  assert.equal(await buildStartupMemoryBlock({ workspacePath: workspaceWithMemory("") }), null);
  assert.equal(await buildStartupMemoryBlock({ workspacePath: workspaceWithMemory("  \n\n  ") }), null);
});

test("a small index is injected in full with a no-re-read note", async () => {
  const block = await buildStartupMemoryBlock({ workspacePath: workspaceWithMemory("# Memory\n- [note](notes/a.md)\n") });
  assert.ok(block);
  assert.match(block!, /^<memory-index file="MEMORY\.md"/);
  assert.match(block!, /- \[note\]\(notes\/a\.md\)/);
  assert.match(block!, /complete="true" note="no need to re-read MEMORY\.md/);
  assert.doesNotMatch(block!, /Recommended index size|notes\/ /);
});

test("an oversize-but-within-budget index gets the same facts-only full note", async () => {
  const content = "# Memory\n" + "x".repeat(RECOMMENDED_MEMORY_MD_BYTES + 512);
  const block = await buildStartupMemoryBlock({ workspacePath: workspaceWithMemory(content), budgetTokens: 8_000 });
  assert.ok(block);
  assert.match(block!, /complete="true"/);
  assert.doesNotMatch(block!, /recommended|Move detail|Cleaner/i);
});

test("an over-budget file is head-truncated with exact sizes and the recommendation", async () => {
  const lines = Array.from({ length: 3_000 }, (_, i) => `- line ${i} of the memory index`);
  const content = lines.join("\n");
  const block = await buildStartupMemoryBlock({ workspacePath: workspaceWithMemory(content), budgetTokens: 1_000 });
  assert.ok(block);
  assert.match(block!, /- line 0 of the memory index/);
  assert.doesNotMatch(block!, /- line 2999 of/);
  assert.match(block!, /shown="first \d+\.\d KB" note="read the file for the rest"/);
  assert.doesNotMatch(block!, /Recommended index size|Move detail|Cleaner/i);
  // Truncation must land on a line boundary, so no half line precedes the
  // closing tag.
  const shown = block!.split("\n</memory-index>")[0]!;
  const lastContentLine = shown.trimEnd().split("\n").at(-1)!;
  assert.match(lastContentLine, /^- line \d+ of the memory index$/);
  // Budget is respected in bytes (4 bytes/token estimate).
  assert.ok(Buffer.byteLength(shown, "utf8") <= 1_000 * 4 + 200);
});

test("multibyte content is never split mid code point", async () => {
  const content = "# 记忆\n" + "记忆索引条目。".repeat(2_000);
  const block = await buildStartupMemoryBlock({ workspacePath: workspaceWithMemory(content), budgetTokens: 500 });
  assert.ok(block);
  assert.doesNotMatch(block!, /�/);
});

test("applyStartupMemoryBlock prepends and marks the prompt source, and is a no-op without a block", () => {
  const wake = asAxSurfaceText("wake");
  const untouched = applyStartupMemoryBlock(null, wake, "cold_start");
  assert.deepEqual(untouched, { prompt: "wake", promptSource: "cold_start" });

  const applied = applyStartupMemoryBlock(asAxSurfaceText("## MEMORY.md ..."), wake, "cold_start");
  assert.equal(applied.prompt, "## MEMORY.md ...\n\nwake");
  assert.equal(applied.promptSource, "cold_start_with_memory");
});

test("a symlinked MEMORY.md is never followed, even to a readable file outside the workspace", async () => {
  const outside = workspaceWithMemory("SECRET outside the workspace");
  const dir = workspaceWithMemory(null);
  symlinkSync(path.join(outside, "MEMORY.md"), path.join(dir, "MEMORY.md"));
  assert.equal(await buildStartupMemoryBlock({ workspacePath: dir }), null);
});

test("only the head of a huge MEMORY.md is read, and the size facts still describe the whole file", async () => {
  const dir = workspaceWithMemory(`${"line of memory\n".repeat(200_000)}TAIL_MARKER\n`);
  const block = String(await buildStartupMemoryBlock({ workspacePath: dir, budgetTokens: 100 }));
  assert.ok(block.includes('shown="first '), block.slice(0, 200));
  assert.ok(!block.includes("TAIL_MARKER"));
  assert.match(block, /size="2[0-9]{3}\.\d KB"/);
});
