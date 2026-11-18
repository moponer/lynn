// 多成员协作稳定性（2026-11-16）：快照读盘热点 / 回合内输出顺序 / 打回口径 / 播报完整度
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Kernel } from "../dist/main/kernel.js";
import { TeamStore } from "../dist/main/team-store.js";
import { TaskStore } from "../dist/main/task-store.js";
import { ManagementTools } from "../dist/main/management-tools.js";
import { collectHeartbeatFacts, heartbeatPrompt } from "../dist/main/heartbeat.js";
import { clipToolOutput, runMemberTask } from "../dist/main/member-runner.js";

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "lynn-flow-"));
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

test("工单列表缓存：写盘后立刻能读到新状态（不会拿旧快照糊界面）", () => {
  const root = tmp();
  const store = new TaskStore(root);
  store.create({ id: "task-1", title: "一", teamId: "t1" });
  assert.equal(store.list().length, 1);
  // 连续读走缓存，但数据必须还是那一份
  assert.equal(store.list()[0].status, "backlog");
  // 写之后立刻读：缓存必须已失效（否则界面要等到下一次轮询才更新）
  store.transition("task-1", "todo");
  assert.equal(store.list().find((t) => t.id === "task-1")?.status, "todo");
  store.create({ id: "task-2", title: "二", teamId: "t1" });
  assert.equal(store.list().length, 2, "新建的单要立刻出现在列表里");
});

test("回合进行中落卡：她的实时输出卡始终留在末尾（历史消息不往下插）", async () => {
  const { kernel } = setup();
  try {
    await kernel.init();
    const live = kernel.card({ kind: "lynn", text: "我先看一下", streaming: true });
    kernel.liveCard = live;
    kernel.card({ kind: "system", text: "已写好群公告" });
    kernel.card({ kind: "tool", badge: "派单", title: "审计员 开工 · task-1", body: "开始" });
    const feed = kernel.handle("session.snapshot").feed;
    assert.equal(feed[feed.length - 1].id, live.id, "她的那张卡必须还在最后一条");
    assert.ok(
      feed.findIndex((c) => /群公告/.test(c.text ?? "")) < feed.findIndex((c) => c.id === live.id),
      "开始阶段落的卡要排在她的话之前，不能穿插到下面",
    );
  } finally {
    await kernel.dispose();
  }
});

test("打回轮次以工单为准：账本里有历史记录也不会提前判「已达上限」", async () => {
  const root = tmp();
  seedModel(root);
  seedTeam(root);
  const tasks = new TaskStore(root);
  const teams = new TeamStore(root);
  tasks.create({ id: "task-1", title: "对账", teamId: "t1", member: "审计员" });
  tasks.transition("task-1", "todo");
  tasks.transition("task-1", "in_progress", { member: "审计员" });
  tasks.transition("task-1", "in_review", { member: "审计员" });
  // 派单账本里堆了 2 条历史打回记录（旧版本残留 / 别处记过）
  for (let i = 0; i < 2; i += 1) {
    teams.appendAssignment("t1", {
      taskId: "task-1",
      at: new Date().toISOString(),
      kind: "reject",
      member: "审计员",
      text: JSON.stringify({ what: "旧记录", expect: "旧", deadline: "旧" }),
    });
  }
  const reason = { what: "结论缺依据", expect: "补两条原始数据", deadline: "1 小时内" };
  // 工单只打回过 0 次 → 这次是第 1 轮，不该被账本的历史条数顶到上限
  assert.equal(tasks.reject("task-1", reason).record.rejectRounds, 1);
  // 上限判定按工单轮次走（3 轮）；这里从 2 开始只是"还差一轮"，不是已经到顶
  const tools = new ManagementTools(teams, root);
  assert.equal(
    tools.acceptOrReject("t1", "task-1", "reject", { member: "审计员", rejectReason: reason, priorRejects: 2 }).escalated,
    false,
    "第 2 轮不该判上限",
  );
  assert.equal(
    tools.acceptOrReject("t1", "task-1", "reject", { member: "审计员", rejectReason: reason, priorRejects: 3 }).escalated,
    true,
    "第 3 轮才到上限",
  );
});

