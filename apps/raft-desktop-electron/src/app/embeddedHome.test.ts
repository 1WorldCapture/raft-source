import assert from "node:assert/strict";
import test from "node:test";
import { resolveEmbeddedHome } from "./embeddedHome.ts";

const base = { storageDirectory: "/ud/computer-deployments", configuredOrigin: "https://x", defaultHome: () => "/env/home" };

test("a saved deployment selection wins over the environment home, via the socket-safe choice", async () => {
  const home = await resolveEmbeddedHome({ ...base, readSelection: async () => "/ud/computer-deployments/very/deep", socketSafe: (h) => ({ home: h === "/ud/computer-deployments/very/deep" ? "/alias" : h, usedAlias: true }) });
  assert.equal(home, "/alias");
});

test("no selection, or an unreadable one, falls back to the default home", async () => {
  assert.equal(await resolveEmbeddedHome({ ...base, readSelection: async () => null }), "/env/home");
  assert.equal(await resolveEmbeddedHome({ ...base, readSelection: async () => { throw new Error("bad"); } }), "/env/home");
});
