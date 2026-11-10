// M1-08：解散时保留编制，下一次同类任务直接复用
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { TeamStore } from "../dist/main/team-store.js";
import { ManagementTools } from "../dist/main/management-tools.js";

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "lynn-tpl-"));

function seed(root) {
  const store = new TeamStore(root);
  store.createTeam("t1", "月报突击队");
  store.writeMember("t1", {
    name: "顾明",
    role: "数据整理",
    goal: "把源数据整理成可核对的周报",
    boundaries: ["只动工作区"],
    tools: ["read_file", "write_file"],
    model: "deepseek-chat",
    limits: { maxTurns: 8, budgetTokens: 200000, wallClockMin: 20 },
    outputContract: { deliverable: "周报第 3 节", evidence: ["report.md"], acceptance: ["条数对得上"] },
    escalateWhen: "源数据缺列",
    body: "按 deadline 回报。",
  });
  return store;
}

test("解散时保留编制：写出模板文件，成员档案完整", () => {
  const root = tmp();
  const store = seed(root);
  const tools = new ManagementTools(store, root);

  assert.equal(tools.dissolveTeam("t1", true), "kept");
  const dir = path.join(root, "team", "_templates");
  const files = fs.readdirSync(dir);
  assert.equal(files.length, 1);
  const tpl = JSON.parse(fs.readFileSync(path.join(dir, files[0]), "utf-8"));
  assert.equal(tpl.name, "月报突击队");
  assert.equal(tpl.members.length, 1);
  assert.equal(tpl.members[0].name, "顾明");
  assert.deepEqual(tpl.members[0].outputContract.acceptance, ["条数对得上"]);

  // 原队伍标记为解散，但模板可用于下一单
  const rec = JSON.parse(fs.readFileSync(path.join(root, "team", "t1", "team.json"), "utf-8"));
  assert.equal(rec.status, "dissolved");
  assert.equal(tools.listTemplates().length, 1);
});

test("用模板起新队：成员原样复制，不覆盖已有队伍", () => {
  const root = tmp();
  const store = seed(root);
  const tools = new ManagementTools(store, root);
  tools.dissolveTeam("t1", true);

  const used = tools.ensureTeamFromTemplate("t2", "继续做周报", "月报突击队");
  assert.deepEqual(used, { name: "月报突击队", members: 1 });
  const members = store.listMembers("t2");
  assert.equal(members.length, 1);
  assert.equal(members[0].role, "数据整理");

  // 已有队伍时不做覆盖
  assert.equal(tools.ensureTeamFromTemplate("t2", "再来一单", "月报突击队"), null);
  assert.equal(store.listMembers("t2").length, 1);
});

test("按标题自动匹配：命中复用，没命中不乱套编制", () => {
  const root = tmp();
  const store = seed(root);
  const tools = new ManagementTools(store, root);
  tools.dissolveTeam("t1", true);

  assert.ok(tools.ensureTeamFromTemplate("t3", "把本月数据整理成周报") !== null);
  // 完全无关的任务：不猜
  assert.equal(tools.ensureTeamFromTemplate("t4", "订一张去上海的机票"), null);
});

test("没有成员时不能存模板（空编制没有复用价值）", () => {
  const root = tmp();
  const store = new TeamStore(root);
  store.createTeam("empty", "空队");
  const tools = new ManagementTools(store, root);
  assert.throws(() => tools.dissolveTeam("empty", true), /没有成员/);
  // 失败后队伍状态没被改
  const rec = JSON.parse(fs.readFileSync(path.join(root, "team", "empty", "team.json"), "utf-8"));
  assert.equal(rec.status, "active");
});

test("内核：上一单保留编制后，新单子直接用模板开工（不再招人）", async () => {
  const root = tmp();
  seed(root);
  const { Kernel } = await import("../dist/main/kernel.js");
  const kernel = new Kernel(root);
  try {
    assert.match(kernel.runTool("dissolve_team", { teamId: "t1", keep: true }), /保留/);
    const out = kernel.runTool("assign_task", {
      teamId: "t2",
      taskId: "WO-9",
      member: "顾明",
      brief: "【目标】把本月数据整理成周报第 3 节\n【完成标准】产出周报第 3 节文件，数字与源表核对一致\n【材料与位置】材料文件在工作区\n【限制】只做第 3 节，不要改源表口径",
      deadline: "15:00",
      template: "月报突击队",
    });
    assert.match(out, /任务契约/);
    assert.ok(kernel.handle("session.snapshot").board.decisions.some((d) => d.kind === "plan"));
    // 团队与成员都已就位
    const members = fs.readdirSync(path.join(root, "team", "t2", "members"));
    assert.equal(members.length, 1);
  } finally {
    await kernel.dispose();
  }
});
