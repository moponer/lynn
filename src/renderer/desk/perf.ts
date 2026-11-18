/**
 * 前端性能度量（2026-11-17 P6-7 / 18 章 F6）。
 *
 * 为什么非要有这个：前面 P6-1/P6-2 我都只能标"派生侧已不再是热点"——因为
 * **`Long Task ≤2/分钟` 是浏览器指标**，Node 里量不出来。没有它，那两格永远是"大概好了"。
 *
 * 设计上的三个取舍：
 *  1. **采集与统计分开**：`LongTaskStats` 是纯函数（喂时间戳进去，出统计），所以能被单测；
 *     真正调 `PerformanceObserver` 的那层薄到不需要测（它只做转发）。
 *  2. **只在有 `PerformanceObserver` 时开**：Electron 里一定有，但组件测试的 SSR 环境里没有——
 *     没有就静默跳过，不许因为度量把界面搞挂。
 *  3. **不采样、不丢帧**：Long Task 本来就稀疏（>50ms 才记），丢一条就可能把"1 分钟 3 次"
 *     记成"1 分钟 2 次"，那正好是验收线上下。
 */

/** 一次 Long Task（>50ms 的主线程阻塞） */
export interface LongTaskEntry {
  /** 相对页面加载的毫秒数 */
  start: number;
  duration: number;
}

/** 验收线（18 章 §7）：长回复期间 ≤2 次/分钟 */
export const LONG_TASK_BUDGET_PER_MIN = 2;

/**
 * 滚动窗口统计。纯函数：给一串 Long Task 与"现在"，算最近 60 秒的次数。
 *
 * 为什么用滚动窗口而不是"每分钟清零"：清零法在边界上会漏——59 秒时 2 次、61 秒时 2 次，
 * 实际是 4 秒内 4 次，但两个桶都显示 2。滚动窗口才不会骗人。
 */
export function longTasksInLastMinute(entries: readonly LongTaskEntry[], now: number, windowMs = 60_000): LongTaskEntry[] {
  const from = now - windowMs;
  return entries.filter((e) => e.start + e.duration >= from);
}

export interface LongTaskStats {
  /** 最近 60 秒的条数 */
  perMinute: number;
  /** 窗口内最长的一次（ms） */
  worstMs: number;
  /** 累计条数（整个会话） */
  total: number;
  /** 是否在验收线内 */
  withinBudget: boolean;
}

export function longTaskStats(entries: readonly LongTaskEntry[], now: number): LongTaskStats {
  const recent = longTasksInLastMinute(entries, now);
  const worst = recent.reduce((m, e) => Math.max(m, e.duration), 0);
  return {
    perMinute: recent.length,
    worstMs: Math.round(worst),
    total: entries.length,
    withinBudget: recent.length <= LONG_TASK_BUDGET_PER_MIN,
  };
}

/**
 * 首屏耗时：从 `navigationStart` 到"第一帧有内容"。
 *
 * 用 `performance.now()` 的语义（相对 navigationStart），所以直接取 first-contentful-paint。
 * 拿不到（老内核/无 paint 条目）就返回 null——**返回 0 会假装很快**，那比没有更糟。
 */
export function firstContentfulPaint(entries: readonly { name: string; startTime: number }[]): number | null {
  const fcp = entries.find((e) => e.name === "first-contentful-paint");
  return fcp ? Math.round(fcp.startTime) : null;
}

/** 一帧掉帧判定：超过 16.7ms 的 2 倍算明显掉帧（50ms 与 Long Task 同阈值，便于对照） */
export const FRAME_DROP_MS = 34;

export interface FrameStats {
  /** 采样帧数 */
  frames: number;
  /** 明显掉帧数（>34ms） */
  dropped: number;
  /** 掉帧比例（0–1） */
  dropRate: number;
  /** p95 帧时长 */
  p95Ms: number;
}

export function frameStats(durations: readonly number[]): FrameStats {
  if (!durations.length) return { frames: 0, dropped: 0, dropRate: 0, p95Ms: 0 };
  const sorted = [...durations].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95));
  return {
    frames: durations.length,
    dropped: durations.filter((d) => d > FRAME_DROP_MS).length,
    dropRate: Math.round((durations.filter((d) => d > FRAME_DROP_MS).length / durations.length) * 1000) / 1000,
    p95Ms: Math.round(sorted[idx]),
  };
}

/**
 * 一行给人看的摘要（设置页用）。
 *
 * 刻意写成中文短句而不是 `perMinute=3`：设置页是给用户看的，
 * 他要的是"现在卡不卡"，不是一组裸指标。
 */
export function describePerf(input: { longTasks: LongTaskStats; fcpMs: number | null; frames?: FrameStats }): string {
  const parts: string[] = [];
  parts.push(
    input.longTasks.withinBudget
      ? `主线程：最近一分钟 ${input.longTasks.perMinute} 次长任务（≤${LONG_TASK_BUDGET_PER_MIN} 达标）`
      : `主线程：最近一分钟 ${input.longTasks.perMinute} 次长任务（超过 ${LONG_TASK_BUDGET_PER_MIN} 次，界面会卡顿）`,
  );
  if (input.longTasks.worstMs > 0) parts.push(`最长 ${input.longTasks.worstMs}ms`);
  parts.push(input.fcpMs === null ? "首屏：未采集到" : `首屏：${input.fcpMs}ms`);
  if (input.frames && input.frames.frames > 0) {
    parts.push(`掉帧 ${Math.round(input.frames.dropRate * 100)}%（p95 ${input.frames.p95Ms}ms）`);
  }
  return parts.join(" · ");
}