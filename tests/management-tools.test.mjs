import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { TeamStore } from "../dist/main/team-store.js";
import { ManagementTools } from "../dist/main/management-tools.js";

function tmpRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "lynn-tools-"));
}

const member = (over = {}) => ({
  name: "林工",
  role: "后端工程师",
  goal: "清洗对账",
  boundaries: ["只改数据目录"],
  tools: ["read_file", "write_file", "run_command"],
  model: "deepseek-chat",
  limits: { maxTurns: 40, budgetTokens: 300000, wallClockMin: 30 },
  outputContract: { deliverable: "diff", evidence: ["测试输出"], acceptance: ["test 全绿"] },
  escalateWhen: "需要新依赖",
  body: "岗位说明",
  ...over,
});

let root, store, tools;

beforeEach(() => {
  root = tmpRoot();
  store = new TeamStore(root);
  tools = new ManagementTools(store, root);
  store.createTeam("t1", "月报突击队");
});

test("create_member：起手 2 人内直接放行，第 3 人起必须写明分工", () => {
  // 成员名用通用岗位名（档案规范：带编号的任务马甲名会被招募闸拒收）
  const names = ["审查员", "盘点员", "撰写员", "核验员", "分析员", "校对员"];
  tools.createMember("t1", member({ name: names[0] }));
  tools.createMember("t1", member({ name: names[1] }));
  assert.throws(
    () => tools.createMember("t1", member({ name: names[2] })),
    /起手编制先控制在 2 人/,
    "小任务第 3 人起要写明分工",
  );
  for (let i = 2; i < 6; i++) {
    tools.createMember("t1", member({ name: names[i] }), "并行抓取 4 个站点");
  }
  // 写理由仍可扩编（理由入审计）
  const file = tools.createMember("t1", member({ name: "统筹员" }), "跨站点汇总与复核");
  assert.ok(fs.existsSync(file));
});

test("assign_task：本次分配越权（超出岗位白名单）直接拒绝", () => {
  tools.createMember("t1", member());
  assert.throws(
    () => tools.assignTask("t1", { taskId: "x", member: "林工", brief: "b", deadline: "d", tools: ["browser_navigate"] }),
    /只能收窄不能扩张/,
  );
  // 收窄合法
  tools.assignTask("t1", { taskId: "x", member: "林工", brief: "b", deadline: "d", tools: ["read_file"] });
  const recs = store.readAssignments("t1", "x");
  assert.equal(recs.length, 1);
  assert.equal(JSON.parse(recs[0].text).tools.join(","), "read_file");
});

test("check_progress：她只看状态计数与最新回报，不读全量日志", () => {
  tools.createMember("t1", member());
  tools.assignTask("t1", { taskId: "x", member: "林工", brief: "b", deadline: "d" });
  tools.reviewResult("t1", "x", { member: "林工", text: "做完了", evidence: ["out.log"] });
  const p = tools.checkProgress("t1", "x");
  assert.equal(p.assigns, 1);
  assert.equal(p.reports, 1);
  assert.equal(p.latest.member, "林工");
});

test("review_result：证据可选，无证据也能登记（关键任务另由任务层拦）", () => {
  tools.createMember("t1", member());
  const r = tools.reviewResult("t1", "x", { member: "林工", text: "真的做完了", evidence: [] });
  assert.equal(r.verdict, "logged");
  tools.reviewResult("t1", "x", { member: "林工", text: "做完了", evidence: ["reconcile.log"] });
});

test("accept_or_reject：不带理由的打回算她失职", () => {
  tools.createMember("t1", member());
  assert.throws(
    () => tools.acceptOrReject("t1", "x", "reject", { member: "林工" }),
    /打回必须可执行/,
  );
});

test("打回上限 3 轮：第 4 次不再循环，升级问你", () => {
  tools.createMember("t1", member());
  tools.assignTask("t1", { taskId: "x", member: "林工", brief: "b", deadline: "d" });
  const reason = { what: "w", expect: "e", deadline: "d" };
  for (let i = 0; i < 3; i++) {
    const r = tools.acceptOrReject("t1", "x", "reject", { member: "林工", rejectReason: reason });
    assert.equal(r.escalated, false);
  }
  const fourth = tools.acceptOrReject("t1", "x", "reject", { member: "林工", rejectReason: reason });
  assert.equal(fourth.escalated, true, "第 4 次打回必须升级问你");
  assert.equal(tools.pendingQuestions().length, 1);
  assert.equal(store.rejectCount("t1", "x"), 3, "升级后不再追加打回记录");
});

test("ask_user：成员的问题归集到她转呈，产生待答问题", () => {
  const q = tools.askUser("口径选 A 还是 B？", "竞品快报需求");
  assert.equal(q.id, "q-1");
  assert.equal(tools.pendingQuestions().length, 1);
});

test("report_to_user：四件套齐全才算汇报", () => {
  const rep = tools.reportToUser("t1", {
    taskId: "x",
    conclusion: "月报已生成",
    evidence: ["report.pdf"],
    unfinished: ["图表4待确认"],
    decisionsNeeded: ["是否群发"],
  });
  assert.equal(rep.conclusion, "月报已生成");
  const recs = store.readAssignments("t1", "x");
  assert.equal(JSON.parse(recs[recs.length - 1].text).report, true);
});

test("dissolve_team：解散落盘状态；保留复用只写审计", () => {
  assert.equal(tools.dissolveTeam("t1", false), "dissolved");
  const rec = JSON.parse(fs.readFileSync(path.join(root, "team", "t1", "team.json"), "utf-8"));
  assert.equal(rec.status, "dissolved");
  // 解散后不能再派活
  assert.throws(
    () => tools.createMember("t1", member({ name: "新人" })),
    /状态为 dissolved/,
  );
});

test("审计账本：每个动作追加一条，可归因", () => {
  tools.createMember("t1", member());
  tools.assignTask("t1", { taskId: "x", member: "林工", brief: "b", deadline: "d" });
  const audit = fs
    .readFileSync(path.join(root, "audit.jsonl"), "utf-8")
    .trim()
    .split("\n")
    .map((l) => JSON.parse(l));
  assert.deepEqual(audit.map((a) => a.tool), ["create_member", "assign_task"]);
});

test("create_member：自动从头像库挑脸，同队不撞脸；指定 id 无效当场拒", () => {
  const names = ["审查员", "盘点员", "撰写员", "核验员"];
  for (let i = 0; i < 4; i++) tools.createMember("t1", member({ name: names[i] }), "并行取样与复核");
  const faces = store.listMembers("t1").map((p) => p.avatarId);
  assert.equal(faces.every(Boolean), true, "招募时必须落一个头像 id");
  assert.equal(new Set(faces).size, faces.length, "同一队里不能两个人用同一张脸");

  // 同一个名字重招（换个队）仍是同一张脸：界面不会突然换人
  const again = member({ name: names[0] });
  assert.throws(() => tools.createMember("t1", { ...again, avatarId: "nope" }, "头像复核"), /未知头像 id/);
  tools.createMember("t1", { ...again, avatarId: "a11" }, "头像复核");
  assert.equal(store.readMember("t1", names[0]).avatarId, "a11", "用户/风铃指定的 id 必须原样落盘");
});
