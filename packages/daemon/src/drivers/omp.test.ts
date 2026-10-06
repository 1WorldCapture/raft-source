import assert from "node:assert/strict";
import { test } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  isSupportedOmpVersion,
  MIN_SUPPORTED_OMP_VERSION,
  OmpDriver,
  ompCandidatePaths,
  resolveOmpCommand,
  unsupportedOmpVersionMessage,
} from "./omp.js";
import type { ProbeDeps } from "./probe.js";

function withTempHome(cb: (home: string) => void): void {
  const home = mkdtempSync(path.join(os.tmpdir(), "slock-omp-"));
  try {
    cb(home);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
}

function missingBinaryDeps(home: string): ProbeDeps {
  return {
    platform: "darwin",
    homeDir: home,
    env: { HOME: home },
    // PATH lookup fails and no fallback file exists.
    execFileSyncFn: (() => {
      throw new Error("not found");
    }) as unknown as ProbeDeps["execFileSyncFn"],
  };
}

test("ompCandidatePaths covers the documented install locations in order", () => {
  withTempHome((home) => {
    assert.deepEqual(ompCandidatePaths({ homeDir: home, env: { HOME: home } }), [
      path.join(home, ".local", "bin", "omp"),
      path.join(home, ".bun", "bin", "omp"),
      path.join("/opt", "homebrew", "bin", "omp"),
      path.join("/usr", "local", "bin", "omp"),
    ]);
  });
});

test("resolveOmpCommand falls back to the install locations when PATH misses", () => {
  withTempHome((home) => {
    const bunInstall = path.join(home, ".bun", "bin", "omp");
    mkdirSync(path.dirname(bunInstall), { recursive: true });
    writeFileSync(bunInstall, "#!/bin/sh\n", { mode: 0o755 });

    const resolved = resolveOmpCommand(missingBinaryDeps(home));
    assert.equal(resolved, bunInstall);
  });
});

test("probe marks omp unavailable when PATH and fallback locations all miss", () => {
  withTempHome((home) => {
    const result = new OmpDriver().probe(missingBinaryDeps(home));
    assert.deepEqual(result, { available: false });
  });
});

test("probe reports an available install with its version", () => {
  withTempHome((home) => {
    const localInstall = path.join(home, ".local", "bin", "omp");
    mkdirSync(path.dirname(localInstall), { recursive: true });
    writeFileSync(localInstall, "#!/bin/sh\n", { mode: 0o755 });

    const commands: Array<{ command: string; args: string[] }> = [];
    const deps: ProbeDeps = {
      ...missingBinaryDeps(home),
      execFileSyncFn: ((command: string, args: string[]) => {
        commands.push({ command, args: [...args] });
        // PATH lookup misses; the resolved fallback answers --version.
        if (command === "which") throw new Error("not found");
        return `omp/18.6.1\n`;
      }) as unknown as ProbeDeps["execFileSyncFn"],
    };

    const result = new OmpDriver().probe(deps);
    assert.deepEqual(result, { available: true, version: "omp/18.6.1" });
    // PATH is consulted first; the version read uses the resolved absolute
    // path so the eventual launch never depends on the daemon's PATH.
    assert.deepEqual(commands, [
      { command: "which", args: ["omp"] },
      { command: localInstall, args: ["--version"] },
    ]);
  });
});

test("probe refuses installs older than the supported floor", () => {
  withTempHome((home) => {
    const localInstall = path.join(home, ".local", "bin", "omp");
    mkdirSync(path.dirname(localInstall), { recursive: true });
    writeFileSync(localInstall, "#!/bin/sh\n", { mode: 0o755 });

    const deps: ProbeDeps = {
      ...missingBinaryDeps(home),
      execFileSyncFn: (() => "omp/18.5.2\n") as unknown as ProbeDeps["execFileSyncFn"],
    };

    const result = new OmpDriver().probe(deps);
    assert.equal(result.available, false);
    assert.equal(result.version, `omp/18.5.2 (requires >= ${MIN_SUPPORTED_OMP_VERSION})`);
    assert.match(result.diagnostic ?? "", /Upgrade omp/);
  });
});

test("version gate accepts the floor and rejects below it", () => {
  assert.equal(isSupportedOmpVersion("18.6.0"), true);
  assert.equal(isSupportedOmpVersion("18.6.1"), true);
  assert.equal(isSupportedOmpVersion("19.0.0"), true);
  assert.equal(isSupportedOmpVersion("18.5.9"), false);
  assert.equal(isSupportedOmpVersion("17.9.9"), false);
  assert.equal(isSupportedOmpVersion(null), true);
  assert.equal(isSupportedOmpVersion("not-a-version"), true);
});

test("unsupportedOmpVersionMessage carries the upgrade path", () => {
  assert.equal(unsupportedOmpVersionMessage("18.6.1"), null);
  assert.equal(unsupportedOmpVersionMessage(null), null);
  const message = unsupportedOmpVersionMessage("18.5.0");
  assert.match(message ?? "", /requires OMP >= 18\.6\.0/);
  assert.match(message ?? "", /omp\.sh\/install/);
  assert.match(message ?? "", /brew install can1357\/tap\/omp/);
});

test("driver carries the phase-1 target contract", () => {
  const driver = new OmpDriver();
  assert.equal(driver.id, "omp");
  assert.deepEqual(driver.lifecycle, { kind: "persistent", stdin: "direct", inFlightWake: "steer" });
  assert.deepEqual(driver.communication, { chat: "slock_cli", runtimeControl: "none" });
  assert.equal(driver.stdoutChannel, "structured_protocol");
  assert.deepEqual(driver.session, { recovery: "resume_or_fresh" });
  assert.equal(driver.supportsStdinNotification, true);
  assert.equal(driver.busyDeliveryMode, "direct");
});

test("the driver refuses protocol sends before it is ready", async () => {
  const driver = new OmpDriver();
  await assert.rejects(
    () => driver.request({ type: "get_state" }),
    /not ready/,
  );
  assert.deepEqual(driver.parseLine("{}"), []);
  assert.equal(driver.encodeStdinMessage("hello", null), null);
});
