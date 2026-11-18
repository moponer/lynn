/**
 * 性能度量（P6-7 / 18 章 F6）。
 *
 * 这块的价值在于**让「Long Task ≤2/分钟」从愿望变成可读的数字**——前面 P6-1/P6-2 我都只能标
 * "派生侧已不再是热点"，因为那是浏览器指标，Node 里量不出来。这里把**统计口径**抽成纯函数，
 * 于是口径本身能被断言（浏览器那一层只剩转发，写错也只是少采几条）。
 *
 * 重点断言三件事：
 *  1. **滚动窗口**而不是"每分钟清零"——清零法在边界上会骗人（59s 两次 + 61s 两次 = 4 秒 4 次，
 *     两个桶却都显示 2）；
 *  2. 拿不到首屏就返回 null，**不返回 0**（0 看起来像"很快"，比没有更糟）；
 *  3. 摘要文案要能读出"达没达标"，而不是只给一组裸指标。
 */
import test from "node:test";
import assert from "node:assert/strict";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const p = await jiti.import("../src/renderer/desk/perf.ts", { default: true });
const { longTaskStats, longTasksInLastMinute, firstContentfulPaint, frameStats, describePerf, LONG_TASK_BUDGET_PER_MIN, FRAME_DROP_MS } =
  p;

const task = (start, duration = 60) => ({ start, duration });

test("滚动窗口：只数最近 60 秒，而不是「当前这一分钟」", () => {
  const now = 100_000;
  const entries = [
    task(now - 90_000), // 窗口外
    task(now - 50_000), // 窗口内
    task(now - 10_000), // 窗口内
  ];
  assert.equal(longTasksInLastMinute(entries, now).length, 2);
  assert.equal(longTaskStats(entries, now).perMinute, 2);
});

test("滚动窗口不会在分钟边界上骗人（清零法的经典坑）", () => {
  // 场景：第 59 秒连发 2 次、第 61 秒又连发 2 次。
  // "每分钟清零"的桶会显示 2（新一分钟才 2 次）——但真实感受是"刚刚卡了 4 下"。
  // 滚动窗口数的是"最近 60 秒"，所以这里应当数到 4。
  const now = 61_000;
  const entries = [task(59_000), task(59_500), task(60_500), task(61_000)];
  const stats = longTaskStats(entries, now);
  assert.equal(stats.perMinute, 4, `最近 60 秒内 4 次全在窗口里，实际 ${stats.perMinute}`);
  assert.equal(stats.withinBudget, false, "4 次远超 2 次的上限");

  // 到第 121 秒：窗口是 61–121s，只剩 61.0s 那一条 → 自动回到达标
  const later = longTaskStats(entries, 121_000);
  assert.equal(later.perMinute, 1, "出窗的自动不再计入");
  assert.equal(later.withinBudget, true);
});

test("跨边界的任务算在窗口内：start 早但 duration 盖到窗口里", () => {
  const now = 100_000;
  const entries = [task(now - 60_500, 1000)]; // 起点在 60.5s 前，但结束在 59.5s 前
  assert.equal(longTasksInLastMinute(entries, now).length, 1, "还在跑的 Long Task 不该被算成出窗");
});

test("达标线：≤2 次/分钟算达标", () => {
  const now = 50_000;
  assert.equal(longTaskStats([task(now - 1000), task(now - 2000)], now).withinBudget, true);
  assert.equal(longTaskStats([task(now - 1000), task(now - 2000), task(now - 3000)], now).withinBudget, false);
  assert.equal(LONG_TASK_BUDGET_PER_MIN, 2, "验收线是 18 章 §7 定的 2 次/分钟");
});

test("最差值取窗口内最长的一次（出窗的不算）", () => {
  const now = 100_000;
  const stats = longTaskStats([task(now - 120_000, 900), task(now - 5000, 120), task(now - 9000, 70)], now);
  assert.equal(stats.worstMs, 120, "120ms 那条才是窗口内最长；900ms 那条已出窗");
});

test("首屏：拿不到就返回 null，绝不返回 0（0 看起来像「很快」）", () => {
  assert.equal(firstContentfulPaint([]), null);
  assert.equal(firstContentfulPaint([{ name: "first-paint", startTime: 120 }]), null, "只有 first-paint 不算");
  assert.equal(firstContentfulPaint([{ name: "first-contentful-paint", startTime: 342.7 }]), 343, "四舍五入到毫秒");
});

test("掉帧：>34ms 算明显掉帧，p95 取真实分位", () => {
  const frames = [16, 16, 17, 16, 40, 16, 16, 16, 16, 16, 16, 16, 16, 16, 16, 16, 16, 16, 16, 100];
  const s = frameStats(frames);
  assert.equal(s.frames, 20);
  assert.equal(s.dropped, 2, "40ms 与 100ms 两条超阈值");
  assert.equal(s.dropRate, 0.1);
  assert.ok(s.p95Ms >= 16 && s.p95Ms <= 100, `p95 应在合理区间，实际 ${s.p95Ms}`);
  assert.equal(FRAME_DROP_MS, 34);
});

test("掉帧：没有采样时不编数字", () => {
  const s = frameStats([]);
  assert.deepEqual(s, { frames: 0, dropped: 0, dropRate: 0, p95Ms: 0 });
});

test("摘要：达标与超线要能一眼读出来，缺数据要说「未采集到」", () => {
  const ok = describePerf({ longTasks: longTaskStats([task(1000)], 2000), fcpMs: 320 });
  assert.match(ok, /达标/);
  assert.match(ok, /320ms/);

  const bad = describePerf({ longTasks: longTaskStats([task(1000), task(2000), task(3000)], 4000), fcpMs: null });
  assert.match(bad, /超过/);
  assert.match(bad, /未采集到/, "没采到首屏就说没采到，不要写 0ms");

  const withFrames = describePerf({
    longTasks: longTaskStats([], 1000),
    fcpMs: 200,
    frames: frameStats([16, 16, 50]),
  });
  assert.match(withFrames, /掉帧 33%/);
});