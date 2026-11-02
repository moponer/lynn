// 回合与权限：排队、停止、审批、决策回路（不依赖真模型）
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Kernel } from "../dist/main/kernel.js";
import { TeamStore } from "../dist/main/team-store.js";

function setup() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "lynn-turn-"));
  const kernel = new Kernel(root);
  const teams = new TeamStore(root);
  teams.createTeam("t1", "测试组");
  teams.writeMember("t1", {
    name: "林工",
    role: "整理",
    goal: "整理",
    boundaries: ["只动工作区"],
    tools: ["read_file", "write_file"],
    model: "deepseek-chat",
    limits: { maxTurns: 6, budgetTokens: 100000, wallClockMin: 10 },
    outputContract: { deliverable: "报告", evidence: ["文件"], acceptance: ["可对账"] },
    escalateWhen: "卡住",
    body: "",
  });
  return { root, kernel };
}

test("快照永远带 turn / usage / queue / prefs（界面靠它切状态）", () => {
  const { kernel } = setup();
  const snap = kernel.handle("session.snapshot");
  assert.equal(typeof snap.turn.phase, "string");
  assert.equal(snap.turn.busy, false);
  assert.equal(typeof snap.usage.contextWindow, "number");
  assert.deepEqual(snap.queue, []);
  assert.equal(typeof snap.prefs.autoStart, "boolean");
});

test("生成中再发：进队列，可撤回；插话走 steer 不进队列", () => {
  const { kernel } = setup();
  kernel.busy = true; // 模拟正在跑
  const r1 = kernel.handle("feed.send", { text: "第二条" });
  assert.equal(r1.queued, true);
  const list = kernel.handle("session.queue", { action: "list" });
  assert.equal(list.items.length, 1);
  const removed = kernel.handle("session.queue", { action: "remove", id: r1.queueId });
  assert.equal(removed.items.length, 0);

  const r2 = kernel.handle("feed.send", { text: "换个方向", mode: "steer" });
  assert.equal(r2.queued, false);
  // 没有运行时可插话时，如实告知并降级为排队（不丢这句话）
  const afterSteer = kernel.handle("session.queue", { action: "list" }).items;
  assert.equal(afterSteer.length, 1);
  const said = kernel.handle("session.snapshot").feed.at(-1);
  assert.match(said.text, /插话没送出去/);
  kernel.handle("session.queue", { action: "clear" });
  kernel.busy = false;
});

test("计划档位拒绝写类工具，只读放行", async () => {
  const { kernel } = setup();
  kernel.handle("permission.set", { mode: "plan" });
  const denied = await kernel.gateTool("assign_task", {});
  assert.match(denied, /权限档位=计划/);
  assert.equal(await kernel.gateTool("check_progress", {}), null);
});

test("询问档位：写类挂起成审批，批准后放行，拒绝后给可读理由", async () => {
  const { kernel } = setup();
  kernel.handle("permission.set", { mode: "ask" });

  const pending = kernel.gateTool("assign_task", { taskId: "WO-1" });
  const snap = kernel.handle("session.snapshot");
  const ap = snap.board.decisions.find((d) => d.kind === "approval");
  assert.ok(ap, "应有一张审批卡");

  kernel.handle("decision.resolve", { id: ap.id, action: "start" });
  assert.equal(await pending, null, "批准后应放行");

  const pending2 = kernel.gateTool("assign_task", { taskId: "WO-2" });
  const ap2 = kernel.handle("session.snapshot").board.decisions.find((d) => d.kind === "approval");
  kernel.handle("decision.resolve", { id: ap2.id, action: "reject" });
  assert.match(await pending2, /拒绝了这次/);
});

test("工具执行唯一入口：两条路径共用（计划档拒绝 / 自动档放行）", async () => {
  const { kernel } = setup();
  kernel.handle("permission.set", { mode: "plan" });
  const denied = await kernel.executeToolCall("assign_task", { teamId: "t1", taskTitle: "x", member: "林工", brief: "b" });
  assert.match(denied, /权限档位=计划/);

  kernel.handle("permission.set", { mode: "auto" });
  const started = await kernel.executeToolCall("assign_task", {
    teamId: "t1",
    taskTitle: "整理周报",
    member: "林工",
    brief: "读 csv 出第 3 节",
  });
  assert.equal(typeof started, "string");
  assert.ok(!started.includes("工具执行失败"), started);
  // 契约确认制：调用后只是"呈给用户"，不是立即开工
  assert.ok(kernel.handle("session.snapshot").board.decisions.some((d) => d.kind === "plan"));
});

test("问答回路：回答写入下一回合的输入（不吞内容）", async () => {
  const { kernel } = setup();
  const asked = kernel.runTool("ask_user", {
    question: "报告用 Markdown 还是 docx？",
    checks: [],
  });
  assert.match(asked, /等待回答/);
  const d = kernel.handle("session.snapshot").board.decisions[0];
  assert.equal(d.kind, "question");

  // 不接模型：`submitTurnIfIdle` 会先落 user 卡与 history，再起回合（失败会进 error 卡）
  kernel.handle("decision.resolve", { id: d.id, action: "answer", text: "Markdown" });
  const feed = kernel.handle("session.snapshot").feed;
  const reply = feed.find((c) => c.kind === "user" && (c.text ?? "").includes("Markdown"));
  assert.ok(reply, "回答应作为新一回合的用户消息出现");
  assert.match(reply.text, /报告用 Markdown 还是 docx/);
  assert.equal(kernel.handle("session.snapshot").board.decisions.length, 0);
});

test("命令审计落 audit.jsonl（拦截也留痕，能回查）", async () => {
  const { root, kernel } = setup();
  kernel.auditTool("t1", "WO-1", "林工", { kind: "cmd_blocked", command: "rm -rf /", why: "递归删除根目录", cwd: root });
  const lines = fs.readFileSync(path.join(root, "audit.jsonl"), "utf-8").trim().split("\n");
  const last = JSON.parse(lines.at(-1));
  assert.equal(last.kind, "cmd_blocked");
  assert.equal(last.taskId, "WO-1");
  assert.match(last.command, /rm -rf/);
});
