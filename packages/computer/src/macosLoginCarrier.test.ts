import { createHash } from "node:crypto";
import assert from "node:assert/strict";
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "vitest";

import {
  buildMacosLoginCarrierSpec,
  convergeAppHostLifecycle,
  convergeCliHostLifecycle,
  readHostLifecycleMarker,
  readHostLifecycleRecoveryStatus,
  refreshCliLoginCarrierIfOwned,
  removeHostLifecycle,
  type HostLifecycleCommandRunner,
} from "./macosLoginCarrier.js";
import { buildStatusReport } from "./status.js";
import { runDoctorChecks } from "./doctor.js";

function launchctlHarness() {
  const jobs = new Map<string, string>();
  const calls: string[][] = [];
  const run: HostLifecycleCommandRunner = async (command, args) => {
    calls.push([command, ...args]);
    if (command === "/usr/bin/plutil") {
      assert.deepEqual(args.slice(0, 5), [
        "-extract",
        "CFBundleIdentifier",
        "raw",
        "-o",
        "-",
      ]);
      const raw = await readFile(args[5]!, "utf8");
      const bundleId = /<key>CFBundleIdentifier<\/key>\s*<string>([^<]+)<\/string>/u.exec(raw)?.[1];
      if (!bundleId) throw new Error("bundle id missing");
      return { stdout: `${bundleId}\n`, stderr: "" };
    }
    assert.equal(command, "/bin/launchctl");
    if (args[0] === "print" && args.length === 2 && /^gui\/\d+$/.test(args[1]!)) {
      return { stdout: `${args[1]} = { type = domain }\n`, stderr: "" };
    }
    if (args[0] === "bootstrap") {
      const definition = await readFile(args[2]!, "utf8");
      const label = /<key>Label<\/key>\s*<string>([^<]+)<\/string>/u.exec(definition)?.[1];
      assert.ok(label);
      jobs.set(`${args[1]}/${label}`, definition);
      return { stdout: "", stderr: "" };
    }
    if (args[0] === "bootout") {
      jobs.delete(args[1]!);
      return { stdout: "", stderr: "" };
    }
    if (args[0] === "print" && args.length === 2) {
      const definition = jobs.get(args[1]!);
      if (!definition) throw new Error("job missing");
      return { stdout: `${args[1]} = { ${definition} }\n`, stderr: "" };
    }
    throw new Error(`unexpected command: ${command} ${args.join(" ")}`);
  };
  return { calls, jobs, run };
}

test("macOS CLI login carrier is a distinct RunAtLoad job without KeepAlive or retired argv", async () => {
  const spec = buildMacosLoginCarrierSpec({
    slockHome: "/Users/example/.slock",
    dispatcherPath: "/Users/example/.local/bin/raft-computer",
    userHome: "/Users/example",
    uid: 501,
  });
  assert.match(spec.label, /^build\.raft\.computer\.login\.[0-9a-f]{16}$/u);
  assert.deepEqual(spec.args, ["__service", "--slock-home", "/Users/example/.slock"]);
  assert.match(spec.definition, /<key>RunAtLoad<\/key>\s*<true\/>/u);
  assert.doesNotMatch(spec.definition, /<key>KeepAlive<\/key>/u);
  assert.doesNotMatch(spec.definition, /--os-supervised|RAFT_COMPUTER_SUPERVISOR_OWNER/u);
});

