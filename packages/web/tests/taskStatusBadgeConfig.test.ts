/**
 * Task status → badge color is a single shared source (`TASK_STATUS_UI` in
 * components/task/taskStatusUi.ts). Every surface that shows a task-status badge
 * — the message footer, the Activity/inbox thread row, task cards — reads this
 * one map, so the same task renders the same color everywhere.
 *
 * This guards the semantic that has regressed twice: `closed` is a terminal but
 * REVERSIBLE state (closed → todo is a valid transition), not a destructive
 * action, so it uses the warm-neutral `brutal-stone` token — never
 * `brutal-red`. It was fixed in task #145, then re-broke when the Activity row
 * kept its own local `statusConfig` mapping closed → brutal-red (task #543).
 */

import { strict as assert } from "node:assert";
import test from "node:test";
import {
  getTaskStatusBackgroundStyle,
  TASK_STATUS_UI,
  STATUS_BADGE_CONFIG,
  STATUS_STYLES,
} from "../src/components/task/taskStatusUi";

test("closed task badge is neutral stone, never destructive red", () => {
  assert.equal(TASK_STATUS_UI.closed.bg, "bg-brutal-stone");
  assert.notEqual(TASK_STATUS_UI.closed.bg, "bg-brutal-red");
});

test("every task status maps to its design-system color token", () => {
  assert.equal(TASK_STATUS_UI.todo.bg, "bg-brutal-orange");
  assert.equal(TASK_STATUS_UI.in_progress.bg, "bg-brutal-cyan");
  assert.equal(TASK_STATUS_UI.in_review.bg, "bg-brutal-lavender");
  assert.equal(TASK_STATUS_UI.done.bg, "bg-brutal-lime");
  assert.equal(TASK_STATUS_UI.closed.bg, "bg-brutal-stone");
});

test("STATUS_BADGE_CONFIG and STATUS_STYLES are the same source, not divergent copies", () => {
  // Callsites read these aliases; they must stay identical to TASK_STATUS_UI or
  // the same task renders different colors in different surfaces (the task #543
  // bug — a local per-surface copy is exactly what drifted).
  assert.equal(STATUS_BADGE_CONFIG, TASK_STATUS_UI);
  assert.equal(STATUS_STYLES, TASK_STATUS_UI);
});

test("canonical task backgrounds resolve to final CSS variables from the same SSOT", () => {
  assert.deepEqual(getTaskStatusBackgroundStyle("todo"), {
    "--task-status-bg": "var(--color-brutal-orange)",
  });
  assert.deepEqual(getTaskStatusBackgroundStyle("in_progress"), {
    "--task-status-bg": "var(--color-brutal-cyan)",
  });
  assert.deepEqual(getTaskStatusBackgroundStyle("in_review"), {
    "--task-status-bg": "var(--color-brutal-lavender)",
  });
  assert.deepEqual(getTaskStatusBackgroundStyle("done"), {
    "--task-status-bg": "var(--color-brutal-lime)",
  });
  assert.deepEqual(getTaskStatusBackgroundStyle("closed"), {
    "--task-status-bg": "var(--color-brutal-stone)",
  });
});

test("every status has an Elegant semantic background and class callsites keep Brutal's canonical one", async () => {
  const { taskStatusBgClass } = await import("../src/components/task/taskStatusUi");
  for (const status of Object.keys(TASK_STATUS_UI) as Array<keyof typeof TASK_STATUS_UI>) {
    const cfg = TASK_STATUS_UI[status];
    assert.match(cfg.bgElegant, /^bg-(warning|info|secondary|success|fill)-/, `${status} needs a semantic Elegant background`);
    assert.doesNotMatch(cfg.bgElegant, /brutal/);
    assert.equal(taskStatusBgClass(status), `${cfg.bgElegant} theme-brutal:${cfg.bg}`);
  }
});

test("StatusBadge paints Brutal's canonical colour only under theme-brutal and never inline", async () => {
  const { createElement } = await import("react");
  const { renderToStaticMarkup } = await import("react-dom/server");
  const { StatusBadge } = await import("../src/components/task/StatusBadge");
  const html = renderToStaticMarkup(createElement(StatusBadge, { status: "todo" }, "Todo"));
  assert.match(html, /theme-brutal:bg-brutal-orange/);
  assert.match(html, /theme-brutal:bg-\(--task-status-bg\)!/);
  assert.match(html, /--task-status-bg:var\(--color-brutal-orange\)/);
  // A plain class or an inline background-color would paint every theme with Brutal colours.
  assert.doesNotMatch(html, /(^|[\s"])bg-brutal-orange/);
  assert.doesNotMatch(html, /background-color/);
});
