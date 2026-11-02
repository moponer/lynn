import { test } from "node:test";
import assert from "node:assert/strict";
import { SKIN_TOKEN_KEYS, checkSkin, skinCssVars } from "../dist/shared/skin.js";

/** 皮肤包规范（§2.4）：纯声明式，只声明内置动效器与白名单 Token。 */

const good = {
  kind: "lynnskin",
  version: 1,
  id: "lynn.skin.dusk",
  name: "暮色",
  base: "night",
  motion: { kind: "ripple", speed: 0.8, opacity: 0.4 },
  tokens: { "--blue": "#6fb3d1", "--seal": "#c8443a" },
};

test("合法皮肤通过", () => {
  const r = checkSkin(good);
  assert.equal(r.ok, true, r.issues.join("；"));
});

test("带脚本 / 外联一律拒收", () => {
  for (const bad of [{ script: "alert(1)" }, { js: "x" }, { css: "url(http://evil)" }]) {
    const r = checkSkin({ ...good, ...bad });
    assert.equal(r.ok, false);
    assert.ok(r.issues.some((i) => i.includes("不允许")));
  }
});

test("只能声明内置动效器，不能自造", () => {
  assert.equal(checkSkin({ ...good, motion: { kind: "canvas-shader", speed: 1, opacity: 0.5 } }).ok, false);
  assert.equal(checkSkin({ ...good, motion: { kind: "ripple", speed: 9, opacity: 0.5 } }).ok, false);
  assert.equal(checkSkin({ ...good, motion: { kind: "ripple", speed: 1, opacity: 2 } }).ok, false);
});

test("Token 只能覆盖白名单，不能新增或改名", () => {
  const r = checkSkin({ ...good, tokens: { "--accent": "#fff" } });
  assert.equal(r.ok, false);
  assert.ok(r.issues.some((i) => i.includes("--accent")));
  // 值必须是颜色
  assert.equal(checkSkin({ ...good, tokens: { "--blue": "blue; background:url(x)" } }).ok, false);
});

test("skinCssVars 只输出白名单内的键", () => {
  const skin = { ...good, tokens: { "--blue": "#123456", "--nope": "#ffffff" } };
  const vars = skinCssVars(skin);
  assert.deepEqual(vars, { "--blue": "#123456" });
  assert.ok(SKIN_TOKEN_KEYS.includes("--seal"));
  assert.ok(!SKIN_TOKEN_KEYS.includes("--accent"));
});
