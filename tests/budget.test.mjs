// M2-11：成本记账 + 软上限降级 —— 预算判定/按次落盘/降级决策不静默停机
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { evaluateBudget, appendUsage, readUsage, pickModel } from "../dist/main/budget.js";
import { Kernel } from "../dist/main/kernel.js";

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "lynn-bud-"));

test("预算判定：未配置=none（不做假保护）；达限=soft", () => {
  assert.deepEqual(evaluateBudget(1000, 0), { mode: "none", ratio: 0 }, "未设预算如实 none");
  assert.equal(evaluateBudget(700, 1000).mode, "normal");
  assert.equal(evaluateBudget(1000, 1000).mode, "soft");
  assert.equal(evaluateBudget(1500, 1000).mode, "soft");
});

test("记账：append/read 往返；坏文件不炸", () => {
  const root = tmp();
  appendUsage(root, { at: "t1", kind: "turn", in: 100, out: 50, model: "deepseek-chat" });
  appendUsage(root, { at: "t2", kind: "turn", in: 200, out: 80, model: "glm-4-flash", fallback: true });
  const lines = readUsage(root);
  assert.equal(lines.length, 2);
  assert.equal(lines[1].fallback, true);
  assert.equal(readUsage(path.join(root, "nope")).length, 0, "没记录返回空不炸");
});

test("降级决策：有备用就切并说明；没备用如实说继续用（不静默停机）", () => {
  const cfg = { model: "deepseek-chat" };
  const withFb = pickModel(cfg, "deepseek-chat-lite", "soft");
  assert.equal(withFb.model, "deepseek-chat-lite");
  assert.equal(withFb.fallback, true);
  assert.ok(withFb.note.includes("不静默停机"));

  const noFb = pickModel(cfg, "", "soft");
  assert.equal(noFb.model, "deepseek-chat", "没备用继续用当前");
  assert.ok(noFb.note.includes("未配置备用模型"), "如实说明");

  assert.equal(pickModel(cfg, "lite", "normal").model, "deepseek-chat", "未达限不切");
  assert.equal(pickModel(cfg, "deepseek-chat", "soft").model, "deepseek-chat", "备用与当前相同不切");
});

test("Kernel：达软限落提示卡（一次）；prefs 可配置预算", async () => {
  const root = tmp();
  const kernel = new Kernel(root);
  try {
    await kernel.init();
    const cards = [];
    kernel.onEvent((ev) => {
      if (ev.type === "card") cards.push(ev.card);
    });

    // 配置预算并模拟已用超限
    const saved = kernel.handle("config.prefs", { autoStart: false, softBudgetTokens: 1000, fallbackModel: "" });
    assert.equal(saved.softBudgetTokens, 1000);
    kernel.usage.sessionIn = 1500;
    kernel.checkBudget();
    assert.ok(cards.some((c) => c.title?.includes("预算")), "达限落卡");
    const n = cards.length;
    kernel.checkBudget();
    assert.equal(cards.length, n, "不重复刷屏");

    // 按次记账落盘
    kernel.handle("session.new", {});
    assert.ok(fs.existsSync(path.join(root, "logs")), "logs 目录就绪");
  } finally {
    await kernel.dispose();
  }
});
