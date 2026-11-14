// 成员回报的核对清单（2026-11-14）：把「完成标准逐条过了吗」变成结构化表，
// 风铃验收先看这张表，而不是从一段自然语言里猜。
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { runMemberTask } from "../dist/main/member-runner.js";

const tmpWorkdir = () => fs.mkdtempSync(path.join(os.tmpdir(), "lynn-checks-"));

function profile(overrides = {}) {
  return {
    name: "林工",
    role: "数据整理员",
    goal: "把数据整理干净",
    boundaries: ["只动工作区"],
    tools: ["write_file"],
    model: "deepseek-chat",
    limits: { maxTurns: 6, budgetTokens: 300000, wallClockMin: 20 },
    outputContract: { deliverable: "report.md", evidence: ["报告文件"], acceptance: ["数字可对账", "口径统一"] },
    escalateWhen: "卡住",
    body: "",
    ...overrides,
  };
}

function scriptedChat(script) {
  let i = 0;
  return async (input) => {
    const step = script[Math.min(i++, script.length - 1)];
    input.messages.push({ role: "assistant", content: step.content ?? null, tool_calls: step.toolCalls ?? [] });
    for (const call of step.toolCalls ?? []) {
      input.messages.push({ role: "tool", tool_call_id: call.id, name: call.name, content: "（工具结果占位）" });
    }
    return { content: step.content ?? "", toolCalls: step.toolCalls ?? [], promptTokens: 10, completionTokens: 5 };
  };
}

const tc = (id, name, args) => ({ id, name, arguments: JSON.stringify(args) });
const run = (wd, chat) =>
  runMemberTask({
    profile: profile(),
    brief: "出月报",
    deadline: "周五",
    tools: ["write_file"],
    workdir: wd,
    model: { baseUrl: "http://x", apiKey: "k", model: "m" },
    chatFn: chat,
  });

test("checks 合法：回报正文里带核对清单，过与没过都如实写", async () => {
  const wd = tmpWorkdir();
  fs.writeFileSync(path.join(wd, "report.md"), "# 月报\nGMV 100.00");
  const chat = scriptedChat([
    {
      toolCalls: [
        tc("1", "submit_report", {
          text: "月报完成",
          evidence: ["report.md"],
          checks: [
            { name: "数字可对账", pass: true, evidence: "report.md 第 3 节" },
            { name: "口径统一", pass: false },
          ],
        }),
      ],
    },
  ]);
  const r = await run(wd, chat);
  assert.equal(r.status, "reported");
  assert.match(r.report, /核对清单/);
  assert.match(r.report, /\[过\] 数字可对账（report\.md 第 3 节）/);
  assert.match(r.report, /\[未过\] 口径统一/);
});

test("checks 形状错：这条回报整条拒收，改对之后照样能交", async () => {
  const wd = tmpWorkdir();
  fs.writeFileSync(path.join(wd, "a.txt"), "x");
  const chat = scriptedChat([
    { toolCalls: [tc("1", "submit_report", { text: "完成", evidence: ["a.txt"], checks: [{ name: "对账", pass: "yes" }] })] },
    { toolCalls: [tc("2", "submit_report", { text: "完成", evidence: ["a.txt"], checks: [{ name: "对账", pass: true }] })] },
  ]);
  const r = await run(wd, chat);
  assert.equal(r.status, "reported");
  assert.equal(r.turns, 2, "第一轮被拒，第二轮才成交");
  assert.match(r.report, /\[过\] 对账/);
});

test("checks 超过 20 条：拒收，让它只留关键的", async () => {
  const wd = tmpWorkdir();
  fs.writeFileSync(path.join(wd, "b.txt"), "x");
  const many = Array.from({ length: 21 }, (_, i) => ({ name: `第 ${i + 1} 条`, pass: true }));
  const chat = scriptedChat([
    { toolCalls: [tc("1", "submit_report", { text: "完成", evidence: ["b.txt"], checks: many })] },
    { toolCalls: [tc("2", "submit_report", { text: "完成", evidence: ["b.txt"] })] },
  ]);
  const r = await run(wd, chat);
  assert.equal(r.status, "reported");
  assert.equal(r.turns, 2);
  assert.ok(!r.report.includes("核对清单"), "不带 checks 时正文原样，不硬加空表");
});

test("骨架稿拦截：正文有占位符且没有交付物 → 拒收，补全后能交", async () => {
  const wd = tmpWorkdir();
  const chat = scriptedChat([
    { toolCalls: [tc("1", "submit_report", { text: "# 月报\n## 结论\nTODO\n## 明细\n待补充", evidence: [] })] },
    { toolCalls: [tc("2", "write_file", { path: "report.md", content: "# 月报\n结论：GMV 100\n明细：表格" })] },
    { toolCalls: [tc("3", "submit_report", { text: "月报完成（正文略）", evidence: ["report.md"], deliverables: ["report.md"] })] },
  ]);
  const r = await run(wd, chat);
  assert.equal(r.status, "reported");
  assert.equal(r.turns, 3, "第一轮被骨架稿拦下");
  assert.ok(!r.report.includes("TODO"));
});

test("文档里正常讨论 TODO 不算骨架稿（有交付物就放行）", async () => {
  const wd = tmpWorkdir();
  fs.writeFileSync(path.join(wd, "guide.md"), "# 规范\n禁止在提交里留 TODO");
  const chat = scriptedChat([
    { toolCalls: [tc("1", "submit_report", { text: "规范写好了：明确禁止留 TODO", evidence: ["guide.md"], deliverables: ["guide.md"] })] },
  ]);
  const r = await run(wd, chat);
  assert.equal(r.status, "reported");
  assert.equal(r.turns, 1);
});

test("不给 checks 也不拦（可选字段，不能把普通回报挡在门外）", async () => {
  const wd = tmpWorkdir();
  fs.writeFileSync(path.join(wd, "c.txt"), "x");
  const chat = scriptedChat([
    { toolCalls: [tc("1", "submit_report", { text: "做完了，没有清单", evidence: ["c.txt"] })] },
  ]);
  const r = await run(wd, chat);
  assert.equal(r.status, "reported");
  assert.equal(r.report, "做完了，没有清单");
});
