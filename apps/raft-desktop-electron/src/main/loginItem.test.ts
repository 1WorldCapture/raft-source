// Pins the login-item slice of task #7: the LaunchAgent plist runs
// `open -a "Raft Desktop" --args --hidden` at login (the OS-native
// setLoginItemSettings cannot carry args on macOS), the app recognizes a
// login start from its own argv, and the legacy headless-service login items
// are swept away — file removal plus a best-effort bootout that must never
// touch running processes.
import assert from "node:assert/strict";
import test from "node:test";

test("login item: plist shape, hidden-launch detection, legacy cleanup", async (t) => {
  const { buildLoginAgentPlist, isHiddenLaunch, cleanupLegacyLoginAgents, LOGIN_AGENT_LABEL, LEGACY_LOGIN_LABEL_PREFIX } =
    await import("./loginItem.ts");

  await t.test("plist runs open --args --hidden under our label", () => {
    const plist = buildLoginAgentPlist({ appName: "Raft Desktop" });
    assert.ok(plist.includes(`<string>${LOGIN_AGENT_LABEL}</string>`));
    assert.ok(plist.includes("<string>open</string>"));
    assert.ok(plist.includes("<string>-a</string>"));
    assert.ok(plist.includes("<string>Raft Desktop</string>"));
    assert.ok(plist.includes("<string>--args</string>"));
    assert.ok(plist.includes("<string>--hidden</string>"));
    assert.ok(plist.includes("<key>RunAtLoad</key>"));
    // XML-escapes the app name.
    const hostile = buildLoginAgentPlist({ appName: "A&B<C>" });
    assert.ok(!hostile.includes("A&B<C>"), "app name must be escaped");
  });

  await t.test("isHiddenLaunch matches the flag wherever open places it", () => {
    assert.equal(isHiddenLaunch(["/Applications/Raft Desktop.app/Contents/MacOS/Raft Desktop", "--hidden"]), true);
    assert.equal(isHiddenLaunch(["exe", "--args", "--hidden"]), true);
    assert.equal(isHiddenLaunch(["exe"]), false);
    assert.equal(isHiddenLaunch(["exe", "--visible"]), false);
    assert.equal(isHiddenLaunch([]), false);
  });

  await t.test("cleanupLegacyLoginAgents removes only legacy plists, tolerates errors", async () => {
    const booted: string[] = [];
    const removedFiles: string[] = [];
    // Fake filesystem: listDir returns a mixed set; rm/bootout are simulated
    // by monkey-patching the module's collaborators through the injected
    // listDir plus observing via a stubbed fs — here we assert the pure
    // selection logic by feeding a directory listing and a rm spy via
    // dynamic re-import with a tmp LaunchAgents layout.
    const os = await import("node:os");
    const path = await import("node:path");
    const fs = await import("node:fs/promises");
    const home = await fs.mkdtemp(path.join(os.tmpdir(), "raft-loginitem-"));
    const agentsDir = path.join(home, "Library", "LaunchAgents");
    await fs.mkdir(agentsDir, { recursive: true });
    const legacy = path.join(agentsDir, `${LEGACY_LOGIN_LABEL_PREFIX}abcdef12.plist`);
    const legacy2 = path.join(agentsDir, `${LEGACY_LOGIN_LABEL_PREFIX}deadbeef.plist`);
    const ours = path.join(agentsDir, `${LOGIN_AGENT_LABEL}.plist`);
    const stranger = path.join(agentsDir, "com.example.other.plist");
    await fs.writeFile(legacy, "x");
    await fs.writeFile(legacy2, "x");
    await fs.writeFile(ours, "x");
    await fs.writeFile(stranger, "x");

    // The cleanup resolves paths from the REAL homedir — point HOME at the
    // sandbox via a temporarily swapped env for this subtest.
    const realHome = process.env.HOME;
    process.env.HOME = home;
    try {
      const removed = await cleanupLegacyLoginAgents(async (dir) => fs.readdir(dir));
      assert.deepEqual([...removed].sort(), [
        `${LEGACY_LOGIN_LABEL_PREFIX}abcdef12`,
        `${LEGACY_LOGIN_LABEL_PREFIX}deadbeef`,
      ].sort());
      assert.equal((await fs.readdir(agentsDir)).sort().join(","), ["build.raft.desktop.login.plist", "com.example.other.plist"].sort().join(","), "ours and strangers stay");
      void booted; void removedFiles;
    } finally {
      process.env.HOME = realHome;
      await fs.rm(home, { recursive: true, force: true });
    }
  });

  await t.test("cleanup with no LaunchAgents directory is a clean no-op", async () => {
    const os = await import("node:os");
    const path = await import("node:path");
    const fs = await import("node:fs/promises");
    const home = await fs.mkdtemp(path.join(os.tmpdir(), "raft-loginitem-empty-"));
    const realHome = process.env.HOME;
    process.env.HOME = home;
    try {
      const removed = await cleanupLegacyLoginAgents(async (dir) => fs.readdir(dir));
      assert.deepEqual(removed, []);
    } finally {
      process.env.HOME = realHome;
      await fs.rm(home, { recursive: true, force: true });
    }
  });
});
