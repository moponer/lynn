// M2-17：UI 插件契约 v1 冻结锁定（PLUGIN-CONTRACT.md）。
// 这些断言是「冻结」的执行体：删/改下面任何清单项，CI 红——提醒先升 apiVersion=2。
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  MANIFEST_API_VERSION,
  PLUGIN_TIERS,
  UI_SLOTS,
} from "../dist/main/plugin-manifest.js";

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

test("契约 v1：卡槽白名单必须包含全部冻结卡槽（删除/改名 = 破坏冻结）", () => {
  const have = new Set(UI_SLOTS);
  const missing = FROZEN_SLOTS.filter((s) => !have.has(s));
  assert.deepEqual(missing, [], `这些冻结卡槽从代码里消失了：${missing.join("、")}`);
});

test("契约 v1：apiVersion 仍是 1；tier 四档不变", () => {
  assert.equal(MANIFEST_API_VERSION, 1);
  assert.deepEqual([...PLUGIN_TIERS], ["L0", "L1", "L2", "U"]);
});

test("契约 v1：U 档第三方强制沙箱、entry 只许 .html 且不许跳出目录", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "lynn-contract-"));
  const d = path.join(root, "plugins", "p");
  fs.mkdirSync(d, { recursive: true });
  fs.writeFileSync(
    path.join(d, "plugin.json"),
    JSON.stringify({
      id: "lynn.x.c", name: "x", version: "1.0.0", apiVersion: 1, tier: "U",
      engines: { kernel: "^1.4.0" }, entry: "./ui.html", contributes: { slots: ["status.bar"] },
    }),
    "utf-8",
  );
  fs.writeFileSync(path.join(d, "ui.html"), "<b>x</b>", "utf-8");
  const { scanUiPlugins } = await import("../dist/main/ui-plugins.js");
  const r = scanUiPlugins(root);
  assert.equal(r.errors.length, 0, r.errors.join("；"));
  assert.equal(r.plugins[0].manifest.sandbox, true, "第三方强制沙箱（v1 语义）");
});

test("契约 v1：冻结文档存在于仓库根", () => {
  const doc = path.resolve(import.meta.dirname, "..", "PLUGIN-CONTRACT.md");
  assert.ok(fs.existsSync(doc), "PLUGIN-CONTRACT.md 缺失");
  const text = fs.readFileSync(doc, "utf-8");
  for (const s of FROZEN_SLOTS) assert.ok(text.includes(`\`${s}\``), `冻结文档没写卡槽 ${s}`);
  assert.ok(text.includes("apiVersion: 2"), "文档要写清破坏性变更的出口");
});
