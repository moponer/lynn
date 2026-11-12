// 一件事 = 一张工单（2026-11-11 实机截图）：同一成员卡住重来 / 打回重做只能改状态、
// 追加卷宗，不能新出一张单；卡住由风铃自己关单，不把「要不要取消」推给用户。
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Kernel, cleanTaskTitle } from "../dist/main/kernel.js";
import { TeamStore } from "../dist/main/team-store.js";
import { TaskStore } from "../dist/main/task-store.js";

const BRIEF =
  "【目标】盘点 G 盘实习材料并出逐文件清单\n【完成标准】产出清单.md，逐文件可核对\n【材料与位置】材料在 G:\\实习相关文件\n【限制】只读，不改原始材料";

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "lynn-rework-"));

function setup() {
  const root = tmp();
  const teams = new TeamStore(root);
  teams.createTeam("t1", "材料组");
  teams.writeMember("t1", {
    name: "资料侦察员",
    role: "材料盘点员",
    goal: "出逐文件清单",
    boundaries: ["只动工作区"],
    tools: ["read_file", "write_file", "list_dir", "run_command"],
    model: "deepseek-chat",
    limits: { maxTurns: 8, budgetTokens: 100000, wallClockMin: 10 },
    outputContract: { deliverable: "清单", evidence: ["文件"], acceptance: ["可核对"] },
    escalateWhen: "卡住",
    body: "",
  });
  return { root, kernel: new Kernel(root), tasks: new TaskStore(root) };
}

const base = (extra = {}) => ({
  teamId: "t1",
  title: "G盘实习材料盘点",
  member: "资料侦察员",
  brief: BRIEF,
  deadline: "周五",
  ...extra,
});

const timelineOf = (root, id) => fs.readFileSync(path.join(root, "tasks", id, "timeline.jsonl"), "utf-8");

test("标题清洗：重派轮次后缀不进台账", () => {
  assert.equal(cleanTaskTitle("G盘实习材料盘点（workspace模式重派）", "x"), "G盘实习材料盘点");
  assert.equal(cleanTaskTitle("补交清单（第2轮）", "x"), "补交清单");
});

test("reworkTaskId：重做归并到原单，不新建工单，卷宗记一轮", () => {
  const { root, kernel, tasks } = setup();
  kernel.handle("config.prefs", { autoStart: true });
  kernel.runTool("assign_task", base({ taskId: "task-a" }));
  const second = kernel.runTool("assign_task", base({
    title: "G盘实习材料盘点（workspace模式重派）",
    reworkTaskId: "task-a",
  }));
  assert.match(second, /没有新建工单/);
  assert.equal(tasks.list().length, 1, "台账里只该有一张单");
  assert.equal(tasks.get("task-a").title, "G盘实习材料盘点", "原标题保留，不带轮次后缀");
  assert.match(timelineOf(root, "task-a"), /第 2 轮重做/);
});

test("不传 reworkTaskId 也自动归并同成员同标题的重派", () => {
  const prev = process.env.NODE_TEST_CONTEXT;
  delete process.env.NODE_TEST_CONTEXT;
  try {
    const { kernel, tasks } = setup();
    kernel.runTool("assign_task", base());
    const second = kernel.runTool("assign_task", base({ title: "G盘实习材料盘点（第2轮）" }));
    assert.match(second, /没有新建工单/);
    assert.equal(tasks.list().length, 1);
  } finally {
    if (prev === undefined) delete process.env.NODE_TEST_CONTEXT;
    else process.env.NODE_TEST_CONTEXT = prev;
  }
});

test("reworkTaskId 指向不存在的单：如实拒绝", () => {
  const { kernel } = setup();
  assert.match(kernel.runTool("assign_task", base({ reworkTaskId: "nope" })), /reworkTaskId 不存在/);
});

test("stop_task dismiss=true：风铃自己关单，卷宗写明是她判定", () => {
  const { root, kernel, tasks } = setup();
  kernel.handle("config.prefs", { autoStart: true });
  kernel.runTool("assign_task", base({ taskId: "task-a" }));
  // 有交付物才是「正常关单」；无交付物的分支由 reply-guard 测试覆盖（必须报未完成）
  tasks.setDeliverables("task-a", [{ path: "out.md", ref: "artifacts/out.md", at: new Date().toISOString() }]);
  const r = kernel.runTool("stop_task", { taskId: "task-a", reason: "方向已错", dismiss: true });
  assert.match(r, /风铃判定不再继续/);
  assert.equal(tasks.get("task-a").status, "canceled");
  assert.match(timelineOf(root, "task-a"), /风铃判定不再继续，取消这张单/);
});

test("同一张单重做超过 4 轮被拦，不无限重派", () => {
  const { kernel, tasks } = setup();
  kernel.handle("config.prefs", { autoStart: true });
  kernel.runTool("assign_task", base({ taskId: "task-a" }));
  let last = "";
  for (let i = 0; i < 5; i += 1) last = kernel.runTool("assign_task", base({ reworkTaskId: "task-a" }));
  assert.match(last, /已经重做/);
  assert.equal(tasks.list().length, 1, "被拦下也不能新开单");
});
