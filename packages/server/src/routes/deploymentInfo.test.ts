// Task #5/#6 (phase 2): /api/deployment-info — the runtime private-mode
// answer for the mode-agnostic web image, plus (private mode) the trusted
// download URLs. Security guard (PM review): URLs derive ONLY from the
// configured SERVER_URL — a forged Host/X-Forwarded-Host must not move them.
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, test } from "vitest";
import express from "express";
import deploymentInfoRouter from "./deploymentInfo.js";

let dir: string;
let app: express.Express;
let baseUrl: string;
let server: import("node:http").Server;
const prevMode = process.env.RAFT_DEPLOYMENT_MODE;
const prevServerUrl = process.env.SERVER_URL;
const prevDownloadsDir = process.env.RAFT_DOWNLOADS_DIR;

beforeAll(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "deployment-info-"));
  await mkdir(path.join(dir, "cli"), { recursive: true });
  await mkdir(path.join(dir, "daemon"), { recursive: true });
  await mkdir(path.join(dir, "cli", "0.0.24-zcode.1"), { recursive: true });
  await mkdir(path.join(dir, "daemon", "1.0.25"), { recursive: true });
  await writeFile(path.join(dir, "cli", "manifest.json"), JSON.stringify({ version: "0.0.24-zcode.1" }));
  await writeFile(path.join(dir, "daemon", "manifest.json"), JSON.stringify({ version: "1.0.25" }));
  await writeFile(path.join(dir, "cli", "0.0.24-zcode.1", "raft-0.0.24-zcode.1.tgz"), "cli-bytes");
  await writeFile(path.join(dir, "daemon", "1.0.25", "raft-daemon-1.0.25.tgz"), "daemon-bytes");
  process.env.RAFT_DOWNLOADS_DIR = dir;

  app = express();
  app.use("/api/deployment-info", deploymentInfoRouter);
  await new Promise<void>((resolve) => {
    server = app.listen(0, "127.0.0.1", () => {
      baseUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
      resolve();
    });
  });
});

afterAll(async () => {
  if (prevMode === undefined) delete process.env.RAFT_DEPLOYMENT_MODE;
  else process.env.RAFT_DEPLOYMENT_MODE = prevMode;
  if (prevServerUrl === undefined) delete process.env.SERVER_URL;
  else process.env.SERVER_URL = prevServerUrl;
  if (prevDownloadsDir === undefined) delete process.env.RAFT_DOWNLOADS_DIR;
  else process.env.RAFT_DOWNLOADS_DIR = prevDownloadsDir;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await rm(dir, { recursive: true, force: true });
});

describe("GET /api/deployment-info", () => {
  test("reports standard by default and private under the canonical switch", async () => {
    delete process.env.RAFT_DEPLOYMENT_MODE;
    delete process.env.SERVER_URL;
    let res = await fetch(`${baseUrl}/api/deployment-info`);
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { deploymentMode: "standard" });

    process.env.RAFT_DEPLOYMENT_MODE = "private";
    res = await fetch(`${baseUrl}/api/deployment-info`);
    assert.equal((await res.json()).deploymentMode, "private");
  });

  test("private mode carries download URLs built from the manifest versions", async () => {
    process.env.RAFT_DEPLOYMENT_MODE = "private";
    process.env.SERVER_URL = "https://raft.internal.example:18443/";
    const res = await fetch(`${baseUrl}/api/deployment-info`);
    assert.deepEqual(await res.json(), {
      deploymentMode: "private",
      downloads: {
        computerBase: "https://raft.internal.example:18443/downloads/computer",
        cli: "https://raft.internal.example:18443/downloads/cli/0.0.24-zcode.1/raft-0.0.24-zcode.1.tgz",
        daemon: "https://raft.internal.example:18443/downloads/daemon/1.0.25/raft-daemon-1.0.25.tgz",
      },
    });
  });

  test("every served download URL resolves to a real file in the downloads tree (acceptance D2)", async () => {
    process.env.RAFT_DEPLOYMENT_MODE = "private";
    process.env.SERVER_URL = "https://raft.internal.example:18443";
    const res = await fetch(`${baseUrl}/api/deployment-info`);
    const { downloads } = (await res.json()) as { downloads: Record<string, string> };
    const { access } = await import("node:fs/promises");
    // File URLs (cli/daemon) must resolve to real files; computerBase is a
    // directory prefix by contract, checked separately when the tree has one.
    for (const [key, url] of Object.entries(downloads)) {
      if (key === "computerBase") continue;
      const filePath = url.replace("https://raft.internal.example:18443/downloads/", "");
      await access(path.join(dir, filePath)); // throws (fails the test) if the URL is a 404
    }
  });

  test("forged Host / X-Forwarded-Host never move the download URLs (host-header injection)", async () => {
    process.env.RAFT_DEPLOYMENT_MODE = "private";
    process.env.SERVER_URL = "https://raft.internal.example:18443";
    const res = await fetch(`${baseUrl}/api/deployment-info`, {
      headers: { Host: "evil.example", "X-Forwarded-Host": "evil.example" },
    });
    const body = (await res.json()) as { downloads?: { cli?: string; daemon?: string; computerBase?: string } };
    assert.equal(body.downloads?.computerBase, "https://raft.internal.example:18443/downloads/computer");
    assert.equal(body.downloads?.cli?.startsWith("https://raft.internal.example:18443/"), true);
    assert.equal(JSON.stringify(body).includes("evil.example"), false);
  });

  test("private without SERVER_URL omits downloads rather than guessing an origin", async () => {
    process.env.RAFT_DEPLOYMENT_MODE = "private";
    delete process.env.SERVER_URL;
    const res = await fetch(`${baseUrl}/api/deployment-info`);
    assert.deepEqual(await res.json(), { deploymentMode: "private" });
  });

  test("operator-configured link replacements ride along (task #7)", async () => {
    process.env.RAFT_DEPLOYMENT_MODE = "private";
    process.env.SERVER_URL = "https://raft.internal.example:18443";
    process.env.RAFT_PUBLIC_DOCS_URL = "https://docs.internal.example";
    process.env.RAFT_PUBLIC_TERMS_URL = "https://internal.example/terms";
    process.env.RAFT_PUBLIC_PRIVACY_URL = "https://internal.example/privacy";
    try {
      const res = await fetch(`${baseUrl}/api/deployment-info`);
      const body = (await res.json()) as { links?: Record<string, unknown> };
      assert.equal(body.links?.docsUrl, "https://docs.internal.example");
      assert.deepEqual(body.links?.legal, {
        termsUrl: "https://internal.example/terms",
        privacyUrl: "https://internal.example/privacy",
      });
    } finally {
      delete process.env.RAFT_PUBLIC_DOCS_URL;
      delete process.env.RAFT_PUBLIC_TERMS_URL;
      delete process.env.RAFT_PUBLIC_PRIVACY_URL;
    }
  });
});
