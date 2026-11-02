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

test("卡槽白名单与计划书一致（8 个，名字不变）", () => {
  assert.deepEqual(UI_SLOTS, [
    "theme.tokens",
    "stage.view",
    "card.renderer",
    "avatar.driver",
    "sidebar.item",
    "settings.section",
    "status.bar",
    "composer.action",
  ]);
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
