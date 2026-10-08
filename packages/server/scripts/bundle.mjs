// Bundle the server for the slim runtime image (server-image stage 1).
// Produces esbuild single-file ESM bundles + external source maps for the four
// runtime entry points, into packages/server/dist/. Native/wasm-heavy packages
// stay external and are installed into the runtime image's node_modules instead.
//
// Verified against the stage-1 research (#server-image task #1) prototype:
//  - banner aliases createRequire/fileURLToPath (__raftCreateRequire etc.) —
//    version.ts imports createRequire by its own name, so a same-name banner
//    binding is a SyntaxError in ESM output
//  - CJS deps (dotenv, jieba-wasm's node glue) need require/__dirname shims
//  - dist/ sits one level below packages/server/, so `../drizzle` and
//    `../package.json` relative lookups in migrate-deploy.ts / version.ts keep
//    resolving exactly as they do under src/
import { build } from "esbuild";
import { rm } from "node:fs/promises";

const EXTERNAL = [
  "sharp",
  "argon2",
  "pg",
  "pg-native",
  "@electric-sql/pglite",
  "fsevents",
  "jieba-wasm",
];

const ENTRIES = [
  ["src/server.ts", "dist/server.js"],
  ["scripts/migration-preflight.ts", "dist/migration-preflight.js"],
  ["scripts/migrate-deploy.ts", "dist/migrate-deploy.js"],
  ["scripts/verify-feature-flag-admin-privileges.ts", "dist/verify-feature-flag-admin-privileges.js"],
];

const banner = `import { createRequire as __raftCreateRequire } from "node:module";
import { fileURLToPath as __raftFileURLToPath } from "node:url";
const require = __raftCreateRequire(import.meta.url);
const __filename = __raftFileURLToPath(import.meta.url);
const __dirname = __raftFileURLToPath(new URL(".", import.meta.url));`;

const common = {
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node24",
  external: EXTERNAL,
  // "linked" (not "external") so esbuild appends the //# sourceMappingURL
  // comment — without it node --enable-source-maps never loads the .map and
  // stacks stay in bundle line numbers.
  sourcemap: "linked",
  banner: { js: banner },
  logLevel: "info",
};

await rm("dist", { recursive: true, force: true });

for (const [entry, outfile] of ENTRIES) {
  await build({ ...common, entryPoints: [entry], outfile });
}

console.log("[bundle] wrote:", ENTRIES.map(([, out]) => out).join(", "));
