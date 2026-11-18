/**
 * 对话流的渲染窗口（2026-11-17 P6-2 / 18 章 F2 的 C1/C2/C3/C5）。
 *
 * 为什么把这些从组件里抽出来：它们是**纯逻辑**，却住在 `FeedView` 的渲染体里，
 * 于是既没法单测（项目还没有 RTL），也没法 memo。抽成纯函数之后：
 *  - C1「两个错误同时存在会丢一个」——可以用用例直接钉住；
 *  - C2「visibleCount 无上限」——可以断言到顶就不再涨；
 *  - C3「每帧从尾扫」——现在只依赖 (cards, collapseHistory)，可记忆；
 *  - C5「awaitingLynn 渲染内算」——同样变成可记忆的纯函数。
 * 组件只负责把这些结果画出来。
 */

import type { FeedCard } from "../../shared/contract";

/** 一页补回多少条 */
export const FEED_PAGE_SIZE = 80;
/** 渲染窗口上限（C2）：到顶后不再加，防止 DOM 里挂着全部历史 */
export const FEED_MAX_VISIBLE = 400;
/** 最多钉几张可行动错误卡（C1）：原来只钉 1 张，两个错误同时存在时会丢一个 */
export const FEED_MAX_PINNED = 3;

/** 分割点 = 最后一条「你」的消息（C3：只依赖 cards 与开关，可记忆） */
export function feedSplitIndex(cards: readonly FeedCard[], collapseHistory: boolean | undefined): number {
  if (!collapseHistory) return -1;
  for (let i = cards.length - 1; i >= 0; i -= 1) {
    if (cards[i].kind === "user") return i;
  }
  return -1;
}

/** 群里被 @ 的消息是否还没人接（C5）：出错的卡不算回应 */
export function feedAwaitingLynn(visible: readonly FeedCard[]): Set<string> {
  const set = new Set<string>();
  let answered = false;
  for (let i = visible.length - 1; i >= 0; i -= 1) {
    const c = visible[i];
    if (c.code) continue;
    if (c.author?.kind === "lynn" || (c.kind === "lynn" && (c.text ?? "").trim())) {
      answered = true;
      continue;
    }
    if (c.kind === "user" && c.mentions?.length && !answered) set.add(c.id);
  }
  return set;
}

export interface FeedWindow {
  /** 折叠点（-1 = 不折叠） */
  split: number;
  /** 折叠起来的历史条数 */
  historyCount: number;
  /** 当前窗口的底座（折叠生效时是 cards 的后半段） */
  base: readonly FeedCard[];
  /** 窗口内最近 N 条 */
  recent: readonly FeedCard[];
  /** 钉在顶部的可行动错误卡（≤3，且不与 recent 重复） */
  pinned: readonly FeedCard[];
  /** 真正渲染的列表 = pinned + recent */
  visible: readonly FeedCard[];
  /** 渲染窗口是否已到上限（到了就不再加页） */
  capped: boolean;
  /** 还能再补多少条（到上限后为 0） */
  moreAvailable: number;
}

export interface FeedWindowOptions {
  collapseHistory?: boolean;
  showHistory?: boolean;
  visibleCount: number;
}

/**
 * 算一次窗口。纯函数：给定同样的输入永远同样的输出（因此可以被 memo / 单测）。
 */
export function feedWindow(cards: readonly FeedCard[], opts: FeedWindowOptions): FeedWindow {
  const split = feedSplitIndex(cards, opts.collapseHistory);
  const historyCount = split > 0 ? split : 0;
  const base =
    opts.collapseHistory && !opts.showHistory && split > 0 ? cards.slice(split) : cards;
  const capped = opts.visibleCount >= FEED_MAX_VISIBLE;
  const recent = base.slice(-Math.min(opts.visibleCount, FEED_MAX_VISIBLE));

  /**
   * C1：可行动的错误卡即使被折进「历史」也要留在屏上（用户刚发新消息，上一条 429/5xx 的
   * 重试入口不能凭空消失）。原来 `slice(-1)` 只留最后一张 —— 两个错误并存时**丢一个**。
   * 现在取最近 3 张，并且跳过已经在 recent 里的（不重复渲染）。
   */
  const recentIds = new Set(recent.map((c) => c.id));
  const pinned = cards
    .filter((c) => c.kind === "system" && Boolean(c.code) && Boolean(c.action) && c.action !== "none")
    .filter((c) => !recentIds.has(c.id))
    .slice(-FEED_MAX_PINNED);

  const visible = pinned.length ? [...pinned, ...recent] : recent;
  return {
    split,
    historyCount,
    base,
    recent,
    pinned,
    visible,
    capped,
    moreAvailable: Math.max(0, Math.min(base.length - opts.visibleCount, FEED_MAX_VISIBLE - opts.visibleCount)),
  };
}

/** 下一窗口的条数：有上限，到顶就不再涨（C2） */
export function nextVisibleCount(current: number): number {
  return Math.min(FEED_MAX_VISIBLE, current + FEED_PAGE_SIZE);
}