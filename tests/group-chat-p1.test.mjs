// 群聊模式 P1（2026-11-12）：团队与群绑定 / 纯度闸 / 心跳兜底 / 群列表 / 右键菜单数据源
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Kernel } from "../dist/main/kernel.js";
import { TeamStore } from "../dist/main/team-store.js";

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "lynn-group-p1-"));

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

const member = (name, role) => ({
  name,
  role,
  goal: `把${role}的事做完`,
  boundaries: ["只动工作区"],
  tools: ["read_file", "write_file"],
  model: "test-model",
  limits: { maxTurns: 6, budgetTokens: 100000, wallClockMin: 10 },
  outputContract: { deliverable: "report.md", evidence: ["报告文件"], acceptance: ["数字可对账"] },
  escalateWhen: "卡住",
  body: "",
});

/** 两支队：t1 是本群（林工），t2 是别群（阿明） */
function seedTeams(root) {
  const teams = new TeamStore(root);
  teams.createTeam("t1", "月报突击队");
  teams.writeMember("t1", member("林工", "数据整理员"));
  teams.createTeam("t2", "竞品调研组");
  teams.writeMember("t2", member("阿明", "调研员"));
}

function setup() {
  const root = tmp();
  seedModel(root);
  seedTeams(root);
  const kernel = new Kernel(root);
  kernel.handle("config.prefs", { autoStart: false });
  return { root, kernel, teams: new TeamStore(root) };
}

const BRIEF =
  "【目标】把 9 月材料整理成月报\n【完成标准】产出月报文件，数字与源材料核对一致\n【材料与位置】材料文件在工作区\n【限制】只做 9 月，不要改源材料";

/** 用户点「开始」才真正建单——契约卡只是计划 */
const start = (kernel, taskId) => {
  const plan = kernel.handle("session.snapshot").board.decisions.find((d) => d.kind === "plan" && d.jobId === taskId);
  assert.ok(plan, `应有 ${taskId} 的任务契约`);
  assert.equal(kernel.handle("decision.resolve", { id: plan.id, action: "start" }).ok, true);
};

const assign = (kernel, taskId, teamId = "t1", who = "林工", brief = BRIEF) =>
  kernel.runTool("assign_task", {
    teamId,
    taskId,
    member: who,
    brief,
    deadline: "30 分钟",
    acceptance: ["数字可对账"],
  });

async function until(fn, ms = 5000, label = "等待") {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    if (fn()) return;
    await new Promise((r) => setTimeout(r, 50));
  }
  assert.fail(`等待超时：${label}`);
}

const tc = (id, name, args) => ({ id, name, arguments: JSON.stringify(args) });

/** 假模型：写文件 → 带证据回报（成员侧） */
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

test("群绑定：派单建队时把队绑到当前群；本群队伍优先复用", async () => {
  const { kernel, teams } = setup();
  try {
    await kernel.init();
    const threadId = kernel.currentThreadId;
    assign(kernel, "task-1");
    assert.equal(teams.readTeam("t1").threadId, threadId, "本群的队要显式绑到本群");

    // 本群已有工单 → 不传 teamId 也不该另起新队（群里不该冒出两支班底）
    const again = kernel.runTool("assign_task", {
      taskId: "task-2",
      member: "林工",
      brief: BRIEF,
      deadline: "30 分钟",
    });
    assert.doesNotMatch(again, /找不到|没有可用团队/, "本群队伍要能直接复用");
    const snap = kernel.handle("session.snapshot");
    const t2 = snap.board.track.find((t) => t.id === "task-2");
    assert.equal(t2?.teamId, "t1", "第二张单还是本群那支队");
  } finally {
    await kernel.dispose();
  }
});

test("群任务纯净性闸：本群有在办的事时，别群的队不许混进来", async () => {
  const { kernel } = setup();
  try {
    await kernel.init();
    assign(kernel, "task-1");
    const r = kernel.runTool("assign_task", {
      teamId: "t2",
      taskId: "task-x",
      member: "阿明",
      brief: BRIEF,
      deadline: "30 分钟",
    });
    assert.match(r, /另一条任务线/, "别群的活塞进本群要被拒，并说清该另开一群");
    assert.match(r, /另开一群/);
  } finally {
    await kernel.dispose();
  }
});

