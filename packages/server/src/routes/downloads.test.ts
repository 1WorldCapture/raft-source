// Task #4 (phase 2): /downloads routes + local version-source mode.
// Hermetic: RAFT_DOWNLOADS_DIR points at a temp tree with the same shape
// scripts/build-downloads.mjs emits; no network calls (the private-mode
// branch reads files only; the external branch is never exercised here).
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, test, vi } from "vitest";
import express from "express";
import { isPrivateDeploymentMode } from "@botiverse/raft-shared";
import downloadsRouter from "./downloads.js";

const FIXTURE = {
  computer: { version: "9.9.95", targets: { "darwin-arm64": { file: "raft-computer-darwin-arm64", sha256: "a".repeat(64), size: 7 } } },
  cli: { version: "9.9.95", targets: { npm: { file: "raft-9.9.95.tgz", sha256: "b".repeat(64), size: 5 } } },
};

let dir: string;
let app: express.Express;
let baseUrl: string;
let server: import("node:http").Server;
const prevDownloadsDir = process.env.RAFT_DOWNLOADS_DIR;
const prevMode = process.env.RAFT_DEPLOYMENT_MODE;

beforeAll(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "downloads-route-"));
  await mkdir(path.join(dir, "computer", "9.9.95"), { recursive: true });
  await mkdir(path.join(dir, "cli", "9.9.95"), { recursive: true });
  await writeFile(path.join(dir, "computer", "manifest.json"), JSON.stringify({ version: FIXTURE.computer.version, daemonVersion: "1.0.25-test" }));
  await writeFile(path.join(dir, "computer", "9.9.95", "manifest.json"), JSON.stringify(FIXTURE.computer));
  await writeFile(path.join(dir, "computer", "9.9.95", "raft-computer-darwin-arm64"), "payload");
  await writeFile(path.join(dir, "cli", "manifest.json"), JSON.stringify({ version: FIXTURE.cli.version }));
  await writeFile(path.join(dir, "cli", "9.9.95", "manifest.json"), JSON.stringify(FIXTURE.cli));
  await writeFile(path.join(dir, "cli", "9.9.95", "raft-9.9.95.tgz"), "tgz!");
  process.env.RAFT_DOWNLOADS_DIR = dir;

  app = express();
  app.use("/downloads", downloadsRouter);
  await new Promise<void>((resolve) => {
    server = app.listen(0, "127.0.0.1", () => {
      baseUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
      resolve();
    });
  });
});

afterAll(async () => {
  if (prevDownloadsDir === undefined) delete process.env.RAFT_DOWNLOADS_DIR;
  else process.env.RAFT_DOWNLOADS_DIR = prevDownloadsDir;
  if (prevMode === undefined) delete process.env.RAFT_DEPLOYMENT_MODE;
  else process.env.RAFT_DEPLOYMENT_MODE = prevMode;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await rm(dir, { recursive: true, force: true });
});

async function get(url: string) {
  const res = await fetch(`${baseUrl}${url}`);
  return { status: res.status, body: await res.text(), headers: res.headers };
}

describe("downloads routes", () => {
  test("latest pointer manifests are served no-cache", async () => {
    const res = await get("/downloads/computer/manifest.json");
    assert.equal(res.status, 200);
    assert.equal(JSON.parse(res.body).version, "9.9.95");
    assert.match(String(res.headers.get("cache-control")), /no-cache/);
    const cli = await get("/downloads/cli/manifest.json");
    assert.equal(cli.status, 200);
    assert.equal(JSON.parse(cli.body).version, "9.9.95");
  });

  test("versioned manifests and artifacts are immutable-cached and byte-exact", async () => {
    const manifest = await get("/downloads/computer/9.9.95/manifest.json");
    assert.equal(manifest.status, 200);
    assert.match(String(manifest.headers.get("cache-control")), /immutable/);
    assert.deepEqual(JSON.parse(manifest.body).targets["darwin-arm64"], FIXTURE.computer.targets["darwin-arm64"]);

    const artifact = await get("/downloads/computer/9.9.95/raft-computer-darwin-arm64");
    assert.equal(artifact.status, 200);
    assert.equal(artifact.body, "payload");
    assert.match(String(artifact.headers.get("cache-control")), /immutable/);
    const artifactCli = await get("/downloads/cli/9.9.95/raft-9.9.95.tgz");
    assert.equal(artifactCli.status, 200);
    assert.equal(artifactCli.body, "tgz!");
  });

  test("unknown products and path escapes are refused", async () => {
    assert.equal((await get("/downloads/other/manifest.json")).status, 404);
    assert.equal((await get("/downloads/computer/../etc/manifest.json")).status, 404);
    assert.equal((await get("/downloads/computer/9.9.95/..%2f..%2fetc%2fpasswd")).status, 404);
    assert.equal((await get("/downloads/computer/not-a-version/manifest.json")).status, 404);
  });
});

describe("private-mode predicate (canonical switch)", () => {
  test("single entry point semantics", () => {
    expect(isPrivateDeploymentMode("private")).toBe(true);
    expect(isPrivateDeploymentMode(undefined)).toBe(false);
    expect(isPrivateDeploymentMode("production")).toBe(false);
    expect(isPrivateDeploymentMode("")).toBe(false);
  });
});

describe("version services in private mode", () => {
  test("computer + daemon latest versions come from the local manifest", async () => {
    process.env.RAFT_DEPLOYMENT_MODE = "private";
    try {
      // Fresh module instances see an empty cache; the first getLatest* call
      // triggers the private-mode refresh which reads the fixture manifests.
      // The external fetch branch is never reached (and would fail offline).
      vi.resetModules();
      const computer = await import("../services/computerVersionService.js");
      const daemon = await import("../services/daemonVersionService.js");
      const first = await computer.getLatestComputerVersion();
      const firstDaemon = await daemon.getLatestDaemonVersion();
      // The refresh promise runs after the immediate-null return; drain it.
      await new Promise((resolve) => setImmediate(resolve));
      await new Promise((resolve) => setImmediate(resolve));
      await new Promise((resolve) => setImmediate(resolve));
      const second = await computer.getLatestComputerVersion();
      const secondDaemon = await daemon.getLatestDaemonVersion(); // reads computer manifest daemonVersion
      assert.ok(first === null || first === "9.9.95");
      assert.ok(firstDaemon === null || firstDaemon === "1.0.25-test");
      assert.equal(second, "9.9.95");
      assert.equal(secondDaemon, "1.0.25-test");
    } finally {
      vi.resetModules();
      delete process.env.RAFT_DEPLOYMENT_MODE;
    }
  });
});
