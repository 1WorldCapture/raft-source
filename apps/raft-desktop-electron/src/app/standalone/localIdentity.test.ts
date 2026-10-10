import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { readLocalMachineIds } from "./localIdentity.ts";

test("reads each attachment's machine id, skips bad files, dedupes", async () => {
  const home = await mkdtemp(path.join(tmpdir(), "ident-"));
  try {
    const servers = path.join(home, "computer", "servers");
    for (const [name, body] of [["a", '{"machineId":"m1"}'], ["b", '{"machineId":"m2"}'], ["c", "{not json"], ["d", '{"serverMachineId":"x"}'], ["e", '{"machineId":"m1"}']]) {
      await mkdir(path.join(servers, name), { recursive: true });
      await writeFile(path.join(servers, name, "runner.state.json"), body);
    }
    assert.deepEqual(await readLocalMachineIds(home), ["m1", "m2"]);
    assert.deepEqual(await readLocalMachineIds(path.join(home, "missing")), []);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});
