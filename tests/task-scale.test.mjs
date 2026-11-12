// 任务规模与证据策略（纯函数）：小任务小配置，证据只对关键任务强制。
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  estimateTaskScale,
  requiresEvidence,
  resolveEvidencePolicy,
  scaleLimits,
} from "../dist/main/task-scale.js";

const SMALL = "【目标】整理 9 月订单周报\n【完成标准】产出周报，数字与源表一致\n【材料与位置】工作区 orders.csv\n【限制】只做 9 月";
const LARGE = `【目标】完成端到端仓库审计\n${"【完成标准】逐阶段可核对；".repeat(90)}\n【限制】只读`;

test("小任务：简报短、验收项少 → small + 8 轮 / 120K / 建议 1 人", () => {
  assert.equal(estimateTaskScale(SMALL, ["数字一致", "结论可核对"]), "small");
  const l = scaleLimits("small");
  assert.equal(l.maxTurns, 8);
  assert.equal(l.budgetTokens, 120_000);
  assert.equal(l.suggestMembers, 1);
});

test("多阶段信号 / 长简报 / 验收项多 → large", () => {
  assert.equal(estimateTaskScale("【目标】分阶段并行推进整条流水线", []), "large");
  assert.equal(estimateTaskScale(LARGE, []), "large");
  assert.equal(estimateTaskScale("中等长度的简报".repeat(30), ["a", "b", "c", "d"]), "large");
  assert.equal(scaleLimits("large").maxTurns, 18);
});

test("常规任务 → medium（12 轮 / 200K）", () => {
  assert.equal(estimateTaskScale("x".repeat(600), ["a"]), "medium");
  assert.equal(scaleLimits("medium").maxTurns, 12);
  assert.equal(scaleLimits("medium").budgetTokens, 200_000);
});

test("关键任务信号强制证据：审计/对账/安全/可复跑", () => {
  assert.equal(requiresEvidence("【目标】做一次权限审计", []), true);
  assert.equal(requiresEvidence("【目标】把两份账对账", []), true);
  assert.equal(requiresEvidence("【目标】安全基线核查", []), true);
  assert.equal(requiresEvidence("【目标】整理周报", ["结论可复跑"]), true);
  assert.equal(requiresEvidence(SMALL, ["数字一致", "可核对"]), false);
});

test("显式 evidencePolicy 优先于自动判定", () => {
  assert.equal(resolveEvidencePolicy(SMALL, [], "required"), "required");
  assert.equal(resolveEvidencePolicy("审计与合规检查", [], "optional"), "optional");
  assert.equal(resolveEvidencePolicy(SMALL, []), "optional");
});
