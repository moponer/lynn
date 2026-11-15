// 阶段账接入内核（2026-11-15）：阶段进度由代码持有，不再靠模型在上下文里记。
//
// 实机背景：写作/办公类任务里顺序混乱、反复重派——阶段只存在于模型记忆，
// 上下文一压缩就重来一遍。这里锁死四件事：
//  ① 阶段清单按规模/型态取（小任务不架三支队）；
//  ② 派单落阶段账、开工推进「契约」、成员回报推进「产出」；
//  ③ 通过 → 独立验收 → 全阶段齐了由代码收尾；
//  ④ 打回 → 只把产出段拉回执行中，未过项记在单上并带进重派简报。
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Kernel } from "../dist/main/kernel.js";
import { TeamStore } from "../dist/main/team-store.js";
import { TaskStore } from "../dist/main/task-store.js";
import {
  createStagePlan,
  completeStage,
  finalizeStagePlan,
  reopenStage,
  stageDefsFor,
  stageLine,
} from "../dist/main/stage-plan.js";

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "lynn-stage-"));
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

const WORKER = {
  name: "写作者",
  role: "写稿",
  goal: "按判据交稿",
  boundaries: ["只动工作区"],
  tools: ["read_file", "write_file"],
  model: "test-model",
  limits: { maxTurns: 6, budgetTokens: 100000, wallClockMin: 10 },
  outputContract: { deliverable: "稿子", evidence: ["稿件文件"], acceptance: ["主题清楚"] },
  escalateWhen: "卡住",
  body: "",
};

function setup({ withAcceptor = false } = {}) {
  const root = tmp();
  seedModel(root);
  const teams = new TeamStore(root);
  teams.createTeam("t1", "写作小组");
  teams.writeMember("t1", WORKER);
  if (withAcceptor) {
    teams.writeMember("t1", { ...WORKER, name: "验收员", role: "验收", acceptor: true, tools: ["read_file"] });
  }
  const kernel = new Kernel(root);
  kernel.handle("config.prefs", { autoStart: false });
  return { root, kernel, teams, tasks: new TaskStore(root) };
}

const BRIEF_MEDIUM = [
  "【目标】写一篇赞叹秋季的散文，落到 article.md",
  "【完成标准】主题句明确；至少有 3 处季节意象；通读无占位符",
  "【材料与位置】无外部材料，直接在工作区产出",
  "【限制】不要写诗，不要套模板，不要出现 TODO",
].join("\n");

const ASSIGN_MEDIUM = {
  teamId: "t1",
  member: "写作者",
  brief: BRIEF_MEDIUM,
  deadline: "30 分钟",
  acceptance: ["主题句清楚", "季节意象不少于 3 处", "通读无占位符"],
};

const start = (kernel, taskId) => {
  const plan = kernel.handle("session.snapshot").board.decisions.find((d) => d.kind === "plan" && d.jobId === taskId);
  assert.ok(plan, `应有 ${taskId} 的契约`);
  assert.equal(kernel.handle("decision.resolve", { id: plan.id, action: "start" }).ok, true);
};

const until = async (fn, ms = 9000, label = "条件") => {
  const started = Date.now();
  while (Date.now() - started < ms) {
    if (fn()) return;
    await new Promise((r) => setTimeout(r, 50));
  }
  assert.fail(`等待超时：${label}`);
};

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

const WORKER_SCRIPT = [
  { toolCalls: [tc("1", "write_file", { path: "article.md", content: "# 秋\n秋风起，稻穗低垂。三处意象：稻穗、晚霞、桂香。" })] },
  {
    toolCalls: [
      tc("2", "submit_report", {
        text: "【完成】散文已写好",
        deliverables: ["article.md"],
        evidence: ["article.md"],
        checks: [
          { name: "主题句清楚", pass: true, evidence: "article.md 首段" },
          { name: "季节意象不少于 3 处", pass: true, evidence: "稻穗/晚霞/桂香" },
          { name: "通读无占位符", pass: true },
        ],
      }),
    ],
  },
];

