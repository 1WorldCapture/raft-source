import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { test } from "node:test";

// Task #28: the SPA's server-level CSP/X-Frame-Options were inherited by the proxied API location and stacked on top
// of the API's own headers, so the attachment HTML preview iframe (framed from the web origin) was blocked by
// `frame-ancestors 'none'` and the bridge script never ran. This is a static check of the template (no nginx binary
// needed): the API location must declare its own add_header so nothing is inherited from the server block.
const template = readFileSync(resolve(import.meta.dirname, "../nginx-selfhost.conf.template"), "utf8");

function locationBlock(header: RegExp): string {
  const match = header.exec(template);
  assert.ok(match, `location ${header} not found`);
  let depth = 0;
  let end = match.index;
  for (let i = template.indexOf("{", match.index); i < template.length; i++) {
    if (template[i] === "{") depth++;
    if (template[i] === "}" && --depth === 0) { end = i; break; }
  }
  return template.slice(match.index, end + 1);
}

test("the proxied API location does not inherit the SPA's CSP / X-Frame-Options", () => {
  const api = locationBlock(/location ~ \^\/\(api\|internal\|socket\\\.io\|daemon\|share\|\\\.well-known\)\/ \{/);
  assert.match(api, /add_header /, "an add_header in the location is what stops server-level add_header inheritance");
  assert.doesNotMatch(api, /add_header Content-Security-Policy/i, "the API must not get a proxy-level CSP");
  assert.doesNotMatch(api, /add_header X-Frame-Options/i, "nor a proxy-level X-Frame-Options");
  assert.match(api, /proxy_pass /);
});

test("the SPA locations still carry their own security headers", () => {
  const root = locationBlock(/location \/ \{/);
  assert.match(root, /add_header Content-Security-Policy "[^"]*frame-ancestors 'none'/);
  assert.match(root, /add_header X-Frame-Options "DENY"/);
});
