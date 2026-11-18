import { test } from "node:test";
import assert from "node:assert/strict";
import { checkIconsFile } from "../dist/main/plugin-host.js";
import { checkManifest } from "../dist/main/plugin-manifest.js";

/**
 * 图标覆盖（contributes.icons）—— 2026-11-18 设计系统重建时新增的 L0 能力。
 *
 * 这条能力的风险点很集中：那段字符串最终会进 dangerouslySetInnerHTML，
 * 所以准入检查就是它的**全部安全边界**。这里把边界逐条钉住。
 */

const good = {
  home: '<path d="M3 10.5 12 3l9 7.5"/>',
  gear: '<circle cx="12" cy="12" r="3"/><path d="M12 2v3"/>',
};

test("合法图标表通过：只含 SVG 内联标记", () => {
  const r = checkIconsFile(good);
  assert.equal(r.ok, true, r.issues.join("；"));
  assert.deepEqual(Object.keys(r.icons), ["home", "gear"]);
});

test("允许一个 $comment 键放作者说明（不算图标）", () => {
  const r = checkIconsFile({ "$comment": "说明", ...good });
  assert.equal(r.ok, true, r.issues.join("；"));
  assert.equal(Object.keys(r.icons).length, 2);
});

test("脚本与可执行内容一律拒收", () => {
  for (const bad of [
    '<script>alert(1)</script>',
    '<path onclick="alert(1)" d="M0 0"/>',
    '<a href="javascript:alert(1)"/>',
    '<foreignObject><body/></foreignObject>',
    '<image href="https://evil/x.png"/>',
    '<use href="#x"/>',
    '<style>body{display:none}</style>',
  ]) {
    const r = checkIconsFile({ icon: bad });
    assert.equal(r.ok, false, `应当拒收：${bad}`);
  }
});

test("图标名必须是小写字母开头的短名", () => {
  for (const name of ["Home", "a b", "1st", "-x", "x".repeat(40)]) {
    assert.equal(checkIconsFile({ [name]: "<path/>" }).ok, false, `应当拒收名字：${name}`);
  }
});

test("体积与数量有上限", () => {
  assert.equal(checkIconsFile({ big: "<path d=\"" + "0".repeat(5000) + "\"/>" }).ok, false);
  const many = {};
  for (let i = 0; i < 200; i += 1) many["i" + i] = "<path/>";
  assert.equal(checkIconsFile(many).ok, false);
});

test("值必须是字符串，且以标记开头", () => {
  assert.equal(checkIconsFile({ a: 123 }).ok, false);
  assert.equal(checkIconsFile({ a: "M3 10.5 12 3l9 7.5" }).ok, false);
});

test("空表与非法 JSON 形状都拒", () => {
  assert.equal(checkIconsFile({}).ok, false);
  assert.equal(checkIconsFile([]).ok, false);
  assert.equal(checkIconsFile(null).ok, false);
});

test("manifest：icons 只许 L0、必须是 .json", () => {
  const base = {
    id: "lynn.theme.x",
    name: "X",
    version: "1.0.0",
    apiVersion: 1,
    engines: { kernel: ">=0.0.1" },
  };
  const ok = checkManifest({ ...base, tier: "L0", contributes: { icons: "icons.json" } }, { source: "user" });
  assert.equal(ok.ok, true, ok.issues.join("；"));

  const notL0 = checkManifest({ ...base, tier: "L1", contributes: { icons: "icons.json" } }, { source: "user" });
  assert.equal(notL0.ok, false, "L1 不该能声明图标覆盖");

  const notJson = checkManifest({ ...base, tier: "L0", contributes: { icons: "icons.css" } }, { source: "user" });
  assert.equal(notJson.ok, false, "图标覆盖必须是 .json");
});
