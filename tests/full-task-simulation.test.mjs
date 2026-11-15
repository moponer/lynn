// 整链路模拟任务（2026-11-14）：把本轮新增能力串在**一张真实工单**里跑一遍。
//
// 真：Kernel / TaskStore / TeamStore / 成员执行循环 / 工具落盘 / 回报闸 / 顾问旁路 /
//     审批决策 / 验收状态机 / 项目记忆持久化。
// 假：只有模型输出（scriptedChat / advisorChatFn）——没有真实 LLM 调用。
//
// 链路：下令派单 → 成员写文件 → 第一次交骨架稿（应被拒）→ 补全后带 checks 重交 →
//       顾问独立审一次 → 项目记忆只在本项目可见 → 删除审批「这类以后都允许」→ 验收归档。
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Kernel } from "../dist/main/kernel.js";
import { TeamStore } from "../dist/main/team-store.js";
import { TaskStore } from "../dist/main/task-store.js";

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "lynn-sim-"));
const tc = (id, name, args) => ({ id, name, arguments: JSON.stringify(args) });

function seedModel(root) {
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
}

function seedTeam(root) {
  const teams = new TeamStore(root);
  teams.createTeam("t1", "月报突击队");
  teams.writeMember("t1", {
    name: "林工",
    role: "数据整理员",
    goal: "把源数据整理成可核对的月报",
    boundaries: ["只动工作区"],
    tools: ["read_file", "write_file"],
    model: "test-model",
    limits: { maxTurns: 10, budgetTokens: 100000, wallClockMin: 10 },
    outputContract: { deliverable: "report.md", evidence: ["报告文件"], acceptance: ["数字可对账"] },
    escalateWhen: "卡住",
    body: "",
  });
}

/** 逐轮吐工具调用的假模型；tool 结果由成员执行循环真跑后回填 */
function scriptedChat(script) {
  let i = 0;
  return async (input) => {
    const step = script[Math.min(i++, script.length - 1)];
    input.messages.push({ role: "assistant", content: step.content ?? null, tool_calls: step.toolCalls ?? [] });
    return { content: step.content ?? "", toolCalls: step.toolCalls ?? [], promptTokens: 10, completionTokens: 5 };
  };
}

async function until(fn, ms = 8000, label = "条件") {
  const started = Date.now();
  while (Date.now() - started < ms) {
    if (fn()) return;
    await new Promise((r) => setTimeout(r, 50));
  }
  assert.fail(`等待超时：${label}`);
}

