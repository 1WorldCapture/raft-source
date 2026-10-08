// Prune a pnpm deploy output down to the runtime closure the esbuild bundle
// actually loads (server-image stage 1). Everything esbuild bundled already
// lives inside dist/*.js; node_modules only needs the external packages and
// their transitive dependencies, so stripe/xlsx/aws-sdk/mcp-sdk etc. (all
// bundled) can go.
//
// Usage: node scripts/prune-runtime-deps.mjs <deployOut>
//
// Walks from the external roots through the pnpm layout (each .pnpm/<key>/
// node_modules/ dir holds the package plus links to its deps+peers), marks
// every reachable .pnpm directory, then removes the rest. Resolution follows
// real symlinks, so multi-version packages keep exactly the versions the
// deploy installed — no re-install, no version drift.
import { readdir, rm, realpath } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";

// Mirrors EXTERNAL in scripts/bundle.mjs (minus what the runtime never
// resolves): sharp/argon2/pg/pg-native are native, jieba-wasm ships wasm
// assets, drizzle-orm stays external for the dynamic drizzle-orm/pglite
// import. fsevents is macOS-only and simply absent on linux.
const EXTERNAL_ROOTS = [
  "sharp",
  "argon2",
  "pg",
  "pg-native",
  "drizzle-orm",
  "jieba-wasm",
];

// Deliberately dropped from the runtime image: pglite is a dev/test code
// path (prod runs postgres), and it is 24MB the server never imports. Links
// pointing here stay behind but their target is removed — acceptable because
// nothing on the postgres path resolves them.
const EXCLUDED = new Set(["@electric-sql/pglite"]);

const out = process.argv[2];
if (!out) {
  console.error("[prune] usage: prune-runtime-deps.mjs <deployOut>");
  process.exit(1);
}
const nm = path.join(out, "node_modules");
const pnpmDir = path.join(nm, ".pnpm");
if (!existsSync(pnpmDir)) {
  console.error(`[prune] ${pnpmDir} not found — not a pnpm deploy output?`);
  process.exit(1);
}

// The .pnpm directory that (transitively) contains a resolved package path.
function pnpmKeyOf(realPath) {
  const marker = `${path.sep}.pnpm${path.sep}`;
  const idx = realPath.indexOf(marker);
  if (idx === -1) return null;
  const rest = realPath.slice(idx + marker.length);
  return rest.split(path.sep)[0];
}

const keep = new Set(); // .pnpm dir names to keep

async function markPackageDir(dir) {
  // dir = a package root (contains package.json); mark its .pnpm container
  // and recurse into every sibling link inside .pnpm/<key>/node_modules/.
  const key = pnpmKeyOf(dir);
  if (!key || keep.has(key)) return;
  keep.add(key);
  const container = path.join(pnpmDir, key, "node_modules");
  if (!existsSync(container)) return;
  let entries;
  try {
    entries = await readdir(container, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const entryPath = path.join(container, entry.name);
    let real;
    try {
      real = await realpath(entryPath);
    } catch {
      continue; // broken link (e.g. pruned exclusion target) — skip
    }
    if (entry.name.startsWith("@")) {
      // scoped: recurse into its children
      for (const child of await readdir(entryPath, { withFileTypes: true })) {
        if (EXCLUDED.has(`${entry.name}/${child.name}`)) continue;
        await markPackageDir(await realpath(path.join(entryPath, child.name)));
      }
      continue;
    }
    if (EXCLUDED.has(entry.name)) continue;
    await markPackageDir(real);
  }
}

for (const root of EXTERNAL_ROOTS) {
  const top = path.join(nm, root);
  if (!existsSync(top)) {
    console.log(`[prune] root not installed (skipped): ${root}`);
    continue;
  }
  await markPackageDir(await realpath(top));
}

// Remove unmarked .pnpm dirs, then top-level links outside the root set
// (they belong to bundled packages) and the exclusion.
const before = (await readdir(pnpmDir)).length;
let removed = 0;
for (const entry of await readdir(pnpmDir, { withFileTypes: true })) {
  if (!entry.isDirectory()) continue;
  if (keep.has(entry.name)) continue;
  await rm(path.join(pnpmDir, entry.name), { recursive: true, force: true });
  removed += 1;
}

const rootSet = new Set(EXTERNAL_ROOTS);
// Keep a top-level entry only if it is a root itself or its link resolves
// into a kept .pnpm dir (scoped dirs hold one link per package).
async function keepTopLevel(name, isScopedChild = false) {
  const real = await realpath(path.join(nm, name)).catch(() => null);
  if (!real) return false;
  const key = pnpmKeyOf(real);
  if (!key) return false; // workspace-inlined files (deploy copies, not links)
  return keep.has(key) && (isScopedChild || rootSet.has(name));
}
for (const entry of await readdir(nm, { withFileTypes: true })) {
  if (entry.isSymbolicLink()) {
    if (await keepTopLevel(entry.name)) continue;
    await rm(path.join(nm, entry.name), { force: true });
    removed += 1;
    continue;
  }
  if (entry.isDirectory() && entry.name.startsWith("@")) {
    const scopePath = path.join(nm, entry.name);
    for (const child of await readdir(scopePath, { withFileTypes: true })) {
      if (await keepTopLevel(`${entry.name}/${child.name}`, true)) continue;
      await rm(path.join(scopePath, child.name), { force: true });
      removed += 1;
    }
    const rest = await readdir(scopePath);
    if (!rest.length) {
      await rm(scopePath, { recursive: true, force: true });
      removed += 1;
    }
  }
}

console.log(
  `[prune] kept ${keep.size} of ${before} .pnpm dirs, removed ${removed} entries under ${nm}`,
);
