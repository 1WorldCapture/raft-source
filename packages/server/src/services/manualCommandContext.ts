// Manual install-command context (task #6, private deployment phase 2).
//
// The agent-knowledge docs embed install commands. They used to be official
// literals; now they carry `{{placeholders}}` rendered per deployment at
// serve time: standard renders the byte-identical official commands (zero
// change for official deployments — locked by snapshot tests), private
// renders this server's /downloads URLs.
//
// SECURITY (PM review, same rule as deploymentInfo.ts): private URLs derive
// ONLY from the configured SERVER_URL — never from request headers. A
// missing origin or a missing artifact version falls back to the official
// command WITH a warning log — never a bare `{{…}}` and never a guessed
// origin.
import { readFile } from "node:fs/promises";
import path from "node:path";
import { isPrivateDeploymentMode } from "@botiverse/raft-shared";

import { downloadsDir } from "../routes/downloads.js";

export const OFFICIAL_MANUAL_COMMANDS = {
  cliInstallCommand: "npm i -g @botiverse/raft@latest",
  computerInstallCommand: "curl -fsSL https://cdn.raft.build/computer/install.sh | sh",
  computerWindowsInstallCommand: "irm https://cdn.raft.build/computer/install.ps1 | iex",
} as const;

export type ManualCommandKey = keyof typeof OFFICIAL_MANUAL_COMMANDS;
export type ManualCommandValues = Record<ManualCommandKey, string>;

const PLACEHOLDER_RE = /\{\{([A-Za-z0-9_]+)\}\}/g;

async function readLatestVersion(product: "cli"): Promise<string | null> {
  try {
    const raw = await readFile(path.join(downloadsDir(), product, "manifest.json"), "utf8");
    const parsed = JSON.parse(raw) as { version?: unknown };
    return typeof parsed.version === "string" && parsed.version.length > 0 ? parsed.version : null;
  } catch {
    return null;
  }
}

/**
 * The command values for THIS deployment. Private mode derives them from
 * SERVER_URL + the downloads manifests; anything missing falls back to the
 * official command with a warning (the official command is at least a
 * coherent, working instruction — a bare placeholder or a guessed origin
 * is not).
 */
export async function resolveManualCommandValues(): Promise<ManualCommandValues> {
  const values: ManualCommandValues = { ...OFFICIAL_MANUAL_COMMANDS };
  if (!isPrivateDeploymentMode()) return values;

  const origin = process.env.SERVER_URL?.trim().replace(/\/+$/, "");
  if (!origin) {
    console.warn(
      "[manual-template] private deployment without SERVER_URL: manual install commands stay official",
    );
    return values;
  }
  const base = `${origin}/downloads/computer`;
  values.computerInstallCommand =
    `curl -fsSL ${base}/install.sh | RAFT_COMPUTER_RELEASE_BASE=${base} RAFT_COMPUTER_INSTALL_BACKEND=server sh`;
  values.computerWindowsInstallCommand =
    `$env:RAFT_COMPUTER_RELEASE_BASE = "${base}"; $env:RAFT_COMPUTER_INSTALL_BACKEND = "server"; irm ${base}/install.ps1 | iex`;

  const cliVersion = await readLatestVersion("cli");
  if (cliVersion) {
    values.cliInstallCommand = `npm i -g ${origin}/downloads/cli/${cliVersion}/raft-${cliVersion}.tgz`;
  } else {
    console.warn(
      "[manual-template] private deployment without a CLI manifest: the CLI install command stays official",
    );
  }
  return values;
}

/**
 * Replace `{{placeholders}}` with the deployment's command values. Unknown
 * placeholder names (a future doc typo) are removed with a warning — a bare
 * `{{…}}` must never reach an agent following the manual.
 */
export function renderManualCommands(source: string, values: ManualCommandValues): string {
  return source.replace(PLACEHOLDER_RE, (raw, key: string) => {
    if (key in values) return values[key as ManualCommandKey];
    console.warn(`[manual-template] unknown placeholder "${raw}" removed`);
    return "";
  });
}
