/**
 * 基线打分器的口径测试（P0-5）。
 *
 * 重点防两类错：
 *  1. 把 usage.jsonl 的 turn 与 agent.log 的 usage_patrol 重复相加（多数 1,000 万）；
 *  2. 把"证据"当成"交付物"（deliverables=0 但 evidence>0 仍算无交付物）。
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { computeBaseline } from "../scripts/bench/score.mjs";

function tmpRoot() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lynn-bench-"));
  fs.mkdirSync(path.join(dir, "logs"), { recursive: true });
  fs.mkdirSync(path.join(dir, "tasks"), { recursive: true });
  return dir;
}

function writeLog(root, rows) {
  fs.writeFileSync(path.join(root, "logs", "agent.log"), rows.map((r) => JSON.stringify(r)).join("\n"), "utf-8");
}

function writeUsage(root, rows) {
  fs.writeFileSync(path.join(root, "logs", "usage.jsonl"), rows.map((r) => JSON.stringify(r)).join("\n"), "utf-8");
}

function writeTask(root, id, status) {
  fs.mkdirSync(path.join(root, "tasks", id), { recursive: true });
  fs.writeFileSync(
    path.join(root, "tasks", id, "task.json"),
    JSON.stringify({ id, title: id, status, rejectRounds: 0, evidence: [], deliverables: [] }),
    "utf-8",
  );
}

test("首轮成功/无交付物：证据不算交付", () => {
  const root = tmpRoot();
  writeTask(root, "t1", "done");
  writeTask(root, "t2", "blocked");
  writeLog(root, [
    { at: "2026-11-16T05:00:00.000Z", kind: "member_start", taskId: "t1", member: "a" },
    // 第一次就成功（≥300 字 + 有产物）
    { at: "2026-11-16T05:10:00.000Z", kind: "member_exit", taskId: "t1", member: "a", status: "reported", turns: 6, reportChars: 500, deliverables: 1, evidence: 0 },
    { at: "2026-11-16T06:00:00.000Z", kind: "member_start", taskId: "t2", member: "b" },
    // 有证据但没有交付物 → 算无交付物
    { at: "2026-11-16T06:10:00.000Z", kind: "member_exit", taskId: "t2", member: "b", status: "reported", turns: 9, reportChars: 900, deliverables: 0, evidence: 5 },
  ]);
  writeUsage(root, []);
  const r = computeBaseline({ dataRoot: root });
  // 两张单首轮都是 reported 且 ≥300 字 → 首轮都算"成功"（哪怕其中一张没有交付物）
  assert.equal(r.success.firstTry, 2);
  assert.equal(r.success.firstTryDenom, 2);
  assert.equal(r.success.noDeliverable, 1, "只有 evidence 不算交付");
  assert.equal(r.success.reported, 2);
});

test("token 不重复计：total = member + turn，patrol 只是明细", () => {
  const root = tmpRoot();
  writeLog(root, [
    { at: "2026-11-16T05:00:00.000Z", kind: "usage_patrol", in: 1000, out: 10, cacheRead: 900 },
  ]);
  writeUsage(root, [
    { at: "2026-11-16T05:00:00.000Z", kind: "member", in: 2000, out: 20, cacheRead: 1500 },
    // turn 就是巡检/主会话回合的记账，与 usage_patrol 同一批
    { at: "2026-11-16T05:00:00.000Z", kind: "turn", in: 1000, out: 10, cacheRead: 900 },
  ]);
  const r = computeBaseline({ dataRoot: root });
  assert.equal(r.tokens.member.in, 2000);
  assert.equal(r.tokens.turn.in, 1000);
  assert.equal(r.tokens.patrolDetail.in, 1000);
  assert.equal(r.tokens.totalIn, 3000, "不能是 4000（turn 与 patrol 重复）");
  assert.equal(r.tokens.patrolShare, 33.3);
});

test("重复执行：多跑一次算一次额外 run，并估算 token", () => {
  const root = tmpRoot();
  writeLog(root, [
    { at: "2026-11-16T05:00:00.000Z", kind: "member_start", taskId: "t9", member: "a" },
    { at: "2026-11-16T05:05:00.000Z", kind: "member_exit", taskId: "t9", member: "a", status: "error", turns: 3, reportChars: 33, deliverables: 0, evidence: 0 },
    { at: "2026-11-16T05:10:00.000Z", kind: "member_start", taskId: "t9", member: "a" },
    { at: "2026-11-16T05:20:00.000Z", kind: "member_exit", taskId: "t9", member: "a", status: "reported", turns: 5, reportChars: 600, deliverables: 1, evidence: 1 },
  ]);
  writeUsage(root, [{ at: "2026-11-16T05:20:00.000Z", kind: "member", in: 1000, out: 10, cacheRead: 800 }]);
  const r = computeBaseline({ dataRoot: root });
  assert.equal(r.repeat.multiRunTasks, 1);
  assert.equal(r.repeat.extraRuns, 1);
  assert.equal(r.repeat.avgRunTokens, 500, "1000 / 2 次 start");
  assert.equal(r.repeat.extraTokenEstimate, 500);
});

test("坏行与缺失文件不影响结果", () => {
  const root = tmpRoot();
  // 第一行以 { 开头但 JSON 非法 → 计入 badLogLines；非 { 开头的行按设计忽略
  fs.writeFileSync(
    path.join(root, "logs", "agent.log"),
    "{\"broken\":\n{\"at\":\"2026-11-16T05:00:00.000Z\",\"kind\":\"member_start\",\"taskId\":\"t1\"}\n",
    "utf-8",
  );
  const r = computeBaseline({ dataRoot: root });
  assert.equal(r.parse.badLogLines, 1);
  assert.equal(r.runs.starts, 1);
  assert.equal(r.tasks.total, 0);
});
