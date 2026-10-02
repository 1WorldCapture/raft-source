import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { test } from "node:test";
import { powerShellQuote, shellQuote } from "../src/utils/commandEscaping";
import {
  getComputerCommandsFromDeployment,
  pinnedChannelVersion,
} from "../src/utils/computerSetupCommand";
import type { DeploymentComputerSetupReady } from "../src/utils/deploymentComputerSetup";

const DEPLOYMENT: DeploymentComputerSetupReady = {
  schemaVersion: 1,
  status: "ready",
  serverUrl: "https://raft.example.private",
  releaseSource: {
    backend: "manifest",
    releaseBase: "https://raft.example.private/computer",
  },
  installChannel: "latest",
};

const HANDS_DEPLOYMENT: DeploymentComputerSetupReady = {
  ...DEPLOYMENT,
  releaseSource: {
    backend: "hands",
    releaseBase: "https://raft.example.private/computer",
    handsOrigin: "https://hands.example.private",
  },
};

test("shell and PowerShell quoting neutralize interpreter metacharacters", () => {
  assert.equal(shellQuote("/acme"), `'/acme'`);
  assert.equal(shellQuote("it's"), `'it'\\''s'`);
  assert.equal(
    shellQuote("$(printf INJECTED) `id` ; a"),
    `'$(printf INJECTED) ` + "`id`" + ` ; a'`,
  );
  assert.equal(powerShellQuote("it's"), `'it''s'`);
  assert.equal(powerShellQuote("$(calc)"), `'$(calc)'`);
});

test("pinnedChannelVersion extracts the semver and rejects non-pin channels", () => {
  assert.equal(pinnedChannelVersion("pinned:1.2.3"), "1.2.3");
  assert.equal(pinnedChannelVersion("pinned:1.2.3-beta.1"), "1.2.3-beta.1");
  assert.equal(pinnedChannelVersion("latest"), null);
  assert.equal(pinnedChannelVersion("alpha"), null);
  assert.equal(pinnedChannelVersion("pinned:not-a-version"), null);
});

test("mac-linux install puts config env on the sh side of the pipe and quotes every value", () => {
  const commands = getComputerCommandsFromDeployment({
    deployment: DEPLOYMENT,
    serverSlug: "acme",
  });
  assert.ok(commands);
  assert.equal(
    commands.install,
    `curl -fsSL 'https://raft.example.private/computer/install.sh' | `
      + `RAFT_COMPUTER_RELEASE_BACKEND='manifest' `
      + `RAFT_COMPUTER_RELEASE_BASE='https://raft.example.private/computer' `
      + `RAFT_COMPUTER_INSTALL_CHANNEL='latest' sh`,
  );
  // Setup always carries the explicit --server-url (contract v1).
  assert.equal(
    commands.setup,
    `raft-computer setup '/acme' --server-url 'https://raft.example.private'`,
  );
  assert.equal(commands.status, "raft-computer status");
  assert.equal(commands.restart, `raft-computer restart '/acme'`);
});

