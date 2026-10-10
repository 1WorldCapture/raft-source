import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "vitest";
import { clearStartAwaitingService, markStartAwaitingService, startAwaitingPath, startIsAwaitingService } from "./startAwaiting.js";
import { readFile } from "node:fs/promises";

async function withHome(fn: (home: string) => Promise<void>): Promise<void> {
  const home = await mkdtemp(path.join(tmpdir(), "start-await-"));
  try { await fn(home); } finally { await rm(home, { recursive: true, force: true }); }
}

test("a live, recent start marker means the service must not queue for the lock", async () => {
  await withHome(async (home) => {
    assert.equal(await startIsAwaitingService(home), false, "no marker");
    await markStartAwaitingService(home, 4242, 1_000);
    assert.equal(await startIsAwaitingService(home, { isAlive: () => true, now: () => 2_000 }), true);
    assert.equal(await startIsAwaitingService(home, { isAlive: () => false, now: () => 2_000 }), false, "dead start");
    assert.equal(await startIsAwaitingService(home, { isAlive: () => true, now: () => 1_000 + 61_000 }), false, "stale marker");
  });
});

test("clear only removes this process's own marker", async () => {
  await withHome(async (home) => {
    await markStartAwaitingService(home, 111);
    await clearStartAwaitingService(home, 222);
    assert.ok(JSON.parse(await readFile(startAwaitingPath(home), "utf8")).pid === 111, "someone else's marker stays");
    await clearStartAwaitingService(home, 111);
    assert.equal(await startIsAwaitingService(home, { isAlive: () => true }), false);
  });
});
