// Real HTTP stalls exercise the same Computer API and quit gate as the app.
// Every session, selection and server belongs to this test's temporary root.
import assert from "node:assert/strict";
import test from "node:test";
import { createServer } from "node:http";
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createComputerApi, userSessionPath } from "@botiverse/raft-computer/lib";

// quitFlow only touches native power monitoring when its flow is invoked.
// Its controller itself stays platform independent.
for (const phase of ["authorize", "token", "me"] as const) {
  test(`quit settles an in-flight ${phase} response and preserves the old Computer`, { timeout: 15_000 }, async (t) => {
    const root = await mkdtemp(path.join(tmpdir(), "raft-quit-auth-"));
    t.after(() => rm(root, { recursive: true, force: true }));
    t.mock.module("electron", { namedExports: {
      app: { getPath: () => root }, dialog: {}, powerMonitor: {},
    } });
    const { ComputerHost } = await import("./computerHost.ts");
    const { createQuitController } = await import("../main/quitFlow.ts");
    const old = path.join(root, "old");
    const storage = path.join(root, "desktop");
    await mkdir(path.dirname(userSessionPath(old)), { recursive: true });
    const previous = JSON.stringify({ serverUrl: "https://old.invalid", accessToken: "old-fixture", refreshToken: "old-refresh", userId: "old-user" });
    await writeFile(userSessionPath(old), previous);
    let reached!: () => void;
    const seen = new Promise<void>((resolve) => { reached = resolve; });
    const server = createServer((request, response) => {
      const current = request.url?.split("/").at(-1);
      response.setHeader("content-type", "application/json");
      response.statusCode = current === "authorize" ? 201 : 200;
      if (current === phase) {
        response.write("{"); // preserve an unfinished response body
        reached();
      } else if (current === "authorize") {
        response.end(JSON.stringify({ deviceCode: "fixture", userCode: "ABCD-1234", verificationUri: "/login/device", expiresIn: 30, interval: 1 }));
      } else if (current === "token") {
        response.end(JSON.stringify({ accessToken: "fixture", refreshToken: "fixture", userId: "new-user" }));
      } else { response.end("{}"); }
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    t.after(async () => {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    });
    const address = server.address();
    assert.ok(address && typeof address === "object");
    const origin = `http://127.0.0.1:${address.port}`;
    const host = new ComputerHost({ home: old, storageDirectory: storage, configuredOrigin: origin });
    const abort = new AbortController();
    t.after(() => abort.abort());
    const connection = host.connectCurrentDeployment({ signal: abort.signal,
      confirm: async () => true,
      authenticate: (home, url) => {
        assert.ok(home.startsWith(storage + path.sep));
        return createComputerApi(home).login({ serverUrl: url }, undefined, { signal: abort.signal }).then(() => {});
      },
    }).then(() => null, (error: unknown) => error);
    await seen;
    let complete!: () => void;
    const done = new Promise<void>((resolve) => { complete = resolve; });
    let finished = false;
    const quit = createQuitController({
      attempt: () => host.runQuitAttempt(async () => { await host.waitForConnection(); return true; }),
      complete: () => { finished = true; complete(); }, failed: (error) => { throw error; },
    });
    quit.beforeQuit({ preventDefault() {} });
    await Promise.resolve();
    assert.equal(finished, false, "quit must wait until cancellation has finished");
    abort.abort(); // the main-process before-quit listener cancels this signal
    let watchdog!: ReturnType<typeof setTimeout>;
    try {
      await Promise.race([done, new Promise<never>((_, reject) => {
        watchdog = setTimeout(() => reject(new Error("quit blocked on cancelled authentication")), 5_000);
      })]);
    } finally { clearTimeout(watchdog); }
    const error = await connection;
    assert.ok(error instanceof Error);
    assert.equal(error.name, "AbortError");
    assert.equal(host.slockHome, old);
    assert.equal(await readFile(userSessionPath(old), "utf8"), previous);
    assert.deepEqual(await readdir(storage), []);
  });
}
