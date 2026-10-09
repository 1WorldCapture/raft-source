import assert from "node:assert/strict";
import test from "node:test";
import { createElement, isValidElement, type ReactNode } from "react";
import { connectionBannerFrame } from "./connectionBannerFrame.ts";
import { tabHeaderBlockHeight } from "./tokens.ts";

function Host(props: { children?: ReactNode; style?: unknown }) {
  return createElement("host", null, props.children);
}

function slots(node: ReactNode): ReactNode[] {
  if (!isValidElement(node)) return [];
  const children = (node.props as { children?: ReactNode }).children;
  if (children == null || children === false) return [];
  return Array.isArray(children) ? children : [children];
}

function pathTo(node: ReactNode, target: ReactNode, prefix: number[] = []): number[] | null {
  if (node === target) return prefix;
  const children = slots(node).filter((child) => child != null && child !== false);
  for (let index = 0; index < children.length; index += 1) {
    const found = pathTo(children[index], target, [...prefix, index]);
    if (found) return found;
  }
  return null;
}

test("showing and hiding the strip keeps the child mounted on the same host", () => {
  let mounts = 0;
  function Marker() {
    return createElement("marker");
  }
  const marker = createElement(Marker);
  const strip = createElement("strip");
  const hidden = connectionBannerFrame({
    Host,
    rootStyle: { flex: 1 },
    bodyStyle: { flex: 1 },
    children: marker,
    strip: null,
    status: null,
  });
  const shown = connectionBannerFrame({
    Host,
    rootStyle: { flex: 1 },
    bodyStyle: { flex: 1 },
    children: marker,
    strip,
    status: createElement("status"),
  });
  const hiddenAgain = connectionBannerFrame({
    Host,
    rootStyle: { flex: 1 },
    bodyStyle: { flex: 1 },
    children: marker,
    strip: null,
    status: null,
  });

  assert.deepEqual(pathTo(hidden, marker), [0, 0]);
  assert.deepEqual(pathTo(shown, marker), [0, 0]);
  assert.deepEqual(pathTo(hiddenAgain, marker), [0, 0]);
  assert.deepEqual(pathTo(shown, strip), [1]);
  assert.equal(pathTo(strip, marker), null);

  const seen = new Set<string>();
  for (const tree of [hidden, shown, hiddenAgain]) {
    const path = pathTo(tree, marker);
    assert.ok(path);
    const key = `${path.join(".")}:${marker.type === Marker ? "Marker" : "other"}`;
    if (seen.has(key)) continue;
    seen.add(key);
    mounts += 1;
  }
  assert.equal(mounts, 1);
});

test("the strip offset matches the yellow tab header, including a short window", () => {
  assert.equal(tabHeaderBlockHeight(800, 47), 62 + 47);
  assert.equal(tabHeaderBlockHeight(600, 24), 48 + 24);
});
