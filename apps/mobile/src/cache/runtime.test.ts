import assert from "node:assert/strict";
import test from "node:test";
import { openNodeSqliteDb } from "./portNode.ts";
import { createCacheRuntime } from "./runtime.ts";

function makeRuntime() {
  return createCacheRuntime({
    openDb: () => openNodeSqliteDb(":memory:"),
    now: () => "2026-09-28T00:00:00Z",
  });
}

test("attach is idempotent per scope and switching servers keeps data", async () => {
  const runtime = makeRuntime();
  const s1 = runtime.attach("https://a.example", "u1", "srv-1");
  assert.equal(runtime.attach("https://a.example", "u1", "srv-1"), s1);
  const s2 = runtime.attach("https://a.example", "u1", "srv-2");
  assert.notEqual(s1, s2);
  assert.equal(runtime.scopeId, s2);

  await runtime.repo.putChannels(s1, [{ id: "c1", type: "channel", raw: { id: "c1" } }]);
  await runtime.repo.putChannels(s2, [{ id: "c9", type: "channel", raw: { id: "c9" } }]);

  // Switch back: the first server's cache is intact (no wipe on switch).
  runtime.attach("https://a.example", "u1", "srv-1");
  assert.deepEqual(
    runtime.repo.getChannelsSync(runtime.scopeId ?? -1).map((c) => c.id),
    ["c1"],
  );
});

test("logout wipes only the attached scope and detaches", async () => {
  const runtime = makeRuntime();
  const s1 = runtime.attach("https://a.example", "u1", "srv-1");
  const s2 = runtime.attach("https://a.example", "u1", "srv-2");
  await runtime.repo.appendPage(s1, "c1", {
    messages: [{ seq: 1, id: "m-1", raw: { id: "m-1", seq: 1 } }],
  });
  await runtime.repo.appendPage(s2, "c9", {
    messages: [{ seq: 1, id: "m-9", raw: { id: "m-9", seq: 1 } }],
  });

  runtime.attach("https://a.example", "u1", "srv-2");
  await runtime.logout();
  assert.equal(runtime.scopeId, null);
  const back = runtime.attach("https://a.example", "u1", "srv-2");
  assert.deepEqual(runtime.repo.getLatestMessagesSync(back, "c9", 10), []);
  const other = runtime.attach("https://a.example", "u1", "srv-1");
  assert.equal(runtime.repo.getLatestMessagesSync(other, "c1", 10).length, 1);
});

test("resetAll clears every partition (origin change)", async () => {
  const runtime = makeRuntime();
  const s1 = runtime.attach("https://a.example", "u1", "srv-1");
  await runtime.repo.appendPage(s1, "c1", {
    messages: [{ seq: 1, id: "m-1", raw: { id: "m-1", seq: 1 } }],
  });
  await runtime.resetAll();
  assert.equal(runtime.scopeId, null);
  const fresh = runtime.attach("https://b.example", "u2", "srv-1");
  assert.deepEqual(runtime.repo.getLatestMessagesSync(fresh, "c1", 10), []);
});
