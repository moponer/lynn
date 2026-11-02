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
  tools: ["read", "write", "edit", "bash"],
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

test("create_member：6 人上限，超编必须写理由", () => {
  for (let i = 0; i < 6; i++) {
    tools.createMember("t1", member({ name: `成员${i}` }));
  }
  assert.throws(() => tools.createMember("t1", member({ name: "第7人" })), /编制已达 6 人上限/);
  // 写了理由则允许（理由入审计）
  const file = tools.createMember("t1", member({ name: "第7人" }), "并行抓取 4 个站点");
  assert.ok(fs.existsSync(file));
});

test("assign_task：本次分配越权（超出岗位白名单）直接拒绝", () => {
  tools.createMember("t1", member());
  assert.throws(
    () => tools.assignTask("t1", { taskId: "x", member: "林工", brief: "b", deadline: "d", tools: ["browser"] }),
    /只能收窄不能扩张/,
  );
  // 收窄合法
  tools.assignTask("t1", { taskId: "x", member: "林工", brief: "b", deadline: "d", tools: ["read"] });
  const recs = store.readAssignments("t1", "x");
  assert.equal(recs.length, 1);
  assert.equal(JSON.parse(recs[0].text).tools.join(","), "read");
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

test("review_result：无证据不算完成（证据原则）", () => {
  tools.createMember("t1", member());
  assert.throws(
    () => tools.reviewResult("t1", "x", { member: "林工", text: "真的做完了", evidence: [] }),
    /没有证据/,
  );
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