test("阶段模板跟规模/型态走：小任务 3 段、中任务 4 段、探索型只到结论", () => {
  assert.deepEqual(
    stageDefsFor({ scale: "small", mode: "execute" }).map((s) => s.id),
    ["contract", "produce", "report"],
    "小任务不该有独立验收段（一次散文不值一次完整执行）",
  );
  assert.deepEqual(
    stageDefsFor({ scale: "medium", mode: "execute" }).map((s) => s.id),
    ["contract", "produce", "verify", "report"],
  );
  assert.deepEqual(
    stageDefsFor({ scale: "large", mode: "explore" }).map((s) => s.id),
    ["contract", "survey", "report"],
    "探索型要结论与依据，不硬凑产物",
  );
  // 每段都得有可核对的完成判据，否则"阶段完成"又变成主观判定
  for (const d of stageDefsFor({ scale: "large", mode: "execute" })) assert.ok(d.acceptance.trim().length > 4);
});

test("打回重做只动那一段：下游退 pending、轮次 +1、证据清空", () => {
  let p = createStagePlan("p", "写作", stageDefsFor({ scale: "medium", mode: "execute" }));
  p = completeStage(p, "contract", ["契约已定"]);
  p = completeStage(p, "produce", ["article.md 落盘"]);
  assert.equal(p.stages.find((s) => s.id === "verify").status, "active");
  const reopened = reopenStage(p, "produce", "打回：意象只有 1 处");
  const produce = reopened.stages.find((s) => s.id === "produce");
  assert.equal(produce.status, "active", "产出段回到执行中");
  assert.equal(produce.round, 1, "轮次记在同一段上，不新建阶段");
  assert.deepEqual(produce.evidence, []);
  assert.equal(reopened.stages.find((s) => s.id === "verify").status, "pending", "验收必须重来");
  assert.match(stageLine(reopened), /产出落盘/);

  // 已收尾的单被用户重开再来一轮：收尾标记必须撤销（否则出现"已收尾但仍在跑"的矛盾态）
  let fin = createStagePlan("p2", "写作", stageDefsFor({ scale: "medium", mode: "execute" }));
  for (const id of ["contract", "produce", "verify", "report"]) fin = completeStage(fin, id, [`${id}-ok`]);
  fin = finalizeStagePlan(fin);
  const again = reopenStage(fin, "produce", "用户重开：稿子要改");
  assert.equal(again.finalized, false);
  assert.equal(again.stages.find((s) => s.id === "produce").status, "active");
});

test("派单落阶段账，开工推进契约，查进度带阶段而不是让人自己数", async () => {
  const { kernel, tasks } = setup();
  try {
    await kernel.init();
    kernel.runTool("assign_task", { ...ASSIGN_MEDIUM, taskId: "task-s1" });
    const rec = tasks.get("task-s1");
    assert.ok(rec.stagePlan, "派单就该把阶段清单落单");
    assert.equal(rec.stagePlan.stages[0].id, "contract");
    assert.equal(rec.stagePlan.stages[0].status, "active", "建单时只有契约段在执行");
    assert.equal(rec.scale, "medium", "规模要落单（小任务验收下沉靠它）");
    start(kernel, "task-s1");
    const after = tasks.get("task-s1");
    assert.equal(after.stagePlan.stages.find((s) => s.id === "contract").status, "done", "用户点开始 = 契约段完成");
    assert.equal(after.stagePlan.stages.find((s) => s.id === "produce").status, "active");
    const poll = kernel.runTool("check_progress", { taskId: "task-s1" });
    assert.match(poll, /阶段 1\/4/, "查进度直接给「阶段 x/y」，不让模型自己数");
    // 界面读同一份阶段账（2026-11-15）：台账一行就能看见走到第几段，不用点开问风铃
    const track = kernel.handle("session.snapshot").board.track.find((t) => t.id === "task-s1");
    assert.ok(track?.stage, "快照要带阶段摘要");
    assert.equal(track.stage.total, 4);
    assert.equal(track.stage.done, 1);
  } finally {
    await kernel.dispose();
  }
});

