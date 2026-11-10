import { test } from "node:test";
import assert from "node:assert/strict";
import {
  BUILTIN_UI_PLUGINS,
  UI_SLOTS,
  checkUiPlugin,
  enabledUiPlugins,
  pluginsForSlot,
} from "../dist/shared/ui-plugin.js";

/** U 插件卡槽契约（§4.2.4）：只许白名单卡槽；第三方必须沙箱。 */

const base = {
  id: "lynn.demo.clock",
  name: "时钟",
  version: "1.0.0",
  slots: ["status.bar"],
  source: "official",
  sandbox: false,
};

// 冻结的 8 个卡槽：名字与顺序都不得改动（v1 冻结承诺）。
// v1 允许**新增**卡槽（PLUGIN-CONTRACT.md 第 7 行），但每个新增项都必须在下面登记——
// 偷偷加一个卡槽同样会红，只是出口从"数量相等"变成"新增项显式列出"。
const FROZEN_SLOTS = [
  "theme.tokens",
  "stage.view",
  "card.renderer",
  "avatar.driver",
  "sidebar.item",
  "settings.section",
  "status.bar",
  "composer.action",
];

test("卡槽白名单：冻结 8 个原样保留，新增卡槽须显式登记", () => {
  assert.deepEqual(UI_SLOTS.slice(0, FROZEN_SLOTS.length), FROZEN_SLOTS, "冻结卡槽的名字与顺序不得改动");
  // v1 新增项（CONSOLE-UPDATE：内置视图卡槽，仅官方可声明）
  assert.deepEqual(UI_SLOTS.slice(FROZEN_SLOTS.length), ["stage.console"]);
});

test("不留内置示例插件（界面上不允许有只做样子的东西）", () => {
  assert.equal(BUILTIN_UI_PLUGINS.length, 0);
});

test("未声明的卡槽被拒（不能自己造卡槽名）", () => {
  const r = checkUiPlugin({ ...base, slots: ["status.bar", "global.overlay"] });
  assert.equal(r.ok, false);
  assert.ok(r.issues.some((i) => i.includes("global.overlay")));
});

test("第三方 UI 插件必须 sandbox=true", () => {
  const r = checkUiPlugin({ ...base, source: "third-party", sandbox: false });
  assert.equal(r.ok, false);
  assert.ok(r.issues.some((i) => i.includes("sandbox")));
  assert.equal(checkUiPlugin({ ...base, source: "third-party", sandbox: true }).ok, true);
});

test("id / version / slots 不合法都拒绝", () => {
  assert.equal(checkUiPlugin({ ...base, id: "myplugin" }).ok, false);
  assert.equal(checkUiPlugin({ ...base, version: "1" }).ok, false);
  assert.equal(checkUiPlugin({ ...base, slots: [] }).ok, false);
});

test("按卡槽取插件，且能按启停状态过滤", () => {
  const fixtures = [
    { ...base, id: "lynn.a", name: "A", slots: ["status.bar"] },
    { ...base, id: "lynn.b", name: "B", slots: ["composer.action"], source: "third-party", sandbox: true },
  ];
  const status = pluginsForSlot(fixtures, "status.bar");
  assert.deepEqual(status.map((p) => p.id), ["lynn.a"]);

  const composer = pluginsForSlot(fixtures, "composer.action");
  assert.deepEqual(composer.map((p) => p.id), ["lynn.b"]);

  const enabled = enabledUiPlugins(fixtures, ["lynn.b"]);
  assert.equal(enabled.length, 1);
  assert.equal(pluginsForSlot(enabled, "composer.action").length, 0);
});
