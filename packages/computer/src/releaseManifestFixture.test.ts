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
    try {
      const run = await execFileAsync("sh", [
        "-c",
        `eval "$(printf '%s' "$2")"\nprintf '%s' "$1" | manifest_latest_version -\n`,
        "sh",
        body,
        match[0],
      ]) as unknown as { stdout: string | Buffer };
      const stdout = typeof run.stdout === "string" ? run.stdout : run.stdout.toString();
      assert.ok(testCase.expect.ok, `fixture ${testCase.file} must fail in shell but resolved: ${stdout}`);
      assert.equal(stdout, testCase.expect.version, `fixture ${testCase.file}`);
    } catch (error) {
      assert.ok(!testCase.expect.ok, `fixture ${testCase.file} must resolve in shell but failed: ${error}`);
    }
  }
}, { timeout: 30_000 });

test("PowerShell: the install.ps1 ConvertFrom-Json access resolves the shared fixtures", async () => {
  // One pwsh process evaluates every fixture (cold starts are slow); the
  // script performs exactly the access install.ps1 performs — ConvertFrom-Json
  // then the top-level .version property.
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
    "$failed = $false",
    "foreach ($c in $cases) {",
    "  $v = $null",
    "  try { $m = Get-Content -Raw -LiteralPath $c.file | ConvertFrom-Json; $v = $m.version } catch { $v = $null }",
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
