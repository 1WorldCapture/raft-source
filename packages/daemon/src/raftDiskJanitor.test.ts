import { test } from "vitest";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readdir, rm, symlink, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  RAFT_MIGRATION_GENERATION_IDLE_MS,
  createRaftDiskWalkBudget,
  measureDirectoryBytes,
  measureRaftDiskFootprint,
  removeMigrationGenerationBulk,
  runRaftDiskJanitor,
  scheduleRaftDiskJanitor,
} from "./raftDiskJanitor.js";
import {
  AGENT_MIGRATION_WORKSPACE_BACKUP_MAX_AGE_MS,
  AGENT_MIGRATION_WORKSPACE_BACKUP_MAX_PER_AGENT,
} from "./agentMigrationWorkspaceArchive.js";

const DAY_MS = 24 * 60 * 60 * 1_000;
const NOW = new Date("2026-10-04T12:00:00Z");

async function withHome(fn: (home: string) => Promise<void>): Promise<void> {
  const home = await mkdtemp(path.join(tmpdir(), "raft-disk-janitor-"));
  try {
    await fn(home);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
}

async function writeBytes(filePath: string, bytes: number): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, Buffer.alloc(bytes));
}

async function age(target: string, ageMs: number): Promise<void> {
  const at = new Date(NOW.getTime() - ageMs);
  await utimes(target, at, at);
}

/** A target-side generation: chunks, an extraction root and the arrival report. */
async function generation(home: string, migration: string, ageMs: number): Promise<string> {
  const root = path.join(home, "migrations", migration, "agent_migration_transport_1");
  await writeBytes(path.join(root, "chunks", "0.chunk"), 1_000);
  await writeBytes(path.join(root, "chunks", "1.chunk"), 500);
  await mkdir(path.join(root, "extracting-abc123"), { recursive: true });
  await writeBytes(path.join(root, "arrival-report-v2.json"), 10);
  for (const entry of ["chunks/0.chunk", "chunks/1.chunk", "chunks", "extracting-abc123", "arrival-report-v2.json", ""]) {
    await age(path.join(root, entry), ageMs);
  }
  return root;
}

test("measureDirectoryBytes sums regular files, never follows symlinks, and reports a truncated walk", async () => {
  await withHome(async (home) => {
    await writeBytes(path.join(home, "a", "one"), 100);
    await writeBytes(path.join(home, "a", "b", "two"), 23);
    await writeBytes(path.join(home, "outside", "big"), 10_000);
    await symlink(path.join(home, "outside"), path.join(home, "a", "link"));

    const budget = createRaftDiskWalkBudget();
    assert.equal(await measureDirectoryBytes(path.join(home, "a"), budget), 123);
    assert.equal(budget.outcome, "complete");

    const tiny = createRaftDiskWalkBudget({ maxEntries: 1 });
    await measureDirectoryBytes(path.join(home, "a"), tiny);
    assert.equal(tiny.outcome, "truncated", "a partial walk must not read as a small complete number");

    assert.equal(await measureDirectoryBytes(path.join(home, "missing"), createRaftDiskWalkBudget()), 0);
  });
});

test("an arrived generation loses its bulk transfer data but keeps the JSON report", async () => {
  await withHome(async (home) => {
    const root = await generation(home, "m1", 0);
    const freed = await removeMigrationGenerationBulk(root, createRaftDiskWalkBudget());
    assert.equal(freed, 1_500);
    assert.deepEqual(await readdir(root), ["arrival-report-v2.json"]);
  });
});

test("janitor clears only migration generations idle for over a week", async () => {
  await withHome(async (home) => {
    const idle = await generation(home, "old", RAFT_MIGRATION_GENERATION_IDLE_MS + DAY_MS);
    const active = await generation(home, "recent", RAFT_MIGRATION_GENERATION_IDLE_MS - DAY_MS);
    const sourceSide = path.join(home, "migrations", "src", "agent_migration_transport_2");
    await writeBytes(path.join(sourceSide, "source-spool", "part"), 7);
    await age(path.join(sourceSide, "source-spool", "part"), 30 * DAY_MS);
    await age(path.join(sourceSide, "source-spool"), 30 * DAY_MS);
    await age(sourceSide, 30 * DAY_MS);
    await writeBytes(path.join(home, "migrations", "grant-target", "arrival-report.json"), 5);

    const result = await runRaftDiskJanitor({ slockHome: home, now: NOW });

    assert.deepEqual(await readdir(idle), ["arrival-report-v2.json"]);
    assert.deepEqual((await readdir(active)).sort(), ["arrival-report-v2.json", "chunks", "extracting-abc123"]);
    assert.deepEqual(await readdir(sourceSide), []);
    assert.deepEqual(await readdir(path.join(home, "migrations", "grant-target")), ["arrival-report.json"]);
    assert.equal(result.migrationGenerationsCleaned, 2);
    assert.equal(result.migrationFreedBytes, 1_507);
    assert.equal(result.sweepOutcome, "complete");
  });
});

