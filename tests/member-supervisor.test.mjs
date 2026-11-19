// 指挥者巡检 + 催办（2026-11-04 用户实报："光显示有个屁用，阿黎什么都不管？"）
// 期望：成员长时间没动静或反复撞边界时，风铃自己起一轮跟进；她能给成员补一句指示（不重派）。
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Kernel, supervisorCase } from "../dist/main/kernel.js";
import { TeamStore } from "../dist/main/team-store.js";

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "lynn-sup-"));

function setup() {
  const root = tmp();
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
  const teams = new TeamStore(root);
  teams.createTeam("t1", "月报突击队");
  teams.writeMember("t1", {
    name: "林工",
    role: "数据整理员",
    goal: "出月报",
    boundaries: ["只动工作区"],
    tools: ["read_file", "write_file"],
    model: "test-model",
    limits: { maxTurns: 6, budgetTokens: 100000, wallClockMin: 10 },
    outputContract: { deliverable: "report.md", evidence: ["文件"], acceptance: ["可对账"] },
    escalateWhen: "卡住",
    body: "",
  });
  const kernel = new Kernel(root);
  kernel.handle("config.prefs", { autoStart: false });
  return { root, kernel };
}

const tc = (id, name, args) => ({ id, name, arguments: JSON.stringify(args) });

function scripted(stepMs = 100) {
  let i = 0;
  const seen = [];
  const chat = async (input) => {
    seen.push(input.messages.map((m) => (typeof m.content === "string" ? m.content : "")).join("\n"));
    await new Promise((r) => setTimeout(r, stepMs));
    i += 1;
    return {
      content: "",
      toolCalls: [tc(`s-${i}`, "write_file", { path: `step-${i}.md`, content: "…" })],
      promptTokens: 1,
      completionTokens: 1,
    };
  };
  return { chat, seen };
}

async function until(fn, ms = 6000, label = "条件") {
  const started = Date.now();
  while (Date.now() - started < ms) {
    if (fn()) return;
    await new Promise((r) => setTimeout(r, 50));
  }
  assert.fail(`等待超时：${label}`);
}

function start(kernel, taskId = "task-1") {
  kernel.runTool("assign_task", { teamId: "t1", taskId, member: "林工", brief: `【目标】完成工单 ${taskId}\n【完成标准】产出结果文件，内容与源材料核对一致\n【材料与位置】材料文件在工作区\n【限制】只处理本单，不要动其他工单`, deadline: "30 分钟" });
  const plan = kernel.handle("session.snapshot").board.decisions.find((d) => d.kind === "plan" && d.jobId === taskId);
  kernel.handle("decision.resolve", { id: plan.id, action: "start" });
}

test("巡检判定：3 分钟没动静 → 跟进；撞墙 3 次 → 优先跟进；冷却期内不重复", () => {
  const now = 10_000_000;
  const noted = new Map();
  const quiet = supervisorCase([{ taskId: "A", member: "林工", quietMs: 200_000, blocked: 0 }], now, noted);
  assert.equal(quiet?.taskId, "A");
  assert.match(quiet.text, /没有任何动作/);

  const blocked = supervisorCase([{ taskId: "B", member: "探针", quietMs: 1000, blocked: 3 }], now, noted);
  assert.equal(blocked?.taskId, "B");
  assert.match(blocked.text, /被边界拦下 3 次/);

  noted.set("A", now - 60_000);
  assert.equal(supervisorCase([{ taskId: "A", member: "林工", quietMs: 200_000, blocked: 0 }], now, noted), null, "10 分钟内不重复");

  const fine = supervisorCase([{ taskId: "C", member: "林工", quietMs: 5_000, blocked: 1 }], now, noted);
  assert.equal(fine, null, "正常在跑/被拦 1 次不该打扰");
});

