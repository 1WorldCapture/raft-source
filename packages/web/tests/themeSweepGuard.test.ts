import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import test from "node:test";

// @ts-expect-error plain .mjs codemod shared with the sweep tooling
import { transformSource } from "../scripts/theme-sweep-codemod.mjs";

const webRoot = resolve(import.meta.dirname, "..");

/**
 * Folders already swept to semantic raft-ui tokens (upstream-port C1 sweep).
 * A swept folder may not reintroduce a bare hard-coded Brutal class
 * (text-black*, bg-white, border-black*, border-2, shadow-brutal*, bg-soft-signal,
 * bg-brutal-*, bg-black*): write `<semantic class> theme-brutal:<brutal class>`
 * instead (`node scripts/theme-sweep-codemod.mjs <file>` does it for you).
 * Add each area here in the PR that sweeps it.
 */
const SWEPT = [
  "src/components/ui",
  "src/App.tsx",
  "src/pages",
  "src/office",
];
// Top-level files directly under src/components (area 1) are listed by name so
// sub-folders swept later are not pulled in early.
const SWEPT_TOP_LEVEL_COMPONENTS = true;

function* walk(path: string): Generator<string> {
  const st = statSync(path);
  if (st.isDirectory()) {
    for (const name of readdirSync(path).sort()) yield* walk(join(path, name));
  } else if (/\.tsx?$/.test(path) && !/\.(test|d)\.tsx?$/.test(path)) {
    yield path;
  }
}

function sweptFiles(): string[] {
  const files: string[] = [];
  for (const entry of SWEPT) files.push(...walk(join(webRoot, entry)));
  if (SWEPT_TOP_LEVEL_COMPONENTS) {
    const dir = join(webRoot, "src/components");
    for (const name of readdirSync(dir).sort()) {
      if (/\.tsx?$/.test(name) && !/\.(test|d)\.tsx?$/.test(name)) files.push(join(dir, name));
    }
  }
  return files;
}

test("swept folders keep every hard-coded Brutal colour behind a theme-brutal: guard", () => {
  const offenders: string[] = [];
  for (const file of sweptFiles()) {
    const { changes } = transformSource(readFileSync(file, "utf8")) as { changes: number };
    if (changes > 0) offenders.push(`${relative(webRoot, file)} (${changes})`);
  }
  assert.deepEqual(offenders, [], "unguarded Brutal classes in swept files; run scripts/theme-sweep-codemod.mjs");
});

test("the codemod writes the semantic class first and the guarded Brutal class second, and is idempotent", () => {
  const { text, changes } = transformSource(
    `<div className="border-2 border-black bg-white text-black/60 hover:bg-black/5 shadow-brutal-sm" />`,
  ) as { text: string; changes: number };
  assert.equal(changes, 6);
  assert.equal(
    text,
    `<div className="border theme-brutal:border-2 border-line-strong theme-brutal:border-black bg-layer-panel theme-brutal:bg-white text-foreground-muted theme-brutal:text-black/60 hover:bg-fill-muted theme-brutal:hover:bg-black/5 shadow-raft-xs theme-brutal:shadow-brutal-sm" />`,
  );
  assert.equal((transformSource(text) as { changes: number }).changes, 0);
});