test("成员回报推进产出段；通过后验收段完成；汇报齐了由代码收尾", async () => {
  const { kernel, tasks } = setup();
  try {
    await kernel.init();
    kernel.memberChatFn = scriptedChat(WORKER_SCRIPT);
    kernel.runTool("assign_task", { ...ASSIGN_MEDIUM, taskId: "task-s2" });
    start(kernel, "task-s2");
    await until(() => tasks.get("task-s2")?.status === "in_review", 9000, "回报进待审查");
    const afterReport = tasks.get("task-s2");
    assert.equal(afterReport.stagePlan.stages.find((s) => s.id === "produce").status, "done", "成员交了活 = 产出段完成");
    assert.equal(afterReport.stagePlan.stages.find((s) => s.id === "verify").status, "active");

    kernel.runTool("read_artifact", { taskId: "task-s2" });
    const acc = kernel.runTool("accept_or_reject", { taskId: "task-s2", member: "写作者", verdict: "accept" });
    assert.match(acc, /阶段/, "验收结果要带上阶段进度");
    const afterAccept = tasks.get("task-s2");
    assert.equal(afterAccept.stagePlan.stages.find((s) => s.id === "verify").status, "done");
    assert.equal(afterAccept.stagePlan.finalized, false, "汇报还没交，不许收尾");

    kernel.runTool("report_to_user", { taskId: "task-s2", conclusion: "散文已交付并归档" });
    const afterReportUser = tasks.get("task-s2");
    assert.equal(afterReportUser.stagePlan.stages.find((s) => s.id === "report").status, "done");
    assert.equal(afterReportUser.stagePlan.finalized, true, "全阶段齐了由代码生成最终验收表");
  } finally {
    await kernel.dispose();
  }
});

test("打回：产出段拉回执行中，未过项落在单上并进重派简报", async () => {
  const { kernel, tasks } = setup();
  try {
    await kernel.init();
    kernel.memberChatFn = scriptedChat(WORKER_SCRIPT);
    kernel.runTool("assign_task", { ...ASSIGN_MEDIUM, taskId: "task-s3" });
    start(kernel, "task-s3");
    await until(() => tasks.get("task-s3")?.status === "in_review", 9000, "回报进待审查");

    kernel.runTool("read_artifact", { taskId: "task-s3" });
    const rej = kernel.runTool("accept_or_reject", {
      taskId: "task-s3",
      member: "写作者",
      verdict: "reject",
      what: "季节意象只有 1 处",
      expect: "补到 3 处且分布在正文里",
      deadline: "20 分钟",
      failedChecks: ["季节意象不少于 3 处"],
    });
    assert.match(rej, /只重做/, "要明确告诉它只重做未过项");
    const rec = tasks.get("task-s3");
    assert.equal(rec.stagePlan.stages.find((s) => s.id === "produce").status, "active", "只把产出段拉回执行中");
    assert.equal(rec.stagePlan.stages.find((s) => s.id === "verify").status, "pending", "旧验收作废");
    assert.deepEqual(rec.reworkFocus.items, ["季节意象不少于 3 处"]);

    const rework = kernel.runTool("assign_task", { ...ASSIGN_MEDIUM, taskId: "task-s3", reworkTaskId: "task-s3" });
    assert.match(rework, /本轮只重做未过项：季节意象不少于 3 处/, "重派时必须把未过项写在成员看得到的地方");
    assert.equal(tasks.get("task-s3").stagePlan.stages.length, 4, "重做不新建阶段");
  } finally {
    await kernel.dispose();
  }
});

test("小任务不另起验收员：判据少的事由风铃看核对清单拍板", async () => {
  const { kernel, tasks } = setup({ withAcceptor: true });
  try {
    await kernel.init();
    kernel.memberChatFn = scriptedChat(WORKER_SCRIPT);
    const wakes = [];
    const orig = kernel.wakeLynnForReview.bind(kernel);
    kernel.wakeLynnForReview = (taskId, member, text) => {
      wakes.push(`${taskId}::${member}`);
      orig(taskId, member, text);
    };
    kernel.runTool("assign_task", {
      teamId: "t1",
      taskId: "task-s4",
      member: "写作者",
      brief: "【目标】写一段 200 字短文\n【完成标准】有结论\n【材料与位置】工作区\n【限制】不要跑题",
      deadline: "10 分钟",
    });
    assert.equal(tasks.get("task-s4").scale, "small");
    start(kernel, "task-s4");
    await until(() => wakes.includes("task-s4::写作者"), 9000, "小任务直接叫醒风铃");
    assert.equal(
      kernel.handle("session.snapshot").feed.some((c) => c.badge === "验收"),
      false,
      "小任务不该再起一名验收员",
    );
  } finally {
    await kernel.dispose();
  }
});
