import assert from "node:assert/strict";
import test from "node:test";
import { isHttpUrl } from "./markdownUrl.ts";

test("http and https URLs pass, case-insensitively", () => {
  assert.equal(isHttpUrl("https://example.com/a.png"), true);
  assert.equal(isHttpUrl("http://example.com"), true);
  assert.equal(isHttpUrl("HTTPS://EXAMPLE.COM/IMG.PNG?w=100#frag"), true);
  assert.equal(isHttpUrl("Http://example.com"), true);
});

test("relative and protocol-relative URLs are rejected", () => {
  assert.equal(isHttpUrl("images/local.png"), false);
  assert.equal(isHttpUrl("/absolute/path.png"), false);
  assert.equal(isHttpUrl("//cdn.example.com/a.png"), false);
  assert.equal(isHttpUrl("../up.png"), false);
  assert.equal(isHttpUrl("#anchor"), false);
});

test("non-http schemes are rejected", () => {
  assert.equal(isHttpUrl("data:image/png;base64,AAAA"), false);
  assert.equal(isHttpUrl("javascript:alert(1)"), false);
  assert.equal(isHttpUrl("mailto:user@example.com"), false);
  assert.equal(isHttpUrl("file:///etc/passwd"), false);
  assert.equal(isHttpUrl("app://screen/main"), false);
  assert.equal(isHttpUrl(""), false);
});
