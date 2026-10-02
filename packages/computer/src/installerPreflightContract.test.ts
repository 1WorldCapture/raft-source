// Real-installer regressions for the PR #132 first-review findings:
//  - P2 pre-flight ORDER: capability probing (release-source --help) is
//    separate from config validation; a conflicting/corrupt source or an
//    invalid env group must refuse BEFORE any byte or state is replaced,
//    while a genuine pre-contract binary keeps the compat path.
//  - P2 attested sizes: the manifest backend must refuse hash-correct but
//    size-wrong / size-missing / unreachable artifacts without touching the
//    current install state.
// All cells run the REAL install.sh against a file:// release root.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { test } from "vitest";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const repoRoot = resolve(import.meta.dirname, "../../..");
const installScriptPath = resolve(repoRoot, "packages/computer/scripts/install.sh");

const sha256Of = (bytes: Buffer | string): string => createHash("sha256").update(bytes).digest("hex");

/**
 * A fixture "binary" that models the installer's interaction surface. With
 * `capable=false` it is a pre-contract binary (no release-source subcommand);
 * with `capable=true` it answers the --help capability probe, mirrors
 * RAFT_TEST_RS_SHOW for `show`, and RAFT_TEST_RS_INIT for `init` (logging the
 * call to RAFT_TEST_RS_LOG).
 */
async function writeFixtureBinary(path: string, version: string, capable: boolean): Promise<Buffer> {
  const lines = [
    "#!/bin/sh",
    'case "$1" in',
    `  --version) printf '%s\\n' ${JSON.stringify(version)}; exit 0 ;;`,
  ];
  if (capable) {
    lines.push(
      "  release-source)",
      '    case "$2" in',
      "      --help) exit 0 ;;",
      '      show) exit "${RAFT_TEST_RS_SHOW:-0}" ;;',
      "      init)",
      "        printf 'init %s\\n' \"$*\" >> \"${RAFT_TEST_RS_LOG:-/dev/null}\"",
      "        exit \"${RAFT_TEST_RS_INIT:-0}\" ;;",
      "    esac",
      "    exit 1 ;;",
    );
  }
  lines.push(
    "  __installer-converge) printf 'converged\\n'; exit 0 ;;",
    "  stop|start|__supervisor) exit 0 ;;",
    "esac",
    "exit 0",
  );
  const bytes = Buffer.from(lines.join("\n") + "\n");
  await writeFile(path, bytes);
  await chmod(path, 0o755);
  return bytes;
}

/** The installer's bytes-on-disk platform check consults `file -b`; feed it the host description. */
async function writeFileCommandShim(root: string, target: string): Promise<string> {
  const fakeBin = resolve(root, "fake-bin");
  await mkdir(fakeBin, { recursive: true });
  const description =
    target.startsWith("darwin-arm64") ? "Mach-O 64-bit executable arm64"
    : target.startsWith("darwin-x64") ? "Mach-O 64-bit executable x86_64"
    : target.startsWith("linux-arm64") ? "ELF 64-bit LSB executable, aarch64"
    : target.startsWith("linux-x64") ? "ELF 64-bit LSB executable, x86-64"
    : "fixture executable";
  const shim = resolve(fakeBin, "file");
  await writeFile(shim, `#!/bin/sh\nprintf '%s\\n' ${JSON.stringify(description)}\n`);
  await chmod(shim, 0o755);
  return fakeBin;
}

interface ManifestTweak {
  binarySize?: number;
  omitBinarySize?: boolean;
  omitWasmSize?: boolean;
  oldPreContract?: boolean;
}

