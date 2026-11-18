/**
 * 端到端（P6-5 / 18 章 F5「1 条 e2e（假桥）」）。
 *
 * 这条链要证明的是**从内核事件到界面渲染**中间没有断点：
 *   真实 Kernel 派单 → 假模型驱动成员跑完 → 内核落快照 → deskFromSnapshot 派生 → FeedView 渲染出内容
 *
 * 用「假桥」而不是真 Electron：Electron 窗口在这个环境里起不来，而且真起窗口测的也是同一段渲染代码。
 * 假桥的边界很清楚——它验证**数据形状与渲染结果**，不验证 IPC 传输与窗口生命周期（那需要真窗口）。
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createJiti } from "jiti";
import { loadModule, render, textOf } from "./helpers/render-ssr.mjs";

const jiti = createJiti(import.meta.url, { jsx: { runtime: "automatic" } });
const model = await jiti.import("../src/renderer/desk/model.ts", { default: true });
const feedMod = await loadModule("src/renderer/desk/Feed.tsx");

const { Kernel } = await import("../dist/main/kernel.js");
const { TeamStore } = await import("../dist/main/team-store.js");

function tmp() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "lynn-e2e-"));
}

function seed(root) {
  fs.writeFileSync(
    path.join(root, "settings.json"),
    JSON.stringify({
      model: {
        provider: "test",
        baseUrl: "http://127.0.0.1:9/v1",
        model: "test-model",
        apiKey: { encrypted: false, data: "test-key" },
        updatedAt: new Date().toISOString(),
      },
    }),
    "utf-8",
  );
  const teams = new TeamStore(root);
  teams.createTeam("t1", "端到端小组");
  teams.writeMember("t1", {
    name: "执行员",
    role: "数据整理员",
    roleId: "analyst",
    goal: "把材料整理成报告",
    boundaries: ["只动工作区"],
    tools: ["read_file", "write_file"],
    model: "test-model",
    limits: { maxTurns: 6, budgetTokens: 100000, wallClockMin: 10 },
    outputContract: { deliverable: "report.md", evidence: ["报告文件"], acceptance: ["有结论"] },
    escalateWhen: "卡住",
    body: "先读再写。",
  });
}

const tc = (id, name, args) => ({ id, name, arguments: JSON.stringify(args) });

/** 等一个条件成立（内核是异步后台跑单） */
async function until(fn, ms, what) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    if (fn()) return;
    await new Promise((r) => setTimeout(r, 40));
  }
  throw new Error(`等待超时：${what}`);
}

test("e2e（假桥）：派单 → 成员交付 → 快照 → 派生 → 界面渲染出汇报", async () => {
  const root = tmp();
  seed(root);
  const kernel = new Kernel(root);
  kernel.handle("config.prefs", { autoStart: false });
  try {
    await kernel.init();

    // 假模型：第一轮写文件，第二轮交回报
    kernel.memberChatFn = async (input) => {
      const toolRounds = input.messages.filter((m) => m.role === "tool").length;
      const step =
        toolRounds === 0
          ? { toolCalls: [tc("1", "write_file", { path: "report.md", content: "# 结论\n三条要点" })] }
          : {
              toolCalls: [
                tc("2", "submit_report", {
                  text: "【完成】报告写好了，三条要点都在正文里",
                  evidence: ["report.md"],
                  deliverables: ["report.md"],
                }),
              ],
            };
      input.messages.push({ role: "assistant", content: null, tool_calls: step.toolCalls });
      for (const c of step.toolCalls) {
        input.messages.push({ role: "tool", tool_call_id: c.id, name: c.name, content: "（占位）" });
      }
      return { content: "", toolCalls: step.toolCalls, promptTokens: 10, completionTokens: 5 };
    };

    const assigned = kernel.runTool("assign_task", {
      teamId: "t1",
      taskId: "task-e2e",
      member: "执行员",
      brief: "【目标】写 report.md\n【完成标准】有结论\n【材料与位置】工作区\n【限制】只动工作区",
      acceptance: ["有结论"],
      deadline: "30 分钟",
    });
    assert.doesNotMatch(String(assigned), /简报不合格|已退回/);

    // 批准契约 → 真开工。注意必须走 decision.resolve：直接调 accept_or_reject 是**验收**，
    // 不是批准契约（两者语义完全不同，早先的测试就踩过这个坑）。
    const plan = kernel.handle("session.snapshot").board.decisions.find((d) => d.kind === "plan" && d.jobId === "task-e2e");
    assert.ok(plan, "应有 task-e2e 的任务契约");
    assert.equal(kernel.handle("decision.resolve", { id: plan.id, action: "start" }).ok, true, "契约应能批准开工");

    await until(
      () => kernel.handle("session.snapshot").feed.some((c) => c.badge === "回报"),
      15000,
      "成员回报卡",
    );

    // ---- 假桥：拿真实快照，走真实派生，做真实渲染 ----
    const snap = kernel.handle("session.snapshot");
    const desk = model.deskFromSnapshot(snap);
    assert.ok(desk.jobs.length >= 1, "派生的 Desk 里应有这张单");
    const job = desk.jobs.find((j) => j.id === "task-e2e");
    assert.ok(job, "Desk 里找不到 task-e2e");
    /**
     * 断言要对着**真实存在的链路**：
     * `FeedCard.report` 只挂在 `report_to_user` 的「汇报」卡上（风铃对用户的最终汇报），
     * 成员回报卡是 `badge: "回报"`、没有 report 字段。早先我断言 job.report 有值，
     * 那是在测一个不存在的契约——这类"测了个假的"比没测更糟，因为它会给人虚假的安全感。
     */
    assert.equal(job.status, "in_review", `成员交付后单子应进待审，实际 ${job.status}`);
    assert.equal(job.member, "执行员");
    const reportCard = snap.feed.find((c) => c.badge === "回报" && c.jobId === "task-e2e");
    assert.ok(reportCard, "应有这张单的回报卡");
    assert.match(String(reportCard.text ?? reportCard.body ?? ""), /三条要点/, "回报正文要能读到");

    // 渲染：把真实 feed 交给真实组件
    const html = render(feedMod.FeedView, { cards: snap.feed, collapseHistory: true });
    const text = textOf(html);
    assert.ok(text.includes("执行员") || text.includes("回报"), `界面里应看得到回报：${text.slice(0, 300)}`);
    assert.ok(!html.includes("undefined"), "渲染结果里不许出现 undefined（模板变量没取到值）");
    assert.ok(!html.includes("NaN"), "渲染结果里不许出现 NaN");
  } finally {
    await kernel.dispose();
  }
});