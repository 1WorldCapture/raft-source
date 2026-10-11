import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { test } from "vitest";
import { attachPoolClientErrorHandler } from "./pgPoolErrorHandler.js";

/**
 * pg-pool removes its own idle-client 'error' listener at checkout, so an
 * error that fires while a client sits between queries (mid-transaction)
 * would be unhandled and crash the process. The guard attaches a listener at
 * pool 'connect' time that survives checkout. These tests model pool/client
 * as plain EventEmitters — the wiring is what matters, not real pg traffic.
 */

function fakePoolAndClient(): { pool: EventEmitter; client: EventEmitter } {
  const pool = new EventEmitter();
  const client = new EventEmitter();
  attachPoolClientErrorHandler(pool as never, "test");
  pool.emit("connect", client);
  return { pool, client };
}

test("a client error emitted after checkout is handled, not thrown", () => {
  const { client } = fakePoolAndClient();
  // Without the guard this emit throws ("Unhandled 'error' event").
  assert.doesNotThrow(() => {
    client.emit("error", new Error("connection dropped between queries"));
  });
});

test("each connected client gets its own listener", () => {
  const pool = new EventEmitter();
  attachPoolClientErrorHandler(pool as never, "test");
  const first = new EventEmitter();
  const second = new EventEmitter();
  pool.emit("connect", first);
  pool.emit("connect", second);
  assert.doesNotThrow(() => {
    first.emit("error", new Error("first dropped"));
    second.emit("error", new Error("second dropped"));
  });
});

test("a client that never emitted an error stays error-free", () => {
  const { client } = fakePoolAndClient();
  assert.equal(client.listenerCount("error"), 1);
});
