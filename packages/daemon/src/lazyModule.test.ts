import assert from "node:assert/strict";
import { test } from "vitest";
import { createLazyModule } from "./lazyModule.js";

test("concurrent first callers share a single load", async () => {
  let loads = 0;
  let release!: (value: { id: number }) => void;
  const lazy = createLazyModule(() => {
    loads += 1;
    return new Promise<{ id: number }>((resolve) => {
      release = resolve;
    });
  });
  assert.equal(lazy.peek(), null);
  const first = lazy.get();
  const second = lazy.get();
  assert.equal(loads, 1);
  release({ id: 1 });
  const [a, b] = await Promise.all([first, second]);
  assert.equal(a, b);
  assert.equal(lazy.peek(), a);
  assert.equal(await lazy.get(), a);
  assert.equal(loads, 1, "later callers reuse the loaded module");
});

test("a failed load is not cached, every concurrent caller sees the failure, and the next caller retries", async () => {
  const unhandled: unknown[] = [];
  const onUnhandled = (reason: unknown) => unhandled.push(reason);
  process.on("unhandledRejection", onUnhandled);
  try {
    let loads = 0;
    const lazy = createLazyModule(async () => {
      loads += 1;
      if (loads === 1) throw new Error("boom");
      return { ok: true };
    });
    const results = await Promise.allSettled([lazy.get(), lazy.get()]);
    assert.deepEqual(results.map((result) => result.status), ["rejected", "rejected"]);
    assert.equal(loads, 1, "the two concurrent callers still shared the one failing load");
    assert.equal(lazy.peek(), null);

    assert.deepEqual(await lazy.get(), { ok: true });
    assert.equal(loads, 2);
    assert.deepEqual(lazy.peek(), { ok: true });

    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(unhandled, [], "no unhandled rejection is left behind");
  } finally {
    process.off("unhandledRejection", onUnhandled);
  }
});
