// 任务分配与证据策略的内核接线（2026-11-11）：
// 小任务小配置、证据默认可选、关键任务才强制。
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Kernel } from "../dist/main/kernel.js";
import { TeamStore } from "../dist/main/team-store.js";
import { TaskStore } from "../dist/main/task-store.js";

const SMALL =
  "【目标】把 9 月订单表整理成周报\n【完成标准】产出周报-09.md，数字与源表核对一致\n" +
  "【材料与位置】材料文件在工作区 orders.csv\n【限制】只做 9 月，不要改源表口径";
const AUDIT =
  "【目标】对当前权限配置做一次审计\n【完成标准】产出审计结论，逐项说明是否合规\n" +
  "【材料与位置】材料在导出的配置里\n【限制】只读，不改任何配置";

function setup() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "lynn-evidence-"));
  const teams = new TeamStore(root);
  teams.createTeam("t1", "证据策略组");
  teams.writeMember("t1", {
    name: "林工",
    role: "数据整理员",
    goal: "整理数据",
    boundaries: ["只动工作区"],
    tools: ["read_file", "write_file", "list_dir", "run_command"],
    model: "deepseek-chat",
    limits: { maxTurns: 15, budgetTokens: 300000, wallClockMin: 30 },
    outputContract: { deliverable: "报告", evidence: ["文件"], acceptance: ["可对账"] },
    escalateWhen: "卡住",
    body: "",
  });
  return { root, kernel: new Kernel(root), tasks: new TaskStore(root) };
}

const assign = (kernel, extra) =>
  kernel.runTool("assign_task", {
    teamId: "t1",
    title: "9月订单周报",
    member: "林工",
    brief: SMALL,
    deadline: "周五",
    ...extra,
  });

test("小任务：自动给 8 轮 / 120K，证据默认 optional", () => {
  const { kernel, tasks } = setup();
  kernel.handle("config.prefs", { autoStart: true });
  const reply = assign(kernel, { taskId: "task-a" });
  assert.match(reply, /小任务配置：8 轮 \/ 120K/);
  assert.match(reply, /按交付结果验收/);
  assert.equal(tasks.get("task-a").evidencePolicy, "optional");
});

test("用户要结果：审计类简报也不再自动强制证据，默认 optional", () => {
  const { kernel, tasks } = setup();
  kernel.handle("config.prefs", { autoStart: true });
  const reply = assign(kernel, { taskId: "task-b", title: "权限配置审计", brief: AUDIT });
  assert.match(reply, /按交付结果验收/);
  assert.equal(tasks.get("task-b").evidencePolicy, "optional", "不再因为简报里有“审计”就卡证据");
});

test("显式 evidencePolicy 覆盖自动判定", () => {
  const { kernel, tasks } = setup();
  kernel.handle("config.prefs", { autoStart: true });
  assign(kernel, { taskId: "task-c", evidencePolicy: "required" });
  assert.equal(tasks.get("task-c").evidencePolicy, "required");
});

test("普通任务空证据回报：不再被挡，工单进入待审查", () => {
  const { root, kernel, tasks } = setup();
  kernel.handle("config.prefs", { autoStart: true });
  assign(kernel, { taskId: "task-a" });
  // 无模型时成员开不了工，手动推到位，只验证证据策略这一段
  tasks.transition("task-a", "in_progress");

  const msg = kernel.runTool("review_result", {
    teamId: "t1",
    taskId: "task-a",
    member: "林工",
    text: "【完成】周报已整理",
    evidence: [],
  });
  assert.match(msg, /证据可选|待审查/);
  assert.equal(tasks.get("task-a").status, "in_review", "普通任务无证据也能进审查");
  assert.equal(tasks.get("task-a").evidence.length, 0);
});
