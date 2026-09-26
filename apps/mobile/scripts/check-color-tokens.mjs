import { readdirSync, readFileSync } from "node:fs";
import { resolve, relative } from "node:path";

const root = resolve(import.meta.dirname, "..");
const allow = new Set([
  "src/ui/tokens.ts",
  "src/ui/pixelAvatar.ts",
]);
const hex = /#[0-9A-Fa-f]{3,8}\b/g;

function files(dir, out = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name === "android" || entry.name === "ios") continue;
    const full = resolve(dir, entry.name);
    if (entry.isDirectory()) files(full, out);
    else if (/\.(ts|tsx)$/.test(entry.name) && !entry.name.endsWith(".test.ts")) out.push(full);
  }
  return out;
}

const hits = [];
for (const file of [...files(resolve(root, "app")), ...files(resolve(root, "src"))]) {
  const rel = relative(root, file);
  if (allow.has(rel)) continue;
  const text = readFileSync(file, "utf8");
  if (hex.test(text)) hits.push(rel);
  hex.lastIndex = 0;
}

if (hits.length > 0) {
  console.error("Hex colors belong in src/ui/tokens.ts:\n" + hits.join("\n"));
  process.exit(1);
}