test("janitor applies the keep-3 / 30-day backup rule to every agent and reports each removal", async () => {
  await withHome(async (home) => {
    const backups = path.join(home, "migration-workspace-backups");
    // Agent A: four backups all past 30 days; the newest three stay (floor), the oldest goes.
    for (let index = 1; index <= 4; index += 1) {
      await writeBytes(path.join(backups, "agent-a", `mig-${index}`, "MEMORY.md"), index === 1 ? 400 : 1);
      await age(path.join(backups, "agent-a", `mig-${index}`), AGENT_MIGRATION_WORKSPACE_BACKUP_MAX_AGE_MS + (10 - index) * DAY_MS);
    }
    // Agent B: four recent backups; the oldest is over the per-agent cap.
    for (let index = 0; index <= AGENT_MIGRATION_WORKSPACE_BACKUP_MAX_PER_AGENT; index += 1) {
      const name = index === 0 ? "preexisting-mig-0" : `mig-${index}`;
      await writeBytes(path.join(backups, "agent-b", name, "f"), 10);
      await age(path.join(backups, "agent-b", name), (10 - index) * DAY_MS);
    }

    const result = await runRaftDiskJanitor({ slockHome: home, now: NOW });

    assert.deepEqual((await readdir(path.join(backups, "agent-a"))).sort(), ["mig-2", "mig-3", "mig-4"]);
    assert.deepEqual((await readdir(path.join(backups, "agent-b"))).sort(), ["mig-1", "mig-2", "mig-3"]);
    assert.deepEqual(
      result.backupsRemoved.sort((left, right) => left.ownerAgentId.localeCompare(right.ownerAgentId)),
      [
        { ownerAgentId: "agent-a", backupKind: "migration", ageDays: 39, freedBytes: 400 },
        { ownerAgentId: "agent-b", backupKind: "preexisting", ageDays: 10, freedBytes: 10 },
      ],
    );
    assert.equal(result.backupsFreedBytes, 410);
  });
});

test("footprint reports Raft's own directories separately", async () => {
  await withHome(async (home) => {
    await generation(home, "m1", 0);
    await writeBytes(path.join(home, "migration-workspace-backups", "agent-a", "mig-1", "f"), 300);
    await writeBytes(path.join(home, "cli-transport", "agent-a", "launch-1", "raft"), 20);
    await writeBytes(path.join(home, "agent-proxy-tokens", "agent-a", "launch-1.token"), 5);
    await writeBytes(path.join(home, "agents", "agent-a", "huge-workspace-file"), 99_999);

    assert.deepEqual(await measureRaftDiskFootprint(home), {
      raft_migration_chunks_bytes: 1_510,
      raft_workspace_backups_bytes: 300,
      raft_launch_dirs_bytes: 25,
      measure_outcome: "complete",
    });
  });
});

test("the janitor schedule waits, never overlaps passes, and stops cleanly", async () => {
  const pending: Array<{ fn: () => void; ms: number }> = [];
  const timers = {
    setTimeout: (fn: () => void, ms: number) => {
      const timer = { fn, ms };
      pending.push(timer);
      return timer;
    },
    clearTimeout: (timer: unknown) => {
      const index = pending.indexOf(timer as { fn: () => void; ms: number });
      if (index >= 0) pending.splice(index, 1);
    },
  };
  let finishPass!: () => void;
  let passes = 0;
  const schedule = scheduleRaftDiskJanitor({
    timers,
    initialDelayMs: 600,
    intervalMs: 86_400,
    pass: () => {
      passes += 1;
      return new Promise<void>((resolve) => { finishPass = resolve; });
    },
  });
  assert.deepEqual(pending.map((timer) => timer.ms), [600]);
  pending.shift()!.fn();
  assert.equal(passes, 1);
  assert.equal(pending.length, 0, "the next pass is armed only after this one finishes");
  finishPass();
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(pending.map((timer) => timer.ms), [86_400]);
  schedule.stop();
  assert.equal(pending.length, 0);
});

const OLD = RAFT_MIGRATION_GENERATION_IDLE_MS + DAY_MS;

