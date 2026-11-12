// 2026-11-11 七阶段长任务实测回归：授权不同步、自动开工不可见、check_progress 空转、
// 思考复读无熔断。这里锁死内核接线，不只测纯函数。
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Kernel } from "../dist/main/kernel.js";
import { TeamStore } from "../dist/main/team-store.js";
import { TaskStore } from "../dist/main/task-store.js";

const BRIEF_A =
  "【目标】把 9 月订单表整理成周报\n【完成标准】产出周报-09.md，数字与源表核对一致\n【材料与位置】材料文件在工作区 orders.csv\n【限制】只做 9 月，不要改源表口径";
const BRIEF_B =
  "【目标】核对 10 月库存台账并出差异表\n【完成标准】产出 diff-10.md，逐行可复算\n【材料与位置】材料文件在工作区 stock.csv\n【限制】只读，不改原始台账";
const LINE = '根据 "Critical Context" 中的 "仓库结构适应"，我们已经主动探测并修正了路径偏差，所以不需要再担心路径问题。';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "lynn-long-"));

function setup() {
  const root = tmp();
  const teams = new TeamStore(root);
  teams.createTeam("t1", "长任务组");
  teams.writeMember("t1", {
    name: "林工",
    role: "数据整理员",
    goal: "整理数据",
    boundaries: ["只动工作区"],
    tools: ["read_file", "write_file", "list_dir", "run_command"],
    model: "deepseek-chat",
    limits: { maxTurns: 6, budgetTokens: 100000, wallClockMin: 10 },
    outputContract: { deliverable: "报告", evidence: ["文件"], acceptance: ["可对账"] },
    escalateWhen: "卡住",
    body: "",
  });
  return { root, kernel: new Kernel(root), tasks: new TaskStore(root) };
}

test("自动开工：readRoots 同步落权，授权信息并进派单卡不重复发系统卡", () => {
  const { kernel, tasks } = setup();
  kernel.handle("config.prefs", { autoStart: true });
  const grant = fs.mkdtempSync(path.join(os.tmpdir(), "lynn-grant-"));
  const reply = kernel.runTool("assign_task", {
    teamId: "t1",
    taskId: "task-a",
    title: "9月订单周报",
    member: "林工",
    brief: BRIEF_A,
    deadline: "周五",
    readRoots: [grant],
  });
  assert.match(reply, /按任务契约开工/);
  assert.deepEqual(tasks.get("task-a").readRoots, [path.resolve(grant)], "开工即落权，不用再等人补授权");
  const snap = kernel.handle("session.snapshot");
  assert.ok(
    !snap.feed.some((c) => /已按契约自动开工/.test(c.text ?? "")),
    "工作区/工具/只读授权并进那一张派单卡，不再单独刷第二张系统卡",
  );
});

test("重派不丢授权：同一会话里用户已批准的只读根自动继承", () => {
  const { kernel, tasks } = setup();
  kernel.handle("config.prefs", { autoStart: true });
  const grant = fs.mkdtempSync(path.join(os.tmpdir(), "lynn-grant-"));
  kernel.runTool("assign_task", {
    teamId: "t1", taskId: "task-a", title: "9月订单周报", member: "林工",
    brief: BRIEF_A, deadline: "周五", readRoots: [grant],
  });
  const reply2 = kernel.runTool("assign_task", {
    teamId: "t1", taskId: "task-b", title: "10月库存差异表", member: "林工",
    brief: BRIEF_B, deadline: "周五",
  });
  assert.doesNotMatch(reply2, /这活已经派过了/, "不同任务不该被去重闸拦下");
  assert.deepEqual(tasks.get("task-b").readRoots, [path.resolve(grant)], "忘了带 readRoots 也要继承已批准的根");
});

test("check_progress：结果没变时第 3 次明确叫停轮询", () => {
  const { kernel } = setup();
  const call = () => kernel.runTool("check_progress", { teamId: "t1", taskId: "task-none" });
  assert.doesNotMatch(call(), /轮询提醒/);
  assert.doesNotMatch(call(), /轮询提醒/);
  assert.match(call(), /\[轮询提醒\].*不要再轮询了/);
});

test("流式复读熔断：内核自动截断、落止损卡、置熔断标志", () => {
  const { kernel } = setup();
  kernel.repetitionAborted = false;
  kernel.lastRepetitionScan = 0;
  kernel.liveCard = {
    id: "live-1",
    kind: "lynn",
    text: "",
    thinking: `开头：先核对阶段4 与阶段6 的状态。\n\n${Array(12).fill(LINE).join("\n\n")}`,
    streaming: true,
  };
  kernel.guardRepetition();
  assert.equal(kernel.repetitionAborted, true, "命中后本轮不再继续生成");
  assert.ok((kernel.liveCard.thinking ?? "").length < 300, "重复段要截掉，不能留一整屏");
  assert.match(kernel.liveCard.thinking ?? "", /开头：先核对/, "前文保留");
  assert.ok(
    kernel.handle("session.snapshot").feed.some((c) => /已自动停止本轮/.test(c.text ?? "")),
    "要给用户一张说明卡，不是默默停掉",
  );
});