test("催办：nudgeMember 送进成员下一轮上下文，不重派、不中断", async () => {
  const { kernel } = setup();
  try {
    await kernel.init();
    const { chat, seen } = scripted();
    kernel.memberChatFn = chat;
    start(kernel);
    await until(() => seen.length >= 1, 5000, "成员开跑");

    const r = kernel.nudgeMember("task-1", "你只能访问任务工作区，别再去读 F:/spiker");
    assert.match(r, /已送达/);
    await until(() => seen.some((s) => s.includes("【风铃补充指示】")), 6000, "补充指示进入上下文");
    assert.ok(
      seen.some((s) => s.includes("别再去读 F:/spiker")),
      "成员下一轮必须看到这句",
    );
    assert.equal(kernel.runningTaskIds().length, 1, "催办不重启成员");
    kernel.handle("task.cancel", { taskId: "task-1" });
  } finally {
    await kernel.dispose();
  }
});

test("巡检接线：命中就落「阿黎开始跟进」卡并起内部回合；5 分钟内不刷第二张", async () => {
  const { kernel } = setup();
  try {
    await kernel.init();
    const { chat } = scripted(400);
    kernel.memberChatFn = chat;
    start(kernel);

    // 只验接线：替换 submitTurnIfIdle（巡检改为走队列），免得真去调模型
    const turns = [];
    kernel.submitTurnIfIdle = (text, opts) => {
      turns.push({ text, internal: !!opts?.internal, ephemeral: !!opts?.ephemeral });
      kernel.busy = true; // 模拟正在跑，防止第二个 tick 抢先
    };
    kernel.memberStepAt.set("task-1", Date.now() - 240_000);
    kernel.supervisorTick();

    assert.equal(turns.length, 1, "应当起一轮跟进");
    assert.equal(turns[0].internal, true, "巡检回合不冒充用户发言");
    assert.equal(turns[0].ephemeral, true, "巡检轮不落历史");
    assert.match(turns[0].text, /自动巡检|没有任何动作/);
    assert.ok(
      kernel.handle("session.snapshot").feed.some((c) => (c.text ?? "").includes("阿黎开始跟进")),
      "用户要能看到她开始管了",
    );

    kernel.busy = false;
    kernel.supervisorTick();
    assert.equal(turns.length, 1, "5 分钟节流：不允许连续起回合");
    kernel.handle("task.cancel", { taskId: "task-1" });
  } finally {
    await kernel.dispose();
  }
});

test("巡检收敛：同一张单超过上限次数就停手、交还用户（治兜圈子）", async () => {
  const { kernel } = setup();
  try {
    await kernel.init();
    const { chat } = scripted(400);
    kernel.memberChatFn = chat;
    start(kernel);

    const turns = [];
    kernel.submitTurnIfIdle = (text) => {
      turns.push(text);
      kernel.busy = false; // 每次都让它空闲，便于连续触发
    };
    // 每次都把这张单推到"静默超时"，并清掉 5 分钟节流与 10 分钟冷却，
    // 模拟"过了很久、这张单又没动静了，巡检再次命中"的场景
    const fire = (n) => {
      for (let i = 0; i < n; i += 1) {
        kernel.memberStepAt.set("task-1", Date.now() - 240_000);
        kernel.lastSupervisorAt = 0;
        kernel.supervisorNoted.clear();
        kernel.supervisorTick();
      }
    };

    // 上限是 3：前 3 次真正起回合，第 4 次起只落"停手"卡、不起回合
    fire(4);
    assert.equal(turns.length, 3, `最多自动跟进 3 次，实际 ${turns.length}`);
    const feed = kernel.handle("session.snapshot").feed;
    assert.ok(
      feed.some((c) => (c.text ?? "").includes("先停手") && (c.text ?? "").includes("等你拍板")),
      "超过上限要如实停手并交还用户，而不是无限叫醒",
    );
    kernel.handle("task.cancel", { taskId: "task-1" });
  } finally {
    await kernel.dispose();
  }
});