test("模拟任务全链路：派单 → 骨架稿被拒 → checks 回报 → 顾问 → 项目记忆 → 审批族 → 归档", async () => {
  const root = tmp();
  seedModel(root);
  seedTeam(root);
  const kernel = new Kernel(root);
  const tasks = new TaskStore(root);
  kernel.handle("config.prefs", { autoStart: false });

  try {
    await kernel.init();

    // 0) 项目身份：项目记忆与审批族都要挂在一个项目下
    const projectDir = tmp();
    fs.writeFileSync(path.join(projectDir, "README.md"), "# 月度报表项目");
    kernel.handle("project.setRoot", { root: projectDir });

    // 1) 成员脚本：真写文件 → 交骨架稿 → 补全交付物 → 带核对清单重交
    kernel.memberChatFn = scriptedChat([
      { toolCalls: [tc("1", "write_file", { path: "data.csv", content: "月份,GMV\n9月,100\n10月,120\n" })] },
      {
        toolCalls: [
          tc("2", "submit_report", { text: "# 月报\n## 结论\nTODO 待补充\n## 明细\n待补充", evidence: [] }),
        ],
      },
      {
        toolCalls: [
          tc("3", "write_file", { path: "report.md", content: "# 9 月月报\nGMV 100，与 data.csv 一致\n" }),
        ],
      },
      {
        toolCalls: [
          tc("4", "submit_report", {
            text: "月报完成：GMV 与源材料一致",
            evidence: ["data.csv"],
            deliverables: ["report.md"],
            checks: [
              { name: "数字可对账", pass: true, evidence: "report.md 第 2 行 / data.csv 9月" },
              { name: "交付物是报告文件", pass: true, evidence: "report.md" },
            ],
          }),
        ],
      },
    ]);

    let advisorCalls = 0;
    kernel.advisorChatFn = async () => {
      advisorCalls += 1;
      return {
        content: JSON.stringify([
          { severity: "nit", title: "报告没写统计口径", evidence: "report.md 未说明 GMV 是否含税" },
        ]),
      };
    };

    // 2) 派单 → 契约确认 → 成员后台真跑
    kernel.runTool("assign_task", {
      teamId: "t1",
      taskId: "WO-SIM",
      member: "林工",
      brief:
        "【目标】把 9 月材料整理成月报\n【完成标准】数字与源材料核对一致、产出 report.md\n【材料与位置】工作区\n【限制】不要改源材料",
      deadline: "30 分钟",
    });
    const plan = kernel.handle("session.snapshot").board.decisions.find((d) => d.kind === "plan" && d.jobId === "WO-SIM");
    assert.ok(plan, "派单先出任务契约");
    assert.equal(kernel.handle("decision.resolve", { id: plan.id, action: "start" }).ok, true);

    await until(() => tasks.get("WO-SIM")?.status === "in_review", 10000, "回报进入待审查");

    // 3) 成员工具真的落了盘（不是模拟出来的返回值）
    const ws = tasks.get("WO-SIM").workspaceRoot;
    assert.ok(ws, "工单要有工作区");
    assert.ok(fs.existsSync(path.join(ws, "report.md")), "report.md 真的被写进工作区");
    assert.ok(fs.existsSync(path.join(ws, "data.csv")), "data.csv 真的被写进工作区");

    // 4) 骨架稿确实被挡回去了：最终回报不含 TODO，且带核对清单
    const reportCards = kernel.handle("session.snapshot").feed.filter((c) => c.jobId === "WO-SIM");
    const joined = reportCards.map((c) => `${c.title ?? ""}${c.body ?? ""}`).join("\n");
    assert.ok(!joined.includes("TODO 待补充"), "骨架稿不能成为最终回报");
    assert.match(joined, /核对清单/, "核对清单进了回报");
    assert.match(joined, /\[过\] 数字可对账/, "checks 逐条展开成可读清单");

    // 5) 顾问独立审了一次，且只审一次
    await until(() => kernel.handle("session.snapshot").feed.some((c) => c.badge === "顾问"), 8000, "顾问卡");
    assert.equal(advisorCalls, 1);
    assert.equal(tasks.get("WO-SIM").status, "in_review", "顾问不改工单状态");

    // 6) 项目记忆：只写进当前项目，且 systemPrompt 里带得上
    const saved = kernel.runTool("save_memory", { scope: "project", entry: "本项目月报口径：GMV 不含税" });
    assert.match(String(saved), /项目/);
    assert.match(String(kernel.runTool("read_memory", { scope: "project" })), /不含税/);
    assert.match(kernel.systemPrompt(), /本项目月报口径/);

    // 7) 删除审批：第一次弹卡，点「这类以后都允许」后同族不再打扰
    //    （自动档不弹卡是 2026-11-15 的口径；这一段要走"询问档"才测得到族放行）
    kernel.handle("permission.set", { mode: "ask" });
    const before = kernel.handle("session.snapshot").board.decisions.length;
    const waiting = kernel.awaitCommandApproval("林工", "WO-SIM", "del data.csv.bak");
    await until(
      () => kernel.handle("session.snapshot").board.decisions.some((d) => d.kind === "approval"),
      3000,
      "删除审批卡",
    );
    const approval = kernel.handle("session.snapshot").board.decisions.find((d) => d.kind === "approval");
    assert.equal(approval.family, "delete");
    assert.equal(kernel.handle("decision.resolve", { id: approval.id, action: "start", always: true }).ok, true);
    assert.equal((await waiting).ok, true);
    assert.equal((await kernel.awaitCommandApproval("林工", "WO-SIM", "del old.tmp")).ok, true);
    assert.equal(kernel.handle("session.snapshot").board.decisions.length, before, "同族不再弹卡");

    // 8) 验收归档
    const done = kernel.handle("task.decide", { taskId: "WO-SIM", action: "approve" });
    assert.equal(done.ok, true);
    assert.equal(done.status, "done");
    assert.equal(tasks.get("WO-SIM").status, "done");
  } finally {
    await kernel.dispose();
  }
});
