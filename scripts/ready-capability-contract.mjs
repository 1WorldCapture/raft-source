// The capabilities on a DaemonCore `ready` message must include every
// capability constant the server checks on that list. 0.2.7 missed
// PROVIDER_PROBE_CAPABILITY; tests still passed because they advertised it
// on a stand-in carrier. Pass the capabilities array from a real ready
// message. This module only scans the server for those checks.

import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join, relative } from "node:path";

const SERVER_SRC = "packages/server/src";

// Absence of these is a supported server path. They are not part of the
// current daemon ready list, and a stand-in must not be required to invent
// them. A name stays here only while server code still checks it.
const OPTIONAL_READY_CAPABILITIES = new Map([
  [
    "DAEMON_CAPABILITY_MODEL_SEEN_BOUNDARY",
    "The server keeps the legacy ack checkpoint until a daemon advertises this. The current ready message does not.",
  ],
  [
    "REMINDER_FIRE_RECEIPT_CAPABILITY",
    "Older daemons may still advertise the receipt protocol. The current ready list sends REMINDER_FIRE_REQUEST_CAPABILITY instead.",
  ],
]);

const INCLUDES_PATTERN = /(?<!transport\.)capabilities\??\.(?:includes|has)\(\s*([A-Z][A-Z0-9_]*)\s*\)/g;
const HAS_MACHINE_PATTERN = /hasMachineCapability\(\s*(?:[^()]|\([^()]*\))*?,\s*([A-Z][A-Z0-9_]*)\s*\)/g;

export function evaluateReadyCapabilityContract(repoRoot, readyCapabilities) {
  if (!Array.isArray(readyCapabilities) || readyCapabilities.some((value) => typeof value !== "string")) {
    throw new Error("readyCapabilities must be the capabilities array from a DaemonCore ready message");
  }
  const read = (relPath) => readFileSync(join(repoRoot, relPath), "utf8");
  const readyValues = new Set(readyCapabilities);
  const gaps = [];
  const checks = scanServerChecks(repoRoot, read);
  const seenChecks = new Set();
  for (const check of checks) {
    seenChecks.add(check.name);
    if (OPTIONAL_READY_CAPABILITIES.has(check.name)) continue;
    const value = resolveConstant(repoRoot, join(repoRoot, check.file), check.name, read);
    if (!value) {
      gaps.push({
        name: check.name,
        value: null,
        file: check.file,
        reason: "server check could not be resolved to a capability string",
      });
      continue;
    }
    if (!readyValues.has(value)) {
      gaps.push({
        name: check.name,
        value,
        file: check.file,
        reason: "server checks this capability and the daemon ready list does not advertise it",
      });
    }
  }
  for (const name of OPTIONAL_READY_CAPABILITIES.keys()) {
    if (!seenChecks.has(name)) {
      gaps.push({
        name,
        value: null,
        file: SERVER_SRC,
        reason: "optional-ready exemption is stale; the server no longer checks this constant",
      });
    }
  }
  return { gaps, checks };
}

function scanServerChecks(repoRoot, read) {
  const root = join(repoRoot, SERVER_SRC);
  const files = [];
  walkTs(root, files);
  const checks = [];
  const seen = new Set();
  for (const abs of files) {
    const relPath = relative(repoRoot, abs);
    const text = read(relPath);
    for (const pattern of [INCLUDES_PATTERN, HAS_MACHINE_PATTERN]) {
      pattern.lastIndex = 0;
      let match;
      while ((match = pattern.exec(text))) {
        const name = match[1];
        const key = `${relPath}:${name}`;
        if (seen.has(key)) continue;
        seen.add(key);
        checks.push({ name, file: relPath });
      }
    }
  }
  return checks;
}

function walkTs(dir, out) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name === "dist") continue;
    const abs = join(dir, entry.name);
    if (entry.isDirectory()) {
      walkTs(abs, out);
      continue;
    }
    if (!entry.name.endsWith(".ts")) continue;
    if (entry.name.endsWith(".test.ts") || entry.name.endsWith(".d.ts")) continue;
    out.push(abs);
  }
}

function resolveConstant(repoRoot, fromFile, name, read) {
  return resolveExportedString(repoRoot, fromFile, name, read, new Set());
}

function resolveExportedString(repoRoot, fromFile, name, read, seen) {
  const key = `${fromFile}#${name}`;
  if (seen.has(key)) return null;
  seen.add(key);
  const relFrom = relative(repoRoot, fromFile);
  const text = relFrom.startsWith("..") ? readFileSync(fromFile, "utf8") : read(relFrom);
  const direct = new RegExp(
    `export const ${name}(?:\\s*:\\s*[^=]+)?\\s*=\\s*(?:\\r?\\n\\s*)?["']([^"']+)["']`,
  ).exec(text);
  if (direct) return direct[1];

  const reexport = namedSpecFrom(text, "export", name);
  if (reexport) {
    const next = resolveModule(repoRoot, fromFile, reexport.spec);
    if (next) {
      const found = resolveExportedString(repoRoot, next, reexport.exportedName, read, seen);
      if (found) return found;
    }
  }

  const imported = namedSpecFrom(text, "import", name);
  if (imported) {
    const next = resolveModule(repoRoot, fromFile, imported.spec);
    if (next) {
      const found = resolveExportedString(repoRoot, next, imported.exportedName, read, seen);
      if (found) return found;
    }
  }

  const stars = [...text.matchAll(/export\s+\*\s+from\s*["']([^"']+)["']/g)];
  for (const star of stars) {
    const next = resolveModule(repoRoot, fromFile, star[1]);
    if (!next) continue;
    const found = resolveExportedString(repoRoot, next, name, read, seen);
    if (found) return found;
  }
  return null;
}

function namedSpecFrom(text, keyword, localName) {
  const pattern = new RegExp(
    `${keyword}\\s+(?:type\\s+)?\\{([\\s\\S]*?)\\}\\s*from\\s*["']([^"']+)["']`,
    "g",
  );
  let match;
  while ((match = pattern.exec(text))) {
    for (const raw of match[1].split(",")) {
      const parts = raw.trim().split(/\s+as\s+/);
      if (parts.length === 0 || parts[0] === "") continue;
      const original = parts[0].replace(/^type\s+/, "").trim();
      const local = (parts[1] ?? parts[0]).replace(/^type\s+/, "").trim();
      if (local === localName) return { spec: match[2], exportedName: original };
    }
  }
  return null;
}

function resolveModule(repoRoot, fromFile, spec) {
  let candidate = null;
  if (spec === "@botiverse/raft-shared") {
    candidate = join(repoRoot, "packages/shared/src/index.ts");
  } else if (spec.startsWith("@botiverse/raft-shared/")) {
    const rel = spec.slice("@botiverse/raft-shared/".length).replace(/\.js$/, "");
    candidate = join(repoRoot, "packages/shared", rel);
  } else if (spec.startsWith(".")) {
    candidate = join(dirname(fromFile), spec).replace(/\.js$/, "");
  }
  if (!candidate) return null;
  const options = [candidate, `${candidate}.ts`, `${candidate}.tsx`];
  return options.find((option) => existsSync(option)) ?? null;
}
