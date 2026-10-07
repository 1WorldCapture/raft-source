import assert from "node:assert/strict";
import test from "node:test";
import { DraftScheduler, draftKey } from "./composerDraft";

test("draft saves stay inside 250ms idle and 3s while typing", () => {
  const saves: string[] = [];
  const timers: Array<{ fn: () => void; ms: number }> = [];
  const scheduler = new DraftScheduler(
    (value) => saves.push(value),
    (fn, ms) => {
      timers.push({ fn, ms });
      return timers.length;
    },
    () => undefined,
  );
  scheduler.update("a", 0);
  assert.equal(timers.at(-1)?.ms, 250);
  scheduler.update("ab", 200);
  assert.equal(timers.at(-1)?.ms, 250);
  scheduler.update("abc", 2900);
  assert.equal(timers.at(-1)?.ms, 100);
  timers.at(-1)?.fn();
  assert.deepEqual(saves, ["abc"]);
});

test("draft keys stay inside secure-store's allowed characters", () => {
  assert.equal(draftKey("channel/1"), "raft.draft.channel_1");
});
