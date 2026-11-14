// 实机四问（2026-11-13）：同一份回报画两遍 / 风铃收轮没有汇报 / 群公告从没写 / 中栏把空态当标题
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Kernel } from "../dist/main/kernel.js";
import { TeamStore } from "../dist/main/team-store.js";
import { TaskStore } from "../dist/main/task-store.js";

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "lynn-qa-"));
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

function scriptedChat(script) {
  let i = 0;
  return async (input) => {
    const step = script[Math.min(i++, script.length - 1)];
    input.messages.push({ role: "assistant", content: step.content ?? null, tool_calls: step.toolCalls ?? [] });
    for (const call of step.toolCalls ?? []) {
      input.messages.push({ role: "tool", tool_call_id: call.id, name: call.name, content: "（占位）" });
    }
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

function setup() {
  const root = tmp();
  seedModel(root);
  seedTeam(root);
  const kernel = new Kernel(root);
  kernel.handle("config.prefs", { autoStart: false });
  return { root, kernel, tasks: new TaskStore(root) };
}

const assign = (kernel, taskId) =>
  kernel.runTool("assign_task", {
    teamId: "t1",
    taskId,
    member: "审计员",
    brief: "【目标】审一遍并写报告\n【完成标准】输出 report.md 且结论清楚\n【材料与位置】工作区\n【限制】只读不改源",
    deadline: "30 分钟",
  });

const start = (kernel, taskId) => {
  const plan = kernel.handle("session.snapshot").board.decisions.find((d) => d.kind === "plan" && d.jobId === taskId);
  assert.ok(plan, `应有 ${taskId} 的契约`);
  assert.equal(kernel.handle("decision.resolve", { id: plan.id, action: "start" }).ok, true);
};

test("同一份成员回报只落一张卡（此前 registerReport 与派单收尾各落一张）", async () => {
  const { kernel, tasks } = setup();
  try {
    await kernel.init();
    kernel.memberChatFn = scriptedChat([
      { toolCalls: [tc("1", "write_file", { path: "report.md", content: "# 报告\n两条隐患" })] },
      { toolCalls: [tc("2", "submit_report", { text: "审计完成：两条隐患", evidence: ["report.md"] })] },
    ]);
    assign(kernel, "task-1");
    start(kernel, "task-1");
    await until(() => tasks.get("task-1")?.status === "in_review", 8000, "回报进待审查");
    const cards = kernel.handle("session.snapshot").feed.filter((c) => c.badge === "回报");
    assert.equal(cards.length, 1, `一份回报只该有一张卡，实际 ${cards.length} 张：${cards.map((c) => c.title).join(" / ")}`);
    assert.match(cards[0].meta ?? "", /轮/, "留下的那张要带轮次/耗时");
  } finally {
    await kernel.dispose();
  }
});

test("收轮时没有文字：落一行如实状态，不留空气泡", async () => {
  const { kernel } = setup();
  try {
    await kernel.init();
    const live = kernel.card({ kind: "lynn", text: "", thinking: "想了很久", streaming: true });
    kernel.liveCard = live;
    kernel.settleAssistant(live, "");
    const feed = kernel.handle("session.snapshot").feed;
    assert.ok(
      feed.some((c) => c.kind === "system" && /没有产出文字/.test(c.text ?? "")),
      "要说清这一轮没有产出文字",
    );
    // 2026-11-13 改法：就地改写成一行系统提示，不再新落一张卡把空壳留在中间
    const turnCard = feed.find((c) => c.id === live.id);
    assert.equal(turnCard.kind, "system", "空气泡要就地变成一行系统提示");
    assert.match(turnCard.text ?? "", /没有产出文字/);
    assert.equal(turnCard.thinking, undefined, "思考也不该留在空气泡里冒充内容");
    assert.equal(
      feed.filter((c) => c.kind === "lynn" && !(c.text ?? "").trim()).length,
      0,
      "不允许留下任何空的风铃气泡",
    );
  } finally {
    await kernel.dispose();
  }
});

test("验收归档了却没汇报 → 收轮时按卷宗事实补一张汇报卡", async () => {
  const { kernel, tasks } = setup();
  try {
    await kernel.init();
    kernel.memberChatFn = scriptedChat([
      { toolCalls: [tc("1", "write_file", { path: "report.md", content: "# 报告" })] },
      { toolCalls: [tc("2", "submit_report", { text: "审计完成", evidence: ["report.md"] })] },
    ]);
    assign(kernel, "task-1");
    start(kernel, "task-1");
    await until(() => tasks.get("task-1")?.status === "in_review", 8000, "回报进待审查");
    kernel.runTool("read_artifact", { taskId: "task-1" });
    kernel.runTool("accept_or_reject", { teamId: "t1", taskId: "task-1", member: "审计员", verdict: "accept" });
    // 她验收完就收轮（没写汇报）
    const live = kernel.card({ kind: "lynn", text: "", streaming: true });
    kernel.liveCard = live;
    kernel.settleAssistant(live, "");
    const feed = kernel.handle("session.snapshot").feed;
    const report = feed.find((c) => c.badge === "汇报");
    assert.ok(report, "验收归档后必须有一张汇报卡，否则用户只看到一堆过程卡");
    assert.match(report.title ?? "", /系统汇总/, "系统补的汇总要标明来源，不冒充她写的话");
    assert.match(report.body ?? "", /验收归档/);
  } finally {
    await kernel.dispose();
  }
});

test("群里已有在办的单但没写公告 → 每轮提示她写（写了就不提）", async () => {
  const { kernel, tasks } = setup();
  try {
    await kernel.init();
    kernel.memberChatFn = scriptedChat([{ toolCalls: [tc("1", "write_file", { path: "report.md", content: "x" })] }]);
    assign(kernel, "task-1");
    start(kernel, "task-1");
    assert.match(kernel.turnFacts(), /本群公告还没写/, "有活干就要提醒她写公告");
    await until(() => kernel.runningTaskIds().length === 0, 8000, "成员跑完");
    kernel.runTool("set_group_notice", { text: "整体：审 lynn；接缝：报告归审计员" });
    assert.ok(!kernel.turnFacts().includes("本群公告还没写"), "写了公告就不该再提醒");
    assert.match(kernel.turnFacts(), /整体：审 lynn/, "公告进了上下文（当轮消息尾部）");
    assert.ok(tasks.get("task-1"), "工单还在");
  } finally {
    await kernel.dispose();
  }
});

/**
 * 2026-11-13 实机顺序问题（用户贴的时间线）：
 *   回报卡 / 风铃的话 / 回报卡（重复）/ 验收通过 —— 她的结论被夹在中间。
 * 两个根因：①叫醒她写在了 registerReport 内部，早于调用方那张回报卡；
 *          ②她的卡在回合开始就创建，之后自己的工具卡全排在它下面。
 */
test("叫醒她之前，成员那张带轮次的回报卡必须已经落好", async () => {
  const { kernel, tasks } = setup();
  try {
    await kernel.init();
    kernel.memberChatFn = scriptedChat([
      { toolCalls: [tc("1", "write_file", { path: "report.md", content: "x" })] },
      { toolCalls: [tc("2", "submit_report", { text: "审计完成", evidence: ["report.md"] })] },
    ]);
    // 把"叫醒"换成探针：记录被叫醒那一刻，回报卡到底在不在
    let reportCardReady = null;
    kernel.wakeLynnForReview = () => {
      const feed = kernel.handle("session.snapshot").feed;
      reportCardReady = feed.some((c) => c.badge === "回报");
    };
    assign(kernel, "task-1");
    start(kernel, "task-1");
    await until(() => tasks.get("task-1")?.status === "in_review", 8000, "回报进待审查");
    await new Promise((r) => setTimeout(r, 100)); // 等微任务
    assert.equal(reportCardReady, true, "叫醒她时回报卡必须已经落好，否则她的话会插在成员回报中间");
  } finally {
    await kernel.dispose();
  }
});

test("收轮时她的话被动作卡埋在上面 → 挪到末尾（结论永远在最后）", async () => {
  const { kernel } = setup();
  try {
    await kernel.init();
    const live = kernel.card({ kind: "lynn", text: "", streaming: true });
    kernel.liveCard = live;
    // 她这一轮里自己落的动作卡（验收 / 派单 / 技能激活）
    kernel.card({ kind: "tool", badge: "审查", title: "验收通过 · 审计员", body: "@审计员" });
    kernel.card({ kind: "tool", badge: "派单", title: "审计员 开工 · task-1", body: "@审计员" });
    kernel.settleAssistant(live, "报告已验收，22 条隐患，结论如下…");
    const feed = kernel.handle("session.snapshot").feed;
    assert.equal(feed[feed.length - 1].id, live.id, "她的话必须排在这轮动作之后（最后一条）");
    assert.match(feed[feed.length - 1].text ?? "", /22 条隐患/);
  } finally {
    await kernel.dispose();
  }
});

/**
 * 交付箱（2026-11-13）：用户确认口径是「同一目录下两张单都产出 audit-report.md → 合并」。
 * 界面按**解析后的绝对路径**去重，所以要保证内核这一侧：同一个文件被两张单交上来时，
 * path 字符串一致、且每条都带固化时刻（否则不知道该以哪张单的 ref/大小为准）。
 */
test("交付物右键删除：只移除记录 vs 连文件一起删，越界拒删", async () => {
  const { kernel, tasks, root } = setup();
  try {
    await kernel.init();
    kernel.wakeLynnForReview = () => {};
    kernel.memberChatFn = scriptedChat([
      { toolCalls: [tc("1", "write_file", { path: "report.md", content: "# 报告" })] },
      { toolCalls: [tc("2", "submit_report", { text: "写完了", evidence: [], deliverables: ["report.md"] })] },
    ]);
    assign(kernel, "task-1");
    start(kernel, "task-1");
    await until(() => tasks.get("task-1")?.status === "in_review", 8000, "回报进待审查");

    const rec = tasks.get("task-1");
    const file = path.join(rec.workspaceRoot, "report.md");
    assert.ok(fs.existsSync(file), "先要有这个文件");
    const first = rec.deliverables[0];

    // ① 只移除记录：文件必须还在
    const r1 = kernel.handle("task.removeDeliverable", { taskId: "task-1", ref: first.ref, deleteFile: false });
    assert.equal(r1.ok, true);
    assert.equal(tasks.get("task-1").deliverables.length, 0, "记录要移除");
    assert.ok(fs.existsSync(file), "文件要保留");

    // ② 连文件一起删：文件必须消失
    tasks.setDeliverables("task-1", [{ path: "report.md", ref: first.ref, bytes: 10, at: new Date().toISOString() }]);
    const r2 = kernel.handle("task.removeDeliverable", { taskId: "task-1", ref: first.ref, deleteFile: true });
    assert.equal(r2.ok, true);
    assert.equal(r2.removedFile, true);
    assert.ok(!fs.existsSync(file), "文件要删掉");

    // ③ 工作区外的文件不许通过这个入口删
    const outside = path.join(root, "outside.txt");
    fs.writeFileSync(outside, "keep me", "utf-8");
    tasks.setDeliverables("task-1", [{ path: outside, ref: "artifacts/outside.txt", bytes: 7 }]);
    const r3 = kernel.handle("task.removeDeliverable", {
      taskId: "task-1",
      ref: "artifacts/outside.txt",
      deleteFile: true,
    });
    assert.equal(r3.ok, false, "越界必须拒绝");
    assert.match(String(r3.error), /不删工作区外的文件/);
    assert.ok(fs.existsSync(outside), "拒绝时不能偷偷删掉");
  } finally {
    await kernel.dispose();
  }
});

test("同一目录同名交付物：两条记录的 path 一致且都带固化时刻", async () => {
  const { kernel, tasks } = setup();
  try {
    await kernel.init();
    kernel.wakeLynnForReview = () => {};
    const round = (taskId, content, text) => {
      kernel.memberChatFn = scriptedChat([
        { toolCalls: [tc("1", "write_file", { path: "audit-report.md", content })] },
        {
          toolCalls: [
            tc("2", "submit_report", { text, evidence: [], deliverables: ["audit-report.md"] }),
          ],
        },
      ]);
      assign(kernel, taskId);
      start(kernel, taskId);
    };

    round("task-A", "# v1", "第一轮写完");
    await until(() => tasks.get("task-A")?.status === "in_review", 8000, "A 回报");
    round("task-B", "# v2 更新", "第二轮在同一份上更新");
    await until(() => tasks.get("task-B")?.status === "in_review", 8000, "B 回报");

    const track = kernel.handle("session.snapshot").board.track;
    const a = track.find((t) => t.id === "task-A")?.deliverables?.[0];
    const b = track.find((t) => t.id === "task-B")?.deliverables?.[0];
    assert.ok(a && b, "两张单都要有交付物");
    assert.equal(a.path, b.path, "同一目录同名 = 同一个 path，交付箱才能合并成一行");
    assert.ok(a.at && b.at, "每条要带固化时刻，才知道谁更新得更晚");
    assert.ok(String(b.at) >= String(a.at), "后一轮的时刻不能早于前一轮");
  } finally {
    await kernel.dispose();
  }
});

test("成员已自交回报时，风铃的 review_result 不许重复登记（否则多一张一样的回报卡）", async () => {
  const { kernel, tasks } = setup();
  try {
    await kernel.init();
    kernel.memberChatFn = scriptedChat([
      { toolCalls: [tc("1", "write_file", { path: "report.md", content: "x" })] },
      { toolCalls: [tc("2", "submit_report", { text: "审计完成", evidence: ["report.md"] })] },
    ]);
    kernel.wakeLynnForReview = () => {}; // 这一轮不真叫她，只看登记语义
    assign(kernel, "task-1");
    start(kernel, "task-1");
    await until(() => tasks.get("task-1")?.status === "in_review", 8000, "回报进待审查");
    const before = kernel.handle("session.snapshot").feed.filter((c) => c.badge === "回报").length;
    assert.equal(before, 1, "成员自交只该有一张回报卡");
    const out = kernel.runTool("review_result", {
      teamId: "t1",
      taskId: "task-1",
      member: "审计员",
      text: "再登记一遍同样的回报",
    });
    assert.match(String(out), /不要重复登记/, "应拒绝重复登记并指路到验收");
    const after = kernel.handle("session.snapshot").feed.filter((c) => c.badge === "回报").length;
    assert.equal(after, 1, "拒绝后不能多出一张回报卡");
  } finally {
    await kernel.dispose();
  }
});
