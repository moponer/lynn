// 简报质量闸与派单参数校验（风铃"接单不确认/简报不清晰/工作区不管/权限不给"的代码层闭环）：
//  - validateBrief：目标/完成标准/材料位置/限制缺一退回，附重写模板
//  - workspace：必须是已存在目录，用户在契约卡上看到并批准
//  - readRoots：只登记，用户点「开始」才落权（模型不能自我扩权）
//  - maxTurns：范围校验，覆盖岗位档案上限
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Kernel } from "../dist/main/kernel.js";
import { validateBrief } from "../dist/main/member-runner.js";
import { TeamStore } from "../dist/main/team-store.js";
import { TaskStore } from "../dist/main/task-store.js";

const GOOD =
  "【目标】把 9 月订单表整理成周报\n【完成标准】产出周报-09.md，数字与源表核对一致\n【材料与位置】材料文件在工作区 orders.csv\n【限制】只做 9 月，不要改源表口径";

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "lynn-brief-"));

function setup() {
  const root = tmp();
  const teams = new TeamStore(root);
  teams.createTeam("t1", "月报组");
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
  const kernel = new Kernel(root);
  // 这组用例专测「契约卡」路径；默认已改为自动开工，这里显式关掉以保留原断言。
  kernel.handle("config.prefs", { autoStart: false });
  return { root, kernel, tasks: new TaskStore(root) };
}

// ---------- validateBrief 纯函数 ----------

test("简报太薄：退回并附重写模板（成员看不到对话，简报必须自足）", () => {
  const r = validateBrief("整理一下材料");
  assert.match(r, /简报太薄/);
  assert.match(r, /【目标】/, "退回信息要带模板，风铃一轮就能改对");
});

test("缺完成标准 / 缺限制 / 缺材料位置：分别点名缺什么", () => {
  const noAccept = validateBrief(
    "【目标】把 9 月订单表整理成周报，认真做完。\n【材料与位置】材料文件在工作区 orders.csv\n【限制】只做 9 月，不要改源表口径",
  );
  assert.match(noAccept, /完成标准/);
  const noLimit = validateBrief(
    "【目标】把 9 月订单表整理成周报\n【完成标准】产出周报-09.md，数字与源表核对一致\n【材料与位置】材料文件在工作区 orders.csv",
  );
  assert.match(noLimit, /限制/);
  const noMaterial = validateBrief(
    "【目标】把 9 月订单表整理成周报\n【完成标准】产出周报-09.md，数字与源表核对一致\n【限制】只做 9 月，不要改源表口径",
  );
  assert.match(noMaterial, /材料/);
});

test("合格简报放行；acceptance 数组可以补上完成标准", () => {
  assert.equal(validateBrief(GOOD), null);
  assert.equal(
    validateBrief("【目标】把 9 月订单表整理成周报\n【材料与位置】材料文件在工作区 orders.csv\n【限制】只做 9 月，不要改源表口径", ["数字与源表核对一致"]),
    null,
  );
});

// ---------- assign_task 集成：闸在团队解析之前，不建队不开单 ----------

test("简报太薄：assign_task 退回，不建工单不出契约卡", () => {
  const { kernel, tasks } = setup();
  const reply = kernel.runTool("assign_task", { teamId: "t1", taskId: "task-1", member: "林工", brief: "整理一下材料", deadline: "周五" });
  assert.match(reply, /简报不合格|简报太薄/);
  assert.equal(tasks.get("task-1"), null, "退回时不落工单");
  assert.equal(kernel.handle("session.snapshot").board.decisions.some((d) => d.kind === "plan"), false, "不出契约卡");
});

test("workspace 不存在 / 盘符根：拒绝并让风铃去问用户，不猜路径", () => {
  const { kernel } = setup();
  const noDir = kernel.runTool("assign_task", {
    teamId: "t1", taskId: "task-1", member: "林工", brief: GOOD, deadline: "周五",
    workspace: path.join(os.tmpdir(), "lynn-not-exist-xyz"),
  });
  assert.match(noDir, /workspace 目录不存在/);
  assert.match(noDir, /ask_user/);
  const driveRoot = kernel.runTool("assign_task", {
    teamId: "t1", taskId: "task-1", member: "林工", brief: GOOD, deadline: "周五",
    workspace: "C:\\",
  });
  assert.match(driveRoot, /盘符根/);
});

test("workspace 有效目录：工单钉住它，契约卡明示（用户点开始=批准）", () => {
  const { root, kernel, tasks } = setup();
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), "lynn-ws-"));
  kernel.runTool("assign_task", { teamId: "t1", taskId: "task-1", member: "林工", brief: GOOD, deadline: "周五", workspace: ws });
  assert.equal(tasks.get("task-1").workspaceRoot, path.resolve(ws), "工单记住派单时的工作区");
  const plan = kernel.handle("session.snapshot").board.decisions.find((d) => d.kind === "plan");
  assert.match(plan.detail, new RegExp(ws.replace(/\\/g, "\\\\")), "契约卡上要写清成员在哪个目录干活");
});

test("readRoots：不存在的目录拒绝；有效目录只登记，用户点「开始」才落权", () => {
  const { root, kernel, tasks } = setup();
  const bad = kernel.runTool("assign_task", {
    teamId: "t1", taskId: "task-1", member: "林工", brief: GOOD, deadline: "周五",
    readRoots: [path.join(os.tmpdir(), "lynn-not-exist-abc")],
  });
  assert.match(bad, /readRoots 里这些目录不存在/);

  const grant = fs.mkdtempSync(path.join(os.tmpdir(), "lynn-grant-"));
  kernel.runTool("assign_task", { teamId: "t1", taskId: "task-2", member: "林工", brief: GOOD, deadline: "周五", readRoots: [grant] });
  assert.equal(tasks.get("task-2").readRoots, undefined, "未批准前不落权");
  const plan = kernel.handle("session.snapshot").board.decisions.find((d) => d.kind === "plan" && d.jobId === "task-2");
  assert.match(plan.detail, /只读授权申请/, "契约卡上要明示授权申请");

  const r = kernel.handle("decision.resolve", { id: plan.id, action: "start" });
  assert.equal(r.ok, true);
  assert.deepEqual(tasks.get("task-2").readRoots, [path.resolve(grant)], "用户批准后落权");
});

test("maxTurns：非法值拒绝；合法值进派单上下文并钳到 40", () => {
  const { kernel } = setup();
  const bad = kernel.runTool("assign_task", { teamId: "t1", taskId: "task-1", member: "林工", brief: GOOD, deadline: "周五", maxTurns: 0 });
  assert.match(bad, /maxTurns 必须是 ≥1 的数字/);
  kernel.runTool("assign_task", { teamId: "t1", taskId: "task-2", member: "林工", brief: GOOD, deadline: "周五", maxTurns: 100 });
  const pending = [...kernel.pendingPlans.values()].find((p) => p.taskId === "task-2");
  assert.equal(pending.maxTurns, 40);
});

test("合格简报正常走到任务契约卡", () => {
  const { kernel, tasks } = setup();
  const reply = kernel.runTool("assign_task", { teamId: "t1", taskId: "task-1", member: "林工", brief: GOOD, deadline: "周五" });
  assert.match(reply, /任务契约已呈给用户/);
  assert.equal(tasks.get("task-1").status, "todo");
});
