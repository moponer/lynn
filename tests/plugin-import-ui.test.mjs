/**
 * 插件包导入面板（P9-4）。
 *
 * 补的是 25 章第 7 节列的缺口：「UI 包导入无图形入口，只有 RPC」。
 *
 * 这组测试守三件事——它们都是"用户能不能真的用上"的关键：
 *  1. 两个入口都在（zip / 目录）：原生对话框一次只能开一种模式；
 *  2. **失败要逐条摊开**：`stage` + `message`，不是一句"导入失败"；
 *  3. **装上不等于启用**：成功提示里必须说清这一点（L1 有代码，得让用户先看清）。
 *
 * 为什么部分断言是"读源码"而不是"渲染"：
 * 这个组件的失败/成功状态由 `useState` 驱动，而 `renderToStaticMarkup` 不跑事件、
 * 也不能注入初始 state。项目没有 RTL/jsdom（离线装不了），所以：
 *  - 能渲染的（初始态、按钮、文案）走真实渲染；
 *  - 状态分支（失败列表、成功提示）走源码结构断言。
 * 后者弱一些，但它能防住"有人把逐条列表改成一句 `导入失败`"这种回退。
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { loadModule, textOf } from "./helpers/render-ssr.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const SRC = fs.readFileSync(path.join(here, "..", "src/renderer/components/PluginImportPanel.tsx"), "utf8");

const i18nMod = await loadModule("src/renderer/i18n.tsx");
const { ZH_STRINGS } = await import("../dist/shared/i18n-strings.js");
const panelMod = await loadModule("src/renderer/components/PluginImportPanel.tsx");

function withI18n(node) {
  return renderToStaticMarkup(createElement(i18nMod.I18nProvider, { strings: ZH_STRINGS }, node));
}

test("面板能渲染，且两个入口都在（zip / 目录）", () => {
  const html = withI18n(createElement(panelMod.PluginImportPanel, {}));
  const text = textOf(html);
  assert.match(text, /\.zip/, "要有「从 .zip 安装」");
  assert.match(text, /目录/, "要有「从目录安装」——自己写的插件是目录形态");
  assert.ok((html.match(/<button/g) ?? []).length >= 2, "至少两个按钮");
});

test("初始状态不显示成功/失败提示（避免误导）", () => {
  const html = withI18n(createElement(panelMod.PluginImportPanel, {}));
  assert.ok(!html.includes("sf-result"), "一进来不该有任何结果条");
});

test("失败时逐条显示 stage 与 message（不是一句「导入失败」）", () => {
  assert.match(SRC, /issues\.map/, "失败列表必须逐条渲染，不能合并成一句");
  assert.match(SRC, /<code>\{i\.stage\}<\/code>/, "必须显示 stage（卡在哪一步）");
  assert.match(SRC, /i\.message/, "必须显示 message（具体原因）");
  assert.match(SRC, /role="alert"/, "失败要能被读屏器立刻播报");
  // 反向断言：不许出现"笼统失败"的写法
  assert.doesNotMatch(SRC, /setIssues\(\[\{ stage: "unknown", message: "导入失败" \}\]\)/, "不许用笼统的失败文案");
});

test("装上不等于启用：成功提示必须说清这一点", () => {
  assert.match(SRC, /enableHint/, "成功分支必须带「装上不等于启用」的提示");
  const hint = ZH_STRINGS["pluginImport.enableHint"];
  assert.ok(hint && /启用/.test(hint), `提示文案要提到启用：${hint}`);
});

test("取消选择时什么都不做（不该弹失败）", () => {
  assert.match(SRC, /if \(picked\.canceled \|\| !picked\.path\) return;/, "取消要直接返回，不能当失败处理");
});

test("两个入口走同一个 RPC，用 mode 区分（不是两套逻辑）", () => {
  assert.match(SRC, /app\.pickPluginPackage/, "要用专门的选择 RPC");
  assert.match(SRC, /mode\s*\}/, "mode 要传进去（file / dir）");
  // 只有一个**调用点**：两个按钮共用一条导入路径（注释里提到不算）
  const noComments = SRC.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
  const calls = (noComments.match(/rpc\("plugins\.import"/g) ?? []).length;
  assert.equal(calls, 1, `导入 RPC 应当只调用一次（共用路径），实际 ${calls} 次`);
});

test("i18n：面板文案全部走 t()，没有写死的 JSX 中文", () => {
  const noComments = SRC.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
  const hardcoded = /<[a-z]+[^>]*>[^<>{]*[\u4e00-\u9fa5]{2,}/.exec(noComments);
  assert.equal(hardcoded, null, `发现写死的 JSX 中文：${hardcoded?.[0]?.slice(0, 60)}`);
});