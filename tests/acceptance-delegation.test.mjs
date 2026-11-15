// 常驻验收员岗位（2026-11-15）：验收下沉给成员。
// 执行成员回报 → 交给本队验收员验收（风铃不读执行成员全文）；
// 验收员交【验收结论】→ 才叫醒风铃看结论拍板。队里没验收员回落老行为。
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Kernel } from "../dist/main/kernel.js";
import { TeamStore } from "../dist/main/team-store.js";
import { TaskStore } from "../dist/main/task-store.js";

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "lynn-accept-"));
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
  name: "执行员",
  role: "写报告",
  goal: "按完成标准交出报告",
  boundaries: ["只动工作区"],
  tools: ["read_file", "write_file"],
  model: "test-model",
  limits: { maxTurns: 6, budgetTokens: 100000, wallClockMin: 10 },
  outputContract: { deliverable: "report.md", evidence: ["报告文件"], acceptance: ["有结论"] },
  escalateWhen: "卡住",
  body: "",
};
const ACCEPTOR = {
  ...WORKER,
  name: "验收员",
  role: "验收把关",
  goal: "对照完成标准核对交付物",
  tools: ["read_file", "list_dir"],
  acceptor: true,
};

function seedTeam(root, withAcceptor) {
  const teams = new TeamStore(root);
  teams.createTeam("t1", "验收小组");
  teams.writeMember("t1", WORKER);
  if (withAcceptor) teams.writeMember("t1", ACCEPTOR);
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

function setup(withAcceptor) {
  const root = tmp();
  seedModel(root);
  seedTeam(root, withAcceptor);
  const kernel = new Kernel(root);
  kernel.handle("config.prefs", { autoStart: false });
  return { root, kernel, teams: new TeamStore(root), tasks: new TaskStore(root) };
}

/**
 * 判据给 3 条 = 中任务（2026-11-15 起小任务不另起验收员，验收下沉只对中/大任务生效）。
 * 这里测的是「验收下沉的路由」，不是规模判定，所以用中任务。
 */
const assign = (kernel, taskId) =>
  kernel.runTool("assign_task", {
    teamId: "t1",
    taskId,
    member: "执行员",
    brief: "【目标】写一份报告\n【完成标准】输出 report.md 且结论清楚\n【材料与位置】工作区\n【限制】只读不改源",
    deadline: "30 分钟",
    acceptance: ["report.md 存在", "结论清楚", "无占位符"],
  });

const start = (kernel, taskId) => {
  const plan = kernel.handle("session.snapshot").board.decisions.find((d) => d.kind === "plan" && d.jobId === taskId);
  assert.ok(plan, `应有 ${taskId} 的契约`);
  assert.equal(kernel.handle("decision.resolve", { id: plan.id, action: "start" }).ok, true);
};

const workerScript = [
  { toolCalls: [tc("1", "write_file", { path: "report.md", content: "# 报告\n两条隐患" })] },
  { toolCalls: [tc("2", "submit_report", { text: "审计完成：两条隐患", evidence: ["report.md"] })] },
];
const acceptorScript = [
  { toolCalls: [tc("3", "read_file", { path: "report.md" })] },
  { toolCalls: [tc("4", "submit_report", { text: "【验收结论】通过：report.md 两条隐患齐全，逐项对完成标准一致" })] },
];

/** 记录风铃被叫醒的（单，成员）——验收下沉的关键观测量 */
function spyWake(kernel) {
  const wakes = [];
  const orig = kernel.wakeLynnForReview.bind(kernel);
  kernel.wakeLynnForReview = (taskId, member, text) => {
    wakes.push(`${taskId}::${member}`);
    orig(taskId, member, text);
  };
  return wakes;
}

test("acceptor 标记随岗位档案落盘并读回（常驻验收员岗位的存储层）", () => {
  const { teams } = setup(true);
  assert.equal(teams.readMember("t1", "验收员").acceptor, true, "验收员的 acceptor 标记要落盘");
  assert.ok(!teams.readMember("t1", "执行员").acceptor, "执行成员不该带 acceptor 标记");
});

test("有验收员：执行成员回报后验收员开工，风铃不被执行成员的全文叫醒", async () => {
  const { kernel, teams, root } = setup(true);
  try {
    await kernel.init();
    kernel.memberChatFn = scriptedChat([...workerScript, ...acceptorScript]);
    const wakes = spyWake(kernel);
    assign(kernel, "task-1");
    start(kernel, "task-1");
    // 验收员开工：群里出现「验收」卡
    await until(() => kernel.handle("session.snapshot").feed.some((c) => c.badge === "验收"), 8000, "验收员开工卡");
    // 验收员交【验收结论】：自己的回报卡 + 这时才叫醒风铃
    await until(
      () => kernel.handle("session.snapshot").feed.some((c) => c.badge === "回报" && /验收员/.test(c.title ?? "")),
      8000,
      "验收员的结论卡",
    );
    await until(() => wakes.includes("task-1::验收员"), 8000, "风铃被验收员的结论叫醒");
    assert.equal(
      wakes.includes("task-1::执行员"),
      false,
      `执行成员的回报不该直接叫醒风铃（实际叫醒：${wakes.join("、") || "无"}）`,
    );
    // 验收员跑的确实是「验收」简报，不是执行简报
    const assigns = teams.readAssignments("t1", "task-1").filter((a) => a.member === "验收员");
    assert.ok(assigns.length >= 1, "验收员应有自己的派单记录");
    assert.match(assigns[0].text, /验收结论/, "验收员的简报要求以【验收结论】交回报");
  } finally {
    await kernel.dispose();
  }
});

test("没验收员：回落老行为，执行成员回报直接叫醒风铃", async () => {
  const { kernel } = setup(false);
  try {
    await kernel.init();
    kernel.memberChatFn = scriptedChat(workerScript);
    const wakes = spyWake(kernel);
    assign(kernel, "task-2");
    start(kernel, "task-2");
    await until(() => wakes.includes("task-2::执行员"), 8000, "风铃被执行成员回报叫醒（回落路径）");
    assert.equal(kernel.handle("session.snapshot").feed.some((c) => c.badge === "验收"), false, "不该有验收卡");
  } finally {
    await kernel.dispose();
  }
});
