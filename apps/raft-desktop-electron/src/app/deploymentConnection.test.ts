import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { access, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { userSessionPath } from "@botiverse/raft-computer/lib";
import { connectDeployment, readDeploymentSelection, type DeploymentConnectionPlan } from "./deploymentConnection.ts";

async function fixture(t: TestContext) {
  const root = await mkdtemp(path.join(tmpdir(), "raft-deployment-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const old = path.join(root, "old");
  await mkdir(path.dirname(userSessionPath(old)), { recursive: true });
  const oldSession = JSON.stringify({ serverUrl: "http://old.invalid", accessToken: "old-fixture", userId: "old-user" });
  await writeFile(userSessionPath(old), oldSession);
  await writeFile(path.join(old, "attachment-fixture.json"), "old attachments");
  const plan: DeploymentConnectionPlan = { currentOrigin: "http://old.invalid", targetOrigin: "https://new.invalid",
    currentHome: old, storageDirectory: path.join(root, "desktop"), connections: ["old-server"] };
  const authenticate = async (home: string, origin: string) => {
    await mkdir(path.dirname(userSessionPath(home)), { recursive: true });
    await writeFile(userSessionPath(home), JSON.stringify({ serverUrl: origin, accessToken: "new-fixture", refreshToken: "fixture-refresh", userId: "new-user" }));
  };
  return { plan, authenticate, oldSession, old };
}

test("cancel confirmation performs no authentication or state mutation", async (t) => {
  const f = await fixture(t);
  let authenticated = false;
  assert.equal(await connectDeployment(f.plan, { confirm: async () => false, authenticate: async () => { authenticated = true; } }), null);
  assert.equal(authenticated, false);
  await assert.rejects(access(f.plan.storageDirectory));
  assert.equal(await readFile(userSessionPath(f.old), "utf8"), f.oldSession);
});

test("failed/cancelled device authorization retains old session, mounts and selection", async (t) => {
  const f = await fixture(t);
  await assert.rejects(connectDeployment(f.plan, { confirm: async () => true, authenticate: async (home, origin) => {
    await f.authenticate(home, origin);
    throw new Error("authentication cancelled");
  } }), /cancelled/);
  assert.equal(await readFile(userSessionPath(f.old), "utf8"), f.oldSession);
  assert.equal(await readFile(path.join(f.old, "attachment-fixture.json"), "utf8"), "old attachments");
  assert.deepEqual(await readdir(f.plan.storageDirectory), []);
  assert.equal(await readDeploymentSelection(f.plan.storageDirectory, f.plan.targetOrigin), null);
});

test("successful authorization atomically selects an empty isolated root and restores it after restart", async (t) => {
  const f = await fixture(t);
  const selected = await connectDeployment(f.plan, { confirm: async (plan) => { assert.deepEqual(plan.connections, ["old-server"]); return true; }, authenticate: f.authenticate });
  assert.ok(selected?.startsWith(f.plan.storageDirectory + path.sep));
  assert.equal(await readDeploymentSelection(f.plan.storageDirectory, f.plan.targetOrigin), selected);
  await assert.rejects(access(path.join(selected!, "attachment-fixture.json")), "old mounts must not be transferred to the new user");
  assert.equal(await readFile(userSessionPath(f.old), "utf8"), f.oldSession);
  assert.equal(await readDeploymentSelection(f.plan.storageDirectory, "https://other.invalid"), null);
});

test("repeated connection reuses the authenticated root without fresh credentials or extra directories", async (t) => {
  const f = await fixture(t);
  let count = 0;
  const deps = { confirm: async () => true, authenticate: async (home: string, origin: string) => { count++; await f.authenticate(home, origin); } };
  const first = await connectDeployment(f.plan, deps);
  const second = await connectDeployment(f.plan, deps);
  assert.equal(first, second);
  assert.equal(count, 1);
  assert.equal((await readdir(f.plan.storageDirectory)).filter((name) => name.startsWith("computer-")).length, 1);
});

test("wrong-origin authorization never switches selection or changes original data", async (t) => {
  const f = await fixture(t);
  await assert.rejects(connectDeployment(f.plan, { confirm: async () => true, authenticate: (home) => f.authenticate(home, "http://unexpected.invalid") }), /有效登录/);
  assert.equal(await readDeploymentSelection(f.plan.storageDirectory, f.plan.targetOrigin), null);
  assert.equal(await readFile(userSessionPath(f.old), "utf8"), f.oldSession);
});

test("switching accounts requires independent authorization and retains previous roots", async (t) => {
  const f = await fixture(t);
  const first = await connectDeployment(f.plan, { confirm: async () => true, authenticate: f.authenticate });
  await assert.rejects(connectDeployment({ ...f.plan, targetUserId: "another-user" }, {
    confirm: async () => true, authenticate: f.authenticate,
  }), /账号不同/);
  assert.equal(await readDeploymentSelection(f.plan.storageDirectory, f.plan.targetOrigin), first);
  assert.equal(await readFile(userSessionPath(f.old), "utf8"), f.oldSession);
});


test("quit cancelling after device authentication cannot commit a new root", async (t) => {
  const f = await fixture(t);
  const abort = new AbortController();
  await assert.rejects(connectDeployment(f.plan, {
    signal: abort.signal, confirm: async () => true,
    authenticate: async (home, origin) => { await f.authenticate(home, origin); abort.abort(); },
  }), { name: "AbortError" });
  assert.equal(await readDeploymentSelection(f.plan.storageDirectory, f.plan.targetOrigin), null);
  assert.deepEqual(await readdir(f.plan.storageDirectory), []);
  assert.equal(await readFile(userSessionPath(f.old), "utf8"), f.oldSession);
});


test("corrupt selection blocks restoration but explicit connection can recover without touching the old root", async (t) => {
  const f = await fixture(t);
  await mkdir(f.plan.storageDirectory, { recursive: true });
  await writeFile(path.join(f.plan.storageDirectory, "selected-root.json"), "null");
  await assert.rejects(readDeploymentSelection(f.plan.storageDirectory, f.plan.targetOrigin), SyntaxError);
  const selected = await connectDeployment(f.plan, { confirm: async () => true, authenticate: f.authenticate });
  assert.equal(await readDeploymentSelection(f.plan.storageDirectory, f.plan.targetOrigin), selected);
  assert.equal(await readFile(userSessionPath(f.old), "utf8"), f.oldSession);
});
