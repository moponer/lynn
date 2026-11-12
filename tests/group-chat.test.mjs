// 群聊模式 P0（2026-11-12）：作者一等化 + @成员 + 工具层强制 @
// 锁住四件事：
//   1) @ 只能 @ 本群成员——陌生名字丢弃并如实说清（防报一个不存在的人）
//   2) 用户消息带定向标记（mentions），渲染层据此显示"这话是对谁说的"
//   3) 工具层强制 @：派单/契约卡自动点名 @成员，模型忘了写也补上
//   4) 成员交回报 → 群里以他本人名义发言（author.kind = member，带脸）
//   5) 定向说明只进当轮，不进历史（历史前缀原样，前缀缓存不被 @ 抖动打穿）
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Kernel } from "../dist/main/kernel.js";
import { TeamStore } from "../dist/main/team-store.js";

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "lynn-group-"));

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

/** 一支队伍：林工（数据整理员）是本群成员 */
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

/** 假模型：写文件 → 带证据回报 */
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

function setup() {
  const root = tmp();
  seedModel(root);
  seedTeam(root);
  const kernel = new Kernel(root);
  kernel.handle("config.prefs", { autoStart: false });
  return { root, kernel };
}

const assign = (kernel, taskId, member = "林工") =>
  kernel.runTool("assign_task", {
    teamId: "t1",
    taskId,
    member,
    brief:
      "【目标】把 9 月材料整理成月报\n【完成标准】产出月报文件，数字与源材料核对一致\n【材料与位置】材料文件在工作区\n【限制】只做 9 月，不要改源材料",
    deadline: "30 分钟",
  });

const start = (kernel, taskId) => {
  const plan = kernel.handle("session.snapshot").board.decisions.find((d) => d.kind === "plan" && d.jobId === taskId);
  assert.ok(plan, `应有 ${taskId} 的任务契约`);
  assert.equal(kernel.handle("decision.resolve", { id: plan.id, action: "start" }).ok, true);
};

async function until(fn, ms = 8000, label = "等待") {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    if (fn()) return;
    await new Promise((r) => setTimeout(r, 50));
  }
  assert.fail(`等待超时：${label}`);
}

test("群聊：@ 只认本群成员；陌生名字丢弃并如实说清", async () => {
  const { kernel } = setup();
  try {
    await kernel.init();
    assign(kernel, "task-1"); // 本群有林工了

    kernel.handle("feed.send", { text: "@林工 这段口径按季度重出；@张三 这事你来" });
    const feed = kernel.handle("session.snapshot").feed;

    const user = feed.filter((c) => c.kind === "user").pop();
    assert.ok(user, "用户消息要落卡");
    assert.deepEqual(
      (user.mentions ?? []).map((m) => m.name),
      ["林工"],
      "只有本群成员能被 @",
    );
    assert.equal(user.mentions[0].kind, "member");
    assert.equal(user.mentions[0].memberId, "林工");

    const notice = feed.find((c) => c.kind === "system" && /群里没有/.test(c.text ?? ""));
    assert.ok(notice, "不存在的 @ 要如实说清，不能装作 @ 到了人");
    assert.match(notice.text, /@张三/);
  } finally {
    await kernel.dispose();
  }
});

test("群聊：派单与契约卡由工具层强制点名 @成员", async () => {
  const { kernel } = setup();
  try {
    await kernel.init();
    assign(kernel, "task-2");
    start(kernel, "task-2");

    const feed = kernel.handle("session.snapshot").feed;
    const plan = feed.find((c) => c.badge === "派单");
    assert.ok(plan, "应有派单/契约卡");
    assert.ok(
      (plan.mentions ?? []).some((m) => m.name === "林工"),
      "派单卡必须点名 @成员（工具层强制，模型忘了也补上）",
    );
    assert.match(plan.body ?? "", /@林工/, "正文也要写清是对谁说的");
    assert.equal(plan.author?.kind, "lynn", "这是风铃的动作");
  } finally {
    await kernel.dispose();
  }
});

test("群聊：成员交回报 → 群里以他本人名义发言（带头像）", async () => {
  const { kernel } = setup();
  try {
    await kernel.init();
    kernel.memberChatFn = scriptedChat([
      { toolCalls: [tc("1", "write_file", { path: "report.md", content: "# 月报\nGMV 100.00" })] },
      { toolCalls: [tc("2", "submit_report", { text: "月报完成，数字来自源表", evidence: ["report.md"] })] },
    ]);
    assign(kernel, "task-3");
    start(kernel, "task-3");

    await until(
      () => kernel.handle("session.snapshot").feed.some((c) => c.badge === "回报" && c.author?.kind === "member"),
      8000,
      "成员回报以本人名义进群",
    );
    const report = kernel.handle("session.snapshot").feed.find((c) => c.badge === "回报" && c.author?.kind === "member");
    assert.equal(report.author.name, "林工");
    assert.equal(report.author.memberId, "林工");
    assert.ok(report.author.avatarId, "成员要有脸");
    assert.equal(report.author.role, "数据整理员", "岗位要跟着人一起出现");
  } finally {
    await kernel.dispose();
  }
});

test("群聊：定向说明只进当轮，不进历史（保住前缀缓存）", async () => {
  const { kernel } = setup();
  try {
    await kernel.init();
    assign(kernel, "task-4");
    kernel.handle("feed.send", { text: "@林工 按季度重出" });

    const dir = kernel.groupDirective([{ kind: "member", name: "林工", memberId: "林工" }]);
    assert.match(dir, /林工/, "定向说明要点名");
    assert.match(dir, /nudge_member/, "定向说明要指明落地动作");

    assert.ok(
      !kernel.history.some((h) => h.content.includes("【群内定向】")),
      "定向说明不进历史（历史前缀原样，缓存命中不受 @ 抖动影响）",
    );
    assert.ok(
      kernel.history.some((h) => h.content.includes("@林工")),
      "用户原话里的 @ 要留在历史里（模型下一轮仍看得见）",
    );
  } finally {
    await kernel.dispose();
  }
});
