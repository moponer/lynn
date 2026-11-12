// 工单生命周期（2026-11-04）：停得下来、取消得掉、删得干净、起不来不许假装在跑。
// 背景：用户实报"卡住的单没法删 / 停掉也没用 / 不知道有几个在跑"。
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Kernel } from "../dist/main/kernel.js";
import { TeamStore } from "../dist/main/team-store.js";
import { TaskStore } from "../dist/main/task-store.js";

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "lynn-life-"));

function seedModel(root, prefs = {}) {
  fs.writeFileSync(
    path.join(root, "settings.json"),
    JSON.stringify(
      {
        model: {
          provider: "test",
          baseUrl: "http://127.0.0.1:9/v1",
          model: "test-model",
          apiKey: { encrypted: false, data: "test-key" },
          updatedAt: new Date().toISOString(),
        },
        prefs,
      },
      null,
      2,
    ),
    "utf-8",
  );
}

function seedTeam(root, names = ["林工"]) {
  const teams = new TeamStore(root);
  teams.createTeam("t1", "月报突击队");
  for (const name of names) {
    teams.writeMember("t1", {
      name,
      role: "数据整理员",
      goal: "把源数据整理成可核对的月报",
      boundaries: ["只动工作区"],
      tools: ["read_file", "write_file"],
      model: "test-model",
      limits: { maxTurns: 6, budgetTokens: 100000, wallClockMin: 10 },
      outputContract: { deliverable: "report.md", evidence: ["报告文件"], acceptance: ["数字可对账"] },
      escalateWhen: "卡住",
      body: "",
    });
  }
}

const tc = (id, name, args) => ({ id, name, arguments: JSON.stringify(args) });

/** 永不休工的成员：每 100ms 写一个文件，直到轮次上限 */
function slowChat(delay = 100) {
  let i = 0;
  return async () => {
    await new Promise((r) => setTimeout(r, delay));
    i += 1;
    return {
      content: "",
      toolCalls: [tc(`s-${i}`, "write_file", { path: `step-${i}.md`, content: "…" })],
      promptTokens: 1,
      completionTokens: 1,
    };
  };
}

async function until(fn, ms = 6000, label = "条件") {
  const started = Date.now();
  while (Date.now() - started < ms) {
    if (fn()) return;
    await new Promise((r) => setTimeout(r, 50));
  }
  assert.fail(`等待超时：${label}`);
}

function setup(prefs) {
  const root = tmp();
  seedModel(root, prefs);
  seedTeam(root, ["林工", "小舟"]);
  const kernel = new Kernel(root);
  kernel.handle("config.prefs", { autoStart: false });
  return { root, kernel, tasks: new TaskStore(root) };
}

function assignAndStart(kernel, taskId, member = "林工") {
  kernel.runTool("assign_task", {
    teamId: "t1",
    taskId,
    member,
    brief: `【目标】完成工单 ${taskId} 的材料整理\n【完成标准】产出整理结果文件，内容与源材料核对一致\n【材料与位置】材料文件在工作区\n【限制】只处理本单 ${taskId}，不要动其他工单`,
    deadline: "30 分钟",
  });
  const plan = kernel.handle("session.snapshot").board.decisions.find((d) => d.kind === "plan" && d.jobId === taskId);
  assert.ok(plan, `应有 ${taskId} 的任务契约`);
  kernel.handle("decision.resolve", { id: plan.id, action: "start" });
}

test("停掉在跑的成员：工单转「卡住」，不再永远挂着「进行中」", async () => {
  const { kernel, tasks } = setup();
  try {
    await kernel.init();
    kernel.memberChatFn = slowChat();
    assignAndStart(kernel, "task-1");
    assert.equal(tasks.get("task-1").status, "in_progress", "有模型、真起来了才进进行中");
    assert.deepEqual(kernel.handle("session.snapshot").running, ["task-1"], "快照要如实说谁在跑");

    const r = kernel.handle("task.cancel", { taskId: "task-1" });
    assert.equal(r.ok, true);
    await until(() => kernel.handle("session.snapshot").running.length === 0, 5000, "成员收手");
    assert.equal(tasks.get("task-1").status, "blocked", "停了就要有可见变化：进「卡住」等人决定");
  } finally {
    await kernel.dispose();
  }
});

