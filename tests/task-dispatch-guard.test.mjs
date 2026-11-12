// 2026-11-11：工单 ID 由系统生成 + 新会话第一句不直接派单。
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Kernel } from "../dist/main/kernel.js";
import { TeamStore } from "../dist/main/team-store.js";
import { TaskStore } from "../dist/main/task-store.js";

const GOOD =
  "【目标】把 9 月订单表整理成周报\n【完成标准】产出周报-09.md，数字与源表核对一致\n【材料与位置】材料文件在工作区 orders.csv\n【限制】只做 9 月，不要改源表口径";

function setup() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "lynn-guard-"));
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
  kernel.handle("config.prefs", { autoStart: false });
  return { root, kernel, tasks: new TaskStore(root) };
}

test("生产环境忽略模型自造 taskId，系统生成并回传真实 ID", () => {
  const { kernel, tasks } = setup();
  const old = process.env.NODE_TEST_CONTEXT;
  delete process.env.NODE_TEST_CONTEXT;
  try {
    const out = kernel.runTool("assign_task", {
      teamId: "t1",
      taskId: "perm-locate-002",
      member: "林工",
      brief: GOOD,
      deadline: "周五",
    });
    assert.match(out, /任务 ID：task-/, "返回里必须带系统生成的 id");
    assert.equal(tasks.get("perm-locate-002"), null, "模型自造的 id 不能落库");
    const all = tasks.list();
    assert.equal(all.length, 1);
    assert.match(all[0].id, /^task-/);
  } finally {
    if (old === undefined) delete process.env.NODE_TEST_CONTEXT;
    else process.env.NODE_TEST_CONTEXT = old;
  }
});

test("不传 taskId 也生成；契约卡 jobId 与返回 ID 一致", () => {
  const { kernel, tasks } = setup();
  const old = process.env.NODE_TEST_CONTEXT;
  delete process.env.NODE_TEST_CONTEXT;
  try {
    const out = kernel.runTool("assign_task", {
      teamId: "t1",
      member: "林工",
      brief: GOOD,
      deadline: "周五",
    });
    const id = /任务 ID：(task-[a-z0-9-]+)/.exec(out)?.[1];
    assert.ok(id, `返回里没有任务 ID：${out}`);
    assert.ok(tasks.get(id), "工单应已落库");
    const plan = kernel.handle("session.snapshot").board.decisions.find((d) => d.kind === "plan");
    assert.equal(plan.jobId, id);
  } finally {
    if (old === undefined) delete process.env.NODE_TEST_CONTEXT;
    else process.env.NODE_TEST_CONTEXT = old;
  }
});

test("新会话第一句短/模糊：不建单，先让模型 ask_user 确认", () => {
  const { kernel, tasks } = setup();
  kernel.history.push({ role: "user", content: "嗯，随便看看" });
  const out = kernel.runTool("assign_task", {
    teamId: "t1",
    member: "林工",
    brief: GOOD,
    deadline: "周五",
  });
  assert.match(out, /先用 ask_user/);
  assert.equal(tasks.list().length, 0, "闸住时不能落工单");
  assert.equal(kernel.handle("session.snapshot").board.decisions.length, 0, "也不出契约卡");
});

test("第二句明确委托：放行（不再被第一句闸住）", () => {
  const { kernel, tasks } = setup();
  kernel.history.push({ role: "user", content: "嗯，随便看看" });
  kernel.history.push({ role: "assistant", content: "你想让我做什么？" });
  kernel.history.push({ role: "user", content: "帮我整理订单表成周报" });
  const out = kernel.runTool("assign_task", {
    teamId: "t1",
    member: "林工",
    brief: GOOD,
    deadline: "周五",
  });
  assert.match(out, /任务契约已呈给用户/);
  assert.equal(tasks.list().length, 1);
});