test("打回后工单回到执行中（真的重做），不是停在卡住", async () => {
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
    const out = kernel.runTool("accept_or_reject", {
      teamId: "t1",
      taskId: "task-1",
      member: "审计员",
      verdict: "reject",
      what: "结论缺依据",
      expect: "补两条原始数据",
      deadline: "1 小时内",
      failedChecks: ["结论有出处"],
    });
    assert.doesNotMatch(String(out), /已达上限/, "第 1 轮打回不该报上限");
    const rec = tasks.get("task-1");
    assert.equal(rec.status, "in_progress", "打回后要回到执行中重做");
    assert.equal(rec.rejectRounds, 1);
    assert.deepEqual(rec.reworkFocus?.items, ["结论有出处"], "未过项要记在单上，重派只重做这几条");
  } finally {
    await kernel.dispose();
  }
});

test("验收归档后的系统汇总：报清轮次与交付物，不再只说「已验收」", async () => {
  const { kernel, tasks } = setup();
  try {
    await kernel.init();
    kernel.memberChatFn = scriptedChat([
      { toolCalls: [tc("1", "write_file", { path: "report.md", content: "# 报告\n两条隐患" })] },
      { toolCalls: [tc("2", "submit_report", { text: "审计完成", evidence: ["report.md"] })] },
    ]);
    assign(kernel, "task-1");
    start(kernel, "task-1");
    await until(() => tasks.get("task-1")?.status === "in_review", 8000, "回报进待审查");
    kernel.runTool("read_artifact", { taskId: "task-1" });
    kernel.runTool("accept_or_reject", { teamId: "t1", taskId: "task-1", member: "审计员", verdict: "accept" });
    const live = kernel.card({ kind: "lynn", text: "", streaming: true });
    kernel.liveCard = live;
    kernel.settleAssistant(live, "");
    const report = kernel.handle("session.snapshot").feed.find((c) => c.badge === "汇报");
    assert.ok(report, "应有系统汇总卡");
    assert.match(report.body ?? "", /第 1 轮/, "要报清这是第几轮做出来的");
    assert.match(report.body ?? "", /交付物/, "要列交付物");
  } finally {
    await kernel.dispose();
  }
});

test("成员开工第一句就把授权写清（写哪、只能读哪、几轮）", async () => {
  const wd = fs.mkdtempSync(path.join(os.tmpdir(), "lynn-auth-"));
  const seen = [];
  let i = 0;
  const chat = async (input) => {
    seen.push({ tools: input.tools.map((t) => t.function.name), firstUser: String(input.messages[1]?.content ?? "") });
    const script = [
      { toolCalls: [tc("1", "write_file", { path: "out.md", content: "结果" })] },
      { toolCalls: [tc("2", "write_file", { path: "out2.md", content: "结果2" })] },
      { toolCalls: [tc("3", "submit_report", { text: "完成", evidence: ["out.md"] })] },
    ];
    const step = script[Math.min(i++, script.length - 1)];
    input.messages.push({ role: "assistant", content: step.content ?? null, tool_calls: step.toolCalls });
    for (const c of step.toolCalls) input.messages.push({ role: "tool", tool_call_id: c.id, name: c.name, content: "（占位）" });
    return { content: step.content ?? "", toolCalls: step.toolCalls, promptTokens: 10, completionTokens: 5 };
  };
  const r = await runMemberTask({
    profile: {
      name: "林工",
      role: "数据整理员",
      goal: "整理数据",
      boundaries: ["只动工作区"],
      tools: ["write_file"],
      model: "m",
      limits: { maxTurns: 3, budgetTokens: 100000, wallClockMin: 10 },
      outputContract: { deliverable: "out.md", evidence: ["产物"], acceptance: ["文件存在"] },
      escalateWhen: "",
      body: "",
    },
    brief: "【目标】写两份结果",
    deadline: "今天",
    tools: ["write_file"],
    maxTurns: 3,
    workdir: wd,
    readRoots: () => [],
    model: { baseUrl: "http://x", apiKey: "k", model: "m" },
    chatFn: chat,
  });
  assert.equal(r.status, "reported");
  assert.match(seen[0].firstUser, /【本次授权】/, "第一句话就要有授权清单");
  assert.match(seen[0].firstUser, /写入范围/, "要写清只能写工作区");
  assert.match(seen[0].firstUser, /轮次上限/, "要让成员知道还剩几轮");
  // 缓存纪律：工具定义整段不变（最后一轮也不许收窄，否则前缀缓存全废）
  const base = seen[0].tools.slice().sort().join(",");
  for (const round of seen) {
    assert.equal(round.tools.slice().sort().join(","), base, "每轮工具定义必须一致");
  }
});

