import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Kernel } from "../dist/main/kernel.js";
import { TaskStore } from "../dist/main/task-store.js";
import { TaskCase } from "../dist/main/task-case.js";
import { TeamStore } from "../dist/main/team-store.js";

/**
 * 内核 × 权威工单 × 任务卷宗（§4.8 / §4.10.4 / §4.10.5）：
 * 派单 → 执行中；回报（带**可验证**证据）→ 待审查；用户拍板 → 已归档。
 * 没证据 / 证据验不了，都不能进审查；没拍板不能归档。
 */

function setup() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "lynn-flow-"));
  new TeamStore(root).createTeam("t1", "月报突击队");
  const kernel = new Kernel(root);
  kernel.runTool("create_member", {
    teamId: "t1",
    name: "林工",
    role: "后端工程师",
    goal: "整理周报",
    tools: ["read_file", "write_file"],
    deliverable: "周报",
    acceptance: ["数据对得上"],
  });
  const evidenceDir = path.join(root, "member-out");
  fs.mkdirSync(evidenceDir, { recursive: true });
  const evidence = (name, content = "ok\n") => {
    const p = path.join(evidenceDir, name);
    fs.writeFileSync(p, content);
    return p;
  };
  return { root, kernel, tasks: new TaskStore(root), cases: new TaskCase(root), evidence };
}

const assign = (kernel, taskId) =>
  kernel.runTool("assign_task", {
    teamId: "t1",
    taskId,
    member: "林工",
    brief: "整理 9 月周报",
    deadline: "30 分钟",
  });

/** 默认（未开自动开始）走任务契约：派单后必须由用户确认一次 */
const confirmPlan = (kernel, taskId) => {
  const plan = kernel.handle("session.snapshot").board.decisions.find((d) => d.kind === "plan" && d.jobId === taskId);
  assert.ok(plan, `应有 ${taskId} 的任务契约`);
  return kernel.handle("decision.resolve", { id: plan.id, action: "start" });
};

const assignConfirmed = (kernel, taskId) => {
  assign(kernel, taskId);
  confirmPlan(kernel, taskId);
};

test("任务契约：派单先停在 todo，确认后才进 in_progress，卷宗有 timeline 与摘要", () => {
  const { kernel, tasks, cases } = setup();
  assign(kernel, "WO-9");
  assert.equal(tasks.get("WO-9").status, "todo", "未确认前不能谎报执行中");

  confirmPlan(kernel, "WO-9");
  const rec = tasks.get("WO-9");
  assert.ok(rec, "应有权威工单记录");
  assert.equal(rec.status, "in_progress");
  assert.equal(rec.member, "林工");
  assert.ok(rec.version >= 2);

  const timeline = cases.readTimeline("WO-9");
  assert.ok(timeline.some((e) => e.kind === "assign" && e.member === "林工"));
  assert.match(cases.readSummary("WO-9"), /派给 林工/);
});

test("证据必须是可点开的真实文件：假路径进不了审查，工单停在执行中", () => {
  const { kernel, tasks } = setup();
  assignConfirmed(kernel, "WO-13");
  const msg = kernel.runTool("review_result", {
    teamId: "t1",
    taskId: "WO-13",
    member: "林工",
    text: "做完了",
    evidence: ["不存在的文件.md"],
  });
  assert.match(msg, /可验证|停在执行中/);
  assert.equal(tasks.get("WO-13").status, "in_progress");
  assert.equal(tasks.get("WO-13").evidence[0].verified, false);
});

test("回报带真实证据 → 收入 artifacts → in_review；用户拍板 → done", () => {
  const { kernel, tasks, cases, evidence } = setup();
  assignConfirmed(kernel, "WO-10");
  const src = evidence("report_0914.md", "# 周报\n");

  const early = kernel.handle("task.decide", { taskId: "WO-10", action: "approve" });
  assert.equal(early.ok, false);
  assert.match(early.error, /无证据/);

  const msg = kernel.runTool("review_result", {
    teamId: "t1",
    taskId: "WO-10",
    member: "林工",
    text: "周报已生成",
    evidence: [src],
  });
  assert.match(msg, /待审查/);
  assert.equal(tasks.get("WO-10").status, "in_review");

  // 证据被收进卷宗，且 ref 指向 artifacts/
  const rec = tasks.get("WO-10");
  assert.equal(rec.evidence.length, 1);
  assert.equal(rec.evidence[0].verified, true);
  assert.match(rec.evidence[0].ref, /^artifacts\//);
  assert.ok(fs.existsSync(path.join(cases.artifactsDir("WO-10"), "report_0914.md")));

  const ok = kernel.handle("task.decide", { taskId: "WO-10", action: "approve" });
  assert.equal(ok.ok, true);
  assert.equal(ok.status, "done");
  assert.equal(tasks.get("WO-10").status, "done");
  assert.match(cases.readSummary("WO-10"), /验收归档/);
  assert.ok(cases.readTimeline("WO-10").some((e) => e.kind === "approve"));
});

test("打回必须带三要素；缺了报错，带全则回 in_progress 并计轮次", () => {
  const { kernel, tasks, evidence, cases } = setup();
  assignConfirmed(kernel, "WO-11");
  kernel.runTool("review_result", {
    teamId: "t1",
    taskId: "WO-11",
    member: "林工",
    text: "第一版",
    evidence: [evidence("report_v1.md")],
  });
  assert.equal(tasks.get("WO-11").status, "in_review");

  const bad = kernel.handle("task.decide", { taskId: "WO-11", action: "reject" });
  assert.equal(bad.ok, false);
  assert.match(bad.error, /打回必须写清/);

  const good = kernel.handle("task.decide", {
    taskId: "WO-11",
    action: "reject",
    reason: { what: "第 3 节少了 #2411", expect: "按 number 去重", deadline: "15 分钟" },
  });
  assert.equal(good.ok, true);
  assert.equal(good.status, "in_progress");
  assert.equal(tasks.get("WO-11").rejectRounds, 1);
  assert.match(cases.readSummary("WO-11"), /用户打回（第 1 轮）/);
});

test("板子上的工单来自权威记录（status/version/evidence 一致）", () => {
  const { kernel, evidence } = setup();
  assignConfirmed(kernel, "WO-12");
  kernel.runTool("review_result", {
    teamId: "t1",
    taskId: "WO-12",
    member: "林工",
    text: "交付",
    evidence: [evidence("a.md"), evidence("b.log")],
  });
  const item = kernel.snapshotBoard().track.find((t) => t.id === "WO-12");
  assert.ok(item);
  assert.equal(item.status, "in_review");
  assert.equal(item.evidenceCount, 2);
  assert.ok((item.version ?? 0) >= 3);
});
