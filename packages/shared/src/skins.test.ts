import assert from "node:assert/strict";
import test from "node:test";

import {
  DEFAULT_SKIN_ID,
  SIGNAL_ACCENT_STEP,
  SIGNAL_SCALE,
  SKINS,
  chromeChannels,
  isSkinId,
  signalCss,
  signalHex,
  signalStepCss,
  signalStepHex,
  skinById,
} from "./skins.js";

// The scale strings desktop used to inline in skins.ts. The CSS test locks
// those strings; the sRGB table is what Chromium paints for them.
const DESKTOP_SCALE = [
  [50, "98.4%", "0.017"],
  [100, "97.5%", "0.027"],
  [200, "94%", "0.066"],
  [300, "91.3%", "0.103"],
  [400, "88.3%", "0.162"],
  [500, "75.9%", "0.155"],
  [600, "63.7%", "0.13"],
  [700, "50.8%", "0.104"],
  [800, "38.8%", "0.08"],
  [900, "26%", "0.053"],
  [950, "19.9%", "0.041"],
] as const;

// Chromium canvas pixels for `oklch(from <chrome> <L> <C> h)`, one hex per
// DESKTOP_SCALE step. A channel may differ by 1 from 8-bit rounding.
const CHROMIUM_SRGB: Record<string, readonly string[]> = {
  "#FFD440": ["#fefaed", "#fdf7e3", "#fbebb9", "#fbe191", "#ffd441", "#d4ac02", "#a88801", "#7b6300", "#544200", "#2d2300", "#1c1500"],
  "#FBE08C": ["#fefaed", "#fdf7e3", "#fbebb9", "#fbe191", "#fed441", "#d4ac02", "#a78802", "#7b6300", "#544300", "#2d2300", "#1c1500"],
  "#FBCB9C": ["#fff8ee", "#fff4e4", "#ffe3bd", "#ffd598", "#ffc155", "#f29a2d", "#c07922", "#8d5815", "#613a0a", "#351e04", "#221101"],
  "#F9B4A0": ["#fff6f2", "#fff1ea", "#ffddcd", "#ffcab2", "#ffaf8a", "#ff8a67", "#cd6c50", "#974e39", "#683324", "#391a11", "#250e08"],
  "#F7BBCB": ["#fff5f9", "#fff0f6", "#ffdae8", "#ffc6de", "#ffa8d2", "#ff83ab", "#ca6786", "#954a62", "#663042", "#381822", "#240d15"],
  "#EFA9C6": ["#fff5fb", "#fff0f8", "#ffdaef", "#ffc6e9", "#ffa9e2", "#fa84ba", "#c66792", "#924a6b", "#643148", "#371826", "#240d17"],
  "#D6C4F0": ["#fcf7ff", "#faf3ff", "#f4e1ff", "#f1d2ff", "#efbcff", "#c696ff", "#9c76cb", "#725596", "#4e3967", "#2a1d39", "#1a1125"],
  "#BFC4F0": ["#f7f9ff", "#f3f5ff", "#e2e7ff", "#d4dbff", "#c4cbff", "#9ea4ff", "#7c81d8", "#5a5ea0", "#3c3f6e", "#1f213d", "#121328"],
  "#A9D6F2": ["#effcff", "#e6faff", "#c1f3ff", "#9deeff", "#54e8ff", "#25beff", "#1b96cf", "#106e99", "#064a69", "#03273a", "#011826"],
  "#A6E0DA": ["#eefefc", "#e3fdfa", "#b9faf3", "#8bf9ef", "#00faed", "#00cfc3", "#00a49a", "#007871", "#00524d", "#002c29", "#001b19"],
  "#C2E0AC": ["#f5fcf1", "#f0fbe8", "#dbf5c8", "#c9f1aa", "#afef79", "#8bc556", "#6d9b43", "#4e722e", "#344d1d", "#1a290c", "#0f1a05"],
  "#E9DDC4": ["#fff9ed", "#fff6e3", "#ffe9b9", "#ffde91", "#ffcf41", "#dda803", "#af8402", "#806000", "#584000", "#302200", "#1e1400"],
  "#D9E0E8": ["#f2fbff", "#eaf9ff", "#ccefff", "#b0e7ff", "#83deff", "#60b5ff", "#4a8fd7", "#34689f", "#21466e", "#0f253d", "#071728"],
};

function channelDelta(actual: string, expected: string): number {
  const left = Number.parseInt(actual.slice(1), 16);
  const right = Number.parseInt(expected.slice(1), 16);
  return Math.max(
    Math.abs(((left >> 16) & 255) - ((right >> 16) & 255)),
    Math.abs(((left >> 8) & 255) - ((right >> 8) & 255)),
    Math.abs((left & 255) - (right & 255)),
  );
}

test("default skin is rose and unknown ids fall back to it", () => {
  assert.equal(DEFAULT_SKIN_ID, "rose");
  assert.equal(skinById("rose").chrome, "#EFA9C6");
  assert.equal(skinById("missing").id, "rose");
  assert.equal(isSkinId("rose"), true);
  assert.equal(isSkinId("amber"), true);
  assert.equal(isSkinId("Rose"), false);
  assert.equal(isSkinId(""), false);
  assert.equal(isSkinId(null), false);
});

test("the palette is the desktop list, in the same order", () => {
  assert.deepEqual(SKINS.map((skin) => skin.id), [
    "signal", "amber", "peach", "coral", "blush", "rose",
    "lilac", "iris", "sky", "aqua", "sage", "sand", "cloud",
  ]);
  assert.equal(SKINS[0].chrome, "#FFD440");
  assert.deepEqual(chromeChannels("#FFD440"), [255, 212, 64]);
});

test("signal css matches the color desktop used to set", () => {
  assert.deepEqual(SIGNAL_SCALE.map((row) => [row.step, row.lightness, row.chroma]), DESKTOP_SCALE.map((row) => [...row]));
  for (const skin of SKINS) {
    for (const [step, lightness, chroma] of DESKTOP_SCALE) {
      assert.equal(signalStepCss(skin.chrome, step), `oklch(from ${skin.chrome} ${lightness} ${chroma} h)`);
    }
    assert.equal(signalCss(skin.chrome), signalStepCss(skin.chrome, SIGNAL_ACCENT_STEP));
  }
});

test("resolved signal colors match the sRGB Chromium paints for those oklch values", () => {
  for (const skin of SKINS) {
    const painted = CHROMIUM_SRGB[skin.chrome];
    assert.ok(painted, skin.chrome);
    DESKTOP_SCALE.forEach(([step], index) => {
      const delta = channelDelta(signalStepHex(skin.chrome, step), painted[index]);
      assert.ok(delta <= 1, `${skin.id} step ${step} ${signalStepHex(skin.chrome, step)} vs ${painted[index]}`);
    });
  }
  assert.equal(channelDelta(signalHex("#FFD440"), "#ffd441") <= 1, true);
  assert.equal(channelDelta(signalHex("#EFA9C6"), "#ffa9e2") <= 1, true);
});
