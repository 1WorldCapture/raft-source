// Upstream-port completeness check.
//
// 0.2.7 imported the provider probe and still never ran it: upstream's
// registry.manifest.ts lists PROVIDER_PROBE_CAPABILITY in
// BUILT_IN_READY_CAPABILITIES, and that one line was not in our tree. Each
// PR's own tests passed because they advertised the capability on a stand-in
// carrier. This script compares upstream uses of the names you are porting
// with the same paths in our tree, so a dropped line shows up in review.
//
// Import lines are not uses. An unused import that our tree dropped is not
// the behavior that went missing. A use is any other line that contains the
// name as a whole token (or as an exact substring, when the name is not an
// identifier). The same normalized line must appear in our copy of that file.
//
// Deliberate omissions go in scripts/upstream-port-omissions.json with a
// reason. A blank reason is an error.
//
// Usage:
//   node scripts/upstream-port-completeness.mjs \
//     --upstream upstream/v1.21.2-source.1 \
//     --ours <git-ref> \
//     --name PROVIDER_PROBE_CAPABILITY \
//     [--name <another>] \
//     [--allowlist scripts/upstream-port-omissions.json] \
//     [--repo <checkout>]
//
// Fetch the upstream tag once per clone:
//   git fetch https://github.com/botiverse/raft-source.git \
//     refs/tags/v1.21.2-source.1:refs/tags/upstream/v1.21.2-source.1
//
// Paste this into an upstream-port PR description (fill in the result):
//
//   Upstream completeness: `node scripts/upstream-port-completeness.mjs --upstream upstream/v1.21.2-source.1 --ours HEAD --name <NAME>`
//   Result: missing 0. Deliberate omissions: none, or list each path with its reason from scripts/upstream-port-omissions.json.
//
// Exit 0 when nothing is missing, 1 when a use is missing, 2 on usage errors.

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const DEFAULT_ALLOWLIST = "scripts/upstream-port-omissions.json";

export function normalizeUseLine(line) {
  return stripLineComment(line).trim().replace(/\s+/g, " ");
}

export function collectUses(text, name) {
  const lines = text.split(/\r?\n/);
  const inImport = importMask(lines);
  const pattern = namePattern(name);
  const uses = [];
  for (let index = 0; index < lines.length; index += 1) {
    if (inImport[index]) continue;
    const code = stripLineComment(lines[index]);
    if (!pattern.test(code)) continue;
    uses.push({
      lineNumber: index + 1,
      text: lines[index],
      normalized: normalizeUseLine(lines[index]),
    });
  }
  return uses;
}

export function missingUses({ upstreamText, oursText, name, path, omissions = [] }) {
  const upstream = collectUses(upstreamText, name);
  const ours = oursText == null ? [] : collectUses(oursText, name);
  const available = new Map();
  for (const use of ours) {
    available.set(use.normalized, (available.get(use.normalized) ?? 0) + 1);
  }
  const missing = [];
  for (const use of upstream) {
    if (isOmitted(omissions, name, path, use.normalized)) continue;
    const left = available.get(use.normalized) ?? 0;
    if (left > 0) {
      available.set(use.normalized, left - 1);
      continue;
    }
    missing.push({
      path,
      lineNumber: use.lineNumber,
      text: use.text.trim(),
      normalized: use.normalized,
    });
  }
  return missing;
}

export function loadOmissions(filePath) {
  const data = JSON.parse(readFileSync(filePath, "utf8"));
  if (!data || !Array.isArray(data.omissions)) {
    throw new Error(`${filePath} must be a JSON object with an omissions array`);
  }
  for (const item of data.omissions) {
    if (!item || typeof item.path !== "string" || item.path.length === 0) {
      throw new Error(`${filePath} has an omission without a path`);
    }
    if (typeof item.name !== "string" || item.name.length === 0) {
      throw new Error(`${filePath} has an omission without a name`);
    }
    if (typeof item.reason !== "string" || item.reason.trim().length === 0) {
      throw new Error(`${filePath} omission ${item.path} ${item.name} needs a reason`);
    }
  }
  return data.omissions;
}

export function compareTrees({ repo, upstreamRef, oursRef, names, omissions = [] }) {
  const reports = [];
  for (const name of names) {
    const paths = filesMentioning(repo, upstreamRef, name);
    if (paths.length === 0) {
      throw new Error(`${name} does not appear in ${upstreamRef}`);
    }
    const missing = [];
    for (const path of paths) {
      const upstreamText = gitShow(repo, upstreamRef, path);
      if (upstreamText == null) continue;
      const oursText = gitShow(repo, oursRef, path);
      missing.push(...missingUses({
        upstreamText,
        oursText,
        name,
        path,
        omissions,
      }));
    }
    reports.push({ name, missing });
  }
  return reports;
}

