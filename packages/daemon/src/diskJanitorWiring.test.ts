import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "vitest";
import { DaemonCore } from "./core.js";

async function makeCore(): Promise<DaemonCore> {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "slock-disk-janitor-wiring-test-"));
  return new DaemonCore({
    serverUrl: "https://daemon.example.com",
    apiKey: "sk_machine_test",
    dataDir,
    runtimeDetector: () => ({ ids: [], versions: {} }),
  });
}

type Wiring = { installDiskJanitor(): void; diskJanitor: { stop(): void } | null };

test("the disk janitor is installed once per daemon and SLOCK_DAEMON_DISK_JANITOR_DISABLED=1 turns it off", async () => {
  const core = (await makeCore()) as unknown as Wiring;
  const saved = process.env.SLOCK_DAEMON_DISK_JANITOR_DISABLED;
  try {
    process.env.SLOCK_DAEMON_DISK_JANITOR_DISABLED = "1";
    core.installDiskJanitor();
    assert.equal(core.diskJanitor, null, "disabled: nothing is scheduled");

    delete process.env.SLOCK_DAEMON_DISK_JANITOR_DISABLED;
    core.installDiskJanitor();
    const first = core.diskJanitor;
    assert.ok(first, "enabled: scheduled (first pass is 10 minutes out, the timer is unref'd)");
    core.installDiskJanitor();
    assert.equal(core.diskJanitor, first, "installing twice keeps the single schedule");
  } finally {
    core.diskJanitor?.stop();
    core.diskJanitor = null;
    if (saved === undefined) delete process.env.SLOCK_DAEMON_DISK_JANITOR_DISABLED;
    else process.env.SLOCK_DAEMON_DISK_JANITOR_DISABLED = saved;
  }
});
