import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { COMPUTER_HOST_FILE, defaultBinaryPath, defaultStandaloneHome, parseHostMode, readHostMode, writeHostMode } from "./hostMode.ts";

test("no file, malformed file and unknown mode all mean 'embedded' (today's behavior stays the default)", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "host-mode-"));
  try {
    assert.deepEqual(await readHostMode(dir), { mode: "embedded" });
    await writeFile(path.join(dir, COMPUTER_HOST_FILE), "{not json");
    assert.deepEqual(await readHostMode(dir), { mode: "embedded" });
    assert.deepEqual(parseHostMode({ mode: "standalone" }), { mode: "embedded" }, "standalone without a home is not trusted");
    assert.deepEqual(parseHostMode({ mode: "standalone", home: "relative/path" }), { mode: "embedded" });
    assert.deepEqual(parseHostMode({ mode: "weird", home: "/x" }), { mode: "embedded" });
    assert.deepEqual(parseHostMode(null), { mode: "embedded" });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("standalone mode round-trips through the file", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "host-mode-"));
  try {
    await writeHostMode(dir, { mode: "standalone", home: "/Users/x/.slock" });
    assert.deepEqual(await readHostMode(dir), { mode: "standalone", home: "/Users/x/.slock" });
    assert.match(await readFile(path.join(dir, COMPUTER_HOST_FILE), "utf8"), /"standalone"/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("default locations: ~/.slock (env override wins) and ~/.local/bin/raft-computer", () => {
  assert.equal(defaultStandaloneHome({}, "/Users/x"), path.join("/Users/x", ".slock"));
  assert.equal(defaultStandaloneHome({ RAFT_HOME: "/tmp/iso" }, "/Users/x"), "/tmp/iso");
  assert.equal(defaultStandaloneHome({ SLOCK_HOME: "/tmp/iso2" }, "/Users/x"), "/tmp/iso2");
  assert.equal(defaultBinaryPath("/Users/x"), path.join("/Users/x", ".local", "bin", "raft-computer"));
});