test("在跑的单要能看见进度：进度卡归属工单，成员卡给「最近一步」", async () => {
  const { kernel } = setup();
  try {
    await kernel.init();
    kernel.memberChatFn = slowChat(80);
    assignAndStart(kernel, "task-1");
    await until(
      () => kernel.handle("session.snapshot").board.teams.some((t) => t.members.some((m) => m.lastStep)),
      5000,
      "成员最近一步",
    );
    const snap = kernel.handle("session.snapshot");
    // 图纸「往来」按 jobId 过滤：进度卡不带 jobId 时用户只看到「派单·契约」，以为没进度（实报）
    assert.ok(
      snap.feed.some((c) => c.badge === "进度" && c.jobId === "task-1"),
      "进度卡必须归属这张工单",
    );
    const member = snap.board.teams.flatMap((t) => t.members).find((m) => m.lastStep);
    assert.match(member.lastStep, /write_file|step-/);
    kernel.handle("task.cancel", { taskId: "task-1" });
  } finally {
    await kernel.dispose();
  }
});

test("取消一张单：进归档带（目录还在），重复取消幂等", async () => {
  const { root, kernel, tasks } = setup();
  try {
    await kernel.init();
    kernel.memberChatFn = slowChat();
    assignAndStart(kernel, "task-1");
    kernel.handle("task.cancel", { taskId: "task-1" });
    await until(() => kernel.handle("session.snapshot").running.length === 0, 5000, "成员收手");

    assert.deepEqual(kernel.handle("task.dismiss", { taskId: "task-1" }), { ok: true });
    assert.equal(tasks.get("task-1").status, "canceled");
    assert.ok(fs.existsSync(path.join(root, "tasks", "task-1", "task.json")), "取消只进归档带，不删文件");
    assert.deepEqual(kernel.handle("task.dismiss", { taskId: "task-1" }), { ok: true }, "重复取消幂等");
  } finally {
    await kernel.dispose();
  }
});

test("删除一张单：目录一并消失；在跑的不许删", async () => {
  const { root, kernel, tasks } = setup();
  try {
    await kernel.init();
    kernel.memberChatFn = slowChat();
    assignAndStart(kernel, "task-1");

    const rejected = kernel.handle("task.remove", { taskId: "task-1" });
    assert.equal(rejected.ok, false);
    assert.match(rejected.error ?? "", /还在跑|先停/);

    kernel.handle("task.cancel", { taskId: "task-1" });
    await until(() => kernel.handle("session.snapshot").running.length === 0, 5000, "成员收手");

    const removed = kernel.handle("task.remove", { taskId: "task-1" });
    assert.equal(removed.ok, true);
    assert.ok(removed.removed?.length, "要如实返回删了什么");
    assert.equal(removed.kept?.length, 1, "跨任务共享的工作区不随这张单删除，要如实列出来");
    assert.ok(removed.kept[0].endsWith("workspace"), "kept 应是共享默认工作区");
    assert.equal(tasks.get("task-1"), null, "工单记录没了");
    assert.ok(!fs.existsSync(path.join(root, "tasks", "task-1")), "目录、卷宗、工作区一起删");
    assert.equal(kernel.handle("session.snapshot").board.track.find((t) => t.id === "task-1"), undefined);
  } finally {
    await kernel.dispose();
  }
});

test("并发上限读设置：到顶的单停在「待办」并说清原因，不假装进行中", async () => {
  const { kernel, tasks } = setup({ maxParallelMembers: 1 });
  try {
    await kernel.init();
    kernel.memberChatFn = slowChat(150);
    assignAndStart(kernel, "task-1", "林工");
    assignAndStart(kernel, "task-2", "小舟"); // 不同成员，只有"并发上限"这一条会拒

    assert.equal(kernel.handle("session.snapshot").running.length, 1, "上限 1 就只跑一个");
    assert.equal(tasks.get("task-2").status, "todo", "起不来不许挂在「进行中」");
    const feed = kernel.handle("session.snapshot").feed.map((c) => c.text ?? "").join("\n");
    assert.match(feed, /同时最多 1 个成员在跑/);
  } finally {
    await kernel.dispose();
  }
});