test("an object-store staging workspace is user data and is never walked, even with a chunks directory in it", async () => {
  await withHome(async (home) => {
    const session = path.join(home, "migrations", "sess_1");
    await writeBytes(path.join(session, "workspace", "chunks", "notes.md"), 50);
    await writeBytes(path.join(session, "workspace", "extracting-x", "a"), 5);
    for (const entry of ["workspace/chunks/notes.md", "workspace/chunks", "workspace/extracting-x/a", "workspace/extracting-x", "workspace", ""]) {
      await age(path.join(session, entry), OLD);
    }
    const result = await runRaftDiskJanitor({ slockHome: home, now: NOW });
    assert.deepEqual((await readdir(path.join(session, "workspace"))).sort(), ["chunks", "extracting-x"]);
    assert.deepEqual(result.removedPaths, []);
  });
});

test("a generation of the migration the daemon holds a lease for is skipped, however old it looks", async () => {
  await withHome(async (home) => {
    const root = await generation(home, "live", OLD);
    const result = await runRaftDiskJanitor({ slockHome: home, now: NOW, activeMigrationSegments: new Set(["live"]) });
    assert.deepEqual((await readdir(root)).sort(), ["arrival-report-v2.json", "chunks", "extracting-abc123"]);
    assert.equal(result.migrationGenerationsCleaned, 0);
  });
});

test("an extracting root that holds the full workspace is kept and reported, never deleted", async () => {
  await withHome(async (home) => {
    const root = await generation(home, "failed-rename", OLD);
    await writeBytes(path.join(root, "extracting-abc123", "workspace", "MEMORY.md"), 99);
    await age(path.join(root, "extracting-abc123"), OLD);
    await age(root, OLD);
    const result = await runRaftDiskJanitor({ slockHome: home, now: NOW });
    assert.deepEqual((await readdir(root)).sort(), ["arrival-report-v2.json", "extracting-abc123"]);
    assert.deepEqual(result.keptPaths, [{ path: path.join(root, "extracting-abc123"), reason: "un-adopted extracted workspace" }]);
    assert.ok(result.removedPaths.includes(path.join(root, "chunks")));
  });
});

test("the newest three backups survive whatever their age", async () => {
  await withHome(async (home) => {
    const agentRoot = path.join(home, "migration-workspace-backups", "agent-old");
    for (const index of [1, 2, 3]) {
      await writeBytes(path.join(agentRoot, `mig-${index}`, "MEMORY.md"), 3);
      await age(path.join(agentRoot, `mig-${index}`), AGENT_MIGRATION_WORKSPACE_BACKUP_MAX_AGE_MS * 3 + index * DAY_MS);
    }
    const result = await runRaftDiskJanitor({ slockHome: home, now: NOW });
    assert.equal((await readdir(agentRoot)).length, 3);
    assert.deepEqual(result.backupsRemoved, []);
  });
});

test("an exhausted budget stops deleting, not only measuring", async () => {
  await withHome(async (home) => {
    const first = await generation(home, "a", OLD);
    const second = await generation(home, "b", OLD);
    const budget = createRaftDiskWalkBudget({ maxEntries: 0 });
    const result = await runRaftDiskJanitor({ slockHome: home, now: NOW, budget });
    assert.ok((await readdir(first)).includes("chunks"));
    assert.ok((await readdir(second)).includes("chunks"));
    assert.equal(result.sweepOutcome, "truncated");
    assert.deepEqual(result.removedPaths, []);
  });
});

test("every removed path is reported", async () => {
  await withHome(async (home) => {
    const root = await generation(home, "logged", OLD);
    const result = await runRaftDiskJanitor({ slockHome: home, now: NOW });
    assert.deepEqual(result.removedPaths.sort(), [path.join(root, "chunks"), path.join(root, "extracting-abc123")]);
  });
});

test("a symlinked backup root is not followed and a backup root inside the data dir is refused", async () => {
  await withHome(async (home) => {
    const outside = path.join(home, "outside");
    await writeBytes(path.join(outside, "agent", "mig-1", "f"), 1);
    await writeBytes(path.join(outside, "agent", "mig-2", "f"), 1);
    await writeBytes(path.join(outside, "agent", "mig-3", "f"), 1);
    await writeBytes(path.join(outside, "agent", "mig-4", "f"), 1);
    await symlink(outside, path.join(home, "migration-workspace-backups"));
    await runRaftDiskJanitor({ slockHome: home, now: NOW });
    assert.equal((await readdir(path.join(outside, "agent"))).length, 4);
  });
  await withHome(async (home) => {
    const backups = path.join(home, "migration-workspace-backups");
    for (const index of [1, 2, 3, 4]) await writeBytes(path.join(backups, "agent", `mig-${index}`, "f"), 1);
    const result = await runRaftDiskJanitor({ slockHome: home, now: NOW, dataDir: home });
    assert.equal((await readdir(path.join(backups, "agent"))).length, 4);
    assert.deepEqual(result.backupsRemoved, []);
  });
});
