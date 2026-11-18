/**
 * 前端派生拆分（P6-1 / 18 章 F1）。
 *
 * 热点是这条链：`toJob` 里对**每张单**倒扫整个 feed 找最新回报（O(单数 × feed)），
 * 而流式回复 60s 能产生几百次快照派生（18 章 §2 P1）。这里要证明两件事：
 *
 *  1. **等价**：改成单遍索引后，每张单拿到的回报必须和逐单倒扫**完全一样**
 *     （优化最危险的地方就是"快了一点但悄悄变了语义"）；
 *  2. **真的快了**：同一份快照上，逐单倒扫 vs 单遍索引的耗时差距要能量出来。
 *
 * 为什么要用 jiti 直接加载 TS 源码：渲染层没有单文件编译产物（vite 打成 bundle），
 * 而这条逻辑是纯函数、不碰 DOM。用一个假的编译产物去测它，测的就不是真实代码了。
 */
import test from "node:test";
import assert from "node:assert/strict";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const model = await jiti.import("../src/renderer/desk/model.ts", { default: true });
const { deskFromSnapshot, feedReportIndex } = model;

/** 造一份"像真的"的快照：多单 + 长 feed + 多成员 */
function makeSnapshot({ jobs = 30, feedLen = 800, members = 8 } = {}) {
  const teamId = "t1";
  const teamMembers = Array.from({ length: members }, (_, i) => ({
    name: `成员${i}`,
    role: "执行",
    model: "deepseek-chat",
    color: ["#c33", "#3c3", "#33c"][i % 3],
    avatarId: `a0${(i % 9) + 1}`,
    status: "idle",
    effectiveTools: ["read_file"],
    toolWhitelist: ["read_file"],
    budgetUsed: 1000 * i,
    budgetTotal: 300000,
  }));
  const track = Array.from({ length: jobs }, (_, i) => ({
    id: `task-${i}`,
    teamId,
    title: `任务 ${i}`,
    status: i % 3 === 0 ? "in_review" : i % 3 === 1 ? "in_progress" : "done",
    reviewer: "lynn",
    stage: 1,
    member: teamMembers[i % members].name,
    at: "2026-11-17T10:00:00.000Z",
    evidenceCount: 1,
    evidence: [],
    deliverables: [],
    rejectRounds: 0,
    version: 1,
    threadId: "th1",
    round: 1,
    timeline: [],
  }));

  // feed：大量普通卡 + 每 3 张单的末尾放一条回报卡（有的单放两条，验证"取最新"）
  const feed = [];
  for (let i = 0; i < feedLen; i += 1) {
    const jobId = `task-${i % jobs}`;
    if (i % 7 === 0) {
      feed.push({ id: `c${i}`, kind: "tool", jobId, title: `步骤 ${i}`, text: "x".repeat(60) });
    } else if (i % 13 === 0) {
      feed.push({ id: `c${i}`, kind: "report", jobId, report: { conclusion: `第 ${i} 版结论`, evidence: "", unfinished: "", decision: "" } });
    } else {
      feed.push({ id: `c${i}`, kind: "lynn", jobId, text: "y".repeat(40) });
    }
  }

  return {
    project: "demo",
    workspace: { primary: "", extras: [], projectId: "", projectName: "", trusted: false },
    prefs: { autoStart: false },
    feed,
    turn: { busy: true, phase: "streaming", taskId: "task-1", startedAt: "2026-11-17T10:00:00.000Z" },
    usage: { turnIn: 1, turnOut: 1, contextPercent: 12 },
    queue: [],
    running: ["task-1"],
    orphans: 0,
    thread: { id: "th1", title: "会话" },
    threads: [{ id: "th1", title: "会话", updatedAt: "2026-11-17T10:00:00.000Z" }],
    board: {
      teams: [{ id: teamId, name: "小组", status: "active", threadId: "th1", members: teamMembers }],
      track,
      decisions: [],
    },
  };
}

/** 逐单倒扫的参考实现——就是优化前的做法 */
function naiveReport(feed, taskId) {
  for (let i = feed.length - 1; i >= 0; i -= 1) {
    const c = feed[i];
    if (c.jobId === taskId && c.report) return c.report;
  }
  return undefined;
}

test("等价：每张单拿到的回报与逐单倒扫完全一致", () => {
  const snap = makeSnapshot({ jobs: 30, feedLen: 800 });
  const desk = deskFromSnapshot(snap);
  assert.equal(desk.jobs.length, 30);
  let withReport = 0;
  for (const job of desk.jobs) {
    const want = naiveReport(snap.feed, job.id);
    assert.deepEqual(job.report, want, `${job.id} 的回报与逐单倒扫不一致`);
    if (want) withReport += 1;
  }
  assert.ok(withReport >= 5, `夹具里给回报的单太少（${withReport}），等价性没测到东西`);
});