test("hands backend adds RAFT_COMPUTER_HANDS_ORIGIN and pin carries version + channel", () => {
  const commands = getComputerCommandsFromDeployment({
    deployment: HANDS_DEPLOYMENT,
    serverSlug: "acme",
  });
  assert.ok(commands);
  assert.match(commands.install, /RAFT_COMPUTER_HANDS_ORIGIN='https:\/\/hands\.example\.private' /);
  assert.doesNotMatch(commands.install, /RAFT_COMPUTER_VERSION/);

  const pinned = getComputerCommandsFromDeployment({
    deployment: HANDS_DEPLOYMENT,
    serverSlug: "acme",
  });
  const fromChannel = getComputerCommandsFromDeployment({
    deployment: { ...HANDS_DEPLOYMENT, installChannel: "pinned:2.0.0" },
    serverSlug: "acme",
  });
  assert.ok(pinned && fromChannel);
  assert.match(fromChannel.install, /RAFT_COMPUTER_INSTALL_CHANNEL='pinned:2\.0\.0'/);
  assert.match(fromChannel.install, /RAFT_COMPUTER_VERSION='2\.0\.0'/);
  assert.doesNotMatch(pinned.install, /RAFT_COMPUTER_INSTALL_CHANNEL='pinned:/);
});

test("manual version overrides the deployment channel on both platforms", () => {
  const mac = getComputerCommandsFromDeployment({
    deployment: DEPLOYMENT,
    serverSlug: "acme",
    version: "1.0.14",
  });
  assert.ok(mac);
  assert.match(mac.install, /RAFT_COMPUTER_INSTALL_CHANNEL='pinned:1\.0\.14'/);
  assert.match(mac.install, /RAFT_COMPUTER_VERSION='1\.0\.14'/);

  const win = getComputerCommandsFromDeployment({
    deployment: DEPLOYMENT,
    serverSlug: "acme",
    platform: "windows",
    version: "1.0.14",
  });
  assert.ok(win);
  assert.match(win.install, /\$env:RAFT_COMPUTER_VERSION = '1\.0\.14'/);
  assert.match(win.install, /irm 'https:\/\/raft\.example\.private\/computer\/install\.ps1' \| iex/);
});

test("windows commands use PowerShell quoting and assignments", () => {
  const commands = getComputerCommandsFromDeployment({
    deployment: HANDS_DEPLOYMENT,
    serverSlug: "acme",
    platform: "windows",
  });
  assert.ok(commands);
  assert.equal(
    commands.install,
    `$env:RAFT_COMPUTER_RELEASE_BACKEND = 'hands'; `
      + `$env:RAFT_COMPUTER_RELEASE_BASE = 'https://raft.example.private/computer'; `
      + `$env:RAFT_COMPUTER_HANDS_ORIGIN = 'https://hands.example.private'; `
      + `$env:RAFT_COMPUTER_INSTALL_CHANNEL = 'latest'; `
      + `irm 'https://raft.example.private/computer/install.ps1' | iex`,
  );
  assert.equal(
    commands.setup,
    `raft-computer setup '/acme' --server-url 'https://raft.example.private'`,
  );
});

test("machine id adoption is escaped on both platforms", () => {
  const mac = getComputerCommandsFromDeployment({
    deployment: DEPLOYMENT,
    serverSlug: "acme",
    machineId: "m-1",
  });
  const win = getComputerCommandsFromDeployment({
    deployment: DEPLOYMENT,
    serverSlug: "acme",
    platform: "windows",
    machineId: "m-1",
  });
  assert.ok(mac && win);
  assert.match(mac.setup, / --machine 'm-1'$/);
  assert.match(win.setup, / --machine 'm-1'$/);
});

test("isolated home scoping keeps URLs from the deployment config", () => {
  const mac = getComputerCommandsFromDeployment({
    deployment: DEPLOYMENT,
    serverSlug: "acme",
    isolatedHomeSlug: "acme",
  });
  assert.ok(mac);
  // RAFT_HOME rides the sh side of the pipe so the installer sees it.
  assert.match(
    mac.install,
    /^curl -fsSL 'https:\/\/raft\.example\.private\/computer\/install\.sh' \| RAFT_HOME="\$HOME\/\.raft-computer-acme" RAFT_COMPUTER_INSTALL_DIR="\$HOME\/\.raft-computer-acme\/bin" /,
  );
  // Every binary invocation shares the isolated state root and binary path.
  assert.match(
    mac.setup,
    /^RAFT_HOME="\$HOME\/\.raft-computer-acme" RAFT_COMPUTER_INSTALL_DIR="\$HOME\/\.raft-computer-acme\/bin" "\$HOME\/\.raft-computer-acme\/bin\/raft-computer" setup/,
  );
  assert.match(mac.status, /^RAFT_HOME=/);
  assert.doesNotMatch(mac.install, /raft-computer-\$|raft-computer-acme\/bin\/raft-computer'/);

  const win = getComputerCommandsFromDeployment({
    deployment: DEPLOYMENT,
    serverSlug: "acme",
    platform: "windows",
    isolatedHomeSlug: "acme",
  });
  assert.ok(win);
  assert.match(win.install, /^\$env:RAFT_HOME = "\$env:USERPROFILE\\\.raft-computer-acme"; /);
  assert.match(win.setup, /^& "\$env:RAFT_COMPUTER_INSTALL_DIR\\raft-computer\.exe" setup/);
  // The URL source stays the deployment config, not an env-keyed constant.
  assert.match(win.install, /https:\/\/raft\.example\.private\/computer\/install\.ps1/);
});

test("isolated home expands the real home directory while the slug stays inert", () => {
  // Contract review fix: single quotes made $HOME / $env:USERPROFILE literal.
  // The variable reference must sit in double quotes; only the dynamic slug
  // segment is escaped.
  const mac = getComputerCommandsFromDeployment({
    deployment: DEPLOYMENT,
    serverSlug: "acme",
    isolatedHomeSlug: "acme",
  });
  assert.ok(mac);
  assert.match(mac.setup, /RAFT_HOME="\$HOME\/\.raft-computer-acme"/);
  assert.doesNotMatch(mac.setup, /RAFT_HOME='\$HOME/);

  const sneaky = getComputerCommandsFromDeployment({
    deployment: DEPLOYMENT,
    serverSlug: "acme",
    isolatedHomeSlug: "x$(printf INJECTED)y",
  });
  assert.ok(sneaky);
  // The injected $ is escaped inside the double quotes; the $HOME prefix still expands.
  assert.match(sneaky.setup, /RAFT_HOME="\$HOME\/\.raft-computer-x\\\$\(?printf INJECTED\)?y"/);

  const win = getComputerCommandsFromDeployment({
    deployment: DEPLOYMENT,
    serverSlug: "acme",
    platform: "windows",
    isolatedHomeSlug: "a`b\"c",
  });
  assert.ok(win);
  assert.match(win.install, /^\$env:RAFT_HOME = "\$env:USERPROFILE\\\.raft-computer-a``b`"c"; /);
});

test("the hands alpha QA channel passes through as RAFT_COMPUTER_INSTALL_CHANNEL=alpha", () => {
  const commands = getComputerCommandsFromDeployment({
    deployment: { ...HANDS_DEPLOYMENT, installChannel: "alpha" },
    serverSlug: "acme",
  });
  assert.ok(commands);
  assert.match(commands.install, /RAFT_COMPUTER_INSTALL_CHANNEL='alpha'/);
  assert.doesNotMatch(commands.install, /RAFT_COMPUTER_VERSION/);
  assert.doesNotMatch(commands.install, /INSTALL_CHANNEL='pinned:/);
});

test("a missing slug yields no commands at all", () => {
  assert.equal(getComputerCommandsFromDeployment({ deployment: DEPLOYMENT, serverSlug: "  " }), null);
  assert.equal(getComputerCommandsFromDeployment({ deployment: DEPLOYMENT, serverSlug: null }), null);
});

// --- Real-interpreter execution of the generated commands (contract review):
// regexes over generated strings once treated wrong output as expected, so the
// isolated-home path is now evaluated by actual shells. ---

function extractShAssignment(command: string): string {
  // The quoted value may contain escaped quotes (\") — consume escape pairs first.
  const match = command.match(/RAFT_HOME=("(?:\\.|[^"])*"|\S+)/);
  assert.ok(match, `generated command carries a RAFT_HOME assignment: ${command}`);
  return match[0];
}

function extractPwshAssignment(command: string): string {
  // The quoted value may contain backtick-escaped quotes (`") — consume escape pairs first.
  const match = command.match(/\$env:RAFT_HOME = ("(?:`.|[^"])*")/);
  assert.ok(match, `generated command carries a $env:RAFT_HOME assignment: ${command}`);
  return match[0];
}

test("sh expands the isolated home to the real absolute directory and keeps the suffix literal", { skip: process.platform === "win32" }, () => {
  const commands = getComputerCommandsFromDeployment({
    deployment: DEPLOYMENT,
    serverSlug: "acme",
    isolatedHomeSlug: "acme",
  });
  assert.ok(commands);
  const assignment = extractShAssignment(commands.setup);
  const expanded = execFileSync("sh", ["-c", `${assignment}; printf '%s' "$RAFT_HOME"`], {
    encoding: "utf8",
  });
  assert.equal(expanded, `${process.env.HOME}/.raft-computer-acme`);

  const sneaky = getComputerCommandsFromDeployment({
    deployment: DEPLOYMENT,
    serverSlug: "acme",
    isolatedHomeSlug: "x$(printf INJECTED)y",
  });
  assert.ok(sneaky);
  const sneakyAssignment = extractShAssignment(sneaky.setup);
  const sneakyExpanded = execFileSync("sh", ["-c", `${sneakyAssignment}; printf '%s' "$RAFT_HOME"`], {
    encoding: "utf8",
  });
  // $HOME expands; the command-substitution suffix stays literal text.
  assert.equal(sneakyExpanded, `${process.env.HOME}/.raft-computer-x$(printf INJECTED)y`);
});

const pwshProbe = spawnSync("pwsh", ["-NoProfile", "-Command", "Write-Output ok"], { encoding: "utf8" });
const pwshAvailable = !pwshProbe.error && pwshProbe.status === 0 && pwshProbe.stdout.trim() === "ok";

test("pwsh expands USERPROFILE in the isolated home and keeps the suffix literal", { skip: !pwshAvailable && "pwsh not available on this host" }, () => {
  const win = getComputerCommandsFromDeployment({
    deployment: DEPLOYMENT,
    serverSlug: "acme",
    platform: "windows",
    isolatedHomeSlug: "acme",
  });
  assert.ok(win);
  const assignment = extractPwshAssignment(win.install);
  const profile = execFileSync(
    "pwsh",
    ["-NoProfile", "-Command", 'Write-Output "$env:USERPROFILE"'],
    { encoding: "utf8" },
  ).trim();
  const expanded = execFileSync(
    "pwsh",
    ["-NoProfile", "-Command", `${assignment}; Write-Output $env:RAFT_HOME`],
    { encoding: "utf8" },
  ).trim();
  assert.equal(expanded, `${profile}\\.raft-computer-acme`);

  const sneaky = getComputerCommandsFromDeployment({
    deployment: DEPLOYMENT,
    serverSlug: "acme",
    platform: "windows",
    isolatedHomeSlug: 'a`b"c',
  });
  assert.ok(sneaky);
  const sneakyAssignment = extractPwshAssignment(sneaky.install);
  const sneakyExpanded = execFileSync(
    "pwsh",
    ["-NoProfile", "-Command", `${sneakyAssignment}; Write-Output $env:RAFT_HOME`],
    { encoding: "utf8" },
  ).trim();
  assert.equal(sneakyExpanded, `${profile}\\.raft-computer-a\`b"c`);
});
