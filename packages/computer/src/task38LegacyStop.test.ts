import { test, expect } from "vitest";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { stop } from "./services/stop.js";
import { ComputerServiceError } from "./services/errors.js";
import { serverAttachmentPath, servicePidPath } from "./paths.js";

const SERVER_A = "11111111-1111-4111-8111-111111111111";
const LEGACY_LABEL = "build.raft.computer.0123456789abcdef";

function legacyDefinition(home: string): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<plist version="1.0"><dict>
  <key>Label</key><string>${LEGACY_LABEL}</string>
  <key>ProgramArguments</key><array>
    <string>/bin/sh</string><string>__service</string>
    <string>--slock-home</string><string>${home}</string>
    <string>--os-supervised</string><string>launchd-user</string>
  </array>
  <key>EnvironmentVariables</key><dict>
    <key>RAFT_COMPUTER_OS_SUPERVISOR_OWNER</key>
    <string>raft-computer-os-supervisor-v1-0123456789abcdef</string>
  </dict>
  <key>KeepAlive</key><true/>
  <key>RunAtLoad</key><true/>
</dict></plist>`;
}

async function seed(home: string, withLegacy: boolean): Promise<string[][]> {
  const calls: string[][] = [];
  await mkdir(join(home, "computer", "run"), { recursive: true });
  const laDir = join(home, "Library", "LaunchAgents");
  await mkdir(laDir, { recursive: true });
  if (withLegacy) {
    await writeFile(join(laDir, `${LEGACY_LABEL}.plist`), legacyDefinition(home));
  }
  const p = serverAttachmentPath(home, SERVER_A);
  await mkdir(join(p, ".."), { recursive: true });
  await writeFile(
    p,
    JSON.stringify({
      kind: "computer-attachment",
      serverId: SERVER_A,
      serverMachineId: `cm-${SERVER_A}`,
      serverSlug: "alpha",
      apiKey: `sk_computer_${SERVER_A}`,
      serverUrl: "https://raft.example.test",
    }),
    { mode: 0o600 },
  );
  return calls;
}

test("#38 stop retires a legacy carrier that would otherwise undo the stop", async () => {
  const root = await mkdtemp(join(tmpdir(), "t38stop-"));
  const home = join(root, ".slock");
  const calls = await seed(home, true);
  try {
    await writeFile(servicePidPath(home), String(process.pid));
    const result = await stop(
      { slockHome: home, hostLifecycleOwner: "cli" },
      {
        hostLifecycleDeps: {
          platform: "darwin",
          userHome: home,
          uid: 501,
          runCommand: async (command: string, args: string[]) => {
            calls.push([command, ...args]);
            if (args[0] === "print" && /^gui\/\d+$/.test(args[1] ?? "")) {
              return { stdout: `${args[1]} = { type = domain }\n`, stderr: "" };
            }
            if (args[0] === "print") {
              return { stdout: `${args[1]} = { state = running }\n`, stderr: "" };
            }
            return { stdout: "", stderr: "" };
          },
        },
        convergeHostLifecycle: async () => ({
          owner: "cli" as const, enabled: false, status: "converged" as const,
          label: null, definitionPath: null, definition: null,
        }),
        killService: () => {},
        isProcessAlive: () => false,
        sleep: async () => {},
      },
    );
    // Either terminal stop status is fine — what matters is the bootout.
    expect(["stopped", "stale_pidfile_cleared"]).toContain(result.status);
    // The whole point: the legacy job is booted out at the moment the user
    // asked for the service to go down.
    expect(
      calls.some((c) => c[1] === "bootout" && (c[2] ?? "").includes(LEGACY_LABEL)),
      `expected a bootout of the legacy carrier, saw ${JSON.stringify(calls)}`,
    ).toBe(true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("#38 stop issues no legacy launchctl calls when there is none", async () => {
  const root = await mkdtemp(join(tmpdir(), "t38stop2-"));
  const home = join(root, ".slock");
  const calls = await seed(home, false);
  try {
    await writeFile(servicePidPath(home), String(process.pid));
    await stop(
      { slockHome: home, hostLifecycleOwner: "cli" },
      {
        hostLifecycleDeps: {
          platform: "darwin", userHome: home, uid: 501,
          runCommand: async (command: string, args: string[]) => {
            calls.push([command, ...args]);
            if (args[0] === "print" && /^gui\/\d+$/.test(args[1] ?? "")) {
              return { stdout: `${args[1]} = { type = domain }\n`, stderr: "" };
            }
            if (args[0] === "print") return { stdout: `${args[1]} = { state = running }\n`, stderr: "" };
            return { stdout: "", stderr: "" };
          },
        },
        convergeHostLifecycle: async () => ({
          owner: "cli" as const, enabled: false, status: "converged" as const,
          label: null, definitionPath: null, definition: null,
        }),
        killService: () => {},
        isProcessAlive: () => false,
        sleep: async () => {},
      },
    );
    expect(calls.filter((c) => c[1] === "bootout")).toEqual([]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("#38 stop retires the legacy carrier on the normal (graceful) path too", async () => {
  const root = await mkdtemp(join(tmpdir(), "t38stop3-"));
  const home = join(root, ".slock");
  const calls = await seed(home, true);
  try {
    await writeFile(servicePidPath(home), String(process.pid));
    let alive = true; // live for the walk + first poll, gone by the second
    const result = await stop(
      { slockHome: home, hostLifecycleOwner: "cli" },
      {
        hostLifecycleDeps: {
          platform: "darwin", userHome: home, uid: 501,
          runCommand: async (command: string, args: string[]) => {
            calls.push([command, ...args]);
            if (args[0] === "print" && /^gui\/\d+$/.test(args[1] ?? "")) {
              return { stdout: `${args[1]} = { type = domain }\n`, stderr: "" };
            }
            if (args[0] === "print") return { stdout: `${args[1]} = { state = running }\n`, stderr: "" };
            return { stdout: "", stderr: "" };
          },
        },
        convergeHostLifecycle: async () => ({
          owner: "cli" as const, enabled: false, status: "converged" as const,
          label: null, definitionPath: null, definition: null,
        }),
        killService: () => { alive = false; },
        isProcessAlive: () => alive,
        sleep: async () => {},
      },
    );
    expect(result.status).toBe("stopped");
    expect(
      calls.some((c) => c[1] === "bootout" && (c[2] ?? "").includes(LEGACY_LABEL)),
      `expected a bootout on the graceful path, saw ${JSON.stringify(calls)}`,
    ).toBe(true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
