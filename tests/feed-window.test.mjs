/**
 * 对话流渲染窗口（P6-2 / 18 章 F2 的 C1–C3、C5）。
 *
 * 这五条里有三条是**正确性缺陷**，不是性能：
 *   C1 两个可行动错误卡同时存在时会丢一个；
 *   C2 渲染窗口无上限（历史上限 = DOM 里挂着全部历史）；
 *   C3 分割点每帧从尾扫；
 *   C5 待答标记渲染内现算。
 * 抽成纯函数之后它们才有办法被断言——项目还没有 RTL，组件测试是 F5 的事。
 *
 * C4（展开历史打断贴底跟随）是交互行为，只能在浏览器里验，这里不假装覆盖它。
 */
import test from "node:test";
import assert from "node:assert/strict";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const w = await jiti.import("../src/renderer/desk/feed-window.ts", { default: true });
const { feedWindow, feedSplitIndex, feedAwaitingLynn, nextVisibleCount, FEED_PAGE_SIZE, FEED_MAX_VISIBLE, FEED_MAX_PINNED } = w;

const card = (over) => ({ id: `c${Math.random().toString(36).slice(2, 8)}`, kind: "lynn", text: "hi", ...over });
const errCard = (id, code) => ({ id, kind: "system", code, action: "retry", title: `${code} 出错了` });
const userCard = (id, mentions) => ({ id, kind: "user", text: "你好", ...(mentions ? { mentions } : {}) });

test("C1：两个可行动错误卡同时存在时，两张都要钉住（原来只钉最后一张）", () => {
  // 关键：错误卡要落在窗口**之外**才有"钉住"可言——窗口小时它们本来就可见。
  // 这正是原缺陷的现场：用户发了新消息、历史被折叠，两张错误卡一起被折走，只剩最后一张被捞回来。
  const cards = [errCard("e1", "rate_429"), errCard("e2", "timeout_idle"), ...Array.from({ length: 30 }, (_, i) => card({ id: `x${i}` }))];
  const win = feedWindow(cards, { visibleCount: 5 });
  const ids = win.pinned.map((c) => c.id);
  assert.deepEqual(ids, ["e1", "e2"], `钉住的应是两张，实际 ${JSON.stringify(ids)}`);
  assert.ok(win.visible.some((c) => c.id === "e1"), "第一张错误卡必须出现在渲染列表里");
  assert.ok(win.visible.some((c) => c.id === "e2"));
});

test("C1：钉住张数有上限，且有动作/有 code 才钉", () => {
  const cards = [
    errCard("e1", "a"),
    errCard("e2", "b"),
    errCard("e3", "c"),
    errCard("e4", "d"),
    { id: "no-action", kind: "system", code: "x", action: "none" },
    { id: "no-code", kind: "system", action: "retry" },
    ...Array.from({ length: 30 }, (_, i) => card({ id: `x${i}` })),
  ];
  const win = feedWindow(cards, { visibleCount: 5 });
  assert.equal(win.pinned.length, FEED_MAX_PINNED, `最多钉 ${FEED_MAX_PINNED} 张`);
  assert.deepEqual(
    win.pinned.map((c) => c.id),
    ["e2", "e3", "e4"],
    "取最近的几张；action=none 与没有 code 的卡不该钉",
  );
});

test("C1：已经被窗口收进去的错误卡不重复钉（否则同一条会渲染两次）", () => {
  const cards = [card({ id: "x1" }), errCard("e1", "a")];
  const win = feedWindow(cards, { visibleCount: 10 });
  assert.deepEqual(win.pinned, [], "e1 已经在 recent 里，不该再钉一遍");
  assert.equal(win.visible.filter((c) => c.id === "e1").length, 1);
});

test("C2：窗口到上限就不再涨，如实报 capped 与还能补多少", () => {
  const cards = Array.from({ length: 1000 }, (_, i) => card({ id: `c${i}` }));
  const win = feedWindow(cards, { visibleCount: FEED_MAX_VISIBLE });
  assert.equal(win.capped, true);
  assert.equal(win.moreAvailable, 0, "到上限后不该再给「补回更多」");
  assert.equal(win.visible.length, FEED_MAX_VISIBLE, "渲染条数要被上限夹住");

  const below = feedWindow(cards, { visibleCount: FEED_PAGE_SIZE });
  assert.equal(below.capped, false);
  assert.equal(below.moreAvailable, FEED_MAX_VISIBLE - FEED_PAGE_SIZE);
});