test("心跳兜底：群里 @ 了成员但风铃没接住 → 巡检事实里出现", async () => {
  const { kernel } = setup();
  try {
    await kernel.init();
    assign(kernel, "task-1");
    kernel.handle("feed.send", { text: "@林工 这段口径按季度重出" });

    const pending = kernel.pendingMentions();
    assert.equal(pending.length, 1, "没接住的 @ 要被心跳捞出来");
    assert.equal(pending[0].member, "林工");
    assert.match(pending[0].text, /季度/);

    // 风铃在群里回了一句 → 不再算未回应
    kernel.card({ kind: "lynn", text: "收到，我让林工按季度重出。" });
    assert.equal(kernel.pendingMentions().length, 0, "回应过就不再提醒");
  } finally {
    await kernel.dispose();
  }
});

test("群列表：最近消息摘要落进会话索引；置顶可切", async () => {
  const { kernel } = setup();
  try {
    await kernel.init();
    kernel.handle("feed.send", { text: "群里第一句：帮我核一下 Q3" });
    await until(
      () => {
        const snap = kernel.handle("session.snapshot");
        return Boolean(snap.threads.find((t) => t.id === snap.thread.id)?.lastPreview);
      },
      4000,
      "摘要落进会话索引",
    );
    const snap = kernel.handle("session.snapshot");
    const th = snap.threads.find((t) => t.id === snap.thread.id);
    assert.match(th.lastPreview, /Q3/, "摘要要有群里最后一句");

    const pin = kernel.handle("thread.pin", { id: th.id, pinned: true });
    assert.equal(pin.ok, true);
    assert.equal(pin.pinned, true);
    const after = kernel.handle("session.snapshot");
    assert.equal(after.threads.find((t) => t.id === th.id)?.pinned, true);
  } finally {
    await kernel.dispose();
  }
});

test("右键菜单的数据源：成员档案 / 工单详情 / 催办", async () => {
  const { kernel } = setup();
  try {
    await kernel.init();
    assign(kernel, "task-1");

    const prof = kernel.handle("team.member.detail", { teamId: "t1", name: "林工" });
    assert.equal(prof.ok, true);
    assert.equal(prof.profile.role, "数据整理员");
    assert.ok(prof.profile.goal, "档案要有目标");
    assert.equal(prof.job?.id, "task-1", "要能看出他手上那张单");

    const det = kernel.handle("task.detail", { taskId: "task-1" });
    assert.equal(det.ok, true);
    assert.match(det.detail.brief, /【目标】/, "简报原文要留在单上（判卷口径冻结）");
    assert.deepEqual(det.detail.acceptance, ["数字可对账"], "完成标准是派单时冻结的那版");

    // 没人跑 → 催办如实失败，不假装催到了
    const nudge = kernel.handle("task.nudge", { taskId: "task-1" });
    assert.equal(nudge.ok, false);
    assert.match(nudge.error, /没有在跑/);
  } finally {
    await kernel.dispose();
  }
});

test("多群：切回一个群不丢上下文，且各群互不串", async () => {
  const { kernel } = setup();
  try {
    await kernel.init();
    const A = kernel.handle("session.snapshot").thread.id;
    kernel.handle("feed.send", { text: "群 A 的事：核 Q3 订单" });
    const B = kernel.handle("session.new").threadId;
    kernel.handle("feed.send", { text: "群 B 的事：写周报" });

    // 切回 A：上下文要续上（Pi 侧 --continue），别让风铃"忘了"之前聊过什么
    kernel.handle("thread.switch", { id: A });
    assert.equal(kernel.createFreshSession, false, "切回有历史的群要能续上，不能强制新会话");
    assert.ok(kernel.history.length > 0, "上下文要恢复");
    assert.match(kernel.history.at(-1).content, /群 A/, "恢复的是这个群自己的上下文");
    assert.doesNotMatch(kernel.history.at(-1).content, /群 B/, "别的群的上下文不能串进来");

    // 切到空的新群：才开新会话（Pi 的 --continue 在空目录里可能报错）
    const C = kernel.handle("session.new").threadId;
    assert.equal(kernel.createFreshSession, true, "空群才开新会话");
    assert.equal(kernel.history.length, 0, "空群没有历史");
    assert.ok(C);
  } finally {
    await kernel.dispose();
  }
});

