// Task #6 (phase 2): manual install-command rendering. PM requirements:
// ①standard renders BYTE-IDENTICAL official commands (snapshot-locked);
// ②a missing value falls back to the official command — a bare `{{…}}`
// must never reach an agent following the manual.
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, test } from "vitest";

import {
  OFFICIAL_MANUAL_COMMANDS,
  renderManualCommands,
  resolveManualCommandValues,
} from "./manualCommandContext.js";

const prevMode = process.env.RAFT_DEPLOYMENT_MODE;
const prevServerUrl = process.env.SERVER_URL;
const prevDownloadsDir = process.env.RAFT_DOWNLOADS_DIR;
let dir: string;

beforeAll(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "manual-template-"));
  await mkdir(path.join(dir, "cli"), { recursive: true });
  await writeFile(path.join(dir, "cli", "manifest.json"), JSON.stringify({ version: "0.0.24-zcode.1" }));
});

afterAll(async () => {
  if (prevMode === undefined) delete process.env.RAFT_DEPLOYMENT_MODE;
  else process.env.RAFT_DEPLOYMENT_MODE = prevMode;
  if (prevServerUrl === undefined) delete process.env.SERVER_URL;
  else process.env.SERVER_URL = prevServerUrl;
  if (prevDownloadsDir === undefined) delete process.env.RAFT_DOWNLOADS_DIR;
  else process.env.RAFT_DOWNLOADS_DIR = prevDownloadsDir;
  await rm(dir, { recursive: true, force: true });
});

describe("standard mode", () => {
  test("renders byte-identical official commands (snapshot lock)", async () => {
    delete process.env.RAFT_DEPLOYMENT_MODE;
    const values = await resolveManualCommandValues();
    assert.deepEqual(values, { ...OFFICIAL_MANUAL_COMMANDS });

    const doc = [
      "Install the CLI: `{{cliInstallCommand}}`",
      "```",
      "{{computerInstallCommand}}",
      "raft-computer setup /botiverse",
      "```",
      "```powershell",
      "{{computerWindowsInstallCommand}}",
      "```",
    ].join("\n");
    assert.equal(
      renderManualCommands(doc, values),
      [
        "Install the CLI: `npm i -g @botiverse/raft@latest`",
        "```",
        "curl -fsSL https://cdn.raft.build/computer/install.sh | sh",
        "raft-computer setup /botiverse",
        "```",
        "```powershell",
        "irm https://cdn.raft.build/computer/install.ps1 | iex",
        "```",
      ].join("\n"),
    );
  });
});

describe("private mode", () => {
  test("renders this server's download URLs from SERVER_URL only", async () => {
    process.env.RAFT_DEPLOYMENT_MODE = "private";
    process.env.SERVER_URL = "https://raft.internal.example:18443/";
    process.env.RAFT_DOWNLOADS_DIR = dir;
    const values = await resolveManualCommandValues();
    const base = "https://raft.internal.example:18443/downloads/computer";
    assert.equal(
      values.computerInstallCommand,
      `curl -fsSL ${base}/install.sh | RAFT_COMPUTER_RELEASE_BASE=${base} RAFT_COMPUTER_INSTALL_BACKEND=server sh`,
    );
    assert.equal(values.cliInstallCommand, "npm i -g https://raft.internal.example:18443/downloads/cli/raft-0.0.24-zcode.1.tgz");
    assert.ok(values.computerWindowsInstallCommand.includes(base));
  });

  test("missing SERVER_URL or CLI manifest falls back to official commands", async () => {
    process.env.RAFT_DEPLOYMENT_MODE = "private";
    delete process.env.SERVER_URL;
    const noOrigin = await resolveManualCommandValues();
    assert.equal(noOrigin.cliInstallCommand, OFFICIAL_MANUAL_COMMANDS.cliInstallCommand);
    assert.equal(noOrigin.computerInstallCommand, OFFICIAL_MANUAL_COMMANDS.computerInstallCommand);

    process.env.SERVER_URL = "https://raft.internal.example:18443";
    process.env.RAFT_DOWNLOADS_DIR = path.join(dir, "does-not-exist");
    const noManifest = await resolveManualCommandValues();
    assert.equal(noManifest.cliInstallCommand, OFFICIAL_MANUAL_COMMANDS.cliInstallCommand);
    assert.notEqual(noManifest.computerInstallCommand, OFFICIAL_MANUAL_COMMANDS.computerInstallCommand);
  });
});

describe("placeholder hygiene", () => {
  test("unknown placeholders are removed — never a bare {{…}} in output", async () => {
    delete process.env.RAFT_DEPLOYMENT_MODE;
    const values = await resolveManualCommandValues();
    const out = renderManualCommands("Before {{notARealKey}} after {{cliInstallCommand}}", values);
    assert.equal(out, "Before  after npm i -g @botiverse/raft@latest");
    assert.equal(out.includes("{{"), false);
  });
});
