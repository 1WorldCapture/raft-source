#!/usr/bin/env node
// The Desktop frontend (apps/raft-desktop-electron/frontend) is its own TypeScript
// project: it is in neither the web nor the desktop main tsconfig, and vite/esbuild
// strip types without resolving names. A missing import therefore reaches the
// bundle and only throws at runtime (0.2.5: `trackSearchAnchor is not defined`).
// This runs the frontend project through tsc and fails on the errors that mean
// "an identifier does not exist" (TS2304 cannot find name, TS2552 did you mean,
// TS2503 cannot find namespace, TS2305 no exported member). Other tsc noise in
// that project (type-declaration gaps in test files, cross-package ref types) is
// deliberately not gated here.
import { spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const tsc = spawnSync("npx", ["tsc", "--noEmit", "-p", "frontend/tsconfig.json"], { cwd: root, encoding: "utf8" });
const output = `${tsc.stdout ?? ""}${tsc.stderr ?? ""}`;

// A guard that did not actually check must not pass: tsc failed to spawn, was
// killed by a signal, or exited non-zero without printing a single TS diagnostic
// (e.g. npx could not resolve tsc).
if (tsc.error) {
  console.error(`Desktop frontend name check could not run tsc: ${tsc.error.message}`);
  process.exit(2);
}
if (tsc.status === null) {
  console.error(`Desktop frontend name check: tsc was terminated (${tsc.signal ?? "unknown signal"}) before finishing`);
  process.exit(2);
}
if (tsc.status !== 0 && !/error TS\d+:/.test(output)) {
  console.error(`Desktop frontend name check: tsc exited ${tsc.status} without any TypeScript diagnostics, so nothing was verified:\n${output.trim().slice(0, 2_000)}`);
  process.exit(2);
}
const offenders = output.split("\n").filter((line) => /error TS(2304|2552|2503|2305):/.test(line));
if (offenders.length > 0) {
  console.error("Desktop frontend references names that do not exist:\n" + offenders.join("\n"));
  process.exit(1);
}
console.log("Desktop frontend: no undefined names");
