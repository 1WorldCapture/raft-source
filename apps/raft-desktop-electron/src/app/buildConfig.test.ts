// buildConfig.mjs is the single source for the build-time API endpoint
// (VITE_API_URL). These tests pin the contract the bundlers rely on: origin
// normalization, official-origin detection, loud failure on invalid input, and
// the exact-origin CSP widening for self-hosted builds.
import assert from "node:assert/strict";
import test from "node:test";

import {
  DEFAULT_API_ORIGIN,
  OFFICIAL_API_ORIGINS,
  applyCspToHtml,
  desktopApiDefines,
  parseApiOrigin,
  resolveBuildApiConfig,
} from "../../buildConfig.mjs";

const STOCK_CSP = "default-src 'self' app:; script-src 'self' app:; style-src 'self' app: 'unsafe-inline'; img-src 'self' app: data: blob: https:; font-src 'self' app: data:; connect-src 'self' app: https: wss:; media-src 'self' app: blob: https:;";

test("parseApiOrigin normalizes to the origin and rejects anything not a bare http(s) source", () => {
  assert.equal(parseApiOrigin("https://api.example.com"), "https://api.example.com");
  assert.equal(parseApiOrigin("http://host.example:3001/"), "http://host.example:3001");
  assert.equal(parseApiOrigin("http://host.example:3001/api"), "http://host.example:3001"); // path dropped
  assert.equal(parseApiOrigin("  https://spaced.example.com  "), "https://spaced.example.com"); // trimmed
  assert.equal(parseApiOrigin("ws://api.example.com"), null); // scheme
  assert.equal(parseApiOrigin("ftp://api.example.com"), null); // scheme
  assert.equal(parseApiOrigin("not a url"), null);
  assert.equal(parseApiOrigin("https://user:pass@api.example.com"), null); // credentials
  assert.equal(parseApiOrigin("https://api.example.com/?x=1"), null); // query
  assert.equal(parseApiOrigin("https://api.example.com/#frag"), null); // fragment
  assert.equal(parseApiOrigin(""), null);
  assert.equal(parseApiOrigin(undefined), null);
  assert.equal(parseApiOrigin(42), null);
});

test("resolveBuildApiConfig defaults to official production when VITE_API_URL is unset", () => {
  for (const env of [{}, { VITE_API_URL: "" }, { VITE_API_URL: "   " }]) {
    const config = resolveBuildApiConfig(env);
    assert.deepEqual(config, {
      apiOrigin: DEFAULT_API_ORIGIN,
      isOfficial: true,
      wsOrigin: "wss://api.raft.build",
    });
  }
});

test("resolveBuildApiConfig keeps official origins official and derives the ws origin", () => {
  for (const origin of OFFICIAL_API_ORIGINS) {
    const config = resolveBuildApiConfig({ VITE_API_URL: `${origin}/some/path/` });
    assert.equal(config.apiOrigin, origin);
    assert.equal(config.isOfficial, true);
    assert.equal(config.wsOrigin, `wss:${origin.slice("https:".length)}`);
  }
  const selfHosted = resolveBuildApiConfig({ VITE_API_URL: "http://raft.internal.example:3001/" });
  assert.deepEqual(selfHosted, {
    apiOrigin: "http://raft.internal.example:3001",
    isOfficial: false,
    wsOrigin: "ws://raft.internal.example:3001",
  });
});

test("resolveBuildApiConfig fails the build on an invalid VITE_API_URL", () => {
  for (const bad of ["ws://api.example.com", "https://user@api.example.com", "api.example.com", "//api.example.com"]) {
    assert.throws(() => resolveBuildApiConfig({ VITE_API_URL: bad }), /VITE_API_URL/);
  }
});

test("desktopApiDefines bakes the resolved origin for the main bundle", () => {
  assert.deepEqual(desktopApiDefines({ apiOrigin: "http://raft.internal.example:3001" }), {
    __RAFT_DESKTOP_API_ORIGIN__: '"http://raft.internal.example:3001"',
  });
});

test("applyCspToHtml leaves official builds byte-identical", () => {
  const html = `<!doctype html><html><head>\n      <meta\n        http-equiv="Content-Security-Policy"\n        content="${STOCK_CSP}"\n      />\n</head><body></body></html>`;
  const official = resolveBuildApiConfig({ VITE_API_URL: "https://api.raft.build" });
  assert.equal(applyCspToHtml(html, official), html, "official build must not touch the CSP");
  const unset = resolveBuildApiConfig({});
  assert.equal(applyCspToHtml(html, unset), html, "default build must not touch the CSP");
});

test("applyCspToHtml widens exactly the configured origins for self-hosted builds", () => {
  const html = `<html><head><meta http-equiv="Content-Security-Policy" content="${STOCK_CSP}"></head><body></body></html>`;
  const selfHosted = resolveBuildApiConfig({ VITE_API_URL: "http://raft.internal.example:3001" });
  const out = applyCspToHtml(html, selfHosted);
  const csp = out.match(/content="([^"]*)"/)![1];
  assert.match(csp, /connect-src 'self' app: https: wss: http:\/\/raft\.internal\.example:3001 ws:\/\/raft\.internal\.example:3001(;|$)/);
  assert.match(csp, /img-src 'self' app: data: blob: https: http:\/\/raft\.internal\.example:3001(;|$)/);
  assert.match(csp, /media-src 'self' app: blob: https: http:\/\/raft\.internal\.example:3001(;|$)/);
  // No directive gains a BARE http:/ws: scheme token — only the exact
  // configured origin URLs (http://…, ws://…) are appended.
  assert.doesNotMatch(csp, /connect-src[^;]*\shttp:(?!\/\/)/);
  assert.doesNotMatch(csp, /connect-src[^;]*\sws:(?!\/\/)/);
  // Untouched directives keep their exact stock form.
  assert.match(csp, /script-src 'self' app:;/);
  assert.match(csp, /font-src 'self' app: data:;/);
  // Idempotent: widening the already-widened policy adds nothing.
  const again = applyCspToHtml(out, selfHosted);
  assert.equal(again.match(/content="([^"]*)"/)![1], csp);
});

test("applyCspToHtml fails loudly when the CSP meta tag or a directive is missing", () => {
  const selfHosted = resolveBuildApiConfig({ VITE_API_URL: "http://raft.internal.example:3001" });
  assert.throws(() => applyCspToHtml("<html><head></head></html>", selfHosted), /Content-Security-Policy/);
  const noConnect = `<html><head><meta http-equiv="Content-Security-Policy" content="default-src 'self' app:; img-src 'self' https:; media-src 'self' https:;"></head></html>`;
  assert.throws(() => applyCspToHtml(noConnect, selfHosted), /connect-src/);
});
