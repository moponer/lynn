// 终止任务（2026-11-15）：群界面标题栏右侧那一个按钮，按下去本群所有进程停手，
// 直到用户在这个群发出新消息。这里锁四件事：
//  ① 本群在跑的成员被停、工单收口，且只出**一条**汇总卡（不逐张刷屏）；
//  ② 心跳/巡检在终止期间不许叫醒她；
//  ③ 状态落盘——重启（新建 Kernel）后仍然停手；
//  ④ 只停当前群：别群在跑的单不受影响；用户发新消息才恢复。
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Kernel } from "../dist/main/kernel.js";
import { TeamStore } from "../dist/main/team-store.js";
import { TaskStore } from "../dist/main/task-store.js";
import { ThreadStore } from "../dist/main/threads.js";

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "lynn-halt-"));

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
  teams.createTeam("t1", "审计小组");
  teams.writeMember("t1", {
    name: "审计员",
    role: "代码审计",
    goal: "找出隐患并写报告",
    boundaries: ["只动工作区"],
    tools: ["read_file", "write_file"],
    model: "test-model",
    limits: { maxTurns: 6, budgetTokens: 100000, wallClockMin: 10 },
    outputContract: { deliverable: "report.md", evidence: ["报告文件"], acceptance: ["有结论"] },
    escalateWhen: "卡住",
    body: "",
  });
}

const assign = (kernel, taskId, title = "审一遍") =>
  kernel.runTool("assign_task", {
    teamId: "t1",
    taskId,
    member: "审计员",
    brief: `【目标】${title}并写报告\n【完成标准】输出 report.md 且结论清楚\n【材料与位置】工作区\n【限制】只读不改源`,
    deadline: "30 分钟",
  });

const start = (kernel, taskId) => {
  const plan = kernel.handle("session.snapshot").board.decisions.find((d) => d.kind === "plan" && d.jobId === taskId);
  assert.ok(plan, `应有 ${taskId} 的契约`);
  assert.equal(kernel.handle("decision.resolve", { id: plan.id, action: "start" }).ok, true);
};

async function until(fn, ms = 8000, label = "条件") {
  const started = Date.now();
  while (Date.now() - started < ms) {
    if (fn()) return;
    await new Promise((r) => setTimeout(r, 40));
  }
  assert.fail(`等待超时：${label}`);
}

function setup() {
  const root = tmp();
  seedModel(root);
  seedTeam(root);
  const kernel = new Kernel(root);
  kernel.handle("config.prefs", { autoStart: false, heartbeat: true });
  return { root, kernel, tasks: new TaskStore(root) };
}

test("终止任务：本群成员停机、只出一条汇总卡、心跳闭嘴，发新消息才恢复", async () => {
  const { root, kernel, tasks } = setup();
  // 成员卡在第一次模型调用上：终止时才真的"还在跑"
  let release = () => {};
  kernel.memberChatFn = async () => {
    await new Promise((r) => {
      release = r;
    });
    return { content: "（被中止）", toolCalls: [], promptTokens: 1, completionTokens: 1 };
  };
  try {
    await kernel.init();
    assign(kernel, "task-1");
    start(kernel, "task-1");
    const tid = kernel.handle("session.snapshot").thread.id;
    assert.ok(kernel.runningTaskIds().includes("task-1"), "开工后应有一张在跑的单");

    const before = kernel.heartbeatRunCount();
    const r = kernel.handle("thread.halt", {});
    assert.equal(r.ok, true);
    assert.equal(r.threadId, tid);
    assert.equal(r.stopped, 1, "本群那张在跑的单要被停掉");
    assert.equal(kernel.memberAborts.get("task-1")?.signal.aborted, true, "中止信号要真的发下去");

    // 汇总卡：一条说清停了几张、怎么恢复；不再逐张"已停 WO-…"刷屏
    const feed = kernel.handle("session.snapshot").feed;
    const halts = feed.filter((c) => (c.text ?? "").includes("已终止本群"));
    assert.equal(halts.length, 1, `终止只该有一条汇总卡，实际 ${halts.length} 条`);
    assert.match(halts[0].text, /发一条消息即可恢复/);
    assert.equal(feed.filter((c) => /已停 task-1/.test(c.text ?? "")).length, 0, "逐张停机卡属于刷屏");

    // 状态：内存 + 快照 + 落盘
    const snap = kernel.handle("session.snapshot");
    assert.equal(snap.thread.halted, true);
    assert.equal(snap.threads.find((t) => t.id === tid).halted, true);
    assert.ok(new ThreadStore(root).get(tid).haltedAt, "终止状态要落盘");

    // 心跳/巡检：事件触发与定时触发都不许叫醒
    kernel.heartbeatTick("event");
    kernel.heartbeatTick("timer");
    assert.equal(kernel.heartbeatRunCount(), before, "终止期间心跳不许叫醒她");

    // 幂等：同一个群再停一次不报错
    const again = kernel.handle("thread.halt", { id: tid });
    assert.equal(again.ok, true);
    assert.equal(again.stopped, 0);

    release();
    await until(() => kernel.runningTaskIds().length === 0, 8000, "成员收手");
    assert.equal(tasks.get("task-1")?.status, "blocked", "被停的单收口成卡住，不再假装在跑");

    // 用户发新消息 = 唯一恢复条件
    kernel.handle("feed.send", { text: "接着干：先把报告写出来" });
    const resumed = kernel.handle("session.snapshot");
    assert.equal(resumed.thread.halted, false, "发新消息要解除终止");
    assert.equal(new ThreadStore(root).get(tid).haltedAt, undefined, "落盘状态也要清掉");
  } finally {
    release();
    await kernel.dispose();
  }
});

