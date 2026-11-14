// 顾问（2026-11-14）：独立模型审一份交付，只提会返工的问题。
// 锁三件事：输出解析严格、空话/重复被滤掉、接线后失败不影响验收。
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { parseAdvisorReply, filterNotes, noteKey, severityLabel } from "../dist/main/advisor.js";
import { Kernel } from "../dist/main/kernel.js";
import { TeamStore } from "../dist/main/team-store.js";
import { TaskStore } from "../dist/main/task-store.js";

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "lynn-advisor-"));
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

// ---------- 解析 ----------

test("解析：严格 JSON 数组；带说明文字也能取；坏 JSON 返回空", () => {
  const ok = parseAdvisorReply('[{"severity":"concern","title":"结论没有数字支撑","evidence":"report.md 无表格"}]');
  assert.equal(ok.length, 1);
  assert.equal(ok[0].severity, "concern");
  assert.equal(ok[0].evidence, "report.md 无表格");

  const wrapped = parseAdvisorReply('好的，我的意见是：\n```json\n[{"severity":"blocker","title":"把没做的说成做完"}]\n```');
  assert.equal(wrapped.length, 1);
  assert.equal(wrapped[0].severity, "blocker");

  assert.deepEqual(parseAdvisorReply("看起来没问题"), []);
  assert.deepEqual(parseAdvisorReply(""), []);
  assert.deepEqual(parseAdvisorReply("[{坏}]"), []);
});

test("解析：未知 severity 归为 nit，缺 title 的条目丢弃", () => {
  const notes = parseAdvisorReply('[{"severity":"weird","title":"排版有点乱"},{"severity":"blocker"}]');
  assert.equal(notes.length, 1);
  assert.equal(notes[0].severity, "nit");
});

// ---------- 去噪与预算 ----------

test("空话一律不报（报了等于没报）", () => {
  const seen = new Map();
  const notes = filterNotes(
    [
      { severity: "concern", title: "LGTM" },
      { severity: "blocker", title: "没问题" },
      { severity: "nit", title: "Good." },
      { severity: "concern", title: "结论与证据对不上：说完成但没有产物" },
    ],
    seen,
  );
  assert.equal(notes.length, 1);
  assert.match(notes[0].title, /结论与证据对不上/);
});

test("同一句话去重；升级允许重提，降级不允许", () => {
  const seen = new Map();
  const first = filterNotes([{ severity: "nit", title: "数字口径不一致" }], seen);
  assert.equal(first.length, 1);
  // 同级/降级：被丢掉
  assert.equal(filterNotes([{ severity: "nit", title: "数字口径不一致" }], seen).length, 0);
  // 升级：允许
  const up = filterNotes([{ severity: "blocker", title: "数字口径不一致" }], seen);
  assert.equal(up.length, 1);
  assert.equal(up[0].severity, "blocker");
});

test("预算：非 blocker 每次最多 4 条，blocker 不占预算", () => {
  const notes = Array.from({ length: 7 }, (_, i) => ({ severity: i === 6 ? "blocker" : "nit", title: `问题 ${i + 1}` }));
  const out = filterNotes(notes, new Map(), 4);
  assert.equal(out.filter((n) => n.severity !== "blocker").length, 4);
  assert.equal(out.filter((n) => n.severity === "blocker").length, 1);
});

test("noteKey 归一化：标点/大小写/全角都不影响去重", () => {
  assert.equal(noteKey("Stop."), noteKey("*stop*"));
  assert.equal(noteKey("  stop  "), "stop");
  assert.equal(severityLabel("blocker"), "会返工");
});

// ---------- 内核接线 ----------

test("成员交回报 → 顾问审一次并落卡；同一单不会审第二次", async () => {
  const { kernel, tasks } = setup();
  try {
    await kernel.init();
    kernel.memberChatFn = scriptedChat([
      { toolCalls: [tc("1", "write_file", { path: "report.md", content: "# 报告\n两条隐患" })] },
      { toolCalls: [tc("2", "submit_report", { text: "审计完成：两条隐患", evidence: ["report.md"], deliverables: ["report.md"] })] },
    ]);
    let calls = 0;
    kernel.advisorChatFn = async () => {
      calls += 1;
      return {
        content: JSON.stringify([
          { severity: "concern", title: "结论没有对应的数字支撑", evidence: "回报说两条隐患，report.md 里没有编号" },
        ]),
      };
    };
    assign(kernel, "task-1");
    start(kernel, "task-1");
    await until(
      () => kernel.handle("session.snapshot").feed.some((c) => c.badge === "顾问"),
      8000,
      "顾问卡",
    );
    assert.equal(calls, 1);
    const card = kernel.handle("session.snapshot").feed.find((c) => c.badge === "顾问");
    assert.match(card.body ?? "", /值得看/);
    assert.match(card.body ?? "", /依据：/);
    assert.match(card.title ?? "", /顾问意见/);
    assert.ok(tasks.get("task-1"), "工单还在（顾问不改状态）");

    // 再调一次：同一单不重复审
    await kernel.consultAdvisorFor("task-1", kernel.currentThreadId, "again", []);
    assert.equal(calls, 1, "每单只审一次");
  } finally {
    await kernel.dispose();
  }
});

test("顾问关掉 / 调用失败：都不影响回报与工单状态", async () => {
  const { kernel, tasks } = setup();
  try {
    await kernel.init();
    kernel.handle("config.prefs", { autoStart: false, advisorEnabled: true });
    kernel.memberChatFn = scriptedChat([
      { toolCalls: [tc("1", "write_file", { path: "report.md", content: "# 报告" })] },
      { toolCalls: [tc("2", "submit_report", { text: "完成", evidence: ["report.md"] })] },
    ]);
    kernel.advisorChatFn = async () => {
      throw new Error("顾问端点 500");
    };
    assign(kernel, "task-1");
    start(kernel, "task-1");
    await until(() => tasks.get("task-1")?.status === "in_review", 8000, "回报进待审查");
    // 失败只记日志，不落"顾问看过了"的假卡
    assert.ok(!kernel.handle("session.snapshot").feed.some((c) => c.badge === "顾问"));
  } finally {
    await kernel.dispose();
  }
});
