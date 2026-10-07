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

// ── Task #12: bun-installed omp launches (env-shebang scripts) ──────────

import { resolveOmpLaunch } from "./omp.js";
import { readFileSync } from "node:fs";
import { detectOmpModels } from "./omp.js";

interface VersionCall {
  command: string;
  args: string[];
  envPath: string;
}

/**
 * A probe deps set whose PATH lookup always misses, and whose --version runs
 * are recorded (command, args, env.PATH) before answering from `respond`.
 */
function recordedVersionDeps(
  home: string,
  respond: (call: { command: string; args: string[] }) => string,
): { deps: ProbeDeps; calls: VersionCall[] } {
  const calls: VersionCall[] = [];
  const deps: ProbeDeps = {
    platform: "darwin",
    homeDir: home,
    env: { HOME: home, PATH: "/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin" },
    execFileSyncFn: ((command: string, args: string[], opts?: { env?: Record<string, string> }) => {
      if (command === "which") throw new Error("not found");
      calls.push({ command, args: [...args], envPath: opts?.env?.PATH ?? "" });
      return respond({ command, args: [...args] });
    }) as unknown as ProbeDeps["execFileSyncFn"],
  };
  return { deps, calls };
}

test("probe runs a bun-installed omp via its own bin dir (bun beside the symlink)", () => {
  withTempHome((home) => {
    const ompScript = path.join(home, ".bun", "bin", "omp");
    const bunScript = path.join(home, ".bun", "bin", "bun");
    mkdirSync(path.dirname(ompScript), { recursive: true });
    writeFileSync(ompScript, "#!/usr/bin/env bun\n", { mode: 0o755 });
    writeFileSync(bunScript, "#!/bin/sh\n", { mode: 0o755 });

    const { deps, calls } = recordedVersionDeps(home, () => "omp/18.6.1\n");

    const result = new OmpDriver().probe(deps);
    assert.deepEqual(result, { available: true, version: "omp/18.6.1" });
    // PATH lookup for omp misses, the env-bun interpreter check misses (bun
    // is NOT on the daemon PATH), then the version read runs through bun with
    // the omp bin dir leading the child PATH.
    assert.deepEqual(calls.map((call) => [call.command, call.args]), [
      [bunScript, [ompScript, "--version"]],
    ]);
    assert.ok(calls[0].envPath.startsWith(`${path.dirname(ompScript)}${path.delimiter}`), "omp bin dir must lead the child PATH");
  });
});

test("resolveOmpLaunch falls back to an explicit interpreter argv from well-known dirs", () => {
  withTempHome((home) => {
    const ompScript = path.join(home, ".local", "bin", "omp");
    mkdirSync(path.dirname(ompScript), { recursive: true });
    writeFileSync(ompScript, "#!/usr/bin/env bun\n", { mode: 0o755 });
    const bunScript = path.join(home, ".bun", "bin", "bun");
    mkdirSync(path.dirname(bunScript), { recursive: true });
    writeFileSync(bunScript, "#!/bin/sh\n", { mode: 0o755 });

    const base = { HOME: home, PATH: "/usr/bin:/bin" };
    const plan = resolveOmpLaunch(ompScript, ["--mode", "rpc"], base, { env: base, homeDir: home });
    assert.deepEqual(plan.argv, [bunScript, ompScript, "--mode", "rpc"]);
    assert.ok(plan.env.PATH?.startsWith(`${path.dirname(bunScript)}${path.delimiter}`));
    assert.ok(plan.env.PATH?.includes(`${path.dirname(ompScript)}${path.delimiter}`));
    assert.equal(plan.diagnostic, null);
    // The base env is never mutated — the augmented env belongs to omp children only.
    assert.equal(base.PATH, "/usr/bin:/bin");
  });
});

test("probe keeps the self-contained binary path unchanged (no bun involved)", () => {
  withTempHome((home) => {
    const localInstall = path.join(home, ".local", "bin", "omp");
    mkdirSync(path.dirname(localInstall), { recursive: true });
    // omp.sh self-contained binary: no env shebang, no interpreter needed.
    writeFileSync(localInstall, "#!/bin/sh\necho omp/18.6.1\n", { mode: 0o755 });

    const { deps, calls } = recordedVersionDeps(home, () => "omp/18.6.1\n");
    const result = new OmpDriver().probe(deps);
    assert.deepEqual(result, { available: true, version: "omp/18.6.1" });
    // Direct exec of the resolved file — no interpreter lookup on the wire.
    assert.deepEqual(calls.map((call) => [call.command, call.args]), [
      [localInstall, ["--version"]],
    ]);
  });
});

test("probe reports a missing interpreter as unavailable with a readable cause", () => {
  withTempHome((home) => {
    const ompScript = path.join(home, ".bun", "bin", "omp");
    mkdirSync(path.dirname(ompScript), { recursive: true });
    writeFileSync(ompScript, "#!/usr/bin/env bun\n", { mode: 0o755 });
    // No bun in ~/.bun/bin, no Homebrew bun — the interpreter is gone.

    const { deps } = recordedVersionDeps(home, () => {
      throw new Error("must not exec");
    });
    const result = new OmpDriver().probe(deps);
    assert.equal(result.available, false);
    assert.match(result.diagnostic ?? "", /bun/i);
    assert.match(result.diagnostic ?? "", /omp\.sh\/install/);
    assert.equal(result.version, undefined);
  });
});

test("probe degrades a found-but-failing --version to unavailable, never available-without-version", () => {
  withTempHome((home) => {
    const localInstall = path.join(home, ".local", "bin", "omp");
    mkdirSync(path.dirname(localInstall), { recursive: true });
    writeFileSync(localInstall, "#!/bin/sh\nexit 1\n", { mode: 0o755 });

    const deps: ProbeDeps = {
      ...recordedVersionDeps(home, () => {
        throw new Error("exit 1");
      }).deps,
    };
    const result = new OmpDriver().probe(deps);
    assert.equal(result.available, false, "a versionless probe must not claim availability");
    assert.match(result.diagnostic ?? "", /--version failed/);
  });
});

test("detect cache stays retryable: launch failures are not pinned for the TTL", async () => {
  const home = mkdtempSync(path.join(os.tmpdir(), "slock-omp-cache-"));
  try {
    const counterFile = path.join(home, "spawn-count");
    // Each probe spawns this wrapper, which records itself and exits 1 —
    // modeling a launch failure. Detect must surface the error and NOT cache
    // it, so a follow-up call probes again instead of replaying the failure
    // for a full TTL (task #12 review point).
    const wrapper = path.join(home, "failing-omp.sh");
    writeFileSync(wrapper, `#!/bin/sh\necho x >> "${counterFile}"\nexit 1\n`, { mode: 0o755 });

    const first = await detectOmpModels({ command: wrapper });
    const second = await detectOmpModels({ command: wrapper });
    assert.equal(first.kind, "error");
    assert.equal(second.kind, "error");
    const count = readFileSync(counterFile, "utf8").trim().split("\n").filter(Boolean).length;
    assert.equal(count, 2, "the second detect must re-probe instead of replaying the cached error");
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