test("工具输出过长：头尾保留、中间注明省略（别把上下文与缓存撑爆）", () => {
  const short = "only a little";
  assert.equal(clipToolOutput(short), short);
  const long = "A".repeat(20_000);
  const clipped = clipToolOutput(long);
  assert.ok(clipped.length < long.length, "必须真的变短");
  assert.ok(clipped.startsWith("A".repeat(100)), "开头保留");
  assert.ok(clipped.endsWith("A".repeat(100)), "结尾保留（报错/汇总常在尾部）");
  assert.match(clipped, /已省略/);
});

test("一张单只有一张进度卡（此前单张单刷到 31 张，148/200 条都是进度）", async () => {
  const { kernel, tasks } = setup();
  try {
    await kernel.init();
    const steps = Array.from({ length: 6 }, (_, i) => ({ toolCalls: [tc(String(i), "list_dir", { path: "." })] }));
    kernel.memberChatFn = scriptedChat([
      ...steps,
      { toolCalls: [tc("9", "submit_report", { text: "列完了", evidence: [] })] },
    ]);
    assign(kernel, "task-1");
    start(kernel, "task-1");
    await until(() => tasks.get("task-1")?.status === "in_review" || !kernel.memberRuns.has("task-1"), 15000, "成员跑完");
    const feed = kernel.handle("session.snapshot").feed;
    const progress = feed.filter((c) => c.badge === "进度" && c.jobId === "task-1");
    assert.equal(progress.length, 1, `同一张单只该有一张进度卡，实际 ${progress.length} 张`);
    const lines = String(progress[0].body ?? "").split("\n").filter((l) => l.trim());
    assert.ok(lines.length <= 8, `进度卡正文要滚动截断（最多 8 行），实际 ${lines.length} 行`);
  } finally {
    await kernel.dispose();
  }
});

test("重派时把上一轮做过什么交接给成员（否则它从 list_dir 重新开始）", async () => {
  const { kernel, tasks } = setup();
  try {
    await kernel.init();
    tasks.create({ id: "task-1", title: "审一遍", teamId: "t1", member: "审计员" });
    tasks.transition("task-1", "todo");
    tasks.transition("task-1", "in_progress", { member: "审计员" });
    tasks.transition("task-1", "blocked", { member: "审计员", blockedReason: "no_report" });
    // 上一轮留下的现场：它把目录树列了一遍、又 grep 了一遍，就是没写文件
    kernel.memberTrail.set("task-1", ["list_dir：docs", "grep：卡顿 → 无匹配行", "list_dir：docs/notes"]);
    const r = kernel.runTool("assign_task", {
      teamId: "t1",
      taskId: "task-1",
      reworkTaskId: "task-1",
      member: "审计员",
      brief: "【目标】审一遍并写报告\n【完成标准】输出 report.md\n【材料与位置】工作区\n【限制】只读不改源",
      deadline: "30 分钟",
    });
    assert.notEqual(r.ok, false, `重派应成功：${JSON.stringify(r)}`);
    const plan = [...kernel.pendingPlans.values()].find((p) => p.taskId === "task-1");
    assert.ok(plan, "重做应生成契约（等待用户点开始）");
    assert.match(plan.brief, /【上一轮交接/, "重派要给上一轮轨迹，别让它从零重查");
    assert.match(plan.brief, /list_dir：docs/);
    assert.match(plan.brief, /不要再重复勘察/);
  } finally {
    await kernel.dispose();
  }
});

function memberProfile(overrides = {}) {
  return {
    name: "林工",
    role: "勘察员",
    goal: "查清并落盘",
    boundaries: ["只动工作区"],
    tools: ["read_file", "list_dir", "write_file"],
    model: "m",
    limits: { maxTurns: 6, budgetTokens: 100000, wallClockMin: 20 },
    outputContract: { deliverable: "out.md", evidence: ["产物"], acceptance: ["文件存在"] },
    escalateWhen: "",
    body: "",
    ...overrides,
  };
}

