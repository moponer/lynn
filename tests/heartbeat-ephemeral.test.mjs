// 巡检轮「看一眼就走」+ 工单落盘事件（2026-11-11）：
// 心跳不再把消息塞进长期 history，工单状态变化走 500ms 合并窗口。
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Kernel } from "../dist/main/kernel.js";
import { TaskStore } from "../dist/main/task-store.js";
import { TeamStore } from "../dist/main/team-store.js";

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "lynn-ephemeral-"));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

test("TaskStore：每次落盘都通知；不传回调时行为不变", () => {
  const root = tmp();
  let changes = 0;
  const store = new TaskStore(root, { onChange: () => { changes += 1; } });
  store.create({ id: "task-a", title: "甲", teamId: "t1" });
  assert.equal(changes, 1);
  store.transition("task-a", "todo");
  assert.equal(changes, 2);

  const plain = new TaskStore(tmp());
  plain.create({ id: "task-b", title: "乙", teamId: "t1" });
  assert.equal(plain.list().length, 1, "不传回调照常工作");
});

test("巡检轮：消息只服务这一轮，结束后 history 回到原样", async () => {
  const root = tmp();
  const kernel = new Kernel(root);
  const before = kernel.history.length;
  kernel.submitTurn("[自动巡检] 看一眼现状", undefined, { internal: true, ephemeral: true });
  assert.equal(kernel.history.length, before + 1, "本轮生成期间模型能看到巡检事实");
  await sleep(150);
  assert.equal(kernel.history.length, before, "轮次结束后从 history 摘掉，不累积上下文");
  kernel.dispose();
});

test("P1 巡检隔离：Pi 可用时巡检轮走直连（不进 Pi 主会话），普通轮仍走 Pi", async () => {
  const root = tmp();
  // 最小模型配置：让 runChat 能过配置闸（否则早退到 no_model，测不到路由）
  fs.writeFileSync(
    path.join(root, "settings.json"),
    JSON.stringify({ model: { provider: "mock", baseUrl: "http://127.0.0.1:9/v1", model: "m", apiKey: { encrypted: false, data: "k" }, updatedAt: new Date().toISOString() } }),
    "utf-8",
  );
  const kernel = new Kernel(root);
  kernel.piReady = true;
  let rpc = 0;
  let direct = 0;
  let patrolDirect = 0;
  kernel.runChatRpc = async () => { rpc += 1; };
  kernel.runChatDirect = async (_cfg, _key, _text, patrol = false) => {
    direct += 1;
    if (patrol) patrolDirect += 1;
  };

  kernel.submitTurn("普通一句");
  await sleep(60);
  assert.equal(rpc, 1, "普通对话仍走 Pi 主会话");
  assert.equal(direct, 0);

  const before = kernel.history.length;
  kernel.submitTurn("[自动巡检] 看一眼现状", undefined, { internal: true, ephemeral: true });
  await sleep(60);
  assert.equal(rpc, 1, "巡检轮绝不能追加到 Pi 主会话（否则 thinking/工具往返永久累积）");
  assert.equal(patrolDirect, 1, "巡检轮改走直连（history 归内核管，ephemeral 真删）");
  assert.equal(kernel.history.length, before, "巡检轮收尾后 history 回到原样");
  kernel.dispose();
});

test("工单变更：没有成员在跑时不叫醒模型（纯落库不烧 token）", async () => {
  const root = tmp();
  const teams = new TeamStore(root);
  teams.createTeam("t1", "事件组");
  teams.writeMember("t1", {
    name: "林工", role: "数据整理员", goal: "整理数据", boundaries: ["只动工作区"],
    tools: ["read_file", "list_dir"], model: "deepseek-chat",
    limits: { maxTurns: 8, budgetTokens: 120000, wallClockMin: 10 },
    outputContract: { deliverable: "报告", evidence: [], acceptance: ["可核对"] },
    escalateWhen: "卡住", body: "",
  });
  const kernel = new Kernel(root);
  kernel.handle("config.prefs", { autoStart: true });
  kernel.runTool("assign_task", {
    teamId: "t1", taskId: "task-a", title: "整理周报", member: "林工",
    brief: "【目标】整理周报\n【完成标准】产出周报\n【材料与位置】工作区\n【限制】只读",
    deadline: "周五",
  });
  await sleep(700);
  assert.equal(kernel.wakeGate.lastWakeAt, 0, "没有成员在跑，落盘不应触发模型唤醒");
  kernel.dispose();
});
