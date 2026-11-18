/**
 * 单任务工具用量尺子（P4-1 / 10 章 §9）。
 *
 * 这个脚本的存在意义是让「读文件 ≤7 次/任务」变成**可核对**的数字，而不是一句愿望。
 * 所以测试要证明的是口径本身：
 *  - 一次工具调用 = 一轮（与 10 章的 17 次同口径）；
 *  - 只数 read_file 为"读文件"，read_symbol / repo_map 不算（它们正是用来替代读的）；
 *  - 按 taskId 分组，一张单多个成员也合并（验收员与执行员跑的是同一张单）。
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { computeToolUsage } from "../scripts/bench/tool-usage.mjs";

function seedLog(rows) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "lynn-toolusage-"));
  fs.mkdirSync(path.join(root, "logs"), { recursive: true });
  fs.writeFileSync(path.join(root, "logs", "agent.log"), rows.map((r) => JSON.stringify(r)).join("\n") + "\n", "utf8");
  return root;
}

const row = (taskId, tool, member = "甲", at = "2026-11-16T05:00:00.000Z") => ({
  at,
  kind: "member_tool",
  taskId,
  member,
  tool,
  ok: true,
});

test("口径：一次工具调用 = 一轮；只数 read_file 为读文件", () => {
  const root = seedLog([
    row("t1", "read_file"),
    row("t1", "read_file"),
    row("t1", "grep"),
    row("t1", "read_symbol"), // 符号工具不算"读文件"
    row("t1", "repo_map"),
    row("t1", "write_file"),
  ]);
  const r = computeToolUsage({ dataRoot: root });
  assert.equal(r.tasks, 1);
  assert.equal(r.reads.mean, 2, "只该数两次 read_file");
  assert.equal(r.turnsPerTask.mean, 6, "六次调用就是六轮");
  assert.equal(r.symbolTasks, 1, "用过符号工具的单要单独记出来");
});

test("按 taskId 分组：一张单多个成员合并（验收员跑的是同一张单）", () => {
  const root = seedLog([row("t1", "read_file", "执行员"), row("t1", "read_file", "验收员"), row("t2", "read_file", "执行员")]);
  const r = computeToolUsage({ dataRoot: root });
  assert.equal(r.tasks, 2);
  const t1 = r.detail.find((d) => d.taskId === "t1");
  assert.equal(t1.reads, 2);
  assert.deepEqual(t1.members.sort(), ["执行员", "验收员"]);
});

test("窗口过滤与达标计数", () => {
  const root = seedLog([
    row("old", "read_file", "甲", "2026-11-15T00:00:00.000Z"),
    row("t1", "read_file", "甲", "2026-11-16T05:00:00.000Z"),
    row("t1", "grep", "甲", "2026-11-16T05:00:01.000Z"),
    row("t2", "read_file", "甲", "2026-11-16T05:00:02.000Z"),
  ]);
  const r = computeToolUsage({ dataRoot: root, since: "2026-11-16T00:00" });
  assert.equal(r.tasks, 2, "窗口外的单不该被算进来");
  assert.equal(r.reads.underTarget, 2, "两张单都只读了 1 次，都达标");
  assert.equal(r.turnsPerTask.underTarget, 2);
});

test("空日志不炸：如实报 0 张单", () => {
  const root = seedLog([]);
  const r = computeToolUsage({ dataRoot: root });
  assert.equal(r.tasks, 0);
  assert.equal(r.symbolTasks, 0);
});

test("坏行与非 member_tool 事件都被忽略", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "lynn-toolusage-"));
  fs.mkdirSync(path.join(root, "logs"), { recursive: true });
  fs.writeFileSync(
    path.join(root, "logs", "agent.log"),
    [`${JSON.stringify(row("t1", "read_file"))}`, "{坏行", JSON.stringify({ at: "2026-11-16T05:00:00Z", kind: "member_start", taskId: "t1" })].join("\n"),
    "utf8",
  );
  const r = computeToolUsage({ dataRoot: root });
  assert.equal(r.tasks, 1);
  assert.equal(r.reads.mean, 1, "member_start 不该被当成工具调用");
});