async function buildReleaseTree(root: string, version: string, target: string, tweak: ManifestTweak = {}): Promise<{
  env: Record<string, string | undefined>;
  oldDispatcher: Buffer;
  oldWasm: Buffer;
} > {
  const releaseDir = resolve(root, "release", version);
  const home = resolve(root, "user-home");
  const installDir = resolve(root, "install-dir");
  const slockHome = resolve(root, "slock-home");
  await mkdir(releaseDir, { recursive: true });
  await mkdir(installDir, { recursive: true });

  const fileName = `raft-computer-${target}`;
  const bytes = await writeFixtureBinary(resolve(releaseDir, fileName), version, true);
  const photonWasm = Buffer.from("fixture photon wasm for preflight regressions\n");
  await writeFile(resolve(releaseDir, "photon_rs_bg.wasm"), photonWasm);

  const binarySize = tweak.omitBinarySize ? undefined : (tweak.binarySize ?? bytes.length);
  const wasmSize = tweak.omitWasmSize ? undefined : photonWasm.length;
  const targetEntry: Record<string, unknown> = {
    file: fileName,
    sha256: sha256Of(bytes),
    ...(binarySize !== undefined ? { size: binarySize } : {}),
  };
  const manifest: Record<string, unknown> = {
    version,
    photonWasm: {
      file: "photon_rs_bg.wasm",
      sha256: sha256Of(photonWasm),
      ...(wasmSize !== undefined ? { size: wasmSize } : {}),
    },
    targets: { [target]: targetEntry },
  };
  await writeFile(resolve(releaseDir, "manifest.json"), JSON.stringify(manifest, null, 2));

  // Pre-existing install state that must survive every refused install.
  const oldDispatcher = await writeFixtureBinary(resolve(installDir, "raft-computer"), "0.0.1-old", !tweak.oldPreContract);
  const oldWasm = Buffer.from("old deployed wasm bytes\n");
  await writeFile(resolve(installDir, "photon_rs_bg.wasm"), oldWasm);

  const env: Record<string, string | undefined> = {
    ...process.env,
    HOME: home,
    SLOCK_HOME: slockHome,
    RAFT_COMPUTER_INSTALL_DIR: installDir,
    RAFT_COMPUTER_NO_MODIFY_PATH: "1",
    RAFT_COMPUTER_RELEASE_BACKEND: "manifest",
    RAFT_COMPUTER_RELEASE_BASE: `file://${resolve(root, "release")}`,
    RAFT_COMPUTER_VERSION: version,
    PATH: `${await writeFileCommandShim(root, target)}:${process.env.PATH ?? ""}`,
  };
  return { env, oldDispatcher, oldWasm };
}

async function assertInstallUntouched(root: string, oldDispatcher: Buffer, oldWasm: Buffer): Promise<void> {
  const installDir = resolve(root, "install-dir");
  const dispatcher = await readFile(resolve(installDir, "raft-computer"));
  assert.equal(sha256Of(dispatcher), sha256Of(oldDispatcher), "the deployed dispatcher must be byte-identical after a refused install");
  const wasm = await readFile(resolve(installDir, "photon_rs_bg.wasm"));
  assert.equal(sha256Of(wasm), sha256Of(oldWasm), "the deployed photon wasm must be byte-identical after a refused install");
}

function hostTarget(): string {
  return `${process.platform}-${process.arch}`;
}

async function runInstaller(env: Record<string, string | undefined>): Promise<{ ok: boolean; log: string; code: number }> {
  try {
    const out = await execFileAsync("sh", [installScriptPath], { env });
    return { ok: true, log: `${out.stdout}\n${out.stderr}`, code: 0 };
  } catch (error) {
    const err = error as { stdout?: string; stderr?: string; code?: number };
    return { ok: false, log: `${err.stdout ?? ""}\n${err.stderr ?? ""}`, code: err.code ?? 1 };
  }
}

const onUnixHost = () => ["darwin", "linux"].includes(process.platform) && ["arm64", "x64"].includes(process.arch);

