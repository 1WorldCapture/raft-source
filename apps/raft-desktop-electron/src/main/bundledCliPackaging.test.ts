// The bundled `raft` CLI (packages/cli/dist/index.js) is ESM. Packaged next to nothing it is parsed as
// CommonJS, and under ELECTRON_RUN_AS_NODE it then exits 0 silently, so every `raft` command run by a
// Desktop-hosted agent printed nothing (found in the 0.2.5 quick check; 0.2.4 had it too).
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../../", import.meta.url));

for (const config of ["electron-builder.yml", "electron-builder.linux.yml"]) {
  test(`${config} ships cli/package.json (type module) next to cli/index.js`, () => {
    const text = readFileSync(`${root}${config}`, "utf8");
    assert.match(text, /from: \.\.\/\.\.\/packages\/cli\/dist\/index\.js\n\s+to: cli\/index\.js/);
    assert.match(text, /from: \.\.\/\.\.\/packages\/cli\/dist\/package\.json\n\s+to: cli\/package\.json/);
  });
}

test("the CLI build writes the dist/package.json that the packaging copies, declaring type module", () => {
  const writer = readFileSync(`${root}../../packages/cli/scripts/write-dist-package.mjs`, "utf8");
  assert.match(writer, /join\(distDir, "package\.json"\)/);
  assert.match(writer, /type: pkg\.type/);
  const cliPackage = JSON.parse(readFileSync(`${root}../../packages/cli/package.json`, "utf8"));
  assert.equal(cliPackage.type, "module");
});
