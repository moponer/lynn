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
  kernel.handle("config.prefs", { autoStart: false });
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
    brief: "【目标】把 9 月订单表整理成周报\n【完成标准】产出周报-09.md，数字与源表核对一致\n【材料与位置】材料文件在工作区 orders.csv\n【限制】只做 9 月，不要改源表口径",
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

test("任务契约：派单先停在 todo；没模型时确认后也停在待办（不假开工）", () => {
  const { kernel, tasks, cases } = setup();
  assign(kernel, "WO-9");
  assert.equal(tasks.get("WO-9").status, "todo", "未确认前不能谎报执行中");

  confirmPlan(kernel, "WO-9");
  const rec = tasks.get("WO-9");
  assert.ok(rec, "应有权威工单记录");
  // 本 setup 没有模型：确认了也起不来，工单必须停在待办并说明原因
  assert.equal(rec.status, "todo", "起不来就不许假装执行中");
  assert.equal(rec.member, "林工");
  assert.ok(rec.version >= 2);
  assert.match(
    kernel.handle("session.snapshot").feed.map((c) => c.text ?? "").join("\n"),
    /没开工（停在待办）/,
  );

  const timeline = cases.readTimeline("WO-9");
  assert.ok(timeline.some((e) => e.kind === "assign" && e.member === "林工"));
  assert.match(cases.readSummary("WO-9"), /派给 林工/);
});

test("证据必须是可点开的真实文件：假路径进不了审查，工单停在执行中", () => {
  const { kernel, tasks } = setup();
  assignConfirmed(kernel, "WO-13");
  // 关键任务才强制证据；普通任务证据可选（见 evidence-policy 测试）
  tasks.setEvidencePolicy("WO-13", "required");
  const msg = kernel.runTool("review_result", {
    teamId: "t1",
    taskId: "WO-13",
    member: "林工",
    text: "做完了",
    evidence: ["不存在的文件.md"],
  });
  assert.match(msg, /可核验|补齐后再验收/);
  assert.equal(tasks.get("WO-13").status, "in_progress");
  assert.equal(tasks.get("WO-13").evidence[0].verified, false);
});

