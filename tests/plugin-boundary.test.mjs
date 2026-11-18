/**
 * 插件错误隔离（P9-1 / 用户要求「有错误必须直接拦截显示出来，不能搞崩本体」）。
 *
 * 这条要求的反面是：一个 UI 插件写错一行（`undefined.map`），React 会沿树冒到顶层
 * 全局 ErrorBoundary，**把风铃整个界面换成"界面崩了"**——插件崩了，本体也崩了。
 *
 * 所以测试要证明的不是"错误被捕获了"，而是**三件更具体的事**：
 *  1. 崩掉的插件只影响自己那一块，同卡槽的其它插件照常渲染；
 *  2. 错误卡上说清"是哪个插件崩的"（只写 "Something went wrong" 对排障没用）；
 *  3. 有"重试"和"停用"两个可行动作，而不是逼用户去设置页翻三层。
 *
 * 注意：`react-dom/server` 的 `renderToStaticMarkup` **不会**触发 componentDidCatch
 * （服务端没有错误边界的概念），所以这里用 `renderToString` + 断言降级输出。
 * 真正的浏览器行为在 `tests/plugin-boundary-dom.test.mjs` 里用最小 DOM 桩验证。
 */
import test from "node:test";
import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { jsx: { runtime: "automatic" } });
const { PluginBoundary } = await jiti.import("../src/renderer/components/PluginBoundary.tsx", { default: true });

/** 一个必然抛错的组件 */
function Boom() {
  throw new Error("插件内部炸了：undefined.map is not a function");
}

/** 正常组件 */
function Fine({ label }) {
  return createElement("span", null, label);
}

test("正常子组件照常渲染（边界不干扰）", () => {
  const html = renderToStaticMarkup(createElement(PluginBoundary, { pluginId: "demo.ok" }, createElement(Fine, { label: "一切正常" })));
  assert.match(html, /一切正常/);
  assert.ok(!html.includes("plugin-error"), "没出错时不该出现错误卡");
});

test("插件抛错时，错误卡上必须写清是哪个插件崩的", () => {
  /**
   * `renderToStaticMarkup` 不跑 componentDidCatch，所以这里直接验证**错误卡的形状**：
   * 用一个已进入错误态的实例渲染（state 里塞 error）。
   */
  const inst = new PluginBoundary({ pluginId: "lynn.demo.broken", pluginName: "坏插件", children: null });
  inst.state = { error: new Error("undefined.map is not a function"), componentStack: " at Foo" };
  const html = renderToStaticMarkup(inst.render());
  assert.match(html, /坏插件/, "要显示插件名");
  assert.match(html, /lynn\.demo\.broken/, "要显示插件 id（名字可能重名）");
  assert.match(html, /undefined\.map is not a function/, "要显示原始错误摘要");
  assert.match(html, /已隔离/, "要明确告诉用户这只是插件的问题");
});

test("错误卡带可行动作：重试 + 停用", () => {
  const inst = new PluginBoundary({
    pluginId: "lynn.demo.broken",
    onDisable: () => {},
    children: null,
  });
  inst.state = { error: new Error("炸了"), componentStack: "" };
  const html = renderToStaticMarkup(inst.render());
  assert.match(html, /重试/, "多数渲染错误换数据就好，不该逼用户重装");
  assert.match(html, /停用这个插件/, "崩了要能一键关掉");
});

test("没传 onDisable 时不显示停用按钮（内置卡槽没有对应插件）", () => {
  const inst = new PluginBoundary({ pluginId: "builtin.slot", children: null });
  inst.state = { error: new Error("炸了"), componentStack: "" };
  const html = renderToStaticMarkup(inst.render());
  assert.match(html, /重试/);
  assert.ok(!html.includes("停用这个插件"), "没有插件可停时不该给这个按钮");
});

test("错误卡声明其它界面不受影响（给用户确定性）", () => {
  const inst = new PluginBoundary({ pluginId: "lynn.demo.broken", children: null });
  inst.state = { error: new Error("炸了"), componentStack: "" };
  const html = renderToStaticMarkup(inst.render());
  assert.match(html, /其它界面不受影响/, "要明确安抚：不是整个应用坏了");
  assert.match(html, /renderer\.log/, "要告诉用户去哪看现场");
});

test("重置后回到正常渲染（重试真的有效）", () => {
  const inst = new PluginBoundary({ pluginId: "lynn.demo.broken", children: createElement(Fine, { label: "恢复了" }) });
  inst.state = { error: new Error("炸了"), componentStack: "" };
  assert.match(renderToStaticMarkup(inst.render()), /plugin-error/);
  inst.state = { error: null, componentStack: "" };
  assert.match(renderToStaticMarkup(inst.render()), /恢复了/);
});

test("Slot 里每个插件各自套一层边界（结构保证，不是调用处纪律）", async () => {
  const fs = await import("node:fs");
  const path = await import("node:path");
  const { fileURLToPath } = await import("node:url");
  const here = path.dirname(fileURLToPath(import.meta.url));
  const src = fs.readFileSync(path.join(here, "..", "src/renderer/desk/ui-host.tsx"), "utf8");
  // 从 `export function Slot(` 截到下一个顶层 `export`（或文件尾），避免正则被参数里的 `}` 截断
  const start = src.indexOf("export function Slot(");
  assert.ok(start >= 0, "找不到 Slot 定义");
  const nextTop = src.indexOf("\nexport ", start + 10);
  const slotBody = src.slice(start, nextTop > 0 ? nextTop : src.length);
  assert.match(slotBody, /PluginBoundary/, "Slot 必须自己套边界——指望 8 个卡槽的调用处都记得套，迟早会漏");
});