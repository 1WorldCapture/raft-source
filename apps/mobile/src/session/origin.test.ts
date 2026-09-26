import assert from "node:assert/strict";
import test from "node:test";
import { normalizeServerOrigin } from "./origin.ts";

test("normalizeServerOrigin adds https for public hosts and strips /api", () => {
  assert.equal(normalizeServerOrigin("raft.example.com"), "https://raft.example.com");
  assert.equal(normalizeServerOrigin("https://raft.example.com/api/"), "https://raft.example.com");
});

test("normalizeServerOrigin keeps http for local and IP hosts", () => {
  assert.equal(normalizeServerOrigin("127.0.0.1:8787"), "http://127.0.0.1:8787");
  assert.equal(normalizeServerOrigin("http://192.168.1.20:3000"), "http://192.168.1.20:3000");
});

test("normalizeServerOrigin rejects paths and credentials", () => {
  assert.throws(() => normalizeServerOrigin("https://raft.example.com/app"), /origin/);
  assert.throws(() => normalizeServerOrigin("https://user:pass@raft.example.com"), /password/);
  assert.throws(() => normalizeServerOrigin(""), /Enter the server address/);
});