test("C2：nextVisibleCount 有上限，且一次只进一页", () => {
  assert.equal(nextVisibleCount(0), FEED_PAGE_SIZE);
  assert.equal(nextVisibleCount(FEED_PAGE_SIZE), FEED_PAGE_SIZE * 2);
  assert.equal(nextVisibleCount(FEED_MAX_VISIBLE - 10), FEED_MAX_VISIBLE, "最后一次只涨到上限");
  assert.equal(nextVisibleCount(FEED_MAX_VISIBLE), FEED_MAX_VISIBLE, "到顶后不变");
});

test("C3：分割点 = 最后一条「你」的消息；不折叠时为 -1", () => {
  const cards = [userCard("u1"), card({ id: "a" }), userCard("u2"), card({ id: "b" })];
  assert.equal(feedSplitIndex(cards, true), 2, "应是最后一条 user 的下标");
  assert.equal(feedSplitIndex(cards, false), -1);
  assert.equal(feedSplitIndex([card({ id: "a" })], true), -1, "一条 user 都没有就不该折叠");

  const win = feedWindow(cards, { collapseHistory: true, visibleCount: 10 });
  assert.equal(win.historyCount, 2, "折叠条数 = 分割点之前的条数");
  assert.deepEqual(win.base.map((c) => c.id), ["u2", "b"], "折叠后只显示分割点之后的");
  const shown = feedWindow(cards, { collapseHistory: true, showHistory: true, visibleCount: 10 });
  assert.equal(shown.base.length, 4, "展开历史后底座是全部");
});

test("C5：待风铃应答的判定——出错的卡不算回应", () => {
  const visible = [
    userCard("u1", [{ name: "林工" }]),
    { id: "bad", kind: "system", code: "x", text: "连接失败" },
    userCard("u2", [{ name: "林工" }]),
  ];
  const pending = feedAwaitingLynn(visible);
  assert.ok(pending.has("u2"), "最后一条 @ 之后没有任何回应，应待答");
  assert.ok(pending.has("u1"), "中间那张错误卡不算回应，所以 u1 也仍然待答——这正是原判定的语义");
});

test("C5：风铃说过话之后，之前的 @ 不再算待答", () => {
  const visible = [userCard("u1", [{ name: "林工" }]), card({ id: "l1", kind: "lynn", text: "收到，我去办" })];
  assert.equal(feedAwaitingLynn(visible).size, 0);
});

test("F4：窗口外已回应过的 @ 不该被误判待答（必须基于全量 cards）", () => {
  /**
   * 场景：用户 @ 了成员，风铃回过，但她的回应卡因为分页/折叠被切出可见窗口。
   * 若拿 visible 判定 → answered 永远 false → 那条 @ 一直挂"等风铃"红标。
   * 正确做法是拿全量 cards 判定（Feed 现在这么调）。
   */
  const all = [
    userCard("u1", [{ name: "林工" }]),
    card({ id: "l1", kind: "lynn", text: "收到，我去办" }),
    userCard("u2", [{ name: "林工" }]),
  ];
  // 全量判定：u1 已被 l1 回应，只剩 u2 待答
  const byAll = feedAwaitingLynn(all);
  assert.ok(!byAll.has("u1"), "u1 已有回应，不该待答");
  assert.ok(byAll.has("u2"), "u2 还没有回应，应待答");

  // 对照：只拿窗口（只剩 u2）判定——这正是修复前的错误输入
  const onlyVisible = [all[2]];
  const byVisible = feedAwaitingLynn(onlyVisible);
  assert.ok(byVisible.has("u2"));
  // 关键差异：窗口里丢了 l1，若窗口里还有 u1 就会误判。这里用"窗口含 u1 但不含 l1"复现：
  const partial = [all[0], all[2]];
  const byPartial = feedAwaitingLynn(partial);
  assert.ok(byPartial.has("u1"), "复现：窗口丢了回应卡时 u1 会被误判待答（这就是 F4 的 bug）");
});