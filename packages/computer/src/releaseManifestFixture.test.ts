// Contract v1 (task #6): the SAME root-manifest fixtures drive latest-version
// resolution in all three implementations — TypeScript (this file, exercising
// fetchCdnLatestVersionResult), POSIX shell (the manifest_latest_version block
// extracted verbatim from scripts/install.sh), and PowerShell (ConvertFrom-Json
// + the top-level `.version` access install.ps1 uses). A divergence between
// the three is a contract break even when each side looks individually sane.
import { readFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import assert from "node:assert/strict";
import { test } from "vitest";
import { fetchCdnLatestVersionResult } from "./computerRelease.js";

const execFileAsync = promisify(execFile);
const fixturesDir = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "scripts", "fixtures");
const windowsInstallScriptPath = path.join(fixturesDir, "..", "install.ps1");

interface FixtureCase {
  file: string;
  expect: { ok: true; version: string } | { ok: false; reason: "publishing" | "network" };
}

const CASES: FixtureCase[] = [
  { file: "release-root-manifest.fixture.json", expect: { ok: true, version: "1.0.42" } },
  // Nested target "version" keys and prose mentions must never shadow the root.
  { file: "release-root-manifest.nested-first.fixture.json", expect: { ok: true, version: "2.0.0" } },
  // Braces/escaped quotes inside strings and real document line breaks must
  // not confuse any of the three parsers (shell keeps a string-aware scanner).
  { file: "release-root-manifest.string-braces.fixture.json", expect: { ok: true, version: "1.2.3" } },
  // \uXXXX escapes must decode to the SAME key/value JSON.parse produces:
  // "version":"8.8.8-wrong" and "version":"3.2.1" are duplicate keys (the
  // escaped spelling IS the plain key after decoding) so the last one wins;
  // "version" spelled with a LITERAL backslash never matches.
  { file: "release-root-manifest.unicode-escapes.fixture.json", expect: { ok: true, version: "3.2.1" } },
  { file: "release-root-manifest.no-version.fixture.json", expect: { ok: false, reason: "publishing" } },
  // Structurally invalid JSON resolves NOWHERE — a failed look is never a
  // version. The TS surface maps a body that will not parse to its catch-all
  // network failure.
  { file: "release-root-manifest.invalid.fixture.json", expect: { ok: false, reason: "network" } },
  // Two concatenated objects and an illegal literal are likewise invalid
  // documents everywhere (review reproductions).
  { file: "release-root-manifest.concat-invalid.fixture.json", expect: { ok: false, reason: "network" } },
  { file: "release-root-manifest.bad-literal.fixture.json", expect: { ok: false, reason: "network" } },
  // Duplicate "version" keys where the LAST one is not a string: the value
  // is a number everywhere, so no surface may resolve a version from it
  // (TS maps it to its publishing failure, shell/PS refuse).
  { file: "release-root-manifest.nonstring-version.fixture.json", expect: { ok: false, reason: "publishing" } },
  // Review round 3: a nested "version" after the root one must not leak up
  // (the root flag must not survive recursion), and an array/object version
  // value is not a string anywhere.
  { file: "release-root-manifest.nested-after-root.fixture.json", expect: { ok: true, version: "1.2.3" } },
  { file: "release-root-manifest.array-version.fixture.json", expect: { ok: false, reason: "publishing" } },
  // A raw newline INSIDE a JSON string is invalid input everywhere — the
  // shell surface folds structural newlines for its line-oriented scan but
  // must keep in-string newlines fatal (TS: catch-all network failure).
  { file: "release-root-manifest.raw-newline.fixture.json", expect: { ok: false, reason: "network" } },
  // Review round 4: control bytes must be refused on the ORIGINAL input
  // before any rewriting (raw U+0001, NUL — which command substitution
  // would otherwise strip), and trailing commas / comments are invalid
  // documents everywhere (the PS gate covers them via the strict reader).
  { file: "release-root-manifest.raw-u0001.fixture.json", expect: { ok: false, reason: "network" } },
  { file: "release-root-manifest.nul-byte.fixture.json", expect: { ok: false, reason: "network" } },
  { file: "release-root-manifest.trailing-comma.fixture.json", expect: { ok: false, reason: "network" } },
  { file: "release-root-manifest.comment.fixture.json", expect: { ok: false, reason: "network" } },
  // Review round 6: LEGAL documents an unrelated note field must not block.
  // DEL (U+007F) is a legal JSON string character, and lone surrogates are
  // replaced with U+FFFD by JSON.parse rather than rejected — the version
  // resolves everywhere despite the exotic bytes in another field.
  { file: "release-root-manifest.del-char.fixture.json", expect: { ok: true, version: "1.2.3" } },
  { file: "release-root-manifest.lone-surrogates.fixture.json", expect: { ok: true, version: "1.2.3" } },
];

