import assert from "node:assert/strict";
import test from "node:test";
import { normalizeServerOrigin, resolveBundledServerOrigin } from "./origin.ts";

test("normalizeServerOrigin adds https for public hosts and strips /api", () => {
  assert.equal(normalizeServerOrigin("raft.example.com"), "https://raft.example.com");
  assert.equal(normalizeServerOrigin("https://raft.example.com/api/"), "https://raft.example.com");
});

test("normalizeServerOrigin keeps http for local and IP hosts", () => {
  assert.equal(normalizeServerOrigin("127.0.0.1:8787"), "http://127.0.0.1:8787");
  assert.equal(normalizeServerOrigin("http://192.168.1.20:3000"), "http://192.168.1.20:3000");
});

test("resolveBundledServerOrigin uses the env override and falls back to the default domain", () => {
  assert.equal(resolveBundledServerOrigin(undefined), "http://grokbot.tailf3efbe.ts.net:3001");
  assert.equal(resolveBundledServerOrigin("  "), "http://grokbot.tailf3efbe.ts.net:3001");
  assert.equal(resolveBundledServerOrigin("https://raft.example.com/api"), "https://raft.example.com");
  assert.equal(resolveBundledServerOrigin("https://raft.example.com/app"), "http://grokbot.tailf3efbe.ts.net:3001");
});

test("normalizeServerOrigin rejects paths and credentials", () => {
  assert.throws(() => normalizeServerOrigin("https://raft.example.com/app"), /origin/);
  assert.throws(() => normalizeServerOrigin("https://user:pass@raft.example.com"), /password/);
  assert.throws(() => normalizeServerOrigin(""), /Enter the server address/);
});
