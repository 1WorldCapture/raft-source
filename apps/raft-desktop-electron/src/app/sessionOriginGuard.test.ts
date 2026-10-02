import assert from "node:assert/strict";
import test from "node:test";

import {
  checkSessionOrigin,
  describeSessionOriginMismatch,
} from "./sessionOriginGuard.js";

function fs(files: Record<string, string>) {
  return {
    readFile: (async (file: string) => {
      if (!(file in files)) {
        const err = new Error("ENOENT") as NodeJS.ErrnoException;
        err.code = "ENOENT";
        throw err;
      }
      return files[file];
    }) as typeof import("node:fs/promises").readFile,
  };
}

const HOME = "/Users/test/.slock";
const SESSION = `${HOME}/computer/user-session.json`;

test("checkSessionOrigin: matching session origin → ok", async () => {
  const deps = fs({ [SESSION]: JSON.stringify({ serverUrl: "https://raft.example.com" }) });
  const check = await checkSessionOrigin(HOME, "https://raft.example.com", deps);
  assert.equal(check.status, "ok");
});

test("checkSessionOrigin: foreign deployment session → mismatch (the 2026-10-02 incident shape)", async () => {
  const deps = fs({ [SESSION]: JSON.stringify({ serverUrl: "http://grokbot.example.net:3001" }) });
  const check = await checkSessionOrigin(HOME, "https://raft.example.com", deps);
  assert.equal(check.status, "mismatch");
  assert.equal(check.sessionOrigin, "http://grokbot.example.net:3001");
  const text = describeSessionOriginMismatch(check);
  assert.match(text, /grokbot\.example\.net:3001/);
  assert.match(text, /raft\.example\.com/);
  assert.match(text, /Sign out/);
});

test("checkSessionOrigin: missing session file → none (fresh machine)", async () => {
  const check = await checkSessionOrigin(HOME, "https://raft.example.com", fs({}));
  assert.equal(check.status, "none");
});

test("checkSessionOrigin: garbage JSON → none (no origin evidence)", async () => {
  const deps = fs({ [SESSION]: "{not json" });
  const check = await checkSessionOrigin(HOME, "https://raft.example.com", deps);
  assert.equal(check.status, "none");
});

test("checkSessionOrigin: session without serverUrl → none", async () => {
  const deps = fs({ [SESSION]: JSON.stringify({ kind: "user-session" }) });
  const check = await checkSessionOrigin(HOME, "https://raft.example.com", deps);
  assert.equal(check.status, "none");
});

test("checkSessionOrigin: path/query in serverUrl is dropped (origin compare)", async () => {
  const deps = fs({ [SESSION]: JSON.stringify({ serverUrl: "https://raft.example.com/api?x=1" }) });
  const check = await checkSessionOrigin(HOME, "https://raft.example.com", deps);
  assert.equal(check.status, "ok");
});

test("checkSessionOrigin: trailing slash matches (origin normalize)", async () => {
  const deps = fs({ [SESSION]: JSON.stringify({ serverUrl: "https://raft.example.com/" }) });
  const check = await checkSessionOrigin(HOME, "https://raft.example.com", deps);
  assert.equal(check.status, "ok");
});