async function fixtureBody(file: string): Promise<string> {
  return readFile(path.join(fixturesDir, file), "utf8");
}

test("TypeScript: fetchCdnLatestVersionResult resolves the shared fixtures", async () => {
  for (const testCase of CASES) {
    const body = await fixtureBody(testCase.file);
    const result = await fetchCdnLatestVersionResult("https://releases.example.com/computer", (async () =>
      new Response(body, { status: 200, headers: { "Content-Type": "application/json" } })) as typeof fetch);
    assert.deepEqual(result, testCase.expect, `fixture ${testCase.file}`);
  }
});

test("TypeScript: an unreachable release root reads as a network failure, never a version", async () => {
  const result = await fetchCdnLatestVersionResult("https://releases.example.com/computer", (async () => {
    throw new Error("network down");
  }) as typeof fetch);
  assert.deepEqual(result, { ok: false, reason: "network" });
});

test("shell: the install.sh manifest_latest_version block resolves the shared fixtures", async () => {
  const installSh = await readFile(path.join(fixturesDir, "..", "install.sh"), "utf8");
  // Extract ONLY the function definition (to the closing brace at column
  // zero) so the surrounding comment prose cannot leak in; eval injects it
  // because POSIX `.` cannot source a heredoc.
  const match = installSh.match(/^manifest_latest_version\(\) \{[\s\S]*?^\}/m);
  assert.ok(match, "install.sh must keep the extractable manifest_latest_version function");

  for (const testCase of CASES) {
    const body = await fixtureBody(testCase.file);
    // Execution errors and assertion failures are handled SEPARATELY: a
    // fixture expected to fail that (wrongly) resolves must fail this test,
    // never be swallowed by the execution catch.
    let stdout = "";
    let executionError: unknown = null;
    try {
      const run = await execFileAsync("sh", [
        "-c",
        `eval "$(printf '%s' "$2")"\nprintf '%s' "$1" | manifest_latest_version -\n`,
        "sh",
        body,
        match[0],
      ]) as unknown as { stdout: string | Buffer };
      stdout = typeof run.stdout === "string" ? run.stdout : run.stdout.toString();
    } catch (error) {
      executionError = error;
      const partial = (error as { stdout?: string | Buffer }).stdout;
      if (typeof partial === "string") stdout = partial;
      else if (Buffer.isBuffer(partial)) stdout = partial.toString();
    }
    if (testCase.expect.ok) {
      assert.equal(executionError, null, `fixture ${testCase.file} must resolve in shell but failed: ${executionError}`);
      assert.equal(stdout, testCase.expect.version, `fixture ${testCase.file}`);
    } else {
      assert.ok(
        executionError !== null || stdout.trim().length === 0,
        `fixture ${testCase.file} must refuse to resolve a version in shell but resolved: ${JSON.stringify(stdout)}`,
      );
    }

    // The installer's manifest-latest line calls the function with the file
    // PATH as its argument — both invocation shapes must agree on every
    // fixture (the file branch once broke while stdin kept passing).
    const fixturePath = path.join(fixturesDir, testCase.file);
    let fileOut = "";
    let fileError: unknown = null;
    try {
      const fileRun = await execFileAsync("sh", [
        "-c",
        `eval "$(printf '%s' "$2")"\nmanifest_latest_version "$1"\n`,
        "sh",
        fixturePath,
        match[0],
      ]) as unknown as { stdout: string | Buffer };
      fileOut = typeof fileRun.stdout === "string" ? fileRun.stdout : fileRun.stdout.toString();
    } catch (error) {
      fileError = error;
      const partial = (error as { stdout?: string | Buffer }).stdout;
      if (typeof partial === "string") fileOut = partial;
      else if (Buffer.isBuffer(partial)) fileOut = partial.toString();
    }
    if (testCase.expect.ok) {
      assert.equal(fileError, null, `fixture ${testCase.file} (file argument) must resolve in shell but failed: ${fileError}`);
      assert.equal(fileOut, testCase.expect.version, `fixture ${testCase.file} (file argument)`);
    } else {
      assert.ok(
        fileError !== null || fileOut.trim().length === 0,
        `fixture ${testCase.file} (file argument) must refuse to resolve a version in shell but resolved: ${JSON.stringify(fileOut)}`,
      );
    }
  }
}, { timeout: 30_000 });