test("回报带真实证据 → 收入 artifacts → in_review；用户拍板 → done", () => {
  const { kernel, tasks, cases, evidence } = setup();
  assignConfirmed(kernel, "WO-10");
  const src = evidence("report_0914.md", "# 周报\n");

  // 关键任务（required）无证据仍不能拍板；普通任务证据可选，见 evidence-policy 测试
  tasks.setEvidencePolicy("WO-10", "required");
  const early = kernel.handle("task.decide", { taskId: "WO-10", action: "approve" });
  assert.equal(early.ok, false);
  assert.match(early.error, /无证据|关键任务/);

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

/**
 * 删会话 = 删任务容器。
 * 会话与工单是两套存储：只删 <threadId>.json，工单还在 tasks/<id>/ 里，
 * 台账照列、值台动态区照动——用户看到的就是"会话删了工单还在"。
 */
test("删会话连带清掉它名下的工单，且不误伤其他会话", () => {
  const { kernel, tasks } = setup();
  assignConfirmed(kernel, "WO-31");
  assert.equal(tasks.get("WO-31")?.threadId, kernel.handle("session.snapshot").thread.id);

  const other = kernel.handle("thread.new", { title: "另一条线" }).thread.id;
  assignConfirmed(kernel, "WO-32");
  assert.equal(tasks.get("WO-32")?.threadId, other);
  assert.ok(tasks.get("WO-31"), "另一条线的单不该被牵连");

  const r = kernel.handle("thread.remove", { id: other });
  assert.equal(r.ok, true);
  assert.equal(r.removedTasks, 1, "删会话应报出连带清掉的单数");
  assert.equal(tasks.get("WO-32"), null, "会话名下的单必须一起消失，不能留成无主单");
  assert.ok(tasks.get("WO-31"), "别的会话的单原样保留");
  assert.ok(
    !kernel.handle("thread.list").some((t) => t.id === other),
    "会话本身也要从列表里消失",
  );
});

test("删会话时把执行中的单也一起收掉，不留运行时残留", () => {
  const { kernel, tasks } = setup();
  assignConfirmed(kernel, "WO-33");
  const tid = kernel.handle("session.snapshot").thread.id;
  // 直接把单标成执行中（不真起成员）：删除路径必须自己兜住 in_progress
  tasks.transition("WO-33", "in_progress", { member: "林工" });
  const r = kernel.handle("thread.remove", { id: tid });
  assert.equal(r.ok, true);
  assert.equal(r.removedTasks, 1, "在办的单也要跟着会话一起收掉");
  assert.equal(tasks.get("WO-33"), null);
});

/**
 * 无主单出口：老版本删会话只删了对话记录，工单留在台账里点哪都删不掉。
 * 快照先报数（orphans），再让用户一键清掉——没有 threadId 的历史单不猜、不删。
 */
test("无主单：快照报数，一键清掉，没会话归属的老单不动", async () => {
  const { root, kernel, tasks } = setup();
  const { ThreadStore } = await import("../dist/main/threads.js");
  assignConfirmed(kernel, "WO-41");
  const tid = kernel.handle("session.snapshot").thread.id;

  // 绕过 rpc 直接删会话文件 = 模拟老版本行为（只删对话记录，不碰工单）
  new ThreadStore(root).remove(tid);
  assert.ok(tasks.get("WO-41"), "工单还在台账里（这就是用户看到的现象）");
  assert.equal(kernel.handle("session.snapshot").orphans, 1, "快照要报出无主单数量");

  // 没有 threadId 的历史单不算无主：不能顺手删掉别人的卷宗
  tasks.ensureInProgress({ id: "WO-99", title: "老单", teamId: "t1", member: "林工" });
  assert.equal(kernel.handle("session.snapshot").orphans, 1, "老单没记会话归属，不该被算成无主");

  const r = kernel.handle("task.purgeOrphans");
  assert.equal(r.ok, true);
  assert.equal(r.removed, 1);
  assert.equal(tasks.get("WO-41"), null, "无主单要真的从台账消失");
  assert.ok(tasks.get("WO-99"), "没有会话归属的老单原样保留");
  assert.equal(kernel.handle("session.snapshot").orphans, 0);
});

/**
 * 空场：最后一条会话也删得掉，而且删完不能偷偷补一条同名的「新会话」。
 * 以前删最后一条 = 立刻新建一条标题一样的会话，看上去"删不掉"。
 */
test("删掉最后一条会话就是空场，不偷偷补一条", () => {
  const { kernel } = setup();
  // 全新安装自带一条默认会话：连它一起删光，才是"用户把会话删光了"
  for (const t of kernel.handle("thread.list")) kernel.handle("thread.remove", { id: t.id });
  assert.equal(kernel.handle("thread.list").length, 0);
  const tid = kernel.handle("thread.new", { title: "唯一一条" }).thread.id;
  assert.equal(kernel.handle("thread.list").length, 1);

  const r = kernel.handle("thread.remove", { id: tid });
  assert.equal(r.ok, true);
  assert.equal(r.threadsLeft, 0, "删完应该一条都不剩");
  assert.equal(kernel.handle("thread.list").length, 0, "不许自动补一条新会话");
  const snap = kernel.handle("session.snapshot");
  assert.equal(snap.thread.id, "", "空场就是空场：当前会话 id 为空");
  assert.equal(snap.thread.title, "", "空场不给自己编一个标题");
  assert.deepEqual(snap.threads, [], "会话列表为空，界面才好给空场");
});

/**
 * 空场里派单：工单必须挂到某条会话上，否则又变成"点哪都删不掉"的无主单。
 */
test("空场里派单会自动开一条会话，工单不落成无主单", () => {
  const { kernel, tasks } = setup();
  for (const t of kernel.handle("thread.list")) kernel.handle("thread.remove", { id: t.id });
  assert.equal(kernel.handle("thread.list").length, 0);

  assignConfirmed(kernel, "WO-51");
  const rec = tasks.get("WO-51");
  assert.ok(rec.threadId, "派单时必须钉住会话 id");
  assert.equal(kernel.handle("thread.list").length, 1, "空场派单顺手开了一条会话");
  assert.equal(kernel.handle("session.snapshot").orphans, 0, "不能一开工就是无主单");
});
