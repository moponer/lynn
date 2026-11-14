// 2026-11-12 实机复盘后的机制修复（一轮"写 Word 文档"跑了 3 遍才出真内容）：
//  1. check_progress 不给 teamId 就误报「本机还没有任何团队」→ 风铃误判成员没在跑，同一张单重派 3 次；
//  2. 成员还在跑时风铃替它写回报（"任务已重新派单，正在等待回报"被当成成员回报登记）；
//  3. 显式 maxTurns=3 让成员只够写章节骨架，随后两轮重做白烧 token；
//  4. 成员交了回报但没附证据 → 被当成"没交出回报"掉进 blocked（证据可选之后这条分支没跟着改）。
// 另含 read_artifact：验收前能读产物正文（此前只能看"文件在不在"）。
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Kernel } from "../dist/main/kernel.js";
import { TeamStore } from "../dist/main/team-store.js";
import { TaskStore } from "../dist/main/task-store.js";
import { buildDocx } from "../dist/main/docx.js";

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "lynn-flow-"));

const BRIEF =
  "【目标】写一篇四章节的漏洞文档\n【完成标准】产出 .docx，四章内容齐全\n" +
  "【材料与位置】无外部材料，全新编写\n【限制】模拟内容，不联网";

const tc = (id, name, args) => ({ id, name, arguments: JSON.stringify(args) });

function seedMember(root, teamId = "t1", name = "林工") {
  const teams = new TeamStore(root);
  if (!teams.teamExists(teamId)) teams.createTeam(teamId, `组-${teamId}`);
  teams.writeMember(teamId, {
    name,
    role: "技术文档撰写员",
    goal: "把材料写成可交付文档",
    boundaries: ["只动工作区"],
    tools: ["read_file", "write_file", "office_write_docx"],
    model: "test-model",
    limits: { maxTurns: 8, budgetTokens: 100000, wallClockMin: 10 },
    outputContract: { deliverable: "文档", evidence: ["产物"], acceptance: ["内容齐全"] },
    escalateWhen: "卡住",
    body: "",
  });
  return teams;
}

function seedModel(root) {
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
      },
      null,
      2,
    ),
    "utf-8",
  );
}

const assign = (kernel, taskId, extra = {}) =>
  kernel.runTool("assign_task", { teamId: "t1", taskId, member: "林工", brief: BRIEF, deadline: "周五", ...extra });

async function until(fn, ms = 8000, label = "条件") {
  const started = Date.now();
  while (Date.now() - started < ms) {
    if (fn()) return;
    await new Promise((r) => setTimeout(r, 50));
  }
  assert.fail(`等待超时：${label}`);
}

test("check_progress：不给 teamId 时按工单认团队，不再误报「本机还没有任何团队」", () => {
  const root = tmp();
  seedMember(root, "t1");
  seedMember(root, "t2", "王工"); // 两支活跃队 → resolveTeamId(undefined) 给不出唯一答案
  const kernel = new Kernel(root);
  kernel.handle("config.prefs", { autoStart: false });
  assign(kernel, "task-a");

  const out = kernel.runTool("check_progress", { taskId: "task-a" });
  assert.doesNotMatch(out, /本机还没有任何团队/, "工单在手就必须认得出团队");
  assert.match(out, /"assigns"/);
  // 真没有这张单时也别冒充"没团队"
  assert.match(kernel.runTool("check_progress", { taskId: "task-nope" }), /查不到这张单/);
});

test("review_result：成员还在跑时不许替它交回报", () => {
  const root = tmp();
  seedMember(root);
  const kernel = new Kernel(root);
  kernel.handle("config.prefs", { autoStart: false });
  assign(kernel, "task-a");
  kernel.memberRuns.set("task-a", {}); // 模拟成员正在执行

  const out = kernel.runTool("review_result", {
    teamId: "t1",
    taskId: "task-a",
    member: "林工",
    text: "任务已重新派单，成员正在后台执行。正在等待回报，不做提前审核。",
    evidence: [],
  });
  assert.match(out, /还在跑/);
  kernel.memberRuns.delete("task-a");

  // 空正文同样拒收
  assert.match(
    kernel.runTool("review_result", { teamId: "t1", taskId: "task-a", member: "林工", text: "   ", evidence: [] }),
    /不能为空/,
  );
});

test("assign_task：显式轮次低于 8 被抬到下限并说明（3 轮只能写出骨架）", () => {
  const root = tmp();
  seedMember(root);
  const kernel = new Kernel(root);
  kernel.handle("config.prefs", { autoStart: false });

  const reply = assign(kernel, "task-a", { maxTurns: 3 });
  assert.match(reply, /下限 8 轮/);
  const pending = [...kernel.pendingPlans.values()].find((p) => p.taskId === "task-a");
  assert.equal(pending.maxTurns, 8, "派出去的轮次必须是下限后的值");

  // 给上限以内的值照旧（不越权改大）
  assign(kernel, "task-b", { maxTurns: 12 });
  assert.equal([...kernel.pendingPlans.values()].find((p) => p.taskId === "task-b").maxTurns, 12);
});