test("多群并行：群 A 的成员在跑时，群 B 照样能派单——两边同时在跑", async () => {
  const { kernel } = setup();
  try {
    await kernel.init();
    // 成员的模型慢一点，好让两个群的任务同时挂着
    kernel.memberChatFn = async (input) => {
      await new Promise((r) => setTimeout(r, 400));
      const step = { toolCalls: [tc("1", "write_file", { path: "out.md", content: "x" })] };
      input.messages.push({ role: "assistant", content: null, tool_calls: step.toolCalls });
      for (const call of step.toolCalls) {
        input.messages.push({ role: "tool", tool_call_id: call.id, name: call.name, content: "（占位）" });
      }
      return { content: "", toolCalls: step.toolCalls, promptTokens: 5, completionTokens: 5 };
    };

    const A = kernel.handle("session.snapshot").thread.id;
    assign(kernel, "task-A");
    start(kernel, "task-A");

    // 群 A 的成员还在跑，切到群 B 再派一张（各群各用自己的班底：一支队不能跨群同时干两件事）
    const B = kernel.handle("session.new").threadId;
    assign(
      kernel,
      "task-B",
      "t2",
      "阿明",
      "【目标】写 10 月周报\n【完成标准】出周报文件\n【材料与位置】工作区\n【限制】只写周报",
    );
    start(kernel, "task-B");

    const running = kernel.runningTaskIds();
    assert.ok(running.includes("task-A"), "群 A 的成员还在跑");
    assert.ok(running.includes("task-B"), "群 B 的成员同时在跑——多群不是只能有一个");
    assert.equal(kernel.currentThreadId, B, "当前站在群 B，但群 A 的活没停");
  } finally {
    await kernel.dispose();
  }
});

test("群公告（全局段）：写进去 → 风铃每轮都看得见", async () => {
  const { kernel } = setup();
  try {
    await kernel.init();
    const id = kernel.handle("session.snapshot").thread.id;
    const text = [
      "整体：核 Q3 订单",
      "林工：清洗源表，出 clean.csv",
      "小林：对账并出差异表",
      "接缝：林工的清洗结果交给小林，别两边各做一半",
      "共享写入点：q3/ 目录归小林，其他人只读",
    ].join("\n");
    const r = kernel.handle("thread.announcement", { id, text });
    assert.equal(r.ok, true);
    assert.match(r.text, /接缝/);

    // 风铃每轮都看得见它（system prompt 的本群上下文）
    const prompt = kernel.systemPrompt();
    assert.match(prompt, /本群公告/);
    assert.match(prompt, /接缝：林工的清洗结果交给小林/);

    // 快照带上（渲染层要显示）
    const snap = kernel.handle("session.snapshot");
    assert.match(snap.threads.find((t) => t.id === id)?.announcement ?? "", /共享写入点/);
  } finally {
    await kernel.dispose();
  }
});

test("群列表未读：别群有动静 → 红点 +1；切进去清零", async () => {
  const { kernel } = setup();
  try {
    await kernel.init();
    kernel.memberChatFn = scriptedChat([
      { toolCalls: [tc("1", "write_file", { path: "report.md", content: "# 月报\nGMV 100.00" })] },
      { toolCalls: [tc("2", "submit_report", { text: "月报完成，数字来自源表", evidence: ["report.md"] })] },
    ]);
    const threadA = kernel.handle("session.snapshot").thread.id;
    assign(kernel, "task-1");
    start(kernel, "task-1");

    // 切到别的群（= 离开 A）
    const created = kernel.handle("session.new");
    assert.notEqual(created.threadId, threadA, "要真的离开 A 才能算未读");

    await until(
      () => kernel.handle("session.snapshot").board.track.some((t) => t.id === "task-1" && t.status === "in_review"),
      8000,
      "成员回报进待审查",
    );

    const snap = kernel.handle("session.snapshot");
    const thA = snap.threads.find((t) => t.id === threadA);
    assert.ok((thA?.unread ?? 0) >= 1, "别群有动静 → 这个群未读 +1");

    // 切进去 = 都看过了 → 清零
    kernel.handle("thread.switch", { id: threadA });
    const after = kernel.handle("session.snapshot");
    assert.equal(after.threads.find((t) => t.id === threadA)?.unread, 0, "切进去未读清零");
  } finally {
    await kernel.dispose();
  }
});
