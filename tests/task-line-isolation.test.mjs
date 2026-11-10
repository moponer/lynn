// 任务线隔离（2026-11-04 用户实报）：
// "给她一个审查 hermix 项目的新任务，她为什么用之前的超星学习攻坚组去执行？"
// 规则：一条任务线（同一会话）一支团队；跨会话/新任务不复用上一条任务线的班底，
// 要复用必须显式给 teamId，并且错误信息要说清这两条路。
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Kernel } from "../dist/main/kernel.js";
import { TeamStore } from "../dist/main/team-store.js";
import { TaskStore } from "../dist/main/task-store.js";

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "lynn-line-"));

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
  teams.createTeam("superstar", "超星学习攻坚组");
  teams.writeMember("superstar", {
    name: "小丹",
    role: "学习通执行",
    goal: "把课程刷完",
    boundaries: ["只动工作区"],
    tools: ["read_file"],
    model: "test-model",
    limits: { maxTurns: 6, budgetTokens: 100000, wallClockMin: 10 },
    outputContract: { deliverable: "截图", evidence: ["文件"], acceptance: ["可核对"] },
    escalateWhen: "卡住",
    body: "",
  });
  return { root, kernel: new Kernel(root), teams: new TeamStore(root), tasks: new TaskStore(root) };
}

const assign = (kernel, taskId, member = "小丹", extra = {}) =>
  kernel.runTool("assign_task", {
    taskId,
    member,
    brief: `【目标】完成工单 ${taskId} 的材料整理\n【完成标准】产出整理结果文件，内容与源材料核对一致\n【材料与位置】材料文件在工作区\n【限制】只处理本单 ${taskId}，不要动其他工单`,
    deadline: "30 分钟",
    ...extra,
  });

test("同一条任务线复用同团队；切到新会话后不复用上一条任务线的班底", async () => {
  const { kernel, teams } = setup();
  try {
    await kernel.init();
    // 会话 A：第一次派单，唯一在职队还没做过任务 → 复用它（不新建）
    assign(kernel, "WO-1");
    assert.equal(teams.listTeams().length, 1, "同一任务线的第一张单应复用已有班底");

    // 会话 A 内再来一张 → 仍然是同一条任务线，继续复用
    assign(kernel, "WO-2");
    assert.equal(teams.listTeams().length, 1, "同一会话的第二张单不该另起团队");

    // 切到新会话（= 新任务）→ 不许塞进上一条任务线的团队
    kernel.handle("session.new");
    const msg = assign(kernel, "WO-3");
    assert.equal(teams.listTeams().length, 2, "新任务要新班底，不能复用超星学习攻坚组");
    // 新团队里没有「小丹」：错误信息必须给两条可操作路径
    assert.match(msg, /显式传 teamId|重新 create_member/, `实际：${msg}`);
    assert.match(msg, /超星学习攻坚组/, "要指出人还在哪个团队里");
  } finally {
    await kernel.dispose();
  }
});

test("显式给 teamId 才复用旧班底（同一任务线的后续单）", async () => {
  const { kernel, teams, tasks } = setup();
  try {
    await kernel.init();
    assign(kernel, "WO-1");
    kernel.handle("session.new");
    const msg = assign(kernel, "WO-2", "小丹", { teamId: "superstar" });
    assert.equal(teams.listTeams().length, 1, "显式 teamId 时不再新建团队");
    assert.match(msg, /任务契约|计划/, `应出任务契约，实际：${msg}`);
    assert.equal(tasks.get("WO-2").teamId, "superstar");
  } finally {
    await kernel.dispose();
  }
});
