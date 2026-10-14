import { test, expect } from "vitest";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { isOwnedHistoricalLaunchdDefinition } from "./osSupervisor.js";
import { detectLegacyOsSupervisorCarriers } from "./osSupervisorRuntime.js";
import { buildMacosLoginCarrierSpec } from "./macosLoginCarrier.js";

// --- task #38: recognition + detection are read-only and body-independent ---

const LEGACY_LABEL = "build.raft.computer.0123456789abcdef";
const HOME = "/Users/example/.slock";

function legacyDefinition(label: string, keepAlive = "<true/>", home = HOME): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<plist version="1.0"><dict>
  <key>Label</key><string>${label}</string>
  <key>ProgramArguments</key><array>
    <string>/Users/example/.local/bin/raft-computer</string>
    <string>__service</string>
    <string>--slock-home</string>
    <string>${home}</string>
    <string>--os-supervised</string>
    <string>launchd-user</string>
  </array>
  <key>EnvironmentVariables</key><dict>
    <key>RAFT_COMPUTER_OS_SUPERVISOR_OWNER</key>
    <string>raft-computer-os-supervisor-v1-0123456789abcdef</string>
  </dict>
  <key>KeepAlive</key>
  ${keepAlive}
  <key>RunAtLoad</key><true/>
</dict></plist>`;
}

test("#38 recognition ignores the plist body, KeepAlive included", () => {
  // This is why changing buildOsSupervisorSpec's KeepAlive would not have
  // broken retire: recognition never compares the body.
  expect(isOwnedHistoricalLaunchdDefinition(HOME, LEGACY_LABEL, legacyDefinition(LEGACY_LABEL, "<true/>"))).toBe(true);
  expect(isOwnedHistoricalLaunchdDefinition(HOME, LEGACY_LABEL, legacyDefinition(LEGACY_LABEL, "<false/>"))).toBe(true);
  // A login-item carrier must NOT be mistaken for a legacy one.
  const loginSpec = buildMacosLoginCarrierSpec({
    slockHome: HOME,
    dispatcherPath: "/Users/example/.local/bin/raft-computer",
    userHome: "/Users/example",
    uid: 501,
  });
  expect(isOwnedHistoricalLaunchdDefinition(HOME, loginSpec.label, loginSpec.definition)).toBe(false);
});

test("#38 detect is read-only and returns [] off darwin / when absent", async () => {
  await expect(
    detectLegacyOsSupervisorCarriers(HOME, { platform: "linux" }),
  ).resolves.toEqual([]);
  const root = await mkdtemp(join(tmpdir(), "t38-detect-"));
  try {
    await mkdir(join(root, "Library", "LaunchAgents"), { recursive: true });
    await expect(
      detectLegacyOsSupervisorCarriers(join(root, ".slock"), { platform: "darwin", userHome: root, uid: 501 }),
    ).resolves.toEqual([]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("#38 detect finds a legacy carrier and never launches anything", async () => {
  const root = await mkdtemp(join(tmpdir(), "t38-find-"));
  try {
    const laDir = join(root, "Library", "LaunchAgents");
    await mkdir(laDir, { recursive: true });
    await writeFile(join(laDir, `${LEGACY_LABEL}.plist`), legacyDefinition(LEGACY_LABEL, "<true/>", join(root, ".slock")));
    const calls: string[][] = [];
    const found = await detectLegacyOsSupervisorCarriers(join(root, ".slock"), {
      platform: "darwin",
      userHome: root,
      uid: 501,
      runCommand: async (c: string, args: string[]) => {
        calls.push([c, ...args]);
        return { stdout: "", stderr: "", exitCode: 0 } as never;
      },
    });
    expect(found.map((f) => f.id)).toEqual([LEGACY_LABEL]);
    expect(calls, "detection must not mutate anything").toEqual([]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("#38 detection failure degrades to no-op instead of throwing", async () => {
  await expect(
    detectLegacyOsSupervisorCarriers(HOME, {
      platform: "darwin",
      userHome: "/definitely/not/a/home",
      uid: 501,
    }),
  ).resolves.toEqual([]);
});
