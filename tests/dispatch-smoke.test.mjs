// 冒烟：任务契约 → 用户确认 → 开工的内核接线（不依赖 electron / 真模型）
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Kernel } from "../dist/main/kernel.js";
import { TeamStore } from "../dist/main/team-store.js";
import { TaskStore } from "../dist/main/task-store.js";

function setup() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "lynn-dispatch-"));
  const kernel = new Kernel(root);
  kernel.handle("config.prefs", { autoStart: false });
  const teams = new TeamStore(root);
  teams.createTeam("t1", "冒烟组");
  teams.writeMember("t1", {
    name: "林工",
    role: "数据整理员",
    goal: "整理数据",
    boundaries: ["只动工作区"],
    tools: ["read_file", "write_file"],
    model: "deepseek-chat",
    limits: { maxTurns: 6, budgetTokens: 100000, wallClockMin: 10 },
    outputContract: { deliverable: "报告", evidence: ["文件"], acceptance: ["可对账"] },
    escalateWhen: "卡住",
    body: "",
  });
  return { root, kernel, tasks: new TaskStore(root) };
}

const assign = (kernel) =>
  kernel.runTool("assign_task", {
    teamId: "t1",
    taskId: "task-1",
    member: "林工",
    brief: "【目标】把 9 月订单表整理成月报\n【完成标准】产出月报.md，数字与源表核对一致\n【材料与位置】材料文件在工作区 orders.csv\n【限制】只做 9 月，不要改源表口径",
    deadline: "周五",
  });

test("默认不自动开工：派单先出任务契约，工单停在 todo", () => {
  const { kernel, tasks } = setup();
  const reply = assign(kernel);
  assert.match(reply, /等待确认|呈给用户/);
  assert.equal(tasks.get("task-1").status, "todo");

  const plan = kernel.handle("session.snapshot").board.decisions.find((d) => d.kind === "plan");
  assert.ok(plan, "应有一张任务契约卡");
  assert.equal(plan.jobId, "task-1");
  assert.ok(plan.plan.acceptance.length > 0);
  assert.ok(!fs.existsSync(path.join(kernel.dataRoot, "team", "t1", "assignments", "task-1.jsonl")));
});

test("用户确认后才尝试开工；无模型时如实告知并停在待办，派单记录仍落盘", () => {
  const { root, kernel, tasks } = setup();
  assign(kernel);
  const plan = kernel.handle("session.snapshot").board.decisions.find((d) => d.kind === "plan");
  const r = kernel.handle("decision.resolve", { id: plan.id, action: "start" });
  assert.equal(r.ok, true);

  // 起不来就不许留在"进行中"：停在待办，台账上不会出现永远转圈的单
  assert.equal(tasks.get("task-1").status, "todo");
  const assigns = fs.readFileSync(path.join(root, "team", "t1", "assignments", "task-1.jsonl"), "utf-8");
  assert.ok(assigns.includes('"kind":"assign"'));
  // 工作区与简报包不建（没模型就没开工，不能先承诺工作区）
  assert.ok(!fs.existsSync(path.join(root, "tasks", "task-1", "workspace")));
  assert.equal(kernel.runTool("check_progress", { teamId: "t1", taskId: "task-1" }).includes('"running": false'), true);

  const feed = kernel.handle("session.snapshot").feed.map((c) => c.text ?? "").join("\n");
  assert.match(feed, /模型未配置/);
});