test("PowerShell: install.ps1 parses with zero syntax errors", async () => {
  // The strictness-gate round shipped \$Uri: inside a double-quoted string,
  // which pwsh reads as a drive-qualified variable and refuses to even
  // parse — guard the WHOLE script so the installer can never ship
  // unparseable again.
  const script = [
    "$err = $null",
    "[void][System.Management.Automation.Language.Parser]::ParseFile(",
    `  '${windowsInstallScriptPath.replace(/'/g, "''")}', [ref]$null, [ref]$err)`,
    "if ($err -and $err.Count -gt 0) { $err | ForEach-Object { Write-Output ($_.Extent.StartLineNumber.ToString() + ': ' + $_.Message) }; exit 1 }",
    "Write-Output 'PSH-PARSE-OK'",
  ].join("\n");
  const run = await execFileAsync("pwsh", ["-NoProfile", "-Command", script], { timeout: 60_000 }) as unknown as { stdout: string | Buffer };
  const text = (typeof run.stdout === "string" ? run.stdout : run.stdout.toString()).trim();
  assert.equal(text, "PSH-PARSE-OK", "install.ps1 must parse cleanly");
}, { timeout: 90_000 });

test("PowerShell: the REAL install.ps1 Read-Json resolves the shared fixtures", async () => {
  // Extract the actual Read-Json function from install.ps1 and execute it
  // against local files (Invoke-WebRequest stubbed to serve the fixture
  // bytes) — the parity must cover the shipping implementation, not a
  // hand-mirrored fragment of it.
  const installer = await readFile(windowsInstallScriptPath, "utf8");
  const fn = installer.match(/function Read-Json\(\[string\]\$Uri\) \{[\s\S]*?\n\}/);
  assert.ok(fn, "install.ps1 must keep the extractable Read-Json function");

  const caseLines = CASES.map((testCase) => {
    const file = path.join(fixturesDir, testCase.file).replace(/'/g, "''");
    if (testCase.expect.ok) {
      return `@{ file = '${file}'; expect = '${testCase.expect.version}'; mustResolve = $true }`;
    }
    return `@{ file = '${file}'; expect = $null; mustResolve = $false }`;
  });
  const script = [
    "$cases = @(",
    caseLines.map((line) => `  ${line}`).join(",\n"),
    ")",
    // Stub the transport before the real function is defined.
    "function Invoke-WebRequest { param([string]$Uri, [switch]$UseBasicParsing) ",
    "  $bytes = [System.IO.File]::ReadAllBytes($Uri)",
    "  [pscustomobject]@{ Content = $bytes } }",
    "function Fail([string]$Message) { throw $Message }",
    fn[0],
    "$failed = $false",
    "foreach ($c in $cases) {",
    "  $v = $null",
    "  try {",
    "    $m = Read-Json $c.file",
    "    if ($null -ne $m) { $v = $m.version }",
    "  } catch { $v = $null }",
    "  if ($c.mustResolve) {",
    "    if (-not $v -or $v -isnot [string] -or $v -ne $c.expect) { Write-Output \"MISMATCH $($c.file): got '$v' want '$($c.expect)'\"; $failed = $true }",
    "  } else {",
    "    if ($null -ne $v -and $v -is [string] -and $v.Length -gt 0) { Write-Output \"EXPECTED-UNRESOLVED $($c.file): resolved '$v'\"; $failed = $true }",
    "  }",
    "}",
    "if ($failed) { exit 1 } else { Write-Output 'PSH-OK' }",
  ].join("\n");

  const run = await execFileAsync("pwsh", ["-NoProfile", "-Command", script], { timeout: 90_000 }) as unknown as { stdout: string | Buffer };
  const text = (typeof run.stdout === "string" ? run.stdout : run.stdout.toString()).trim();
  assert.equal(text.endsWith("PSH-OK") ? "PSH-OK" : text, "PSH-OK");
}, { timeout: 120_000 });

