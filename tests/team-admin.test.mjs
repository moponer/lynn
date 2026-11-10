// 编制管理（用户手动）：列 / 改岗位 / 移出成员 / 解散
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Kernel } from "../dist/main/kernel.js";
import { TeamStore } from "../dist/main/team-store.js";
import { TaskStore } from "../dist/main/task-store.js";

const profile = (name, role = "数据整理") => ({
  name,
  role,
  goal: "把源数据整理成可核对的周报",
  boundaries: ["只动工作区"],
  tools: ["read_file", "write_file"],
  model: "deepseek-chat",
  limits: { maxTurns: 8, budgetTokens: 200000, wallClockMin: 20 },
  outputContract: { deliverable: "周报", evidence: ["report.md"], acceptance: ["条数对得上"] },
  escalateWhen: "源数据缺列",
  body: "先对账，再出稿。",
});

function setup() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "lynn-team-admin-"));
  const kernel = new Kernel(root);
  const teams = new TeamStore(root);
  teams.createTeam("t1", "月报突击队");
  teams.writeMember("t1", profile("顾明"));
  teams.writeMember("t1", profile("林晚", "图表校对"));
  return { root, kernel, teams, tasks: new TaskStore(root) };
}

test("团队页列表：带岗位说明正文，工具白名单只读", () => {
  const { kernel } = setup();
  const r = kernel.handle("team.list");
  assert.equal(r.teams.length, 1);
  const t = r.teams[0];
  assert.equal(t.id, "t1");
  assert.equal(t.name, "月报突击队");
  assert.equal(t.members.length, 2);
  assert.ok(t.members[0].body.length > 0, "提示词正文要能读到");
  assert.ok(Array.isArray(t.members[0].tools));
});

test("改岗位：只落 role/goal/提示词，没传的字段不动；空角色拒", () => {
  const { kernel, teams } = setup();
  const r = kernel.handle("team.member.save", {
    teamId: "t1",
    name: "顾明",
    role: "数据工程师",
    body: "先对账，再出稿；口径不一致就上报。",
  });
  assert.equal(r.ok, true);
  const p = teams.readMember("t1", "顾明");
  assert.equal(p.role, "数据工程师");
  assert.equal(p.body, "先对账，再出稿；口径不一致就上报。");
  assert.equal(p.goal, profile("顾明").goal, "没传的字段保持原样");
  assert.equal(p.tools.length, 2, "工具白名单不在这里扩缩");

  const bad = kernel.handle("team.member.save", { teamId: "t1", name: "顾明", role: "  " });
  assert.equal(bad.ok, false);
  assert.match(bad.error, /角色不能为空/);
});

test("移出成员：手上有未收的单就拒；没有单的可删，历史记录保留", () => {
  const { kernel, teams, tasks } = setup();
  tasks.create({ id: "task-1", title: "整理材料", teamId: "t1", member: "顾明" });
  const blocked = kernel.handle("team.member.remove", { teamId: "t1", name: "顾明" });
  assert.equal(blocked.ok, false);
  assert.match(blocked.error, /未收的单/);

  const ok = kernel.handle("team.member.remove", { teamId: "t1", name: "林晚" });
  assert.equal(ok.ok, true);
  assert.equal(teams.listMembers("t1").length, 1);
  assert.equal(teams.listMembers("t1")[0].name, "顾明", "只删指定的那一个");

  const missing = kernel.handle("team.member.remove", { teamId: "t1", name: "林晚" });
  assert.equal(missing.ok, false);
  assert.match(missing.error, /没有成员/);
});

test("解散团队：有未收的单拒；清干净后状态转 dissolved、档案保留、岗位只读", () => {
  const { kernel, teams, tasks } = setup();
  tasks.create({ id: "task-2", title: "整理材料", teamId: "t1", member: "顾明" });
  const blocked = kernel.handle("team.dissolve", { teamId: "t1" });
  assert.equal(blocked.ok, false);
  assert.match(blocked.error, /未收的单/);

  tasks.remove("task-2");
  const ok = kernel.handle("team.dissolve", { teamId: "t1" });
  assert.equal(ok.ok, true);
  assert.equal(teams.readTeam("t1").status, "dissolved");
  assert.equal(teams.listMembers("t1").length, 2, "解散不清档案");

  const locked = kernel.handle("team.member.save", { teamId: "t1", name: "顾明", role: "改名" });
  assert.equal(locked.ok, false);
  assert.match(locked.error, /已解散/);
});

test("设置页挑头像：team.list 报出当前脸，改完落盘且快照同步；不认识的 id 当场拒", () => {
  const { kernel } = setup();
  const before = kernel.handle("team.list").teams[0].members.find((m) => m.name === "顾明");
  assert.ok(before.avatarId, "没存过 avatarId 的老档案也要给界面一个稳定的脸");

  const bad = kernel.handle("team.member.save", { teamId: "t1", name: "顾明", avatarId: "a99" });
  assert.equal(bad.ok, false);
  assert.match(bad.error, /未知头像 id/);

  const saved = kernel.handle("team.member.save", { teamId: "t1", name: "顾明", avatarId: "a11" });
  assert.equal(saved.ok, true);
  assert.equal(kernel.handle("team.list").teams[0].members.find((m) => m.name === "顾明").avatarId, "a11");
  const board = kernel.handle("session.snapshot").board.teams[0].members.find((m) => m.name === "顾明");
  assert.equal(board.avatarId, "a11", "值台成员卡和设置页必须用同一张脸");
  assert.equal(board.color, "#9a8f7a", "头像色也跟着换，别一处一个色");
});
