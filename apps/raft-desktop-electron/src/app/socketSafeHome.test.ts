import assert from "node:assert/strict";
import test from "node:test";
import { chooseSocketSafeHome, serviceSocketFor, socketBytes } from "./socketSafeHome.ts";

const LONG = "/Users/lyon/Library/Application Support/@botiverse/raft-desktop-electron/computer-deployments/computer-slock-raft";
const ALIAS = "/Users/lyon/.slock-raft";
const realOf = (map: Record<string, string>) => (p: string) => { if (p in map) return map[p]; throw new Error("ENOENT"); };

test("a short home is used as is", () => {
  assert.deepEqual(chooseSocketSafeHome("/Users/lyon/.slock", { aliasPath: ALIAS, realpath: realOf({}) }), { home: "/Users/lyon/.slock", usedAlias: false });
});

test("the owner's case: a deployment home whose socket path is too long is reached through the ~/.slock-raft alias that points at it", () => {
  assert.ok(socketBytes(LONG) > 103, "the long real path really is over the limit");
  const r = chooseSocketSafeHome(LONG, { aliasPath: ALIAS, realpath: realOf({ [ALIAS]: LONG, [LONG]: LONG }) });
  assert.deepEqual(r, { home: ALIAS, usedAlias: true });
  assert.ok(Buffer.byteLength(serviceSocketFor(ALIAS)) <= 103);
});

test("too long and no alias (or an alias pointing elsewhere): a clear error, never a silent bind failure", () => {
  for (const real of [realOf({}), realOf({ [ALIAS]: "/somewhere/else", [LONG]: LONG })]) {
    const r = chooseSocketSafeHome(LONG, { aliasPath: ALIAS, realpath: real });
    assert.equal(r.usedAlias, false);
    assert.match(r.error ?? "", /too deep for its socket \(\d+ bytes, the limit is 103\)/);
    assert.equal(r.home, LONG);
  }
});

test("the 103-byte boundary: 103 passes, 104 does not", () => {
  const pad = (n: number) => "/h" + "x".repeat(Math.max(0, n - Buffer.byteLength("/h" + "/computer/run/service.sock")));
  assert.equal(socketBytes(pad(103)), 103);
  assert.equal(chooseSocketSafeHome(pad(103), { realpath: realOf({}) }).error, undefined);
  assert.ok(chooseSocketSafeHome(pad(104), { aliasPath: ALIAS, realpath: realOf({}) }).error);
});
