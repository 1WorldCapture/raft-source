import assert from "node:assert/strict";
import test from "node:test";
import { newerMessageCount } from "./newerMessages";

test("older history is not counted as new messages", () => {
  assert.deepEqual(newerMessageCount([{ seq: 1 }, { seq: 50 }], 0), { newest: 50, added: 0 });
  assert.deepEqual(newerMessageCount([{ seq: 1 }, { seq: 40 }, { seq: 51 }], 50), { newest: 51, added: 1 });
  assert.deepEqual(newerMessageCount([{ seq: 10 }, { seq: 20 }], 50), { newest: 50, added: 0 });
});