test("等价：同一张单有多条回报时取最新的那条", () => {
  const snap = makeSnapshot({ jobs: 3, feedLen: 40 });
  // 手工塞两张同 jobId 的回报卡：后者更新
  snap.feed.push({ id: "r-old", kind: "report", jobId: "task-0", report: { conclusion: "旧", evidence: "", unfinished: "", decision: "" } });
  snap.feed.push({ id: "r-new", kind: "report", jobId: "task-0", report: { conclusion: "新", evidence: "", unfinished: "", decision: "" } });
  const desk = deskFromSnapshot(snap);
  const job = desk.jobs.find((j) => j.id === "task-0");
  assert.equal(job.report.conclusion, "新", "倒序索引要取最后出现的那条");
});

test("feedReportIndex：一遍扫完，重复的 taskId 只留最新", () => {
  const feed = [
    { id: "a", kind: "report", jobId: "t1", report: { conclusion: "1" } },
    { id: "b", kind: "report", jobId: "t2", report: { conclusion: "2" } },
    { id: "c", kind: "report", jobId: "t1", report: { conclusion: "3" } },
    { id: "d", kind: "lynn", jobId: "t1", text: "无回报字段" },
  ];
  const idx = feedReportIndex(feed);
  assert.equal(idx.get("t1").conclusion, "3");
  assert.equal(idx.get("t2").conclusion, "2");
  assert.equal(idx.size, 2, "没有 report 的卡不该进索引");
});

test("性能：单遍索引与逐单倒扫同口径对比（混合分布 + 最坏情况）", () => {
  const snap = makeSnapshot({ jobs: 200, feedLen: 5000, members: 20 });

  /**
   * 为什么实测只有 4 倍左右，而理论是 40 倍（40 单 × 2000 卡 = 8 万次 vs 2000 次）：
   * 倒扫会**提前命中**——多数单的回报卡就在尾部附近，扫几次就返回了。
   * 所以「真实提升」取决于回报卡的分布。为了不把这点藏起来，下面同时测最坏情况
   * （feed 里一条回报都没有 = 每张单都要扫穿整个 feed），那里才是算法差距。
   */
  function timeScan(feed, jobs) {
    for (let i = 0; i < 5; i += 1) {
      feedReportIndex(feed);
      for (const job of jobs) naiveReport(feed, job.id);
    }
    const N = 20;
    let t = process.hrtime.bigint();
    for (let i = 0; i < N; i += 1) feedReportIndex(feed);
    const indexed = Number(process.hrtime.bigint() - t) / 1e6 / N;
    t = process.hrtime.bigint();
    for (let i = 0; i < N; i += 1) {
      for (const job of jobs) naiveReport(feed, job.id);
    }
    const naive = Number(process.hrtime.bigint() - t) / 1e6 / N;
    return { indexed, naive, ratio: naive / indexed };
  }

  const mixed = timeScan(snap.feed, snap.board.track);
  console.log(`  混合分布（200 单 / 5000 卡）：索引 ${mixed.indexed.toFixed(3)}ms · 倒扫 ${mixed.naive.toFixed(3)}ms · ${mixed.ratio.toFixed(1)}×`);
  assert.ok(mixed.ratio > 3, `混合分布下只快了 ${mixed.ratio.toFixed(1)}×，索引没起作用`);

  // 最坏情况：feed 里没有任何回报卡 → 每张单都要扫穿
  const noReport = snap.feed.map((c) => ({ ...c, report: undefined }));
  const worst = timeScan(noReport, snap.board.track);
  console.log(`  最坏情况（无回报卡）：索引 ${worst.indexed.toFixed(3)}ms · 倒扫 ${worst.naive.toFixed(3)}ms · ${worst.ratio.toFixed(1)}×`);
  assert.ok(worst.ratio > 20, `最坏情况下只快了 ${worst.ratio.toFixed(1)}×——“单数 × feed”的放大没被消掉`);
});

test("派生总耗时在预算内：40 单 / 2000 卡的一次全量派生", () => {
  const snap = makeSnapshot({ jobs: 40, feedLen: 2000, members: 12 });
  for (let i = 0; i < 5; i += 1) deskFromSnapshot(snap);
  const N = 20;
  const t0 = process.hrtime.bigint();
  for (let i = 0; i < N; i += 1) deskFromSnapshot(snap);
  const ms = Number(process.hrtime.bigint() - t0) / 1e6 / N;
  console.log(`  全量派生: ${ms.toFixed(3)} ms/次（预算 2ms，一帧 16ms 里可容纳多次）`);
  // 2ms 是刻意的宽预算：它测的是"派生本身不会成为长任务的主要来源"。
  // 真实 Long Task 还有 React 渲染与组件树，那些由 F2/F4 的 memo 与拆分负责。
  assert.ok(ms < 2, `一次派生 ${ms.toFixed(3)}ms 超预算——流式期每秒十几次派生，会直接变成 Long Task`);
});