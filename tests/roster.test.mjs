// M2-14：班底档案资产化 —— 花名册 + 战绩聚合
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { TeamStore } from "../dist/main/team-store.js";
import { ManagementTools } from "../dist/main/management-tools.js";

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "lynn-roster-"));

const profile = (name) => ({
  name,
  role: "数据整理",
  goal: "把源数据整理成可核对的周报",
  boundaries: ["只动工作区"],
  tools: ["read_file", "write_file"],
  model: "deepseek-chat",
  limits: { maxTurns: 8, budgetTokens: 200000, wallClockMin: 20 },
  outputContract: { deliverable: "周报", evidence: ["report.md"], acceptance: ["条数对得上"] },
  escalateWhen: "源数据缺列",
  body: "按 deadline 回报。",
});

test("战绩聚合：per 成员按 assignments 汇总，任务去重，解散的队也保留", () => {
  const root = tmp();
  const store = new TeamStore(root);
  store.createTeam("t1", "月报队");
  store.writeMember("t1", profile("顾明"));
  store.writeMember("t1", profile("林晚"));

  const now = new Date().toISOString();
  store.appendAssignment("t1", { taskId: "a1", at: now, kind: "assign", member: "顾明", text: "整理" });
  store.appendAssignment("t1", { taskId: "a1", at: now, kind: "report", member: "顾明", text: "好了", evidence: ["r.md"] });
  store.appendAssignment("t1", { taskId: "a1", at: now, kind: "reject", member: "顾明", text: "少一行" });
  store.appendAssignment("t1", { taskId: "a1", at: now, kind: "assign", member: "顾明", text: "重交" });
  store.appendAssignment("t1", { taskId: "a1", at: now, kind: "accept", member: "顾明", text: "过验" });
  store.appendAssignment("t1", { taskId: "b2", at: now, kind: "assign", member: "顾明", text: "再一单" });
  store.appendAssignment("t1", { taskId: "b2", at: now, kind: "accept", member: "顾明", text: "过验" });
  store.appendAssignment("t1", { taskId: "c3", at: now, kind: "assign", member: "林晚", text: "顶上" });
  store.appendAssignment("t1", { taskId: "c3", at: now, kind: "escalate", member: "林晚", text: "缺列，问一下" });

  const r = store.roster("t1");
  assert.equal(r.team.name, "月报队");
  const gu = r.members.find((m) => m.profile.name === "顾明");
  assert.equal(gu.record.tasks, 2, "任务去重");
  assert.equal(gu.record.accepted, 2);
  assert.equal(gu.record.rejected, 1);
  assert.equal(gu.record.escalations, 0);
  assert.ok(gu.record.lastAcceptAt);
  const lin = r.members.find((m) => m.profile.name === "林晚");
  assert.equal(lin.record.escalations, 1);
  assert.equal(lin.record.accepted, 0);

  store.dissolveTeam("t1");
  assert.equal(store.roster("t1").team.status, "dissolved", "解散后档案还在（资产不是日志）");
  assert.ok(store.listTeams().some((t) => t.id === "t1"));

  // 坏行不炸聚合
  const f = path.join(root, "team", "t1", "assignments", "dirty.jsonl");
  fs.writeFileSync(f, "{broken json\n", "utf-8");
  assert.equal(store.roster("t1").members.length, 2);
});

test("check_roster 管理工具：指定团队给花名册，不传列全部", () => {
  const root = tmp();
  const store = new TeamStore(root);
  store.createTeam("t1", "月报队");
  store.writeMember("t1", profile("顾明"));
  store.appendAssignment("t1", { taskId: "a1", at: new Date().toISOString(), kind: "accept", member: "顾明", text: "过" });
  const tools = new ManagementTools(store, root);

  const one = tools.roster("t1");
  assert.equal(one.team.id, "t1");
  assert.equal(one.members[0].record.accepted, 1);

  const all = tools.roster();
  assert.ok(Array.isArray(all));
  assert.equal(all.length, 1);
  assert.equal(all[0].members[0].name, "顾明");
});