test("markerless CLI-only Mac with no Desktop claims exactly one carrier", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "raft-macos-login-carrier-"));
  const home = path.join(root, "user");
  const slockHome = path.join(home, ".slock");
  const dispatcherPath = path.join(home, ".local", "bin", "raft-computer");
  const harness = launchctlHarness();
  try {
    const result = await convergeCliHostLifecycle(slockHome, "enabled", {
      platform: "darwin",
      userHome: home,
      uid: 501,
      dispatcherPath,
      legacyDesktopBundlePath: path.join(root, "Applications", "Raft Computer.app"),
      runCommand: harness.run,
    });
    assert.equal(result.owner, "cli");
    assert.equal(result.enabled, true);
    assert.equal(harness.jobs.size, 1);
    const marker = await readHostLifecycleMarker(slockHome);
    assert.equal(marker?.owner, "cli");
    assert.equal(marker?.enabled, true);
    assert.equal(marker?.dispatcherPath, dispatcherPath);
    assert.equal(await readFile(result.definitionPath!, "utf8"), result.definition);
    const markerMode = (await stat(path.join(slockHome, "computer", "host-lifecycle-owner.json"))).mode & 0o777;
    assert.equal(markerMode, 0o600);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("markerless legacy Desktop install leaves ownership unknown with zero launchd mutation", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "raft-macos-login-legacy-app-"));
  const home = path.join(root, "user");
  const slockHome = path.join(home, ".slock");
  const legacyDesktopBundlePath = path.join(root, "Applications", "Raft Computer.app");
  const infoPlistPath = path.join(legacyDesktopBundlePath, "Contents", "Info.plist");
  const harness = launchctlHarness();
  try {
    await mkdir(path.dirname(infoPlistPath), { recursive: true });
    await writeFile(
      infoPlistPath,
      [
        '<?xml version="1.0" encoding="UTF-8"?>',
        "<plist><dict>",
        "<key>CFBundleIdentifier</key>",
        "<string>build.raft.computer-app</string>",
        "</dict></plist>",
      ].join("\n"),
    );
    await assert.rejects(
      convergeCliHostLifecycle(slockHome, "enabled", {
        platform: "darwin",
        userHome: home,
        uid: 501,
        dispatcherPath: path.join(home, ".local", "bin", "raft-computer"),
        legacyDesktopBundlePath,
        runCommand: harness.run,
      }),
      (error: unknown) => {
        assert.equal((error as { code?: string }).code, "HOST_LIFECYCLE_OWNER_AMBIGUOUS");
        assert.match((error as Error).message, /open or upgrade Raft Desktop/i);
        return true;
      },
    );
    assert.equal(
      harness.calls.filter(([command]) => command === "/bin/launchctl").length,
      0,
      "ownership ambiguity must stop before any launchd read or mutation",
    );
    assert.equal(harness.jobs.size, 0);
    const spec = buildMacosLoginCarrierSpec({
      slockHome,
      dispatcherPath: path.join(home, ".local", "bin", "raft-computer"),
      userHome: home,
      uid: 501,
    });
    await assert.rejects(readFile(spec.definitionPath, "utf8"), { code: "ENOENT" });
    assert.equal(await readHostLifecycleMarker(slockHome), null);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("markerless canonical Desktop anomalies fail before launchd or carrier files", async () => {
  for (const shape of ["identity-mismatch", "bundle-symlink", "contents-symlink", "plist-symlink"] as const) {
    const root = await mkdtemp(path.join(os.tmpdir(), `raft-macos-login-${shape}-`));
    const home = path.join(root, "user");
    const slockHome = path.join(home, ".slock");
    const bundlePath = path.join(root, "Applications", "Raft Computer.app");
    const realBundlePath = path.join(root, "Relocated.app");
    const targetPath = shape === "bundle-symlink" ? realBundlePath : bundlePath;
    const harness = launchctlHarness();
    try {
      const realContentsPath = shape === "contents-symlink"
        ? path.join(root, "RelocatedContents")
        : path.join(targetPath, "Contents");
      const realPlistPath = shape === "plist-symlink"
        ? path.join(root, "RelocatedInfo.plist")
        : path.join(realContentsPath, "Info.plist");
      await mkdir(realContentsPath, { recursive: true });
      await writeFile(
        realPlistPath,
        "<plist><dict><key>CFBundleIdentifier</key><string>example.invalid</string></dict></plist>\n",
      );
      if (shape === "bundle-symlink") {
        await mkdir(path.dirname(bundlePath), { recursive: true });
        await symlink(realBundlePath, bundlePath);
      } else if (shape === "contents-symlink") {
        await mkdir(bundlePath, { recursive: true });
        await symlink(realContentsPath, path.join(bundlePath, "Contents"));
      } else if (shape === "plist-symlink") {
        await symlink(realPlistPath, path.join(realContentsPath, "Info.plist"));
      }
      await assert.rejects(
        convergeCliHostLifecycle(slockHome, "enabled", {
          platform: "darwin",
          userHome: home,
          uid: 501,
          dispatcherPath: path.join(home, ".local", "bin", "raft-computer"),
          legacyDesktopBundlePath: bundlePath,
          runCommand: harness.run,
        }),
        (error: unknown) => {
          assert.equal(
            (error as { code?: string }).code,
            "HOST_LIFECYCLE_DESKTOP_IDENTITY_UNVERIFIED",
          );
          return true;
        },
      );
      assert.equal(harness.calls.length, shape === "identity-mismatch" ? 1 : 0);
      assert.equal(harness.jobs.size, 0);
      const spec = buildMacosLoginCarrierSpec({
        slockHome,
        dispatcherPath: path.join(home, ".local", "bin", "raft-computer"),
        userHome: home,
        uid: 501,
      });
      await assert.rejects(readFile(spec.definitionPath, "utf8"), { code: "ENOENT" });
      assert.equal(await readHostLifecycleMarker(slockHome), null);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }
});

test("registration failure is fail-closed and never publishes an enabled marker", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "raft-macos-login-carrier-red-"));
  const home = path.join(root, "user");
  const slockHome = path.join(home, ".slock");
  const dispatcherPath = path.join(home, ".local", "bin", "raft-computer");
  const run: HostLifecycleCommandRunner = async (_command, args) => {
    if (args[0] === "print" && args[1] === "gui/501") return { stdout: "domain", stderr: "" };
    throw new Error("bootstrap denied");
  };
  try {
    await assert.rejects(
      convergeCliHostLifecycle(slockHome, "enabled", {
        platform: "darwin",
        userHome: home,
        uid: 501,
        dispatcherPath,
        legacyDesktopBundlePath: path.join(root, "Applications", "Raft Computer.app"),
        runCommand: run,
      }),
      (error: unknown) => {
        assert.equal((error as { code?: string }).code, "HOST_LIFECYCLE_REGISTRATION_FAILED");
        return true;
      },
    );
    assert.equal(await readHostLifecycleMarker(slockHome), null);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("live readback mismatch removes the unverified job and definition before failing", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "raft-macos-login-readback-red-"));
  const home = path.join(root, "user");
  const slockHome = path.join(home, ".slock");
  const dispatcherPath = path.join(home, ".local", "bin", "raft-computer");
  const harness = launchctlHarness();
  const spec = buildMacosLoginCarrierSpec({
    slockHome,
    dispatcherPath,
    userHome: home,
    uid: 501,
  });
  try {
    await assert.rejects(
      convergeCliHostLifecycle(slockHome, "enabled", {
        platform: "darwin",
        userHome: home,
        uid: 501,
        dispatcherPath,
        legacyDesktopBundlePath: path.join(root, "Applications", "Raft Computer.app"),
        runCommand: async (command, args) => {
          if (
            args[0] === "print"
            && args[1] === `${spec.domain}/${spec.label}`
            && harness.jobs.has(args[1])
          ) {
            return { stdout: `${spec.label} = { unexpected program }`, stderr: "" };
          }
          return harness.run(command, args);
        },
      }),
      (error: unknown) => {
        assert.equal((error as { code?: string }).code, "HOST_LIFECYCLE_READBACK_FAILED");
        return true;
      },
    );
    assert.equal(harness.jobs.size, 0);
    await assert.rejects(readFile(spec.definitionPath, "utf8"), { code: "ENOENT" });
    assert.equal(await readHostLifecycleMarker(slockHome), null);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("refresh replacement failure restores the last verified CLI carrier and propagates failure", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "raft-macos-login-replace-red-"));
  const home = path.join(root, "user");
  const slockHome = path.join(home, ".slock");
  const harness = launchctlHarness();
  const baseDeps = {
    platform: "darwin" as const,
    userHome: home,
    uid: 501,
    dispatcherPath: path.join(home, ".local", "bin", "raft-computer"),
    legacyDesktopBundlePath: path.join(root, "Applications", "Raft Computer.app"),
    runCommand: harness.run,
  };
  try {
    await convergeCliHostLifecycle(slockHome, "enabled", baseDeps);
    const previousMarker = await readHostLifecycleMarker(slockHome);
    const previousDefinition = await readFile(previousMarker!.definitionPath!, "utf8");
    let rejectedReplacement = false;
    let anchorObservedBeforeBootout = false;
    await assert.rejects(
      refreshCliLoginCarrierIfOwned(slockHome, {
        ...baseDeps,
        dispatcherPath: path.join(home, ".local", "bin", "raft-computer-next"),
        runCommand: async (command, args) => {
          if (args[0] === "bootout" && !anchorObservedBeforeBootout) {
            const anchorPath = path.join(
              slockHome,
              "computer",
              "host-lifecycle-pending-replace.json",
            );
            assert.equal((await stat(anchorPath)).mode & 0o777, 0o600);
            assert.equal((await readHostLifecycleRecoveryStatus(slockHome))?.status, "pending-replace");
            // The owner marker is intentionally kept until the new carrier is
            // verified — it still truthfully describes the installed one.
            assert.deepEqual(await readHostLifecycleMarker(slockHome), previousMarker);
            anchorObservedBeforeBootout = true;
          }
          if (args[0] === "bootstrap" && !rejectedReplacement) {
            assert.deepEqual(await readHostLifecycleMarker(slockHome), previousMarker);
            rejectedReplacement = true;
            throw new Error("bootstrap denied");
          }
          return harness.run(command, args);
        },
      }),
      (error: unknown) => {
        assert.equal((error as { code?: string }).code, "HOST_LIFECYCLE_REGISTRATION_FAILED");
        return true;
      },
    );
    assert.equal(anchorObservedBeforeBootout, true);
    assert.deepEqual(await readHostLifecycleMarker(slockHome), previousMarker);
    assert.equal(await readFile(previousMarker!.definitionPath!, "utf8"), previousDefinition);
    assert.equal(harness.jobs.size, 1);
    assert.ok([...harness.jobs.values()][0]!.includes(previousMarker!.dispatcherPath!));
    assert.equal(await readHostLifecycleRecoveryStatus(slockHome), null);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("refresh readback mismatch rolls back the prior job, definition, and owner", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "raft-macos-login-readback-rollback-"));
  const home = path.join(root, "user");
  const slockHome = path.join(home, ".slock");
  const harness = launchctlHarness();
  const baseDeps = {
    platform: "darwin" as const,
    userHome: home,
    uid: 501,
    dispatcherPath: path.join(home, ".local", "bin", "raft-computer"),
    legacyDesktopBundlePath: path.join(root, "Applications", "Raft Computer.app"),
    runCommand: harness.run,
  };
  try {
    await convergeCliHostLifecycle(slockHome, "enabled", baseDeps);
    const previousMarker = await readHostLifecycleMarker(slockHome);
    const previousDefinition = await readFile(previousMarker!.definitionPath!, "utf8");
    await assert.rejects(
      refreshCliLoginCarrierIfOwned(slockHome, {
        ...baseDeps,
        dispatcherPath: path.join(home, ".local", "bin", "raft-computer-next"),
        runCommand: async (command, args, signal) => {
          if (
            args[0] === "print"
            && args[1]?.includes("build.raft.computer.login.")
            && [...harness.jobs.values()][0]?.includes("raft-computer-next")
          ) {
            return { stdout: "unexpected live job", stderr: "" };
          }
          return harness.run(command, args, signal);
        },
      }),
      (error: unknown) => {
        assert.equal((error as { code?: string }).code, "HOST_LIFECYCLE_READBACK_FAILED");
        return true;
      },
    );
    assert.deepEqual(await readHostLifecycleMarker(slockHome), previousMarker);
    assert.equal(await readFile(previousMarker!.definitionPath!, "utf8"), previousDefinition);
    assert.equal(harness.jobs.size, 1);
    assert.ok([...harness.jobs.values()][0]!.includes(previousMarker!.dispatcherPath!));
    assert.equal(await readHostLifecycleRecoveryStatus(slockHome), null);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("rollback failure keeps the enabled marker as the recovery anchor and surfaces one durable degraded receipt", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "raft-macos-login-rollback-red-"));
  const home = path.join(root, "user");
  const slockHome = path.join(home, ".slock");
  const harness = launchctlHarness();
  const baseDeps = {
    platform: "darwin" as const,
    userHome: home,
    uid: 501,
    dispatcherPath: path.join(home, ".local", "bin", "raft-computer"),
    legacyDesktopBundlePath: path.join(root, "Applications", "Raft Computer.app"),
    runCommand: harness.run,
  };
  try {
    await convergeCliHostLifecycle(slockHome, "enabled", baseDeps);
    await assert.rejects(
      refreshCliLoginCarrierIfOwned(slockHome, {
        ...baseDeps,
        dispatcherPath: path.join(home, ".local", "bin", "raft-computer-next"),
        runCommand: async (command, args, signal) => {
          if (args[0] === "bootstrap") throw new Error("all replacement bootstraps denied");
          return harness.run(command, args, signal);
        },
      }),
      (error: unknown) => {
        assert.equal((error as { code?: string }).code, "HOST_LIFECYCLE_ROLLBACK_FAILED");
        return true;
      },
    );
    // The forward path no longer deletes the marker before the swap: a failed
    // rollback leaves the marker as the durable anchor describing the carrier
    // the recovery record can reinstall.
    assert.equal((await readHostLifecycleMarker(slockHome))?.dispatcherPath, baseDeps.dispatcherPath);
    assert.equal((await readHostLifecycleRecoveryStatus(slockHome))?.status, "degraded");
    assert.equal(
      (await stat(path.join(slockHome, "computer", "host-lifecycle-pending-replace.json"))).mode & 0o777,
      0o600,
    );
    const status = await buildStatusReport(slockHome);
    assert.equal(status.hostLifecycle?.status, "degraded");
    const doctor = await runDoctorChecks(slockHome);
    assert.ok(
      doctor.some((check) => check.name === "macOS login carrier" && !check.ok),
      "doctor must consume the same durable degraded receipt",
    );
    await refreshCliLoginCarrierIfOwned(slockHome, baseDeps);
    assert.equal((await readHostLifecycleMarker(slockHome))?.dispatcherPath, baseDeps.dispatcherPath);
    assert.equal(await readHostLifecycleRecoveryStatus(slockHome), null);
    assert.equal(harness.jobs.size, 1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("insufficient shared deadline refuses replacement before anchor, marker, job, or definition mutation", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "raft-macos-login-budget-red-"));
  const home = path.join(root, "user");
  const slockHome = path.join(home, ".slock");
  const harness = launchctlHarness();
  const baseDeps = {
    platform: "darwin" as const,
    userHome: home,
    uid: 501,
    dispatcherPath: path.join(home, ".local", "bin", "raft-computer"),
    legacyDesktopBundlePath: path.join(root, "Applications", "Raft Computer.app"),
    runCommand: harness.run,
  };
  try {
    await convergeCliHostLifecycle(slockHome, "enabled", baseDeps);
    const marker = await readHostLifecycleMarker(slockHome);
    const definition = await readFile(marker!.definitionPath!, "utf8");
    const callsBefore = harness.calls.length;
    await assert.rejects(
      refreshCliLoginCarrierIfOwned(slockHome, {
        ...baseDeps,
        dispatcherPath: path.join(home, ".local", "bin", "raft-computer-next"),
        deadlineAtMs: 11_999,
        now: () => 0,
      }),
      (error: unknown) => {
        assert.equal(
          (error as { code?: string }).code,
          "HOST_LIFECYCLE_REFRESH_BUDGET_INSUFFICIENT",
        );
        return true;
      },
    );
    assert.equal(
      harness.calls.slice(callsBefore).some(([, action]) => action === "bootout" || action === "bootstrap"),
      false,
    );
    assert.deepEqual(await readHostLifecycleMarker(slockHome), marker);
    assert.equal(await readFile(marker!.definitionPath!, "utf8"), definition);
    assert.equal(harness.jobs.size, 1);
    assert.equal(await readHostLifecycleRecoveryStatus(slockHome), null);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("replacement uses the deadline remainder minus rollback reserve and restores on timeout", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "raft-macos-login-forward-timeout-"));
  const home = path.join(root, "user");
  const slockHome = path.join(home, ".slock");
  const harness = launchctlHarness();
  const baseDeps = {
    platform: "darwin" as const,
    userHome: home,
    uid: 501,
    dispatcherPath: path.join(home, ".local", "bin", "raft-computer"),
    legacyDesktopBundlePath: path.join(root, "Applications", "Raft Computer.app"),
    runCommand: harness.run,
  };
  try {
    await convergeCliHostLifecycle(slockHome, "enabled", baseDeps);
    const marker = await readHostLifecycleMarker(slockHome);
    const definition = await readFile(marker!.definitionPath!, "utf8");
    let scheduledMs: number | null = null;
    await assert.rejects(
      refreshCliLoginCarrierIfOwned(slockHome, {
        ...baseDeps,
        dispatcherPath: path.join(home, ".local", "bin", "raft-computer-next"),
        deadlineAtMs: 12_000,
        now: () => 0,
        setTimeoutFn: (fn, ms) => {
          scheduledMs = ms;
          queueMicrotask(fn);
          return Symbol("forward-deadline");
        },
        clearTimeoutFn: () => undefined,
        runCommand: async (command, args, signal) => {
          if (signal?.aborted) {
            const error = new Error("aborted") as NodeJS.ErrnoException;
            error.code = "ABORT_ERR";
            throw error;
          }
          return harness.run(command, args, signal);
        },
      }),
      (error: unknown) => {
        assert.equal((error as { code?: string }).code, "HOST_LIFECYCLE_REFRESH_TIMEOUT");
        return true;
      },
    );
    assert.equal(scheduledMs, 2_000);
    assert.deepEqual(await readHostLifecycleMarker(slockHome), marker);
    assert.equal(await readFile(marker!.definitionPath!, "utf8"), definition);
    assert.equal(harness.jobs.size, 1);
    assert.ok([...harness.jobs.values()][0]!.includes(marker!.dispatcherPath!));
    assert.equal(await readHostLifecycleRecoveryStatus(slockHome), null);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("stop disables CLI post-login activation and start re-enables one job", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "raft-macos-login-toggle-"));
  const home = path.join(root, "user");
  const slockHome = path.join(home, ".slock");
  const harness = launchctlHarness();
  const deps = {
    platform: "darwin" as const,
    userHome: home,
    uid: 501,
    dispatcherPath: path.join(home, ".local", "bin", "raft-computer"),
    legacyDesktopBundlePath: path.join(root, "Applications", "Raft Computer.app"),
    runCommand: harness.run,
  };
  try {
    await convergeCliHostLifecycle(slockHome, "enabled", deps);
    await convergeCliHostLifecycle(slockHome, "disabled", deps);
    assert.equal(harness.jobs.size, 0);
    assert.equal((await readHostLifecycleMarker(slockHome))?.enabled, false);
    await refreshCliLoginCarrierIfOwned(slockHome, deps);
    assert.equal(harness.jobs.size, 0, "upgrade refresh must preserve an explicitly disabled carrier");
    await convergeCliHostLifecycle(slockHome, "enabled", deps);
    assert.equal(harness.jobs.size, 1);
    assert.equal((await readHostLifecycleMarker(slockHome))?.enabled, true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("re-enabling an exact live CLI carrier is readback-only and does not restart it", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "raft-macos-login-idempotent-"));
  const home = path.join(root, "user");
  const slockHome = path.join(home, ".slock");
  const harness = launchctlHarness();
  const deps = {
    platform: "darwin" as const,
    userHome: home,
    uid: 501,
    dispatcherPath: path.join(home, ".local", "bin", "raft-computer"),
    legacyDesktopBundlePath: path.join(root, "Applications", "Raft Computer.app"),
    runCommand: harness.run,
  };
  try {
    await convergeCliHostLifecycle(slockHome, "enabled", deps);
    const marker = await readHostLifecycleMarker(slockHome);
    const markerFile = path.join(slockHome, "computer", "host-lifecycle-owner.json");
    const markerMtime = (await stat(markerFile, { bigint: true })).mtimeNs;
    const definitionMtime = (
      await stat(marker!.definitionPath!, { bigint: true })
    ).mtimeNs;
    const bootstrapCount = harness.calls.filter((call) => call[1] === "bootstrap").length;
    await refreshCliLoginCarrierIfOwned(slockHome, deps);
    assert.equal(
      harness.calls.filter((call) => call[1] === "bootstrap").length,
      bootstrapCount,
    );
    assert.equal((await stat(markerFile, { bigint: true })).mtimeNs, markerMtime);
    assert.equal(
      (await stat(marker!.definitionPath!, { bigint: true })).mtimeNs,
      definitionMtime,
      "healthy refresh must not rewrite the definition",
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a CLI-owned Mac ignores a later Desktop install and refreshes one existing carrier", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "raft-macos-login-known-cli-"));
  const home = path.join(root, "user");
  const slockHome = path.join(home, ".slock");
  const legacyDesktopBundlePath = path.join(root, "Applications", "Raft Computer.app");
  const harness = launchctlHarness();
  const deps = {
    platform: "darwin" as const,
    userHome: home,
    uid: 501,
    dispatcherPath: path.join(home, ".local", "bin", "raft-computer"),
    legacyDesktopBundlePath,
    runCommand: harness.run,
  };
  try {
    await convergeCliHostLifecycle(slockHome, "enabled", deps);
    const marker = await readHostLifecycleMarker(slockHome);
    const bootstrapCount = harness.calls.filter(([, action]) => action === "bootstrap").length;
    await mkdir(path.join(legacyDesktopBundlePath, "Contents"), { recursive: true });
    await writeFile(
      path.join(legacyDesktopBundlePath, "Contents", "Info.plist"),
      "<plist><dict><key>CFBundleIdentifier</key><string>build.raft.computer-app</string></dict></plist>\n",
    );

    await convergeCliHostLifecycle(slockHome, "enabled", deps);
    await refreshCliLoginCarrierIfOwned(slockHome, deps);

    assert.equal(harness.jobs.size, 1);
    assert.equal(
      harness.calls.filter(([, action]) => action === "bootstrap").length,
      bootstrapCount,
    );
    assert.deepEqual(await readHostLifecycleMarker(slockHome), marker);
    assert.equal(
      harness.calls.filter(([command]) => command === "/usr/bin/plutil").length,
      0,
      "known CLI ownership must bypass markerless Desktop ambiguity detection",
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("App claim removes the CLI job before Electron set/get and preserves a single durable owner", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "raft-macos-login-owner-"));
  const home = path.join(root, "user");
  const slockHome = path.join(home, ".slock");
  const harness = launchctlHarness();
  const order: string[] = [];
  const deps = {
    platform: "darwin" as const,
    userHome: home,
    uid: 501,
    dispatcherPath: path.join(home, ".local", "bin", "raft-computer"),
    legacyDesktopBundlePath: path.join(root, "Applications", "Raft Computer.app"),
    runCommand: async (...args: Parameters<HostLifecycleCommandRunner>) => {
      if (args[1][0] === "bootout") order.push("bootout");
      return harness.run(...args);
    },
  };
  let openAtLogin = false;
  try {
    await convergeCliHostLifecycle(slockHome, "enabled", deps);
    await convergeAppHostLifecycle(slockHome, true, {
      ...deps,
      setOpenAtLogin: (enabled) => {
        order.push("set-electron");
        openAtLogin = enabled;
      },
      getOpenAtLogin: () => {
        order.push("get-electron");
        return openAtLogin;
      },
    });
    assert.ok(order.indexOf("bootout") < order.indexOf("set-electron"));
    assert.equal(harness.jobs.size, 0);
    assert.deepEqual(await readHostLifecycleMarker(slockHome), {
      formatVersion: 1,
      owner: "app",
      enabled: true,
      dispatcherPath: null,
      label: null,
      definitionPath: null,
    });
    await refreshCliLoginCarrierIfOwned(slockHome, deps);
    assert.equal(harness.jobs.size, 0, "K refresh must not replace Electron lifecycle ownership");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("CLI convergence yields to an App-owned marker and never enables its carrier", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "raft-macos-login-cli-yields-app-"));
  const home = path.join(root, "user");
  const slockHome = path.join(home, ".slock");
  const harness = launchctlHarness();
  const deps = {
    platform: "darwin" as const,
    userHome: home,
    uid: 501,
    dispatcherPath: path.join(home, ".local", "bin", "raft-computer"),
    legacyDesktopBundlePath: path.join(root, "Applications", "Raft Computer.app"),
    runCommand: harness.run,
  };
  let openAtLogin = true;
  try {
    await convergeAppHostLifecycle(slockHome, true, {
      ...deps,
      setOpenAtLogin: (enabled) => { openAtLogin = enabled; },
      getOpenAtLogin: () => openAtLogin,
    });
    const bootstrapCount = harness.calls.filter(([, action]) => action === "bootstrap").length;
    const result = await convergeCliHostLifecycle(slockHome, "enabled", deps);
    assert.equal(result.owner, "app");
    assert.equal(harness.jobs.size, 0);
    assert.equal(
      harness.calls.filter(([, action]) => action === "bootstrap").length,
      bootstrapCount,
      "CLI must not enable a launchd carrier while the App marker owns lifecycle",
    );
    assert.equal((await readHostLifecycleMarker(slockHome))?.owner, "app");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("App ownership is fail-closed when Electron openAtLogin readback disagrees", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "raft-macos-login-app-red-"));
  const home = path.join(root, "user");
  const slockHome = path.join(home, ".slock");
  const harness = launchctlHarness();
  try {
    await assert.rejects(
      convergeAppHostLifecycle(slockHome, true, {
        platform: "darwin",
        userHome: home,
        uid: 501,
        dispatcherPath: path.join(home, ".local", "bin", "raft-computer"),
        runCommand: harness.run,
        setOpenAtLogin: () => undefined,
        getOpenAtLogin: () => false,
      }),
      (error: unknown) => {
        assert.equal((error as { code?: string }).code, "HOST_LIFECYCLE_APP_READBACK_FAILED");
        return true;
      },
    );
    assert.equal(await readHostLifecycleMarker(slockHome), null);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("remove seam proves zero live job, zero definition and zero owner marker", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "raft-macos-login-remove-"));
  const home = path.join(root, "user");
  const slockHome = path.join(home, ".slock");
  const harness = launchctlHarness();
  const deps = {
    platform: "darwin" as const,
    userHome: home,
    uid: 501,
    dispatcherPath: path.join(home, ".local", "bin", "raft-computer"),
    legacyDesktopBundlePath: path.join(root, "Applications", "Raft Computer.app"),
    runCommand: harness.run,
  };
  try {
    await convergeCliHostLifecycle(slockHome, "enabled", deps);
    const removed = await removeHostLifecycle(slockHome, deps);
    assert.equal(removed.status, "removed");
    assert.equal(harness.jobs.size, 0);
    assert.equal(await readHostLifecycleMarker(slockHome), null);
    await assert.rejects(readFile(removed.definitionPath!, "utf8"), { code: "ENOENT" });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("remove seam fails closed for App ownership unless Electron removal is read back", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "raft-macos-login-app-remove-"));
  const home = path.join(root, "user");
  const slockHome = path.join(home, ".slock");
  const harness = launchctlHarness();
  const deps = {
    platform: "darwin" as const,
    userHome: home,
    uid: 501,
    dispatcherPath: path.join(home, ".local", "bin", "raft-computer"),
    runCommand: harness.run,
  };
  let openAtLogin = true;
  try {
    await convergeAppHostLifecycle(slockHome, true, {
      ...deps,
      setOpenAtLogin: (enabled) => { openAtLogin = enabled; },
      getOpenAtLogin: () => openAtLogin,
    });
    await assert.rejects(removeHostLifecycle(slockHome, deps), (error: unknown) => {
      assert.equal((error as { code?: string }).code, "HOST_LIFECYCLE_APP_OWNER_REQUIRED");
      return true;
    });
    await removeHostLifecycle(slockHome, {
      ...deps,
      setOpenAtLogin: (enabled) => { openAtLogin = enabled; },
      getOpenAtLogin: () => openAtLogin,
    });
    assert.equal(openAtLogin, false);
    assert.equal(await readHostLifecycleMarker(slockHome), null);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("healthy carrier with a different but still-valid dispatcher defers the swap (2026-10-02 outage shape)", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "raft-macos-login-defer-"));
  const home = path.join(root, "user");
  const slockHome = path.join(home, ".slock");
  const harness = launchctlHarness();
  const originalDispatcher = path.join(home, ".local", "bin", "raft-computer");
  const baseDeps = {
    platform: "darwin" as const,
    userHome: home,
    uid: 501,
    dispatcherPath: originalDispatcher,
    legacyDesktopBundlePath: path.join(root, "Applications", "Raft Computer.app"),
    runCommand: harness.run,
  };
  try {
    await convergeCliHostLifecycle(slockHome, "enabled", baseDeps);
    const markerBefore = await readHostLifecycleMarker(slockHome);
    const definitionBefore = await readFile(markerBefore!.definitionPath!, "utf8");
    const callsBefore = harness.calls.length;
    // The dispatcher binary still exists and is executable — a start/restart
    // resolving a DIFFERENT path must not tear down the running login job.
    await mkdir(path.dirname(originalDispatcher), { recursive: true });
    await writeFile(originalDispatcher, "#!/bin/sh\n", { mode: 0o755 });
    const result = await convergeCliHostLifecycle(slockHome, "enabled", {
      ...baseDeps,
      dispatcherPath: path.join(home, ".local", "bin", "raft-computer-next"),
    });
    assert.equal(result.deferredRefresh?.liveDispatcher, originalDispatcher);
    assert.equal(
      result.deferredRefresh?.wantedDispatcher,
      path.join(home, ".local", "bin", "raft-computer-next"),
    );
    const mutating = harness.calls
      .slice(callsBefore)
      .filter((c) => c[1] === "bootout" || c[1] === "bootstrap").length;
    assert.equal(mutating, 0, "no launchctl mutation may happen");
    assert.deepEqual(await readHostLifecycleMarker(slockHome), markerBefore);
    assert.equal(await readFile(markerBefore!.definitionPath!, "utf8"), definitionBefore);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("invalidated dispatcher still forces the real swap", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "raft-macos-login-swap-"));
  const home = path.join(root, "user");
  const slockHome = path.join(home, ".slock");
  const harness = launchctlHarness();
  const originalDispatcher = path.join(home, ".local", "bin", "raft-computer");
  const nextDispatcher = path.join(home, ".local", "bin", "raft-computer-next");
  const baseDeps = {
    platform: "darwin" as const,
    userHome: home,
    uid: 501,
    dispatcherPath: originalDispatcher,
    legacyDesktopBundlePath: path.join(root, "Applications", "Raft Computer.app"),
    runCommand: harness.run,
  };
  try {
    await convergeCliHostLifecycle(slockHome, "enabled", baseDeps);
    // Old dispatcher binary is GONE — the deferral guard must not fire and
    // the carrier must actually move to the new dispatcher.
    const result = await convergeCliHostLifecycle(slockHome, "enabled", {
      ...baseDeps,
      dispatcherPath: nextDispatcher,
    });
    assert.equal(result.deferredRefresh, undefined);
    assert.equal((await readHostLifecycleMarker(slockHome))?.dispatcherPath, nextDispatcher);
    assert.ok([...harness.jobs.values()][0]!.includes(nextDispatcher));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("bootout failure is a safe no-op: definition intact, marker kept, no pending residue", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "raft-macos-login-bootout-red-"));
  const home = path.join(root, "user");
  const slockHome = path.join(home, ".slock");
  const harness = launchctlHarness();
  const originalDispatcher = path.join(home, ".local", "bin", "raft-computer");
  const baseDeps = {
    platform: "darwin" as const,
    userHome: home,
    uid: 501,
    dispatcherPath: originalDispatcher,
    legacyDesktopBundlePath: path.join(root, "Applications", "Raft Computer.app"),
    runCommand: harness.run,
  };
  try {
    await convergeCliHostLifecycle(slockHome, "enabled", baseDeps);
    const markerBefore = await readHostLifecycleMarker(slockHome);
    const definitionBefore = await readFile(markerBefore!.definitionPath!, "utf8");
    await assert.rejects(
      refreshCliLoginCarrierIfOwned(slockHome, {
        ...baseDeps,
        dispatcherPath: path.join(home, ".local", "bin", "raft-computer-next"),
        runCommand: async (command, args, signal) => {
          if (args[0] === "bootout") throw new Error("bootout denied");
          return harness.run(command, args, signal);
        },
      }),
      (error: unknown) => {
        assert.equal((error as { code?: string }).code, "HOST_LIFECYCLE_BOOTOUT_FAILED");
        return true;
      },
    );
    // Old carrier fully intact, marker still truthful, no recovery record.
    assert.deepEqual(await readHostLifecycleMarker(slockHome), markerBefore);
    assert.equal(await readFile(markerBefore!.definitionPath!, "utf8"), definitionBefore);
    assert.ok([...harness.jobs.values()][0]!.includes(originalDispatcher));
    assert.equal(await readHostLifecycleRecoveryStatus(slockHome), null);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("pending recovery with the old carrier actually intact repairs bookkeeping only", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "raft-macos-login-intact-"));
  const home = path.join(root, "user");
  const slockHome = path.join(home, ".slock");
  const harness = launchctlHarness();
  const originalDispatcher = path.join(home, ".local", "bin", "raft-computer");
  const baseDeps = {
    platform: "darwin" as const,
    userHome: home,
    uid: 501,
    dispatcherPath: originalDispatcher,
    legacyDesktopBundlePath: path.join(root, "Applications", "Raft Computer.app"),
    runCommand: harness.run,
  };
  try {
    await convergeCliHostLifecycle(slockHome, "enabled", baseDeps);
    const markerBefore = await readHostLifecycleMarker(slockHome);
    // Forge the stranded state the owner hit on 2026-10-02: a pending replace
    // record exists, but the OLD carrier was never actually destroyed.
    const previousDefinition = await readFile(markerBefore!.definitionPath!, "utf8");
    await rm(path.join(slockHome, "computer", "host-lifecycle-owner.json"), { force: true });
    await writeFile(
      path.join(slockHome, "computer", "host-lifecycle-pending-replace.json"),
      `${JSON.stringify({
        formatVersion: 1,
        phase: "rollback-failed",
        previousMarker: markerBefore,
        previousDefinition,
        previousDefinitionSha256: createHash("sha256").update(previousDefinition).digest("hex"),
        targetDefinitionSha256: "0".repeat(64),
        errorCode: "HOST_LIFECYCLE_BOOTOUT_FAILED",
      })}\n`,
    );
    const callsBefore = harness.calls.length;
    // Any lifecycle command reads the record and recovers; with the job still
    // live and the definition matching, recovery must not touch launchd.
    await convergeCliHostLifecycle(slockHome, "enabled", baseDeps);
    const mutating = harness.calls
      .slice(callsBefore)
      .filter((c) => c[1] === "bootout" || c[1] === "bootstrap").length;
    assert.equal(mutating, 0, "intact carrier needs no launchctl write");
    assert.deepEqual(await readHostLifecycleMarker(slockHome), markerBefore);
    assert.equal(await readHostLifecycleRecoveryStatus(slockHome), null);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("bootout late error (job actually unloaded) restores the previous carrier within the failed call", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "raft-macos-login-late-red-"));
  const home = path.join(root, "user");
  const slockHome = path.join(home, ".slock");
  const harness = launchctlHarness();
  const originalDispatcher = path.join(home, ".local", "bin", "raft-computer");
  const baseDeps = {
    platform: "darwin" as const,
    userHome: home,
    uid: 501,
    dispatcherPath: originalDispatcher,
    legacyDesktopBundlePath: path.join(root, "Applications", "Raft Computer.app"),
    runCommand: harness.run,
  };
  try {
    await convergeCliHostLifecycle(slockHome, "enabled", baseDeps);
    const markerBefore = await readHostLifecycleMarker(slockHome);
    const definitionBefore = await readFile(markerBefore!.definitionPath!, "utf8");
    await assert.rejects(
      refreshCliLoginCarrierIfOwned(slockHome, {
        ...baseDeps,
        dispatcherPath: path.join(home, ".local", "bin", "raft-computer-next"),
        runCommand: async (command, args, signal) => {
          // bootout REALLY unloads, then reports failure — the late-error
          // shape launchd can produce. The code must not treat this as a
          // provable no-op: the recovery record has to survive.
          if (args[0] === "bootout") {
            await harness.run(command, args, signal);
            throw new Error("bootout failed late");
          }
          return harness.run(command, args, signal);
        },
      }),
      (error: unknown) => {
        assert.equal((error as { code?: string }).code, "HOST_LIFECYCLE_BOOTOUT_FAILED");
        return true;
      },
    );
    // Bounded recovery WITHIN the failed call: the previous definition was
    // never swapped (the destructive phase follows bootout), so the same call
    // re-bootstraps it, verifies the old job is live again, and clears the
    // pending record. The caller sees BOOTOUT_FAILED with "carrier restored".
    assert.equal(harness.jobs.size, 1);
    assert.ok([...harness.jobs.values()][0]!.includes(originalDispatcher));
    assert.equal(await readFile(markerBefore!.definitionPath!, "utf8"), definitionBefore);
    assert.equal((await readHostLifecycleMarker(slockHome))?.dispatcherPath, originalDispatcher);
    assert.equal(await readHostLifecycleRecoveryStatus(slockHome), null);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("explicit carrier refresh (mode=refresh) must land the new dispatcher despite a healthy old one", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "raft-macos-login-refresh-mode-"));
  const home = path.join(root, "user");
  const slockHome = path.join(home, ".slock");
  const harness = launchctlHarness();
  const originalDispatcher = path.join(home, ".local", "bin", "raft-computer");
  const nextDispatcher = path.join(home, ".local", "bin", "raft-computer-next");
  const baseDeps = {
    platform: "darwin" as const,
    userHome: home,
    uid: 501,
    dispatcherPath: originalDispatcher,
    legacyDesktopBundlePath: path.join(root, "Applications", "Raft Computer.app"),
    runCommand: harness.run,
  };
  try {
    await convergeCliHostLifecycle(slockHome, "enabled", baseDeps);
    // Old dispatcher exists and is executable — the converge-mode deferral
    // would skip; the explicit refresh (upgrade path) must NOT.
    await mkdir(path.dirname(originalDispatcher), { recursive: true });
    await writeFile(originalDispatcher, "#!/bin/sh\n", { mode: 0o755 });
    await refreshCliLoginCarrierIfOwned(slockHome, {
      ...baseDeps,
      dispatcherPath: nextDispatcher,
    });
    assert.equal((await readHostLifecycleMarker(slockHome))?.dispatcherPath, nextDispatcher);
    assert.ok([...harness.jobs.values()][0]!.includes(nextDispatcher));
    assert.equal(await readHostLifecycleRecoveryStatus(slockHome), null);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("bootout late error whose in-call recovery also fails degrades to the durable pending record", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "raft-macos-login-late-recover-red-"));
  const home = path.join(root, "user");
  const slockHome = path.join(home, ".slock");
  const harness = launchctlHarness();
  const originalDispatcher = path.join(home, ".local", "bin", "raft-computer");
  const baseDeps = {
    platform: "darwin" as const,
    userHome: home,
    uid: 501,
    dispatcherPath: originalDispatcher,
    legacyDesktopBundlePath: path.join(root, "Applications", "Raft Computer.app"),
    runCommand: harness.run,
  };
  try {
    await convergeCliHostLifecycle(slockHome, "enabled", baseDeps);
    const markerBefore = await readHostLifecycleMarker(slockHome);
    const definitionBefore = await readFile(markerBefore!.definitionPath!, "utf8");
    await assert.rejects(
      refreshCliLoginCarrierIfOwned(slockHome, {
        ...baseDeps,
        dispatcherPath: path.join(home, ".local", "bin", "raft-computer-next"),
        runCommand: async (command, args, signal) => {
          // bootout REALLY unloads then errors; every subsequent bootstrap
          // (the in-call recovery AND any later retry) is denied.
          if (args[0] === "bootout") {
            await harness.run(command, args, signal);
            throw new Error("bootout failed late");
          }
          if (args[0] === "bootstrap") throw new Error("bootstrap denied");
          return harness.run(command, args, signal);
        },
      }),
      (error: unknown) => {
        // Terminal degraded code, never rewritten into a "restored" claim.
        assert.equal((error as { code?: string }).code, "HOST_LIFECYCLE_BOOTOUT_RECOVERY_FAILED");
        return true;
      },
    );
    // Degraded, truthfully so: job gone, definition + marker intact, pending
    // record kept as the durable recovery anchor.
    assert.equal(harness.jobs.size, 0);
    assert.equal(await readFile(markerBefore!.definitionPath!, "utf8"), definitionBefore);
    assert.equal((await readHostLifecycleMarker(slockHome))?.dispatcherPath, originalDispatcher);
    assert.equal((await readHostLifecycleRecoveryStatus(slockHome))?.status, "pending-replace");
    // Once bootstrap is allowed again, a plain converge lands the recovery.
    await convergeCliHostLifecycle(slockHome, "enabled", baseDeps);
    assert.ok([...harness.jobs.values()][0]!.includes(originalDispatcher));
    assert.equal(await readHostLifecycleRecoveryStatus(slockHome), null);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("forward-deadline abort during bootout still recovers — the recovery rides the caller signal, not the dead deadline", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "raft-macos-login-abort-fwd-"));
  const home = path.join(root, "user");
  const slockHome = path.join(home, ".slock");
  const harness = launchctlHarness();
  const originalDispatcher = path.join(home, ".local", "bin", "raft-computer");
  const baseDeps = {
    platform: "darwin" as const,
    userHome: home,
    uid: 501,
    dispatcherPath: originalDispatcher,
    legacyDesktopBundlePath: path.join(root, "Applications", "Raft Computer.app"),
    runCommand: harness.run,
  };
  try {
    await convergeCliHostLifecycle(slockHome, "enabled", baseDeps);
    const markerBefore = await readHostLifecycleMarker(slockHome);
    // Refresh with a shared deadline that aborts exactly when bootout runs:
    // bootout REALLY unloads, then the abort fires. The recovery must still
    // execute (caller-level signal) and the error must describe the real
    // outcome — carrier restored.
    const deadline = new AbortController();
    await assert.rejects(
      refreshCliLoginCarrierIfOwned(slockHome, {
        ...baseDeps,
        dispatcherPath: path.join(home, ".local", "bin", "raft-computer-next"),
        signal: deadline.signal,
        deadlineAtMs: Date.now() + 60_000,
        runCommand: async (command, args, signal) => {
          if (args[0] === "bootout") {
            await harness.run(command, args, signal);
            deadline.abort();
            const abortError = new Error("operation aborted");
            abortError.name = "AbortError";
            throw abortError;
          }
          return harness.run(command, args, signal);
        },
      }),
      (error: unknown) => {
        // The in-call recovery succeeded, so the outer handler reports the
        // forward timeout with its accurate "restored the last verified
        // carrier" text — the restoration claim is real here.
        const err = error as { code?: string; message?: string };
        assert.equal(err.code, "HOST_LIFECYCLE_REFRESH_TIMEOUT");
        return true;
      },
    );
    // The old carrier is live again and nothing is left pending.
    assert.equal(harness.jobs.size, 1);
    assert.ok([...harness.jobs.values()][0]!.includes(originalDispatcher));
    assert.equal((await readHostLifecycleMarker(slockHome))?.dispatcherPath, originalDispatcher);
    assert.equal(await readHostLifecycleRecoveryStatus(slockHome), null);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("caller-level cancellation during bootout still recovers — the recovery budget is independent of the caller signal", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "raft-macos-login-abort-parent-"));
  const home = path.join(root, "user");
  const slockHome = path.join(home, ".slock");
  const harness = launchctlHarness();
  const originalDispatcher = path.join(home, ".local", "bin", "raft-computer");
  const baseDeps = {
    platform: "darwin" as const,
    userHome: home,
    uid: 501,
    dispatcherPath: originalDispatcher,
    legacyDesktopBundlePath: path.join(root, "Applications", "Raft Computer.app"),
    runCommand: harness.run,
  };
  try {
    await convergeCliHostLifecycle(slockHome, "enabled", baseDeps);
    const callerSignal = new AbortController();
    await assert.rejects(
      refreshCliLoginCarrierIfOwned(slockHome, {
        ...baseDeps,
        dispatcherPath: path.join(home, ".local", "bin", "raft-computer-next"),
        signal: callerSignal.signal,
        runCommand: async (command, args, signal) => {
          // Signal-bound calls (the forward path) refuse once the caller
          // cancelled; the recovery rides the raw runner and still runs.
          if (signal?.aborted) {
            const abortError = new Error("operation aborted");
            abortError.name = "AbortError";
            throw abortError;
          }
          if (args[0] === "bootout") {
            await harness.run(command, args, signal);
            callerSignal.abort();
            const abortError = new Error("operation aborted");
            abortError.name = "AbortError";
            throw abortError;
          }
          return harness.run(command, args, signal);
        },
      }),
      (error: unknown) => {
        assert.equal((error as { code?: string }).code, "HOST_LIFECYCLE_BOOTOUT_FAILED");
        return true;
      },
    );
    // The caller cancelled, but the recovery budget is independent: the
    // previous carrier is live again and nothing is left pending.
    assert.equal(harness.jobs.size, 1);
    assert.ok([...harness.jobs.values()][0]!.includes(originalDispatcher));
    assert.equal((await readHostLifecycleMarker(slockHome))?.dispatcherPath, originalDispatcher);
    assert.equal(await readHostLifecycleRecoveryStatus(slockHome), null);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("forward timeout + failed in-call recovery reports the degraded truth, never a rewritten 'restored' claim", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "raft-macos-login-timeout-degraded-"));
  const home = path.join(root, "user");
  const slockHome = path.join(home, ".slock");
  const harness = launchctlHarness();
  const originalDispatcher = path.join(home, ".local", "bin", "raft-computer");
  const baseDeps = {
    platform: "darwin" as const,
    userHome: home,
    uid: 501,
    dispatcherPath: originalDispatcher,
    legacyDesktopBundlePath: path.join(root, "Applications", "Raft Computer.app"),
    runCommand: harness.run,
  };
  try {
    await convergeCliHostLifecycle(slockHome, "enabled", baseDeps);
    const deadline = new AbortController();
    await assert.rejects(
      refreshCliLoginCarrierIfOwned(slockHome, {
        ...baseDeps,
        dispatcherPath: path.join(home, ".local", "bin", "raft-computer-next"),
        signal: deadline.signal,
        deadlineAtMs: Date.now() + 60_000,
        runCommand: async (command, args, signal) => {
          if (args[0] === "bootout") {
            await harness.run(command, args, signal);
            deadline.abort();
            const abortError = new Error("operation aborted");
            abortError.name = "AbortError";
            throw abortError;
          }
          // The forward deadline fired AND the recovery bootstrap fails: the
          // report must keep the degraded terminal code and state.
          if (args[0] === "bootstrap") throw new Error("bootstrap denied");
          return harness.run(command, args, signal);
        },
      }),
      (error: unknown) => {
        assert.equal(
          (error as { code?: string }).code,
          "HOST_LIFECYCLE_BOOTOUT_RECOVERY_FAILED",
          "the outer timeout rewrite must not mask the degraded outcome",
        );
        return true;
      },
    );
    assert.equal(harness.jobs.size, 0, "job is genuinely gone");
    assert.equal((await readHostLifecycleRecoveryStatus(slockHome))?.status, "pending-replace");
    assert.equal((await readHostLifecycleMarker(slockHome))?.dispatcherPath, originalDispatcher);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("carrier plist carries self-contained RAFT_HOME/SLOCK_HOME env (#computer-extract pitfall A)", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "carrier-env-"));
  const home = path.join(root, "user");
  const slockHome = path.join(root, "slock");
  await mkdir(home, { recursive: true });
  const harness = launchctlHarness();
  const baseDeps = {
    platform: "darwin" as const,
    uid: 501,
    userHome: home,
    dispatcherPath: path.join(home, ".local", "bin", "raft-computer"),
    runCommand: harness.run,
  };
  try {
    await convergeCliHostLifecycle(slockHome, "enabled", baseDeps);
    const marker = await readHostLifecycleMarker(slockHome);
    const definition = await readFile(marker!.definitionPath!, "utf8");
    assert.ok(definition.includes("<key>RAFT_HOME</key>"), "RAFT_HOME key present");
    assert.ok(definition.includes(`<string>${slockHome}</string>`), "RAFT_HOME value is the home");
    // Both keys present; ProgramArguments pinning is asserted elsewhere already.
    const slockKey = definition.indexOf("<key>SLOCK_HOME</key>");
    assert.ok(slockKey > 0, "SLOCK_HOME key present");
  } finally {
    // `home` lives under `root`; removing `root` covers both (PM review nit, PR #266).
    await rm(root, { recursive: true, force: true });
  }
});