test("成员跑 3 轮还没落盘 → 明确催它先写一版（日志：1451 次调用里只有 19 次写文件）", async () => {
  const wd = fs.mkdtempSync(path.join(os.tmpdir(), "lynn-nudge-"));
  const prompts = [];
  let i = 0;
  const chat = async (input) => {
    prompts.push(input.messages.filter((m) => m.role === "user").map((m) => String(m.content)).join("\n---\n"));
    const script = [
      { toolCalls: [tc("1", "list_dir", { path: "." })] },
      { toolCalls: [tc("2", "list_dir", { path: "docs" })] },
      { toolCalls: [tc("3", "list_dir", { path: "src" })] },
      { toolCalls: [tc("4", "list_dir", { path: "lib" })] },
      { toolCalls: [tc("5", "submit_report", { text: "【受阻】材料看完了", evidence: [] })] },
    ];
    const step = script[Math.min(i++, script.length - 1)];
    input.messages.push({ role: "assistant", content: null, tool_calls: step.toolCalls });
    for (const c of step.toolCalls) input.messages.push({ role: "tool", tool_call_id: c.id, name: c.name, content: "（占位）" });
    return { content: "", toolCalls: step.toolCalls, promptTokens: 10, completionTokens: 5 };
  };
  const r = await runMemberTask({
    profile: memberProfile(),
    brief: "【目标】写出 out.md",
    deadline: "今天",
    tools: ["read_file", "list_dir", "write_file"],
    maxTurns: 6,
    workdir: wd,
    readRoots: () => [],
    model: { baseUrl: "http://x", apiKey: "k", model: "m" },
    chatFn: chat,
  });
  assert.equal(r.status, "reported");
  assert.ok(
    prompts.some((p) => /还没写出任何文件/.test(p)),
    "3 轮没落盘必须提醒它先写一版",
  );
});

test("成员写了文件但回报里没列 → 交付物按实际写盘补录（产物不再看不见）", async () => {
  const wd = fs.mkdtempSync(path.join(os.tmpdir(), "lynn-deliver-"));
  const chat = scriptedChat([
    { toolCalls: [tc("1", "write_file", { path: "out.md", content: "# 结果\n三条结论" })] },
    { toolCalls: [tc("2", "submit_report", { text: "【完成】写好了", evidence: [] })] },
  ]);
  const r = await runMemberTask({
    profile: memberProfile(),
    brief: "【目标】写出 out.md",
    deadline: "今天",
    tools: ["read_file", "list_dir", "write_file"],
    maxTurns: 6,
    workdir: wd,
    readRoots: () => [],
    model: { baseUrl: "http://x", apiKey: "k", model: "m" },
    chatFn: chat,
  });
  assert.equal(r.status, "reported");
  assert.deepEqual(r.deliverables, ["out.md"], "它自己没列，但文件真写了，系统要补录");
  assert.deepEqual(r.producedFiles, ["out.md"]);
});

test("墙钟预算过半会提醒先落盘（避免核实到最后一秒、一个文件都没写）", async () => {
  const wd = fs.mkdtempSync(path.join(os.tmpdir(), "lynn-budget-"));
  const prompts = [];
  let i = 0;
  const chat = async (input) => {
    prompts.push(input.messages.filter((m) => m.role === "user").map((m) => String(m.content)).join("\n---\n"));
    await new Promise((r) => setTimeout(r, 120));
    const step =
      i++ === 0
        ? { toolCalls: [tc("1", "list_dir", { path: "." })] }
        : { toolCalls: [tc("2", "submit_report", { text: "【受阻】没写完", evidence: [] })] };
    input.messages.push({ role: "assistant", content: null, tool_calls: step.toolCalls });
    for (const c of step.toolCalls) input.messages.push({ role: "tool", tool_call_id: c.id, name: c.name, content: "（占位）" });
    return { content: "", toolCalls: step.toolCalls, promptTokens: 10, completionTokens: 5 };
  };
  const r = await runMemberTask({
    profile: memberProfile(),
    brief: "【目标】写出 out.md",
    deadline: "今天",
    tools: ["read_file", "list_dir", "write_file"],
    maxTurns: 6,
    // 0.003 分钟 = 180ms：第一轮跑完就过半
    budgetMinutes: 0.003,
    workdir: wd,
    readRoots: () => [],
    model: { baseUrl: "http://x", apiKey: "k", model: "m" },
    chatFn: chat,
  });
  assert.equal(r.status, "reported");
  assert.ok(
    prompts.some((p) => /时间已用一半|时间只剩约/.test(p)),
    "墙上时间过半必须提醒先落盘",
  );
});

