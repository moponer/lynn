// 群内协作（2026-11-16）：成员像同事一样在群里发进展/结论/疑问/风险，风铃回答与纠偏。
//
// 机制不是自造的，参考的是几个成熟多 agent 项目的共识：
//  - MetaGPT：消息总线 + cause_by/watch，只叫醒相关方，不广播全群；
//  - ChatDev：communicative dehallucination——执行前先把口径问清，比猜着做完再返工便宜；
//  - openspawn / LobeHub：沉默即成功，按打断级别分级，只有阻塞项才 @ 人，且每单有硬上限；
//  - AutoGen：群聊至少两个独立终止条件，否则会一直说到预算烧完。
// 落到本仓就是：update/finding 只落群；question/risk 才叫醒；同单合并、每单最多 3 次唤醒、
// 成员一单最多 8 条发言、每轮最多 1 条——这些都在代码里拦，不靠提示词自律。
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Kernel } from "../dist/main/kernel.js";
import { TeamStore } from "../dist/main/team-store.js";
import { TaskStore } from "../dist/main/task-store.js";
import { runMemberTask } from "../dist/main/member-runner.js";

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "lynn-gc-"));
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
    limits: { maxTurns: 8, budgetTokens: 100000, wallClockMin: 10 },
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
  // 心跳/巡检关掉：这个文件只验证"成员说话 → 谁被叫醒"的路由，不让定时器掺进唤醒计数
  kernel.handle("config.prefs", { autoStart: false, heartbeat: false, supervisor: false });
  return { root, kernel, tasks: new TaskStore(root) };
}