test("终止状态落盘：重启内核后仍然停手，发一条消息才恢复", async () => {
  const root = tmp();
  seedModel(root);
  seedTeam(root);
  const first = new Kernel(root);
  try {
    await first.init();
    const tid = first.handle("session.snapshot").thread.id;
    assert.equal(first.handle("thread.halt", {}).threadId, tid);
  } finally {
    await first.dispose();
  }

  const second = new Kernel(root);
  try {
    await second.init();
    assert.equal(second.handle("session.snapshot").thread.halted, true, "重启不该把终止状态丢掉");
    second.handle("feed.send", { text: "继续，按原计划做完" });
    assert.equal(second.handle("session.snapshot").thread.halted, false);
  } finally {
    await second.dispose();
  }
});

test("终止状态下点「开始」也是新需求：解除终止并真的开工", async () => {
  const { kernel } = setup();
  let release = () => {};
  kernel.memberChatFn = async () => {
    await new Promise((r) => {
      release = r;
    });
    return { content: "（占位）", toolCalls: [], promptTokens: 1, completionTokens: 1 };
  };
  try {
    await kernel.init();
    kernel.handle("thread.halt", {});
    assert.equal(kernel.handle("session.snapshot").thread.halted, true);

    // 契约卡上的「开始」是用户的明确决定，不该被终止状态闷住
    assign(kernel, "task-2", "换一件事");
    start(kernel, "task-2");
    assert.equal(kernel.handle("session.snapshot").thread.halted, false, "拍板等于新需求，要恢复");
    assert.ok(kernel.runningTaskIds().includes("task-2"), "点了开始就要真的开工");
  } finally {
    release();
    await kernel.dispose();
  }
});

test("只停当前群：别群在跑的单不受影响", async () => {
  const { root, kernel } = setup();
  let release = () => {};
  kernel.memberChatFn = async () => {
    await new Promise((r) => {
      release = r;
    });
    return { content: "（占位）", toolCalls: [], promptTokens: 1, completionTokens: 1 };
  };
  try {
    await kernel.init();
    // 在别的群派一张单并开工
    const other = kernel.handle("session.new").threadId;
    assign(kernel, "task-b", "整理另一件事");
    start(kernel, "task-b");
    assert.ok(kernel.runningTaskIds().includes("task-b"));

    // 回到原来的群，只终止这个群
    const home = kernel.handle("session.snapshot").threads.find((t) => t.id !== other)?.id;
    kernel.handle("thread.switch", { id: home });
    const r = kernel.handle("thread.halt", {});
    assert.equal(r.threadId, home);
    assert.equal(r.stopped, 0, "本群没有在跑的单，一单都不该被算进去");
    assert.ok(kernel.runningTaskIds().includes("task-b"), "别群在跑的单不许被顺带停掉");
    assert.equal(new ThreadStore(root).isHalted(other), false, "别群的终止状态不能被连坐");

    // 不存在群：如实拒绝
    const bad = kernel.handle("thread.halt", { id: "th-nope" });
    assert.equal(bad.ok, false);
    assert.match(bad.error ?? "", /没有这个群/);
  } finally {
    release();
    await kernel.dispose();
  }
});