test("install.sh (manifest) refuses a hash-correct size-wrong binary and leaves the install untouched", async (t) => {
  if (!onUnixHost()) { t.skip(); return; }
  const root = await mkdtemp(resolve(tmpdir(), "raft-preflight-size-"));
  try {
    const version = "1.0.1";
    const { env, oldDispatcher, oldWasm } = await buildReleaseTree(root, version, hostTarget(), { binarySize: 424242 });
    const result = await runInstaller(env);
    assert.ok(!result.ok, "a wrong attested size must fail the install");
    assert.match(result.log, /size mismatch for .*: downloaded \d+ bytes but the manifest attests 424242/);
    await assertInstallUntouched(root, oldDispatcher, oldWasm);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("install.sh (manifest) refuses a manifest whose required files lack an attested size", async (t) => {
  if (!onUnixHost()) { t.skip(); return; }
  const root = await mkdtemp(resolve(tmpdir(), "raft-preflight-nosize-"));
  try {
    const version = "1.0.1";
    const { env, oldDispatcher, oldWasm } = await buildReleaseTree(root, version, hostTarget(), { omitWasmSize: true });
    const result = await runInstaller(env);
    assert.ok(!result.ok, "a missing attested size must fail the install");
    assert.match(result.log, /must declare a valid integer size/);
    await assertInstallUntouched(root, oldDispatcher, oldWasm);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("install.sh (manifest) refuses an unreachable artifact and leaves the install untouched", async (t) => {
  if (!onUnixHost()) { t.skip(); return; }
  const root = await mkdtemp(resolve(tmpdir(), "raft-preflight-unreachable-"));
  try {
    const version = "1.0.1";
    const { env, oldDispatcher, oldWasm } = await buildReleaseTree(root, version, hostTarget());
    await rm(resolve(root, "release", version, `raft-computer-${hostTarget()}`));
    const result = await runInstaller(env);
    assert.ok(!result.ok, "an unreachable artifact must fail the install");
    await assertInstallUntouched(root, oldDispatcher, oldWasm);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("install.sh pre-flight refuses a conflicting persisted release source before replacing any byte", async (t) => {
  if (!onUnixHost()) { t.skip(); return; }
  const root = await mkdtemp(resolve(tmpdir(), "raft-preflight-conflict-"));
  try {
    const version = "1.0.1";
    const { env, oldDispatcher, oldWasm } = await buildReleaseTree(root, version, hostTarget());
    // The existing contract-aware binary reports a healthy config (show=0)
    // but refuses the init (a different persisted source).
    env.RAFT_TEST_RS_INIT = "1";
    const result = await runInstaller(env);
    assert.ok(!result.ok, "a conflicting persisted source must fail the install");
    assert.match(result.log, /release-source pre-flight failed/);
    await assertInstallUntouched(root, oldDispatcher, oldWasm);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("install.sh pre-flight refuses an invalid env group before any download", async (t) => {
  if (!onUnixHost()) { t.skip(); return; }
  const root = await mkdtemp(resolve(tmpdir(), "raft-preflight-envgroup-"));
  try {
    const version = "1.0.1";
    const { env, oldDispatcher, oldWasm } = await buildReleaseTree(root, version, hostTarget());
    env.RAFT_TEST_RS_SHOW = "1"; // the binary's own env-group validation fails
    const result = await runInstaller(env);
    assert.ok(!result.ok, "an invalid onboarding env group must fail the install");
    assert.match(result.log, /release-source environment group is invalid/);
    await assertInstallUntouched(root, oldDispatcher, oldWasm);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("install.sh skips the release-source pre-flight only for a pre-contract binary", async (t) => {
  if (!onUnixHost()) { t.skip(); return; }
  const root = await mkdtemp(resolve(tmpdir(), "raft-preflight-precontract-"));
  try {
    const version = "1.0.1";
    // Old dispatcher WITHOUT the release-source subcommand: the compat path
    // must install and persist the source through the post-install init of
    // the freshly installed (contract-aware) binary.
    const { env } = await buildReleaseTree(root, version, hostTarget(), { oldPreContract: true });
    const rsLog = resolve(root, "rs-init.log");
    env.RAFT_TEST_RS_LOG = rsLog;
    const result = await runInstaller(env);
    assert.ok(result.ok, `pre-contract compat install must succeed: ${result.log}`);
    const installed = await readFile(resolve(root, "install-dir", "raft-computer"));
    assert.match(installed.toString("utf8"), /--version\) printf '%s\\n' "1\.0\.1"/, "the new binary must be promoted");
    const initLog = await readFile(rsLog, "utf8");
    assert.match(initLog, /--backend manifest --release-base /, "the post-install init must persist the onboarding source");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

// --- install.ps1 StateHome precedence (PR #132 first review): the installer
// must select the state root EXACTLY like the CLI's resolveRaftHome()
// (RAFT_HOME wins). A reversed pick would init/persist into one root while
// the installed binary resolves the other.
test("install.ps1 StateHome prefers RAFT_HOME over SLOCK_HOME (CLI parity, one root for subcommands)", async (t) => {
  const { readFile } = await import("node:fs/promises");
  const script = await readFile(resolve(repoRoot, "packages/computer/scripts/install.ps1"), "utf8");

  // Extract the exact StateHome computation block the installer ships. The
  // anchor runs to the final `else { Join-Path ... '.slock' }` so the whole
  // if/elseif/else chain is captured (a bare first-`}` cut would pass the
  // RAFT_HOME case while silently dropping the SLOCK_HOME fallback).
  const match = script.match(/\$StateHome = if \(\$env:RAFT_HOME\) \{[\s\S]*?'\.slock'\s*\n\}/);
  assert.ok(match, "install.ps1 must keep an extractable StateHome block");
  const block = match[0];

  const root = await mkdtemp(resolve(tmpdir(), "raft-ps1-statehome-"));
  try {
    const raftRoot = resolve(root, "anna-private-new");
    const slockRoot = resolve(root, "anna-private-old");
    await mkdir(raftRoot, { recursive: true });
    await mkdir(slockRoot, { recursive: true });
    await writeFile(resolve(slockRoot, "sentinel"), "must survive untouched");

    const run = await execFileAsync("pwsh", ["-NoProfile", "-Command", `
$priorRaft = $env:RAFT_HOME; $priorSlock = $env:SLOCK_HOME
$env:RAFT_HOME = '${raftRoot.replace(/'/g, "''")}'
$env:SLOCK_HOME = '${slockRoot.replace(/'/g, "''")}'
${block}
Write-Output $StateHome
$env:RAFT_HOME = $priorRaft; $env:SLOCK_HOME = $priorSlock
`], { timeout: 60_000 }) as unknown as { stdout: string | Buffer };
    const picked = run.stdout.toString().trim();
    assert.equal(picked, raftRoot, "RAFT_HOME must win over SLOCK_HOME (resolveRaftHome parity)");

    // The NOT-selected root stays untouched: no computer/ appears there.
    const entries = await (await import("node:fs/promises")).readdir(slockRoot);
    assert.deepEqual(entries, ["sentinel"], "the unselected SLOCK_HOME root must not receive any state writes");

    // SLOCK-only inheritance still selects it (no silent default).
    const runSlockOnly = await execFileAsync("pwsh", ["-NoProfile", "-Command", `
$env:RAFT_HOME = $null
$env:SLOCK_HOME = '${slockRoot.replace(/'/g, "''")}'
${block}
Write-Output $StateHome
`], { timeout: 60_000 }) as unknown as { stdout: string | Buffer };
    assert.equal(runSlockOnly.stdout.toString().trim(), slockRoot, "SLOCK_HOME applies when RAFT_HOME is unset");

    // Structural: every release-source subcommand invocation pins BOTH home
    // variables to the same selected root, so installer subcommands can
    // never split across two roots.
    const pinCount = (script.match(/\$env:SLOCK_HOME = \$StateHome/g) ?? []).length;
    const raftPinCount = (script.match(/\$env:RAFT_HOME = \$StateHome/g) ?? []).length;
    assert.ok(pinCount >= 2 && raftPinCount === pinCount, "install.ps1 must pin both home variables together for every subcommand");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}, { timeout: 120_000 });
