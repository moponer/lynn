// 多阶段状态机逻辑层（本轮落地范围）：阶段进度由代码持有，压缩上下文抹不掉。
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_STAGE_DEFS,
  VALIDATION_NOTE,
  activateStage,
  blockStage,
  completeStage,
  createStagePlan,
  finalizeStagePlan,
  retryStage,
  shouldFinalize,
  skipStage,
  stagePlanProgress,
  validateStagePlan,
} from "../dist/main/stage-plan.js";

const NOW = "2026-11-11T10:00:00.000Z";
const fresh = () => createStagePlan("p1", "七阶段长任务", DEFAULT_STAGE_DEFS, NOW);

test("建计划：7 段齐备，只有首个无依赖阶段激活，结构自洽", () => {
  const p = fresh();
  assert.equal(p.stages.length, 7);
  assert.equal(validateStagePlan(p), null);
  assert.deepEqual(p.stages.filter((s) => s.status === "active").map((s) => s.id), ["premise"]);
  assert.equal(stagePlanProgress(p).percent, 0);
  assert.match(VALIDATION_NOTE, /验收表/);
});

test("证据闸：无证据不得判完成；不在执行中的阶段也不得判完成", () => {
  const p = fresh();
  assert.throws(() => completeStage(p, "premise", []), /没有证据/);
  assert.throws(() => completeStage(p, "analyze", ["随便一条"]), /不在执行中/);
});

test("依赖闸：前置没完成不能越级激活", () => {
  const p = fresh();
  assert.throws(() => activateStage(p, "write"), /前置还没完成/);
  assert.throws(() => activateStage(p, "final"), /前置还没完成/);
});

test("完成前提后并行分支同时激活，最终阶段要等四个分支都齐", () => {
  let p = completeStage(fresh(), "premise", ["前提已记录"], NOW);
  assert.deepEqual(stagePlanProgress(p).active.sort(), ["analyze", "negative"]);
  p = completeStage(p, "analyze", ["分析原文片段"], NOW);
  p = completeStage(p, "negative", ["真实错误原文"], NOW);
  assert.deepEqual(stagePlanProgress(p).active.sort(), ["parallel", "write"]);
  p = completeStage(p, "write", ["写入回执"], NOW);
  assert.deepEqual(stagePlanProgress(p).active.sort(), ["parallel", "readback"]);
  p = completeStage(p, "parallel", ["三个子任务回报"], NOW);
  p = completeStage(p, "readback", ["读回原文"], NOW);
  assert.deepEqual(stagePlanProgress(p).active, ["final"]);
});

test("走完 7 段才允许收尾，收尾只能发生一次", () => {
  let p = fresh();
  const order = ["premise", "analyze", "negative", "write", "parallel", "readback", "final"];
  for (const id of order) {
    assert.equal(shouldFinalize(p), false, `${id} 完成时还不该收尾`);
    p = completeStage(p, id, [`${id}-证据.txt`], NOW);
  }
  const progress = stagePlanProgress(p);
  assert.equal(progress.done, 7);
  assert.equal(progress.percent, 100);
  assert.equal(progress.next, null);
  assert.equal(shouldFinalize(p), true);
  const done = finalizeStagePlan(p, NOW);
  assert.equal(done.finalized, true);
  assert.equal(shouldFinalize(done), false);
  assert.throws(() => finalizeStagePlan(done, NOW), /不能生成最终验收表/);
  assert.equal(p.finalized, false, "原计划不可变");
});

test("受阻重做留在同一阶段：轮次 +1，不新建阶段、不新建工单", () => {
  let p = fresh();
  const before = p.stages.length;
  p = blockStage(p, "premise", "材料缺失", NOW);
  p = retryStage(p, "premise", "补齐材料", NOW);
  assert.equal(p.stages.length, before);
  assert.equal(p.stages[0].id, "premise");
  assert.equal(p.stages[0].round, 1);
  assert.equal(p.stages[0].status, "active");
  assert.deepEqual(p.stages[0].evidence, []);
  p = completeStage(p, "premise", ["补齐后的前提记录"], NOW);
  assert.equal(p.stages[0].status, "done");
  assert.equal(p.stages[0].evidence.length, 1);
});

test("跳过阶段必须写明原因，跳过后依赖它的阶段可继续", () => {
  const p = fresh();
  assert.throws(() => skipStage(p, "premise", ""), /写明原因/);
  const skipped = skipStage(p, "premise", "本次不需要记忆前提", NOW);
  assert.equal(skipped.stages[0].status, "skipped");
  assert.equal(stagePlanProgress(skipped).skipped, 1);
  assert.deepEqual(stagePlanProgress(skipped).active.sort(), ["analyze", "negative"]);
});

test("结构校验：重复 id / 前置不存在 / 依赖成环 / 收尾态不一致", () => {
  const dup = fresh();
  dup.stages[1].id = "premise";
  assert.match(validateStagePlan(dup), /重复/);

  const missing = fresh();
  missing.stages[1].dependsOn = ["nope"];
  assert.match(validateStagePlan(missing), /前置不存在/);

  assert.throws(
    () => createStagePlan("c", "环", [
      { id: "a", title: "A", acceptance: "x", dependsOn: ["b"] },
      { id: "b", title: "B", acceptance: "x", dependsOn: ["a"] },
    ], NOW),
    /成环/,
  );

  const badFinal = fresh();
  badFinal.finalized = true;
  assert.match(validateStagePlan(badFinal), /未结束阶段/);
});

test("序列化往返后状态与进度不丢（压缩/恢复上下文的底线）", () => {
  let p = fresh();
  p = completeStage(p, "premise", ["前提"], NOW);
  const restored = JSON.parse(JSON.stringify(p));
  assert.equal(validateStagePlan(restored), null);
  assert.deepEqual(stagePlanProgress(restored), stagePlanProgress(p));
});
