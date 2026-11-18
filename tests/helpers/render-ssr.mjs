/**
 * 组件渲染工具（P6-5 / 18 章 F5）。
 *
 * **为什么不用 RTL**：`@testing-library/react` 与 `jsdom` 都不在依赖里，而本项目的硬约束是
 * 「完全本地 / 离线可用」——这台机器连 npm registry 都不通，装不了。
 * 但「装不了 RTL」不等于「不能测组件」：`react-dom/server` 是 `react-dom` 的子路径（已在依赖里），
 * 可以把组件真实渲染成 HTML 再断言。代价是拿不到事件模拟与 DOM 生命周期，
 * 所以这组测试**只断言结构与内容**，不断言交互——交互那部分如实标"未覆盖"，不假装测了。
 *
 * 渲染时需要把浏览器 API 打个最小的桩：`FeedScroller` 用 ResizeObserver/MutationObserver，
 * 模块加载期可能碰到 window。桩只做到"不炸"，不模拟行为——所以它测不出滚动逻辑。
 */
import { createJiti } from "jiti";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "../..");

const jiti = createJiti(import.meta.url, { jsx: { runtime: "automatic" } });

/** 浏览器 API 的最小桩：只为让模块加载与首渲染不炸，不模拟任何行为 */
export function installBrowserStubs() {
  const g = globalThis;
  const noop = () => {};
  const observer = class {
    observe() {}
    unobserve() {}
    disconnect() {}
    takeRecords() {
      return [];
    }
  };
  g.ResizeObserver ??= observer;
  g.MutationObserver ??= observer;
  g.IntersectionObserver ??= observer;
  g.requestAnimationFrame ??= (cb) => setTimeout(cb, 0);
  g.cancelAnimationFrame ??= (id) => clearTimeout(id);
  if (!g.window) {
    g.window = {
      addEventListener: noop,
      removeEventListener: noop,
      dispatchEvent: () => true,
      matchMedia: () => ({ matches: false, addEventListener: noop, removeEventListener: noop, addListener: noop, removeListener: noop }),
      localStorage: { getItem: () => null, setItem: noop, removeItem: noop },
    };
  }
  if (!g.document) {
    g.document = {
      querySelector: () => null,
      querySelectorAll: () => [],
      addEventListener: noop,
      removeEventListener: noop,
      documentElement: { style: { setProperty: noop }, classList: { add: noop, remove: noop } },
      body: { classList: { add: noop, remove: noop } },
      createElement: () => ({ style: {}, setAttribute: noop, appendChild: noop }),
    };
  }
  // Node 22+ 自带一个"需要 --localstorage-file 才能用"的 localStorage：**读它本身就会告警**。
  // 所以不能用 `if (!g.localStorage)` 探测（那会触发 getter），只能看属性描述符。
  const desc = Object.getOwnPropertyDescriptor(g, "localStorage");
  const usable = desc && "value" in desc && desc.value && typeof desc.value.getItem === "function";
  if (!usable) {
    const mem = new Map();
    Object.defineProperty(g, "localStorage", {
      configurable: true,
      writable: true,
      value: {
        getItem: (k) => (mem.has(k) ? mem.get(k) : null),
        setItem: (k, v) => mem.set(k, String(v)),
        removeItem: (k) => mem.delete(k),
        clear: () => mem.clear(),
      },
    });
  }
  if (!g.window.localStorage) g.window.localStorage = g.localStorage;
}

/** 加载一个 TSX/TS 模块（路径相对**仓库根**，如 "src/renderer/desk/Feed.tsx"） */
export async function loadModule(rel) {
  installBrowserStubs();
  return jiti.import(path.join(REPO, rel), { default: true });
}

/** 把组件渲染成 HTML 字符串 */
export function render(Component, props = {}) {
  installBrowserStubs();
  return renderToStaticMarkup(createElement(Component, props));
}

/** 数 HTML 里某段文本出现几次（断言"重复渲染"这类问题时比 includes 准） */
export function countOf(html, needle) {
  if (!needle) return 0;
  return html.split(needle).length - 1;
}

/** 去掉标签只留文本：断言"用户看得到什么"时比在 HTML 里匹配更可靠（不会被属性里的字命中） */
export function textOf(html) {
  return html
    .replace(/<script[\s\S]*?<\/script>/g, "")
    .replace(/<style[\s\S]*?<\/style>/g, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#x27;|&#39;/g, "'")
    .replace(/\s+/g, " ")
    .trim();
}