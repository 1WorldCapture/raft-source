import assert from "node:assert/strict";
import { test } from "vitest";
import {
  recoverableRuntimeDeliveryBackoffReason,
  recoverableRuntimeProcessCloseReason,
} from "./runtimeErrorDeliveryPolicy.js";

const CURSOR_STREAM_TEARDOWN = "RetriableError: WritableIterable is closed";

test("cursor-agent WritableIterable stream teardown is recoverable on both delivery paths", () => {
  assert.equal(
    recoverableRuntimeDeliveryBackoffReason(CURSOR_STREAM_TEARDOWN, null, null),
    "provider_stream_error",
  );
  assert.equal(
    recoverableRuntimeProcessCloseReason(CURSOR_STREAM_TEARDOWN, null, null),
    "provider_stream_error",
  );
});

test("recovery stays narrow: unclassified provider errors are not recoverable on process close", () => {
  assert.equal(
    recoverableRuntimeProcessCloseReason("RetriableError: upstream queue full", null, null),
    null,
  );
  assert.equal(
    recoverableRuntimeProcessCloseReason("RetriableError: WritableIterable is closed", { actionRequired: true }, null),
    null,
  );
  assert.equal(
    recoverableRuntimeProcessCloseReason(CURSOR_STREAM_TEARDOWN, null, { actionRequired: true }),
    null,
  );
});