test("read_artifact：读得到 docx 正文与表格；没有产物时如实说", () => {
  const root = tmp();
  seedMember(root);
  const kernel = new Kernel(root);
  kernel.handle("config.prefs", { autoStart: false });
  assign(kernel, "task-a");

  const artDir = path.join(root, "tasks", "task-a", "artifacts");
  fs.mkdirSync(artDir, { recursive: true });
  fs.writeFileSync(
    path.join(artDir, "周报.docx"),
    buildDocx({
      title: "漏洞文档测试",
      blocks: [
        { type: "heading", level: 1, text: "第一章 漏洞发现" },
        { type: "paragraph", text: "GMV 100.00，模拟内容" },
        { type: "table", headers: ["项", "值"], rows: [["订单", "12"]] },
      ],
    }),
  );
  const tasks = new TaskStore(root);
  tasks.setDeliverables("task-a", [
    { path: "C:\\tmp\\周报.docx", ref: "artifacts/周报.docx", at: new Date().toISOString() },
  ]);

  const out = kernel.runTool("read_artifact", { taskId: "task-a" });
  assert.match(out, /产物：artifacts\/周报\.docx/);
  assert.match(out, /第一章 漏洞发现/);
  assert.match(out, /GMV 100\.00/);
  assert.match(out, /\| 项 \| 值 \|/, "表格要按列读得出来");

  // 另一张还没产物的单：不假装读到内容
  assign(kernel, "task-b");
  assert.match(kernel.runTool("read_artifact", { taskId: "task-b" }), /还没有可读产物/);
  assert.match(kernel.runTool("read_artifact", { taskId: "task-zzz" }), /没有这张单/);
});

test("check_progress：latest 文本超 400 字截断并声明原文长度（轮询不再反复付全文的钱）", () => {
  const root = tmp();
  seedMember(root);
  const kernel = new Kernel(root);
  kernel.handle("config.prefs", { autoStart: false });

  const longText = "回报正文".repeat(200); // 800 字
  assign(kernel, "task-a"); // 走真 assign_task：工单记录与派单记录都要在
  kernel.tools.reviewResult("t1", "task-a", { member: "林工", text: longText, evidence: [] });
  const out = kernel.runTool("check_progress", { teamId: "t1", taskId: "task-a" });
  assert.match(out, /已截断：原文 800 字/, "超长文本必须带截断声明");
  assert.match(out, /read_artifact/, "截断声明要指路细读通道");
  assert.ok(!out.includes("回报正文".repeat(150)), "第 400 字之后的正文不该出现在结果里");

  // 短文本原样通过（不误伤）
  assign(kernel, "task-b");
  const short = kernel.runTool("check_progress", { teamId: "t1", taskId: "task-b" });
  assert.doesNotMatch(short, /已截断/);
});

test("read_artifact：默认读头段，超长带 offset 指路；翻页能读到文末", () => {
  const root = tmp();
  seedMember(root);
  const kernel = new Kernel(root);
  kernel.handle("config.prefs", { autoStart: false });
  assign(kernel, "task-a");

  const artDir = path.join(root, "tasks", "task-a", "artifacts");
  fs.mkdirSync(artDir, { recursive: true });
  const body = `第一章 开头。${"正文内容。".repeat(500)}`; // 2500+ 字，超过 maxChars 的 1000 字下限钳制
  fs.writeFileSync(path.join(artDir, "长文.md"), body);
  new TaskStore(root).setDeliverables("task-a", [
    { path: "C:\\tmp\\长文.md", ref: "artifacts/长文.md", at: new Date().toISOString() },
  ]);

  const first = kernel.runTool("read_artifact", { taskId: "task-a", maxChars: 100 });
  assert.match(first, /第一章 开头/);
  assert.match(first, /已截断：原文 \d+ 字/);
  const m = /offset=(\d+)/.exec(first);
  assert.ok(m, "截断尾注要给出续读 offset");

  const second = kernel.runTool("read_artifact", { taskId: "task-a", maxChars: 100000, offset: Number(m[1]) });
  assert.match(second, /从第 \d+ 字起继续读/);
  assert.match(second, /已到文末/, "翻到尾页要说明已读完");
  const page = /-{48}\n([\s\S]*)/.exec(second)[1];
  assert.ok(page.includes(body.slice(Number(m[1]))), "翻页内容必须无缝衔接第一段");
});

