import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import { installStdoutEpipeGuard } from "./stdoutEpipe.js";

function errorWithCode(code: string): NodeJS.ErrnoException {
  const err = new Error(`write ${code}`) as NodeJS.ErrnoException;
  err.code = code;
  return err;
}

test("installStdoutEpipeGuard swallows EPIPE without throwing", () => {
  const stdout = new EventEmitter();
  installStdoutEpipeGuard(stdout);
  assert.doesNotThrow(() => stdout.emit("error", errorWithCode("EPIPE")));
});

test("installStdoutEpipeGuard swallows follow-up writes to a destroyed stream", () => {
  const stdout = new EventEmitter();
  installStdoutEpipeGuard(stdout);
  assert.doesNotThrow(() => stdout.emit("error", errorWithCode("ERR_STREAM_DESTROYED")));
});

test("installStdoutEpipeGuard keeps any other stdout error fatal", () => {
  const stdout = new EventEmitter();
  installStdoutEpipeGuard(stdout);
  assert.throws(() => stdout.emit("error", errorWithCode("EACCES")), /EACCES/);
});
