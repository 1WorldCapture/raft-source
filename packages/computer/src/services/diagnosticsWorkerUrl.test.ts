// Task #7 (private deployment, phase 2) — telemetry red line on the Computer
// surface: the diagnostics push worker URL mirrors the daemon's four-layer
// policy. The computer test suite's global side-effect guard enforces zero
// real network; this pins the policy itself.
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, test } from "vitest";
import { withHermeticHome } from "../test/hermeticAssertions.js";
import { resolveDiagnosticsWorkerUrl } from "./diagnosticsPush.js";

const prevDisabled = process.env.SLOCK_DAEMON_TRACE_UPLOAD_DISABLED;
const prevUrl = process.env.SLOCK_DAEMON_TRACE_UPLOAD_URL;
let officialHome: string;

beforeAll(async () => {
  officialHome = await mkdtemp(path.join(tmpdir(), "diag-worker-official-"));
});

afterAll(async () => {
  for (const [prev, key] of [
    [prevDisabled, "SLOCK_DAEMON_TRACE_UPLOAD_DISABLED"],
    [prevUrl, "SLOCK_DAEMON_TRACE_UPLOAD_URL"],
  ] as const) {
    if (prev === undefined) delete process.env[key];
    else process.env[key] = prev;
  }
  await rm(officialHome, { recursive: true, force: true });
});

describe("resolveDiagnosticsWorkerUrl (four-layer policy)", () => {
  test("official default unchanged for official deployments", async () => {
    delete process.env.SLOCK_DAEMON_TRACE_UPLOAD_URL;
    assert.equal(await resolveDiagnosticsWorkerUrl(officialHome), "https://slock-trace-upload.botiverse.dev");
  });

  test("private context (persisted server backend) never uploads by default", async () => {
    delete process.env.SLOCK_DAEMON_TRACE_UPLOAD_URL;
    await withHermeticHome(async (home) => {
      await mkdir(path.join(home, "computer"), { recursive: true });
      await writeFile(path.join(home, "computer", "release-backend"), "server\n");
      assert.equal(await resolveDiagnosticsWorkerUrl(home), undefined);
    });
  });

  test("explicit URL (option or env) is the only private-context opt-in", async () => {
    await withHermeticHome(async (home) => {
      await mkdir(path.join(home, "computer"), { recursive: true });
      await writeFile(path.join(home, "computer", "release-backend"), "server\n");
      assert.equal(await resolveDiagnosticsWorkerUrl(home, "https://w.internal"), "https://w.internal");
      process.env.SLOCK_DAEMON_TRACE_UPLOAD_URL = "https://w-env.internal";
      try {
        assert.equal(await resolveDiagnosticsWorkerUrl(home), "https://w-env.internal");
      } finally {
        delete process.env.SLOCK_DAEMON_TRACE_UPLOAD_URL;
      }
    });
  });
});