function importMask(lines) {
  const mask = new Array(lines.length).fill(false);
  let inImport = false;
  for (let index = 0; index < lines.length; index += 1) {
    const trimmed = lines[index].trim();
    if (!inImport && /^import\b/.test(trimmed) && !trimmed.startsWith("import(")) {
      inImport = true;
    }
    if (!inImport) continue;
    mask[index] = true;
    if (/\bfrom\s+["']/.test(lines[index]) || /^import\s+["']/.test(trimmed)) {
      inImport = false;
    }
  }
  return mask;
}

function stripLineComment(line) {
  let out = "";
  let quote = "";
  for (let index = 0; index < line.length; index += 1) {
    const char = line[index];
    if (quote) {
      out += char;
      if (char === "\\") {
        out += line[index + 1] ?? "";
        index += 1;
        continue;
      }
      if (char === quote) quote = "";
      continue;
    }
    if (char === "\"" || char === "'" || char === "`") {
      quote = char;
      out += char;
      continue;
    }
    if (char === "/" && line[index + 1] === "/") break;
    out += char;
  }
  return out;
}

function namePattern(name) {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) return new RegExp(`\\b${escaped}\\b`);
  return new RegExp(escaped);
}

function isOmitted(omissions, name, path, normalized) {
  return omissions.some((item) => {
    if (item.name !== name || item.path !== path) return false;
    if (item.use == null || item.use === "*") return true;
    return item.use === normalized;
  });
}

function filesMentioning(repo, ref, name) {
  const args = ["grep", "-I", "-n", "-F"];
  if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) args.push("-w");
  args.push("-e", name, ref);
  let output = "";
  try {
    output = execFileSync("git", args, {
      cwd: repo,
      encoding: "utf8",
      maxBuffer: 32 * 1024 * 1024,
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (error) {
    if (error.status === 1) return [];
    throw error;
  }
  const prefix = `${ref}:`;
  const paths = new Set();
  for (const line of output.split("\n")) {
    if (!line.startsWith(prefix)) continue;
    const match = /^(.+):\d+:/.exec(line.slice(prefix.length));
    if (match) paths.add(match[1]);
  }
  return [...paths].sort();
}

function gitShow(repo, ref, path) {
  try {
    return execFileSync("git", ["show", `${ref}:${path}`], {
      cwd: repo,
      encoding: "utf8",
      maxBuffer: 16 * 1024 * 1024,
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (error) {
    if (error.status === 128) return null;
    throw error;
  }
}

function formatReports(upstreamRef, oursRef, reports) {
  const lines = [`upstream ${upstreamRef}`, `ours ${oursRef}`];
  let missingCount = 0;
  for (const report of reports) {
    missingCount += report.missing.length;
    lines.push(`name ${report.name}`);
    lines.push(`missing ${report.missing.length}`);
    for (const item of report.missing) {
      lines.push(`${item.path}:${item.lineNumber}`);
      lines.push(`  ${item.text}`);
    }
  }
  return { text: `${lines.join("\n")}\n`, missingCount };
}

function parseArgs(argv) {
  const args = {
    upstreamRef: "",
    oursRef: "",
    names: [],
    allowlist: "",
    repo: process.cwd(),
  };
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (flag === "--upstream" && value) {
      args.upstreamRef = value;
      index += 1;
    } else if (flag === "--ours" && value) {
      args.oursRef = value;
      index += 1;
    } else if (flag === "--name" && value) {
      args.names.push(value);
      index += 1;
    } else if (flag === "--allowlist" && value) {
      args.allowlist = value;
      index += 1;
    } else if (flag === "--repo" && value) {
      args.repo = resolve(value);
      index += 1;
    } else if (flag === "--help" || flag === "-h") {
      args.help = true;
    } else {
      throw new Error(`Unknown argument: ${flag}`);
    }
  }
  return args;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help || !args.upstreamRef || !args.oursRef || args.names.length === 0) {
    process.stderr.write("usage: node scripts/upstream-port-completeness.mjs --upstream <ref> --ours <ref> --name <key> [--name <key>] [--allowlist <file>] [--repo <checkout>]\n");
    process.exit(args.help ? 0 : 2);
  }
  const allowlistPath = args.allowlist
    ? resolve(args.repo, args.allowlist)
    : resolve(args.repo, DEFAULT_ALLOWLIST);
  let omissions = [];
  try {
    omissions = loadOmissions(allowlistPath);
  } catch (error) {
    if (args.allowlist || error.code !== "ENOENT") throw error;
  }
  const reports = compareTrees({
    repo: args.repo,
    upstreamRef: args.upstreamRef,
    oursRef: args.oursRef,
    names: args.names,
    omissions,
  });
  const formatted = formatReports(args.upstreamRef, args.oursRef, reports);
  process.stdout.write(formatted.text);
  process.exit(formatted.missingCount === 0 ? 0 : 1);
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : "";
if (invokedPath === fileURLToPath(import.meta.url)) {
  try {
    main();
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(2);
  }
}
