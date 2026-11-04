// C1 整链路（内核级，不 mock 网络层以外的东西）：
// 派单钉 threadId → 成员后台真跑（写文件 + 带证据回报）→ 回报卡落回出发会话；
// 期间切到新会话，提示卡必须点名"还有 1 张单在后台跑"并给停机动作；
// task.cancelAll 要真能停，且停止卡也归出发会话。
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Kernel } from "../dist/main/kernel.js";
import { TeamStore } from "../dist/main/team-store.js";
import { TaskStore } from "../dist/main/task-store.js";

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "lynn-e2e-"));

/** 明文 Key 的模型配置：loadApiKey 对 encrypted=false 直接读 data */
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

function seedTeam(root) {
  const teams = new TeamStore(root);
  teams.createTeam("t1", "月报突击队");
  teams.writeMember("t1", {
    name: "林工",
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

const tc = (id, name, args) => ({ id, name, arguments: JSON.stringify(args) });

/** 假模型：写文件 → 带证据回报（与 member-runner 单测同构，但这次走内核派单） */
function scriptedChat(script) {
  let i = 0;
  return async (input) => {
    const step = script[Math.min(i++, script.length - 1)];
    input.messages.push({ role: "assistant", content: step.content ?? null, tool_calls: step.toolCalls ?? [] });
    for (const call of step.toolCalls ?? []) {
      input.messages.push({ role: "tool", tool_call_id: call.id, name: call.name, content: "（工具结果占位）" });
    }
    return { content: step.content ?? "", toolCalls: step.toolCalls ?? [], promptTokens: 10, completionTokens: 5 };
  };
}

/** 永不交活的慢成员：每 120ms 写一个文件，用来验"停得下来" */
function slowChat(delay = 120) {
  let i = 0;
  return async () => {
    await new Promise((r) => setTimeout(r, delay));
    i += 1;
    return {
      content: "",
      toolCalls: [tc(`slow-${i}`, "write_file", { path: `step-${i}.md`, content: "…" })],
      promptTokens: 5,
      completionTokens: 5,
    };
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
  return { root, kernel: new Kernel(root), tasks: new TaskStore(root) };
}

const assign = (kernel, taskId, member = "林工") =>
  kernel.runTool("assign_task", { teamId: "t1", taskId, member, brief: "整理 9 月材料出月报", deadline: "30 分钟" });

const start = (kernel, taskId) => {
  const plan = kernel.handle("session.snapshot").board.decisions.find((d) => d.kind === "plan" && d.jobId === taskId);
  assert.ok(plan, `应有 ${taskId} 的任务契约`);
  assert.equal(kernel.handle("decision.resolve", { id: plan.id, action: "start" }).ok, true);
};

test("C1：跨会话派单 → 后台回报落回出发会话；新会话点名在跑的单并给停机动作", async () => {
  const { root, kernel, tasks } = setup();
  try {
    await kernel.init();
    kernel.memberChatFn = scriptedChat([
      { toolCalls: [tc("1", "write_file", { path: "report.md", content: "# 月报\nGMV 100.00" })] },
      { toolCalls: [tc("2", "submit_report", { text: "月报完成，数字来自源表", evidence: ["report.md"] })] },
    ]);

    const threadA = kernel.handle("session.snapshot").thread.id;
    assign(kernel, "task-1");
    start(kernel, "task-1"); // 派单即开工
    assert.deepEqual(kernel.runningTaskIds(), ["task-1"], "成员应真的在跑");
    assert.equal(tasks.get("task-1").threadId, threadA, "派单要钉住出发会话");

    // 用户切到新会话——此时后台还在跑
    const created = kernel.handle("session.new");
    assert.notEqual(created.threadId, threadA);
    const notice = kernel.handle("session.snapshot").feed.find((c) => (c.text ?? "").includes("新会话已开始"));
    assert.ok(notice, "新会话应有系统卡");
    assert.equal(notice.action, "stopRunning", "有单在跑就必须给停机动作");
    assert.match(notice.text, /1 张单在后台跑/);

    // 等后台真跑完并登记
    await until(() => tasks.get("task-1").status === "in_review", 8000, "成员回报进待审查");
    assert.equal(kernel.runningTaskIds().length, 0, "回报之后不再算在跑");
    // 成员的工作区＝会话项目目录（可读写）；不是任务隔离目录
    const wsRoot = kernel.handle("session.snapshot").board.track.find((t) => t.id === "task-1")?.workspaceRoot;
    assert.ok(wsRoot, "工单要记下成员工作区");
    assert.ok(fs.existsSync(path.join(wsRoot, "report.md")), "成员真把文件写进了工作区");

    // 回报卡落在出发会话 A，而不是用户正在看的 B
    const feedB = kernel.handle("session.snapshot").feed;
    assert.ok(!feedB.some((c) => c.badge === "回报"), "新会话里不该出现别处派单的回报卡");

    kernel.handle("thread.switch", { id: threadA });
    const feedA = kernel.handle("session.snapshot").feed;
    assert.ok(feedA.some((c) => c.badge === "回报" && (c.title ?? "").includes("task-1")), "回报卡回到出发会话");
  } finally {
    await kernel.dispose();
  }
});

test("C1：task.cancelAll 真停后台成员，停止卡也归出发会话", async () => {
  const { kernel, tasks } = setup();
  try {
    await kernel.init();
    kernel.memberChatFn = slowChat();
    const threadA = kernel.handle("session.snapshot").thread.id;

    assign(kernel, "task-1");
    start(kernel, "task-1");
    assert.deepEqual(kernel.runningTaskIds(), ["task-1"]);

    // 在另一个会话里点「全部停掉」
    kernel.handle("session.new");
    const r = kernel.handle("task.cancelAll");
    assert.deepEqual(r, { ok: true, stopped: 1 }, "该停的就停一张，不虚报");

    await until(() => kernel.runningTaskIds().length === 0, 6000, "成员收手");
    assert.equal(kernel.handle("task.cancelAll").stopped, 0, "没有在跑的单时如实回 0");
    assert.notEqual(tasks.get("task-1").status, "in_review", "没交活不能进待审查");

    const feedB = kernel.handle("session.snapshot").feed;
    assert.ok(!feedB.some((c) => c.badge === "已停止"), "停止卡不该写进当前会话");

    kernel.handle("thread.switch", { id: threadA });
    assert.ok(
      kernel.handle("session.snapshot").feed.some((c) => c.badge === "已停止"),
      "停止卡回到出发会话（C2 归属原则）",
    );
  } finally {
    await kernel.dispose();
  }
});
