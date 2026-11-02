import { test } from "node:test";
import assert from "node:assert/strict";
import {
  AMBIENT_MODE_LABEL,
  THEME_AMBIENT,
  ambientForTheme,
  frameInterval,
  shouldRender,
} from "../dist/shared/ambient.js";

/** 动效层（§2.4）：省电/待机/隐藏窗口的帧率规则是 GPU 红线的实现基础。 */

const base = { mode: "full", standby: false, reducedMotion: false, windowHidden: false };

test("关闭 / 系统减少动效 / 窗口隐藏 → 不起 RAF", () => {
  assert.equal(frameInterval({ ...base, mode: "off" }), null);
  assert.equal(frameInterval({ ...base, reducedMotion: true }), null);
  assert.equal(frameInterval({ ...base, windowHidden: true }), null);
});

test("待机降帧：全开 10fps、低配 5fps", () => {
  assert.equal(frameInterval({ ...base, standby: true }), 100);
  assert.equal(frameInterval({ ...base, standby: true, mode: "low" }), 200);
});

test("工作时按档位出帧：全开 30fps、低配 15fps", () => {
  assert.equal(frameInterval(base), 1000 / 30);
  assert.equal(frameInterval({ ...base, mode: "low" }), 1000 / 15);
});

test("主题 → 动效声明：三套主题各一个内置动效器，未知主题不猜", () => {
  assert.equal(THEME_AMBIENT.night.kind, "ripple");
  assert.equal(THEME_AMBIENT.paper.kind, "ink");
  assert.equal(THEME_AMBIENT.celadon.kind, "wind");
  assert.equal(ambientForTheme("night").kind, "ripple");
  assert.equal(ambientForTheme("unknown").kind, "none");
});

test("none 不画；省电关闭时任何主题都不画", () => {
  assert.equal(shouldRender("none", base), false);
  assert.equal(shouldRender("ripple", base), true);
  assert.equal(shouldRender("ripple", { ...base, mode: "off" }), false);
  assert.equal(AMBIENT_MODE_LABEL.low, "低配");
});