test("验收员没验完：明确交回风铃，不让单子挂在待审里没人管", async () => {
  const root = tmp();
  seedModel(root);
  const teams = new TeamStore(root);
  teams.createTeam("t1", "交付小组");
  const base = {
    role: "勘察",
    goal: "查清并落盘",
    boundaries: ["只动工作区"],
    tools: ["read_file", "list_dir", "write_file"],
    model: "test-model",
    limits: { maxTurns: 8, budgetTokens: 100000, wallClockMin: 25 },
    outputContract: { deliverable: "out.md", evidence: ["产物"], acceptance: ["文件存在"] },
    escalateWhen: "",
    body: "",
  };
  teams.writeMember("t1", { ...base, name: "执行员" });
  teams.writeMember("t1", { ...base, name: "验收员", acceptor: true, tools: ["read_file", "list_dir"] });
  const kernel = new Kernel(root);
  kernel.handle("config.prefs", { autoStart: false });
  try {
    await kernel.init();
    let who = "";
    kernel.memberChatFn = async (input) => {
      // P3-1b：简报已从 system 移到首条 user，所以「这个人是谁」要看整段对话，不能只看 messages[0]
      who = input.messages.map((m) => String(m.content ?? "")).join("\n");
      if (who.includes("常驻验收员")) throw new Error("No audio was received"); // 模拟验收员模型调用失败
      const step =
        input.messages.filter((m) => m.role === "tool").length === 0
          ? { toolCalls: [tc("1", "write_file", { path: "out.md", content: "# 结论\n三条" })] }
          : { toolCalls: [tc("2", "submit_report", { text: "【完成】写好了", evidence: ["out.md"], deliverables: ["out.md"] })] };
      input.messages.push({ role: "assistant", content: null, tool_calls: step.toolCalls });
      for (const c of step.toolCalls) input.messages.push({ role: "tool", tool_call_id: c.id, name: c.name, content: "（占位）" });
      return { content: "", toolCalls: step.toolCalls, promptTokens: 10, completionTokens: 5 };
    };
    kernel.runTool("assign_task", {
      teamId: "t1",
      taskId: "task-1",
      member: "执行员",
      brief: "【目标】写 out.md\n【完成标准】文件存在且有结论\n【材料与位置】工作区\n【限制】只读不改源",
      acceptance: ["文件存在", "有结论", "结论可核对"],
      deadline: "30 分钟",
    });
    start(kernel, "task-1");
    await until(
      () =>
        kernel
          .handle("session.snapshot")
          .feed.some((c) => /验收员没验完/.test(c.text ?? "")),
      15000,
      "验收员失败的说明卡",
    );
    const feed = kernel.handle("session.snapshot").feed;
    const note = feed.find((c) => /验收员没验完/.test(c.text ?? ""));
    assert.ok(note, "验收员跑挂了必须明确交回风铃");
    assert.match(note.text, /待审查|待审/, "要说清这张单还停在哪");
  } finally {
    await kernel.dispose();
  }
});

test("心跳巡检带着现场摘要，不再是光秃秃的成员名字", () => {
  const facts = collectHeartbeatFacts({
    tasks: [{ id: "task-1", title: "对账周报", status: "in_review", member: "审计员" }],
    runningTaskIds: [],
    pendingPlanTaskIds: [],
    schedules: [],
    detailOf: () => "产物 2 件 · 证据 3 项 · 上次动作 42s 前",
  });
  const text = heartbeatPrompt(facts);
  assert.match(text, /对账周报/);
  assert.match(text, /产物 2 件/, "巡检要带进度线索，她才判得出该不该重派");
  assert.match(text, /上次动作 42s 前/);
});
