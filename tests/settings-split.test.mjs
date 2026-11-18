/**
 * 设置页拆分回归（P6-9 / 18 章 F4）。
 *
 * 拆 `SettingsModal` 是**纯机械重构**：只搬 JSX，不改文案、不改类名、不改结构。
 * 这类改动最怕的不是编译不过（TS 会拦），而是"渲染出来悄悄变了"——
 * 少一个 `sf-row` 类名、把 `<p>` 写成 `<li>`，界面上就是另一个样子，但没有任何东西会报错。
 *
 * 所以这里守两件事：
 *  1. **拆出去的页能独立渲染**，且内容完整（不依赖父组件的隐式上下文）；
 *  2. **设置页整体仍能渲染**（拆分后父组件没把某段弄丢）。
 *
 * 逐字节快照对比在提交时手工做过（before/after 两个 HTML 哈希相同），
 * 这里用"关键结构存在"的断言把它固化成可重复的检查。
 */
import test from "node:test";
import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { loadModule, textOf } from "./helpers/render-ssr.mjs";

const i18nMod = await loadModule("src/renderer/i18n.tsx");
const { ZH_STRINGS } = await import("../dist/shared/i18n-strings.js");

function withI18n(node) {
  return renderToStaticMarkup(createElement(i18nMod.I18nProvider, { strings: ZH_STRINGS }, node));
}

const aboutMod = await loadModule("src/renderer/components/settings/AboutPane.tsx");

test("AboutPane：能独立渲染（不依赖父组件的隐式上下文）", () => {
  const html = withI18n(createElement(aboutMod.AboutPane, { version: "0.0.2" }));
  assert.ok(html.length > 400, `渲染太短（${html.length}），多半没画出来`);
  const text = textOf(html);
  assert.match(text, /风铃|Lynn/, "关于页应含产品名");
});

test("AboutPane：版本号来自 props，不写死", () => {
  const a = withI18n(createElement(aboutMod.AboutPane, { version: "9.9.9" }));
  assert.match(textOf(a), /v9\.9\.9/, "传进来的版本号要显示出来");
  const b = withI18n(createElement(aboutMod.AboutPane, { version: undefined }));
  assert.ok(!textOf(b).includes("undefined"), "没版本号时不许印 undefined");
});

test("AboutPane：六块内容都在（方式/能力/隐私/限制/致谢）", () => {
  const text = textOf(withI18n(createElement(aboutMod.AboutPane, { version: "0.0.2" })));
  for (const key of ["about.wayTitle", "about.capTitle", "about.privacyTitle", "about.limitTitle", "about.creditTitle"]) {
    const label = ZH_STRINGS[key];
    assert.ok(label, `字典缺 ${key}`);
    assert.ok(text.includes(label), `缺少「${label}」这一块`);
  }
});

test("AboutPane：结构类名与拆分前一致（sf-about-k / sf-about-v / sf-about-line）", () => {
  const html = withI18n(createElement(aboutMod.AboutPane, { version: "0.0.2" }));
  // 这三个类名是版式的骨架：改了它们界面就变样，但不会有任何编译错误
  for (const cls of ["sf-about-head", "sf-about-k", "sf-about-v", "sf-about-line"]) {
    assert.ok(html.includes(cls), `缺少结构类名 ${cls}——版式会变`);
  }
  assert.ok(!html.includes("undefined"), "渲染结果里不许出现 undefined");
});

test("拆分后父组件仍能渲染设置页（没把某段弄丢）", async () => {
  globalThis.window = globalThis.window || {};
  globalThis.window.lynn = { rpc: async () => ({}), on: () => () => {} };
  const mod = await loadModule("src/renderer/components/SettingsModal.tsx");
  const html = withI18n(
    createElement(mod.SettingsModal, {
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
    }),
  );
  assert.ok(html.length > 1000, "设置页渲染太短");
  assert.ok(!html.includes("undefined"), "设置页渲染里出现 undefined");
});