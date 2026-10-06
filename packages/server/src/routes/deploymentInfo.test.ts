// Task #5 (phase 2): /api/deployment-info — the runtime private-mode answer
// for the mode-agnostic web image. Hermetic: standalone router + env flip.
import assert from "node:assert/strict";
import { afterAll, beforeAll, describe, test } from "vitest";
import express from "express";
import deploymentInfoRouter from "./deploymentInfo.js";

let app: express.Express;
let baseUrl: string;
let server: import("node:http").Server;
const prevMode = process.env.RAFT_DEPLOYMENT_MODE;

beforeAll(async () => {
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
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

describe("GET /api/deployment-info", () => {
  test("reports standard by default and private under the canonical switch", async () => {
    delete process.env.RAFT_DEPLOYMENT_MODE;
    let res = await fetch(`${baseUrl}/api/deployment-info`);
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { deploymentMode: "standard" });

    process.env.RAFT_DEPLOYMENT_MODE = "private";
    res = await fetch(`${baseUrl}/api/deployment-info`);
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { deploymentMode: "private" });
  });
});