test("验收硬闸：有产物但没读过正文，不许直接点头", () => {
  const root = tmp();
  seedMember(root);
  const kernel = new Kernel(root);
  kernel.handle("config.prefs", { autoStart: false });
  assign(kernel, "task-a");
  const artDir = path.join(root, "tasks", "task-a", "artifacts");
  fs.mkdirSync(artDir, { recursive: true });
  fs.writeFileSync(path.join(artDir, "骨架.docx"), buildDocx({ blocks: [{ type: "paragraph", text: "占位" }] }));
  new TaskStore(root).setDeliverables("task-a", [
    { path: "C:\\tmp\\骨架.docx", ref: "artifacts/骨架.docx", at: new Date().toISOString() },
  ]);

  const blocked = kernel.runTool("accept_or_reject", { teamId: "t1", taskId: "task-a", verdict: "accept", member: "林工" });
  assert.match(blocked, /read_artifact/, "没读正文就验收必须被拦下");
  kernel.runTool("read_artifact", { taskId: "task-a" });
  assert.doesNotMatch(
    kernel.runTool("accept_or_reject", { teamId: "t1", taskId: "task-a", verdict: "accept", member: "林工" }),
    /read_artifact/,
    "读过正文后闸就开",
  );
});

test("成员交回报但没附证据：照样进待审查（不再掉进 blocked 反复重派）", async () => {
  const root = tmp();
  seedModel(root);
  seedMember(root);
  const kernel = new Kernel(root);
  kernel.handle("config.prefs", { autoStart: false });
  const tasks = new TaskStore(root);
  let i = 0;
  kernel.memberChatFn = async (input) => {
    const script = [
      { toolCalls: [tc("1", "write_file", { path: "report.md", content: "# 月报\nGMV 100.00" })] },
      { toolCalls: [tc("2", "submit_report", { text: "【完成】月报写好了，内容在工作区 report.md", evidence: [] })] },
    ];
    const step = script[Math.min(i++, script.length - 1)];
    input.messages.push({ role: "assistant", content: step.content ?? null, tool_calls: step.toolCalls ?? [] });
    for (const call of step.toolCalls ?? []) {
      input.messages.push({ role: "tool", tool_call_id: call.id, name: call.name, content: "（工具结果占位）" });
    }
    return { content: step.content ?? "", toolCalls: step.toolCalls ?? [], promptTokens: 10, completionTokens: 5 };
  };

  try {
    await kernel.init();
    assign(kernel, "task-1");
    const plan = kernel.handle("session.snapshot").board.decisions.find((d) => d.kind === "plan" && d.jobId === "task-1");
    assert.ok(plan, "应有任务契约");
    assert.equal(kernel.handle("decision.resolve", { id: plan.id, action: "start" }).ok, true);

    await until(() => tasks.get("task-1").status === "in_review", 8000, "无证据回报也要进待审查");
    assert.equal(tasks.get("task-1").evidence.length, 0);
    assert.equal(kernel.runningTaskIds().length, 0);
  } finally {
    await kernel.dispose();
  }
});

test("消耗看板：成员跑完一单，编制快照带命中率与缓存读数（界面看板的数据源）", async () => {
  const root = tmp();
  seedModel(root);
  seedMember(root);
  const kernel = new Kernel(root);
  kernel.handle("config.prefs", { autoStart: false });
  const tasks = new TaskStore(root);
  let i = 0;
  kernel.memberChatFn = async (input) => {
    const script = [
      { toolCalls: [tc("1", "write_file", { path: "report.md", content: "# 月报\nGMV 100.00" })] },
      { toolCalls: [tc("2", "submit_report", { text: "【完成】月报写好了，内容在工作区 report.md", evidence: [] })] },
    ];
    const step = script[Math.min(i++, script.length - 1)];
    input.messages.push({ role: "assistant", content: step.content ?? null, tool_calls: step.toolCalls ?? [] });
    for (const call of step.toolCalls ?? []) {
      input.messages.push({ role: "tool", tool_call_id: call.id, name: call.name, content: "（工具结果占位）" });
    }
    // DeepSeek 口径：promptTokens 含命中部分，cacheRead 单独报 → 每轮命中 60 / 输入 80
    return { content: "", toolCalls: step.toolCalls ?? [], promptTokens: 75, completionTokens: 5, cacheRead: 60, cacheWrite: 0 };
  };

  try {
    await kernel.init();
    assign(kernel, "task-1");
    const plan = kernel.handle("session.snapshot").board.decisions.find((d) => d.kind === "plan" && d.jobId === "task-1");
    assert.ok(plan);
    kernel.handle("decision.resolve", { id: plan.id, action: "start" });

    await until(() => tasks.get("task-1").status === "in_review", 8000, "成员跑完");
    const m = kernel
      .handle("session.snapshot")
      .board.teams.find((t) => t.id === "t1")
      ?.members.find((x) => x.name === "林工");
    assert.ok(m, "编制里应有林工");
    assert.equal(m.hitRate, 75, "命中率 = cacheRead(120) / 输入总量(160)，两轮各 60/80");
    assert.equal(typeof m.cacheUsed, "number");
    // 风铃读数在快照里（看板另一行）
    assert.ok(kernel.handle("session.snapshot").usage, "快照应带 usage");
  } finally {
    await kernel.dispose();
  }
});
