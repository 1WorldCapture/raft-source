// Task #7 (private deployment, phase 2) — telemetry red line: the trace
// upload worker URL follows the four-layer policy. Private contexts (env
// switch or the persisted server release backend) NEVER fall back to the
// official endpoint; an explicit URL is the only opt-in.
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, test } from "vitest";

import { resolveTraceUploadWorkerUrl } from "./core.js";

const prevMode = process.env.RAFT_DEPLOYMENT_MODE;
const prevDisabled = process.env.SLOCK_DAEMON_TRACE_UPLOAD_DISABLED;
const prevUrl = process.env.SLOCK_DAEMON_TRACE_UPLOAD_URL;
let home: string;
let officialHome: string;

beforeAll(async () => {
  home = await mkdtemp(path.join(tmpdir(), "daemon-trace-policy-"));
  await mkdir(path.join(home, "computer"), { recursive: true });
  await writeFile(path.join(home, "computer", "release-backend"), "server\n");
  officialHome = await mkdtemp(path.join(tmpdir(), "daemon-trace-policy-official-"));
});

afterAll(async () => {
  for (const [prev, key] of [
    [prevMode, "RAFT_DEPLOYMENT_MODE"],
    [prevDisabled, "SLOCK_DAEMON_TRACE_UPLOAD_DISABLED"],
    [prevUrl, "SLOCK_DAEMON_TRACE_UPLOAD_URL"],
  ] as const) {
    if (prev === undefined) delete process.env[key];
    else process.env[key] = prev;
  }
  await rm(home, { recursive: true, force: true });
  await rm(officialHome, { recursive: true, force: true });
});

function clearEnv(): void {
  delete process.env.RAFT_DEPLOYMENT_MODE;
  delete process.env.SLOCK_DAEMON_TRACE_UPLOAD_DISABLED;
  delete process.env.SLOCK_DAEMON_TRACE_UPLOAD_URL;
}

describe("resolveTraceUploadWorkerUrl (four-layer policy)", () => {
  test("official default unchanged for official deployments", () => {
    clearEnv();
    assert.equal(resolveTraceUploadWorkerUrl(officialHome), "https://slock-trace-upload.botiverse.dev");
  });

  test("private context (persisted server backend) never uploads by default", () => {
    clearEnv();
    assert.equal(resolveTraceUploadWorkerUrl(home), undefined);
  });

  test("private context (env switch) never uploads by default", () => {
    clearEnv();
    process.env.RAFT_DEPLOYMENT_MODE = "private";
    assert.equal(resolveTraceUploadWorkerUrl(officialHome), undefined);
  });

  test("explicit URL is the only private-context opt-in", () => {
    clearEnv();
    process.env.SLOCK_DAEMON_TRACE_UPLOAD_URL = "https://worker.internal.example";
    assert.equal(resolveTraceUploadWorkerUrl(home), "https://worker.internal.example");
  });

  test("DISABLED=1 stays the highest off-switch even with an explicit URL", () => {
    clearEnv();
    process.env.SLOCK_DAEMON_TRACE_UPLOAD_URL = "https://worker.internal.example";
    process.env.SLOCK_DAEMON_TRACE_UPLOAD_DISABLED = "1";
    assert.equal(resolveTraceUploadWorkerUrl(officialHome), undefined);
  });
});
