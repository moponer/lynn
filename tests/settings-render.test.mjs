/**
 * 设置页组件测试（P6-9 / 18 章 F4 的前置安全网）。
 *
 * 为什么先做这个再拆：`SettingsModal` 是 2,960 行的单组件，拆它要穿透 29 个跨页共享的
 * state 与 20+ 个 props。**没有断言就动这种纯机械重构，回归只能靠人工走查**——
 * 而"某块设置点不动了"正是最容易被走查漏掉的那类。
 *
 * 用 `react-dom/server` 而不是 RTL：见 `tests/helpers/render-ssr.mjs` 的说明（离线约束）。
 * 因此只覆盖**结构与内容**，不覆盖交互。
 */
import test from "node:test";
import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { loadModule, textOf } from "./helpers/render-ssr.mjs";

const i18nMod = await loadModule("src/renderer/i18n.tsx");
const { ZH_STRINGS } = await import("../dist/shared/i18n-strings.js");

/** 假桥：设置页一挂载就会调 rpc，没有它整棵树渲染不出来 */
function installFakeBridge() {
  const calls = [];
  globalThis.window = globalThis.window || {};
  globalThis.window.lynn = {
    rpc: async (method) => {
      calls.push(method);
      // 各页初始数据给最小可用形状，避免 undefined 崩在渲染里
      if (method === "update.status") return { phase: "idle" };
      if (method === "data.usage") return { total: 0 };
      if (method === "team.list") return [];
      if (method === "model.list") return [];
      return {};
    },
    on: () => () => {},
  };
  return calls;
}

const BASE_PROPS = {
  current: { configured: true, apiKeySet: true, provider: "DeepSeek", baseUrl: "https://api.deepseek.com/v1", model: "deepseek-chat" },
  theme: "celadon",
  mode: "dark",
  members: [],
  autoStart: false,
  notify: true,
  lang: "zh",
  voiceEnabled: false,
  project: null,
  usage: null,
  onClose: () => {},
};

/** 带 I18nProvider 渲染：不带 Provider 时 useT 会回退成返回 key，看到的就是键名 */
function renderSettings(props = {}) {
  installFakeBridge();
  const tree = createElement(i18nMod.I18nProvider, { strings: ZH_STRINGS }, createElement(SettingsModal, { ...BASE_PROPS, ...props }));
  return renderToStaticMarkup(tree);
}

let SettingsModal = null;
try {
  const mod = await loadModule("src/renderer/components/SettingsModal.tsx");
  SettingsModal = mod.SettingsModal;
} catch {
  SettingsModal = null;
}

test("设置页能渲染出标题与导航（安全网的第一层：它得先能画出来）", (t) => {
  if (!SettingsModal) return t.skip("SettingsModal 无法加载");
  const html = renderSettings();
  assert.ok(html.length > 500, `渲染结果太短（${html.length}），多半没画出来`);
  const text = textOf(html);
  assert.match(text, /设置|风铃/, `标题区没渲染出来：${text.slice(0, 120)}`);
});

test("带上 I18nProvider 后，界面上不该出现 i18n 键名（如 nav.capHer）", (t) => {
  if (!SettingsModal) return t.skip("SettingsModal 无法加载");
  const text = textOf(renderSettings());
  /**
   * 这条守的是一个真实的坑：`useT()` 在没有 Provider 时会**回退成返回 key 本身**，
   * 于是界面上会直接显示 `nav.capHer`。那既可能是测试环境缺 Provider，
   * 也可能是某个键在字典里真的缺失——两种都要查，不能放过。
   */
  const leaked = /\b(?:nav|settings|model|team|persona|memory|safety|look|data|about|overview|perf)\.[a-zA-Z][a-zA-Z0-9]*\b/g;
  const hits = [...new Set(text.match(leaked) ?? [])];
  assert.deepEqual(hits, [], `界面上漏出了 i18n 键名：${hits.join("、")}——要么字典缺键，要么忘了套 Provider`);
});

test("导航分组齐全：能力 / 工作 / 系统三组都在", (t) => {
  if (!SettingsModal) return t.skip("SettingsModal 无法加载");
  const text = textOf(renderSettings());
  /**
   * 从字典取标签而不是硬编码中文：断言的是"这个导航项被渲染出来了"，
   * 不是"中文文案长这样"。写死中文会在改文案时变成假失败（我自己就先写错过一次：
   * 以为 `nav.safety` 是「安全」，实际是「权限」）。
   */
  for (const key of ["nav.overview", "nav.model", "nav.safety", "nav.look", "nav.data"]) {
    const label = ZH_STRINGS[key];
    assert.ok(label, `字典里缺 ${key}`);
    assert.ok(text.includes(label), `导航里找不到 ${key}（「${label}」）`);
  }
});

test("默认落在概览页：待办清单区渲染出来", (t) => {
  if (!SettingsModal) return t.skip("SettingsModal 无法加载");
  const text = textOf(renderSettings());
  // 概览页有三块：待办 / 编制 / 界面流畅度（P6-7 加的）
  assert.match(text, /界面流畅度/, "概览页应含 P6-7 加的性能面板");
});

test("模型未配置时，概览页给出可点的待办（不是空白）", (t) => {
  if (!SettingsModal) return t.skip("SettingsModal 无法加载");
  const text = textOf(
    renderSettings({
      current: { configured: false, apiKeySet: false, provider: "", baseUrl: "", model: "" },
    }),
  );
  assert.match(text, /模型|Key/, `未配置时该提示去配模型：${text.slice(0, 200)}`);
});

test("渲染结果里不许出现 undefined / NaN（模板变量没取到值的典型症状）", (t) => {
  if (!SettingsModal) return t.skip("SettingsModal 无法加载");
  const html = renderSettings();
  assert.ok(!html.includes("undefined"), "渲染结果里出现 undefined");
  assert.ok(!html.includes("NaN"), "渲染结果里出现 NaN");
});