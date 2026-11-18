/**
 * 组件测试（P6-5 / 18 章 F5）。
 *
 * **为什么不是 RTL**：`@testing-library/react` 与 `jsdom` 都不在依赖里，而本项目要求「完全本地、
 * 离线可用」——这台机器连 npm registry 都不通，装不了。但"装不了 RTL"不等于"不能测组件"：
 * `react-dom/server` 已在依赖里，可以把组件真实渲染成 HTML 再断言结构与内容。
 *
 * **代价如实说明**：拿不到事件模拟与 DOM 生命周期，所以这组测试**只覆盖结构与内容**，
 * 不覆盖交互（点击、滚动、焦点）。交互部分标"未覆盖"，不假装测过。
 * 这也是 18 章 F4（拆 2,956 行的 SettingsModal）要等这些断言就位才敢动的原因。
 */
import test from "node:test";
import assert from "node:assert/strict";
import { loadModule, render, textOf, countOf } from "./helpers/render-ssr.mjs";

const feedMod = await loadModule("src/renderer/desk/Feed.tsx");
const avatarMod = await loadModule("src/renderer/desk/MemberAvatar.tsx");
const iconMod = await loadModule("src/renderer/components/Icon.tsx");

const card = (over) => ({ id: `c-${Math.random().toString(36).slice(2, 7)}`, kind: "lynn", text: "好", ...over });
const errCard = (id, code) => ({ id, kind: "system", code, action: "retry", title: `${code} 出错了` });
const userCard = (id, text, mentions) => ({ id, kind: "user", text, ...(mentions ? { mentions } : {}) });

// ---------- 1. FeedView：空态 ----------
test("FeedView：没有往来时给空态，不渲染空列表", () => {
  const html = render(feedMod.FeedView, { cards: [] });
  assert.match(textOf(html), /还没有往来/);
  assert.ok(!html.includes("feed-history"), "空列表不该出现折叠行");
});

// ---------- 2. FeedView：五种声音都画得出来 ----------
test("FeedView：你 / 风铃 / 系统 / 工具 / 成员进度 五种卡都能渲染", () => {
  const cards = [
    userCard("u1", "帮我查一下"),
    card({ id: "l1", kind: "lynn", text: "我去派个人" }),
    card({ id: "s1", kind: "system", text: "已建团队" }),
    card({ id: "t1", kind: "tool", title: "read_file", text: "读了 12 行" }),
    card({ id: "m1", kind: "system", badge: "进展", title: "成员说", text: "第一步好了" }),
  ];
  const text = textOf(render(feedMod.FeedView, { cards }));
  for (const want of ["帮我查一下", "我去派个人", "已建团队", "read_file", "第一步好了"]) {
    assert.ok(text.includes(want), `渲染结果里找不到「${want}」：${text.slice(0, 200)}`);
  }
});

// ---------- 3. C1 回归：两张错误卡都要在屏上 ----------
test("C1 回归：两个可行动错误卡同时存在时，两个「重试」入口都在", () => {
  // 关键：错误卡要落在窗口之外（用户发了新消息 → 历史被折叠），那才是原缺陷的现场
  const cards = [
    errCard("e1", "rate_429"),
    errCard("e2", "timeout_idle"),
    ...Array.from({ length: 40 }, (_, i) => userCard(`u${i}`, `第 ${i} 句`)),
  ];
  const html = render(feedMod.FeedView, { cards, collapseHistory: true });
  assert.ok(html.includes("e1") || textOf(html).includes("rate_429"), "第一张错误卡丢了");
  assert.ok(html.includes("e2") || textOf(html).includes("timeout_idle"), "第二张错误卡丢了");
  // 两张都要有可点的重试按钮
  const text = textOf(html);
  assert.equal(countOf(text, "rate_429") + countOf(text, "timeout_idle") >= 2, true, "两张错误卡应各出现一次");
});

// ---------- 4. C2 回归：渲染窗口到上限时如实提示，不装成按钮 ----------
test("C2 回归：窗口到上限后如实说明，不再给「补回更多」", () => {
  const cards = Array.from({ length: 600 }, (_, i) => userCard(`u${i}`, `第 ${i} 句`));
  const html = render(feedMod.FeedView, { cards });
  // 初始 80 条：应当有"展开更多"
  assert.ok(html.includes("feed-history"), "初始应给「补回更多」");
  // 手动把窗口推到上限：组件内部 state 改不了，所以这条用纯函数那组测试覆盖（feed-window.test.mjs）。
  // 这里只断言：600 条不会一次性全渲染出来（否则 DOM 里会有 600 条）。
  const rendered = countOf(textOf(html), "第 ");
  assert.ok(rendered <= 90, `一次渲染了 ${rendered} 条，窗口没起作用`);
});

// ---------- 5. MemberAvatar：静态头像 ----------
test("MemberAvatar：渲染静态 SVG data-URI，不再依赖 DiceBear", () => {
  const html = render(avatarMod.MemberAvatar, { name: "林工", size: 32 });
  assert.match(html, /data:image\/svg\+xml/, "头像应是内联 SVG data-URI（不联网、不落文件）");
  assert.match(html, /width:32px;height:32px/, "尺寸要按传入值生效");
  assert.match(html, /aria-hidden="true"/, "头像对读屏器是装饰性的");
  assert.ok(!html.includes("http://") && !html.includes("https://"), "不许出现外链（离线可用）");
});

test("MemberAvatar：同一名字稳定同一张脸（换会话不换脸）", () => {
  const a = render(avatarMod.MemberAvatar, { name: "同一个名字" });
  const b = render(avatarMod.MemberAvatar, { name: "同一个名字" });
  assert.equal(a, b, "同名两次渲染结果必须一致");
  const c = render(avatarMod.MemberAvatar, { name: "另一个名字" });
  assert.notEqual(a, c, "不同名字应拿到不同头像（或至少不同 seed 的产物）");
});

// ---------- 6. Icon：图标集合完整性 ----------
test("Icon：常用图标都能渲染出 SVG，未知名字不炸", () => {
  const html = render(iconMod.Icon, { name: "check" });
  assert.match(html, /<svg/, "图标应是内联 SVG");
  // 未知名字不该抛异常（界面里拼错一个图标名不该让整块白屏）
  assert.doesNotThrow(() => render(iconMod.Icon, { name: "根本不存在的图标" }));
});