/** 把风铃的回合替换成记录器：避免真的走模型，也能精确数"叫醒了几次" */
function spyTurns(kernel) {
  const woke = [];
  kernel.submitTurn = (text) => {
    woke.push(String(text ?? ""));
  };
  return woke;
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

test("成员的进展发言落进群里，但不会叫醒风铃（降噪：沉默即成功）", async () => {
  const { kernel, tasks } = setup();
  try {
    await kernel.init();
    const woke = spyTurns(kernel);
    kernel.memberChatFn = scriptedChat([
      { toolCalls: [tc("1", "write_file", { path: "report.md", content: "# 报告\n两条隐患" })] },
      { toolCalls: [tc("2", "post_message", { kind: "update", text: "数据清洗完了，下一步核对总数" })] },
      { toolCalls: [tc("3", "submit_report", { text: "完成：报告已出", evidence: ["report.md"] })] },
    ]);
    assign(kernel, "task-1");
    start(kernel, "task-1");
    await until(() => tasks.get("task-1")?.status === "in_review", 8000, "回报进待审查");

    const feed = kernel.handle("session.snapshot").feed;
    const said = feed.find((c) => c.badge === "进展");
    assert.ok(said, "中途发言必须落进群时间线");
    assert.equal(said.author?.kind, "member", "发言要带成员身份，不是系统卡");
    assert.equal(said.author?.name, "审计员");
    assert.equal(said.jobId, "task-1");
    assert.match(said.body ?? "", /清洗完了/);

    assert.ok(!woke.some((t) => t.includes("成员在群里说话")), "进展类发言不该唤醒风铃");
    assert.ok(woke.some((t) => t.includes("成员回报")), "交回报仍要叫醒她验收（闭环不能断）");
  } finally {
    await kernel.dispose();
  }
});

test("成员提问叫醒风铃；她 reply_member 回答，回答进群也进成员收件箱", async () => {
  const { root, kernel, tasks } = setup();
  try {
    await kernel.init();
    const tid = kernel.ensureThreadId();
    tasks.ensureInProgress({
      id: "task-q",
      title: "口径核对",
      teamId: "t1",
      member: "审计员",
      threadId: tid,
      workspaceRoot: root,
    });
    const woke = spyTurns(kernel);
    kernel.memberSaid(tid, "t1", "task-q", "审计员", {
      kind: "question",
      text: "汇总按含税还是不含税？",
      needAnswer: true,
    });
    assert.equal(woke.length, 1, "一条提问叫醒一次");
    assert.match(woke[0], /成员在群里说话/);
    assert.match(woke[0], /含税/);
    assert.match(woke[0], /reply_member/, "叫醒词里要告诉她用哪只手回答");

    // 模拟成员仍在跑：回答要进收件箱，下一轮才生效
    kernel.memberRuns.set("task-q", Promise.resolve({}));
    const r = kernel.runTool("reply_member", { taskId: "task-q", text: "按含税口径，税点 6%" });
    assert.match(r, /已送达/);
    assert.ok(
      (kernel.memberInbox.get("task-q") ?? []).some((t) => t.includes("含税")),
      "回答必须进成员收件箱，否则下一轮它看不到",
    );
    const feed = kernel.handle("session.snapshot").feed;
    assert.ok(
      feed.some((c) => c.kind === "lynn" && /答你刚才那句/.test(c.text ?? "")),
      "回答要作为她的话落群（不是系统提示）",
    );
    assert.equal(kernel.questionPending.size, 0, "答完就该从待答队列里消失");
    kernel.memberRuns.delete("task-q");
  } finally {
    await kernel.dispose();
  }
});

test("同一单的多条疑问合并成一次唤醒；每单最多叫醒 3 次（问答不能无限循环）", async () => {
  const { root, kernel, tasks } = setup();
  try {
    await kernel.init();
    const tid = kernel.ensureThreadId();
    tasks.ensureInProgress({
      id: "task-q2",
      title: "口径与范围",
      teamId: "t1",
      member: "审计员",
      threadId: tid,
      workspaceRoot: root,
    });
    const woke = spyTurns(kernel);

    // 她正忙：消息先挂着，不打断正在跑的活
    kernel.busy = true;
    kernel.memberSaid(tid, "t1", "task-q2", "审计员", { kind: "question", text: "问题一" });
    kernel.memberSaid(tid, "t1", "task-q2", "审计员", { kind: "question", text: "问题二" });
    assert.equal(woke.length, 0, "忙时不该插队");
    kernel.busy = false;
    kernel.drainQuestionPending();
    assert.equal(woke.length, 1, "同一单的两条疑问只叫醒一次");
    assert.match(woke[0], /问题一/);
    assert.match(woke[0], /问题二/);

    // 再问三次：总唤醒数到 3 就停，第 4 次落一条系统提示，不再单独叫醒
    for (let i = 0; i < 3; i += 1) {
      kernel.memberSaid(tid, "t1", "task-q2", "审计员", { kind: "question", text: `追加问题${i}` });
    }
    const wakes = woke.filter((t) => t.includes("成员在群里说话"));
    assert.equal(wakes.length, 3, `每单最多叫醒 3 次，实际 ${wakes.length}`);
    const feed = kernel.handle("session.snapshot").feed;
    assert.ok(
      feed.some((c) => c.kind === "system" && /不再单独叫醒/.test(c.text ?? "")),
      "超过上限要有可见说明，不能静默丢掉成员的问题",
    );
    // 关键：停叫 != 丢问题。问题留在队列里，每轮事实段会继续提醒她
    assert.equal(kernel.questionPending.size, 1, "超上限后问题仍挂在待答队列");
    assert.ok(kernel.questionMuted.has("task-q2"), "这张单应被标记为「不再单独叫醒」");
  } finally {
    await kernel.dispose();
  }
});

test("群被终止后：成员的提问不叫醒风铃，待答队列也清空", async () => {
  const { root, kernel, tasks } = setup();
  try {
    await kernel.init();
    const tid = kernel.ensureThreadId();
    tasks.ensureInProgress({
      id: "task-h",
      title: "终止后不再打扰",
      teamId: "t1",
      member: "审计员",
      threadId: tid,
      workspaceRoot: root,
    });
    const woke = spyTurns(kernel);
    kernel.haltThread();
    const before = woke.length;
    kernel.memberSaid(tid, "t1", "task-h", "审计员", { kind: "risk", text: "材料目录不存在" });
    assert.equal(woke.length, before, "群已终止，风险也不该叫醒她");
    assert.equal(kernel.questionPending.size, 0);
  } finally {
    await kernel.dispose();
  }
});

test("成员已经跑完时：回答仍落群，但如实说明成员看不到、要重派", async () => {
  const { root, kernel, tasks } = setup();
  try {
    await kernel.init();
    const tid = kernel.ensureThreadId();
    tasks.ensureInProgress({
      id: "task-done",
      title: "已经结束的单",
      teamId: "t1",
      member: "审计员",
      threadId: tid,
      workspaceRoot: root,
    });
    const r = kernel.runTool("reply_member", { taskId: "task-done", text: "按含税口径" });
    assert.match(r, /已经没人在跑/);
    assert.match(r, /reworkTaskId/, "要告诉她自己怎么让成员继续，而不是把选择抛给用户");
    assert.equal(kernel.memberInbox.get("task-done"), undefined, "没有人接的时候不许假装送达");
    const feed = kernel.handle("session.snapshot").feed;
    assert.ok(feed.some((c) => c.kind === "lynn" && /含税/.test(c.text ?? "")), "回答本身仍要落群");
  } finally {
    await kernel.dispose();
  }
});

test("成员下一轮真的能看到风铃的回答（闭环：不是只写进队列）", async () => {
  const wd = tmp();
  const inbox = [];
  let call = 0;
  let sawAnswer = false;
  const chatFn = async (input) => {
    call += 1;
    if (call === 1) {
      // 第 1 轮：先提问；同时模拟"风铃已经答了"（写进收件箱）
      inbox.push("按含税口径，税点 6%");
      return {
        content: "",
        toolCalls: [tc("1", "post_message", { kind: "question", text: "汇总按含税还是不含税？", needAnswer: true })],
        promptTokens: 1,
        completionTokens: 1,
      };
    }
    // 第 2 轮开头会 drain 收件箱——回答必须已经进入模型上下文
    sawAnswer = input.messages.some((m) => m.role === "user" && String(m.content).includes("按含税口径"));
    return {
      content: "",
      toolCalls: [tc("2", "submit_report", { text: "已按含税口径做完", evidence: [] })],
      promptTokens: 1,
      completionTokens: 1,
    };
  };
  const result = await runMemberTask({
    profile: {
      name: "审计员",
      role: "代码审计",
      goal: "核对",
      boundaries: [],
      tools: ["read_file"],
      model: "m",
      limits: { maxTurns: 6, budgetTokens: 100_000, wallClockMin: 10 },
      outputContract: { deliverable: "report.md", evidence: [], acceptance: ["过"] },
      escalateWhen: "",
      body: "",
    },
    brief: "【目标】核对\n【完成标准】过\n【材料与位置】工作区\n【限制】只读",
    deadline: "今天",
    tools: ["read_file"],
    workdir: wd,
    model: { baseUrl: "http://x", apiKey: "k", model: "m" },
    chatFn,
    inbox,
    onMessage: () => "已发到群里，风铃会在你下一轮前答复。",
  });
  assert.equal(result.status, "reported");
  assert.ok(sawAnswer, "回答必须进成员下一轮的上下文，否则等于没答");
});

test("成员侧发言硬闸：同轮只说一句、空/超长拒、一单最多 8 条", async () => {
  const wd = tmp();
  const seen = [];
  const steps = [
    {
      toolCalls: [
        tc("1", "post_message", { kind: "update", text: "第一条" }),
        tc("2", "post_message", { kind: "update", text: "第二条" }),
      ],
    },
    { toolCalls: [tc("3", "post_message", { kind: "question", text: "   " })] },
    { toolCalls: [tc("4", "post_message", { kind: "risk", text: "x".repeat(700) })] },
    ...Array.from({ length: 8 }, (_, i) => ({
      toolCalls: [tc(`p${i}`, "post_message", { kind: "update", text: `进展 ${i}` })],
    })),
    { toolCalls: [tc("done", "submit_report", { text: "完成", evidence: [] })] },
  ];
  const result = await runMemberTask({
    profile: {
      name: "审计员",
      role: "代码审计",
      goal: "核对",
      boundaries: [],
      tools: ["read_file"],
      model: "m",
      limits: { maxTurns: 20, budgetTokens: 1_000_000, wallClockMin: 30 },
      outputContract: { deliverable: "report.md", evidence: [], acceptance: ["过"] },
      escalateWhen: "",
      body: "",
    },
    brief: "【目标】核对\n【完成标准】过\n【材料与位置】工作区\n【限制】只读",
    deadline: "今天",
    tools: ["read_file"],
    workdir: wd,
    model: { baseUrl: "http://x", apiKey: "k", model: "m" },
    chatFn: scriptedChat(steps),
    onMessage: (post) => {
      seen.push(post);
      return "已记录";
    },
  });
  assert.equal(result.status, "reported");
  assert.equal(seen.length, 8, `一单最多收 8 条，实际 ${seen.length}`);
  assert.equal(seen[0].text, "第一条", "同轮第二条被挡（一轮只说一句）");
  assert.equal(seen.at(-1).text, "进展 6");
  assert.ok(!seen.some((p) => p.text === "进展 7"), "第 9 条要撞上限，不能无限刷屏");
});
