import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
import { test } from "vitest";

import { canInstallEnterToOpenUrl, installEnterToOpenUrl, openUrlInBrowser } from "./browserHandoff.js";

test("installEnterToOpenUrl opens the URL on Enter and only once", () => {
  const input = new PassThrough() as PassThrough & { isTTY: boolean };
  input.isTTY = true;
  const opened: string[] = [];

  installEnterToOpenUrl({
    input,
    url: "https://app.raft.build/login/device?user_code=ABCD-1234",
    openUrl: (url) => opened.push(url),
  });

  input.write("x");
  assert.deepEqual(opened, []);

  input.write("\n");
  input.write("\n");
  assert.deepEqual(opened, ["https://app.raft.build/login/device?user_code=ABCD-1234"]);
});

test("canInstallEnterToOpenUrl requires TTY stdin", () => {
  const input = new PassThrough() as PassThrough & { isTTY?: boolean };
  assert.equal(canInstallEnterToOpenUrl(input), false);
  input.isTTY = true;
  assert.equal(canInstallEnterToOpenUrl(input), true);
});

test("openUrlInBrowser refuses to run under vitest (2026-10-02 incident guard)", () => {
  const before = process.env.VITEST;
  process.env.VITEST = "1";
  try {
    assert.throws(
      () => openUrlInBrowser("https://app.raft.build/login/device?user_code=X"),
      /must not run under vitest/,
    );
  } finally {
    if (before === undefined) delete process.env.VITEST;
    else process.env.VITEST = before;
  }
});
