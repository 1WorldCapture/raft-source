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

  await t.test("cleanupLegacyLoginAgents removes only THIS app's legacy plists; standalone installs stay", async () => {
    const os = await import("node:os");
    const path = await import("node:path");
    const fs = await import("node:fs/promises");
    const home = await fs.mkdtemp(path.join(os.tmpdir(), "raft-loginitem-"));
    const agentsDir = path.join(home, "Library", "LaunchAgents");
    await fs.mkdir(agentsDir, { recursive: true });
    const ownExe = "/Applications/Raft Desktop.app/Contents/MacOS/Raft Desktop";
    const ownHome = "/Users/tester/.slock";
    const carrier = (dispatcher: string, slockHome: string) => [
      "<?xml version=\"1.0\"?><plist version=\"1.0\"><dict><key>Label</key><string>x</string>",
      "<key>ProgramArguments</key><array>",
      `<string>${dispatcher}</string>`,
      "<string>__service</string>",
      "<string>--slock-home</string>",
      `<string>${slockHome}</string>`,
      "</array></dict></plist>",
    ].join("");
    const oursA = path.join(agentsDir, `${LEGACY_LOGIN_LABEL_PREFIX}abcdef12.plist`);
    const standalone = path.join(agentsDir, `${LEGACY_LOGIN_LABEL_PREFIX}deadbeef.plist`); // CLI raft-computer's
    const otherHome = path.join(agentsDir, `${LEGACY_LOGIN_LABEL_PREFIX}cafe1234.plist`); // ours, different SLOCK_HOME
    const stranger = path.join(agentsDir, "com.example.other.plist");
    await fs.writeFile(oursA, carrier(ownExe, ownHome));
    await fs.writeFile(standalone, carrier("/usr/local/bin/raft-computer", "/Users/tester/.slock"));
    await fs.writeFile(otherHome, carrier(ownExe, "/Users/other/.slock"));
    await fs.writeFile(stranger, "x");

    const realHome = process.env.HOME;
    process.env.HOME = home;
    try {
      const result = await cleanupLegacyLoginAgents(async (dir) => fs.readdir(dir), {
        readFile: fs.readFile,
        rm: fs.rm,
        ownExecutablePath: ownExe,
        ownSlockHome: ownHome,
      });
      assert.deepEqual(result.removed, [`${LEGACY_LOGIN_LABEL_PREFIX}abcdef12`]);
      assert.deepEqual(result.skipped.map((s) => s.label).sort(), [
        `${LEGACY_LOGIN_LABEL_PREFIX}cafe1234`,
        `${LEGACY_LOGIN_LABEL_PREFIX}deadbeef`,
      ].sort(), "standalone installs and other homes are left alone (and logged)");
      // Deletion is file-only by construction (deps inject rm; no launchctl
      // in the cleanup path), so a running job can never be SIGTERMed.
      const left = (await fs.readdir(agentsDir)).sort();
      assert.ok(left.includes(`${LEGACY_LOGIN_LABEL_PREFIX}deadbeef.plist`));
      assert.ok(!left.includes(`${LEGACY_LOGIN_LABEL_PREFIX}abcdef12.plist`));
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
      const result = await cleanupLegacyLoginAgents(async (dir) => fs.readdir(dir), {
        readFile: fs.readFile,
        rm: fs.rm,
        ownExecutablePath: "/opt/x",
        ownSlockHome: "/Users/x/.slock",
      });
      assert.deepEqual(result, { removed: [], skipped: [] });
    } finally {
      process.env.HOME = realHome;
      await fs.rm(home, { recursive: true, force: true });
    }
  });
});

test("isolated test build: login items are a full no-op (task #13 review)", async (t) => {
  const { setLoginItemAtLogin, getLoginItemAtLogin, cleanupLegacyLoginAgents, setIsolatedLoginItemsNoopForTests } =
    await import("./loginItem.ts");
  const os = await import("node:os");
  const path = await import("node:path");
  const fs = await import("node:fs/promises");

  t.after(() => setIsolatedLoginItemsNoopForTests(null));
  setIsolatedLoginItemsNoopForTests(true);

  await t.test("setLoginItemAtLogin(true/false) touch nothing", async () => {
    const home = await fs.mkdtemp(path.join(os.tmpdir(), "raft-loginitem-iso-"));
    const realHome = process.env.HOME;
    process.env.HOME = home;
    try {
      // Any filesystem or launchctl effect would land under this fake HOME's
      // LaunchAgents; both branches must leave it untouched (and not throw —
      // a throw would fail the host's startup converge).
      await setLoginItemAtLogin(true);
      await setLoginItemAtLogin(false);
      const agents = path.join(home, "Library", "LaunchAgents");
      const exists = await fs.stat(agents).then(() => true, () => false);
      assert.equal(exists, false, "no LaunchAgents dir should be created");
    } finally {
      process.env.HOME = realHome;
      await fs.rm(home, { recursive: true, force: true });
    }
  });

  await t.test("getLoginItemAtLogin always reads disabled", async () => {
    const home = await fs.mkdtemp(path.join(os.tmpdir(), "raft-loginitem-iso2-"));
    const realHome = process.env.HOME;
    process.env.HOME = home;
    try {
      // Even with the OWNER's plist present on disk, an isolated build must
      // not adopt its state.
      const agents = path.join(home, "Library", "LaunchAgents");
      await fs.mkdir(agents, { recursive: true });
      await fs.writeFile(
        path.join(agents, `${(await import("./loginItem.ts")).LOGIN_AGENT_LABEL}.plist`),
        "<plist></plist>",
      );
      assert.equal(await getLoginItemAtLogin(), false);
    } finally {
      process.env.HOME = realHome;
      await fs.rm(home, { recursive: true, force: true });
    }
  });

  await t.test("cleanupLegacyLoginAgents skips without listing or deleting", async () => {
    let listed = false;
    let removed = false;
    const result = await cleanupLegacyLoginAgents(async () => {
      listed = true;
      return ["build.raft.computer.login.abcdef12.plist"];
    }, {
      readFile: (async () => "<plist></plist>") as unknown as typeof import("node:fs/promises").readFile,
      rm: async () => { removed = true; },
      ownExecutablePath: "/opt/x",
      ownSlockHome: "/Users/x/.slock",
    });
    assert.deepEqual(result, { removed: [], skipped: [] });
    assert.equal(listed, false, "must not even list the owner's LaunchAgents");
    assert.equal(removed, false);
  });
});
