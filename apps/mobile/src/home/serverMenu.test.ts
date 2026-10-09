import assert from "node:assert/strict";
import test from "node:test";
import type { RaftServer } from "../model/messages";
import { buildServerMenu } from "./serverMenu";

const server = (id: string, name: string) => ({ id, name }) as RaftServer;

test("two servers: current is marked, other unread shows the dot and its count", () => {
  const menu = buildServerMenu([server("a", "Alpha"), server("b", "Beta")], "a", { a: 9, b: 3 });
  assert.equal(menu.switchable, true);
  assert.equal(menu.otherUnread, true);
  assert.deepEqual(menu.items.map((i) => [i.id, i.initial, i.current, i.unread]), [
    ["a", "A", true, 0], // the current server's own unread never counts
    ["b", "B", false, 3],
  ]);
});

test("no unread elsewhere: no dot", () => {
  const menu = buildServerMenu([server("a", "Alpha"), server("b", "Beta")], "a", { a: 5, b: 0 });
  assert.equal(menu.otherUnread, false);
});

test("a single server is not switchable (no ▾, title not tappable)", () => {
  const menu = buildServerMenu([server("a", "Alpha")], "a", {});
  assert.equal(menu.switchable, false);
  assert.equal(menu.items.length, 1);
});

test("no servers loaded yet, or unknown current id", () => {
  assert.deepEqual(buildServerMenu([], null, {}), { items: [], switchable: false, otherUnread: false });
  const menu = buildServerMenu([server("a", "Alpha"), server("b", "Beta")], "zzz", { a: 1 });
  assert.equal(menu.items.some((i) => i.current), false);
  assert.equal(menu.otherUnread, true);
});

test("CJK names get the first character as initial", () => {
  assert.equal(buildServerMenu([server("a", "雷神服务器")], "a", {}).items[0]?.initial, "雷");
});
