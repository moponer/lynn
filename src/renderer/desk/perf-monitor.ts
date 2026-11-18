/**
 * 性能采集的浏览器侧薄层（P6-7 / 18 章 F6）。
 *
 * 这一层刻意写得很薄：它只做「向浏览器要数据 → 存进数组」，统计全在 `perf.ts` 的纯函数里。
 * 好处是**真正需要正确性的部分（统计口径）能被单测**，而这里就算写错也只是"少采了几条"。
 *
 * 三条纪律：
 *  1. 没有 `PerformanceObserver` 就整个跳过（SSR/测试环境没有，不许因此报错）；
 *  2. 观察者只挂一次（React 严格模式会双跑 effect，重复挂会双计数）；
 *  3. 数组有上限：长会话跑几小时后不能一直涨。
 */
import { useEffect, useState } from "react";
import { firstContentfulPaint, longTaskStats, type LongTaskEntry, type LongTaskStats } from "./perf";

/** 最多留多少条（一条 50ms+ 的任务，2000 条足够覆盖几十小时的异常段） */
const MAX_ENTRIES = 2000;

interface PerfStore {
  longTasks: LongTaskEntry[];
  fcpMs: number | null;
  started: boolean;
}

const store: PerfStore = { longTasks: [], fcpMs: null, started: false };

/** 订阅者（设置页打开时才有人订阅） */
const listeners = new Set<() => void>();
function notify(): void {
  for (const fn of listeners) fn();
}

/**
 * 开始采集（幂等）。在 App 启动时调一次即可。
 */
export function startPerfMonitor(): void {
  if (store.started) return;
  if (typeof window === "undefined" || typeof PerformanceObserver === "undefined") return;
  store.started = true;

  try {
    // Long Task：>50ms 的主线程阻塞，正是 18 章 §7 的验收口径
    const obs = new PerformanceObserver((list) => {
      for (const e of list.getEntries()) {
        store.longTasks.push({ start: Math.round(e.startTime), duration: Math.round(e.duration) });
      }
      if (store.longTasks.length > MAX_ENTRIES) store.longTasks.splice(0, store.longTasks.length - MAX_ENTRIES);
      notify();
    });
    obs.observe({ entryTypes: ["longtask"] });
  } catch {
    /* 内核不支持 longtask：不采就是了，不报错 */
  }

  try {
    // 首屏：paint 条目是一次性的，取到就记下
    const paint = new PerformanceObserver((list) => {
      const fcp = firstContentfulPaint(list.getEntries().map((e) => ({ name: e.name, startTime: e.startTime })));
      if (fcp !== null && store.fcpMs === null) {
        store.fcpMs = fcp;
        notify();
      }
    });
    paint.observe({ entryTypes: ["paint"] });
    // 有些环境 paint 条目在 observer 挂上之前就产生了：补读一次
    if (store.fcpMs === null && typeof performance.getEntriesByType === "function") {
      const fcp = firstContentfulPaint(
        performance.getEntriesByType("paint").map((e) => ({ name: e.name, startTime: e.startTime })),
      );
      if (fcp !== null) store.fcpMs = fcp;
    }
  } catch {
    /* 同上 */
  }
}

/** 读当前统计（给设置页） */
export function readPerfStats(now = performance.now()): { longTasks: LongTaskStats; fcpMs: number | null } {
  return { longTasks: longTaskStats(store.longTasks, now), fcpMs: store.fcpMs };
}

/**
 * 设置页用的 hook：每秒刷一次。
 *
 * 为什么要定时刷而不是只在事件来时刷：`perMinute` 是**滚动窗口**，
 * 没有新事件时它也会随时间变小——不刷新就会一直显示旧数字。
 */
export function usePerfStats(): { longTasks: LongTaskStats; fcpMs: number | null } {
  const [snap, setSnap] = useState(() => readPerfStats());
  useEffect(() => {
    const tick = () => setSnap(readPerfStats());
    const unsub = () => listeners.delete(tick);
    listeners.add(tick);
    const timer = setInterval(tick, 1000);
    return () => {
      unsub();
      clearInterval(timer);
    };
  }, []);
  return snap;
}

/** 测试用：清空采集（避免用例之间互相污染） */
export function resetPerfMonitor(): void {
  store.longTasks.length = 0;
  store.fcpMs = null;
  store.started = false;
  listeners.clear();
}