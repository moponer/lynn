// 日志分类与限流（2026-11-11）：分类可单独关、有每分钟上限、单条截断，避免日志暴涨。
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { LogGate, categoryOf } from "../dist/main/log-policy.js";
import { Kernel } from "../dist/main/kernel.js";

test("分类映射：member/heartbeat/task/tool/system", () => {
  assert.equal(categoryOf("member_tool"), "tool", "工具调用单独归 tool，便于只关这一类");
  assert.equal(categoryOf("member_exit"), "member");
  assert.equal(categoryOf("heartbeat_event"), "heartbeat");
  assert.equal(categoryOf("task_state"), "task");
  assert.equal(categoryOf("cmd_run"), "tool");
  assert.equal(categoryOf("tool_start"), "tool");
  assert.equal(categoryOf("repetition_aborted"), "system");
  assert.equal(categoryOf("whatever"), "system");
});

test("默认：心跳日志关闭，其余可写；总开关一关全不写", () => {
  let t = 0;
  const g = new LogGate(() => ({}), () => t);
  assert.equal(g.allow("heartbeat_tick"), null, "心跳默认关：它落卡就够了");
  assert.equal(g.allow("member_exit"), "member");

  const off = new LogGate(() => ({ enabled: false }), () => t);
  assert.equal(off.allow("member_tool"), null);
});

test("分类开关：关掉 tool 不影响 member", () => {
  const g = new LogGate(() => ({ categories: { tool: false } }), () => 0);
  assert.equal(g.allow("cmd_run"), null);
  assert.equal(g.allow("member_exit"), "member");
});

test("每分钟上限：超了丢弃并计数，窗口滚动后恢复", () => {
  let t = 0;
  const g = new LogGate(() => ({ perMinute: { member: 2 } }), () => t);
  assert.equal(g.allow("member_a"), "member");
  assert.equal(g.allow("member_b"), "member");
  assert.equal(g.allow("member_c"), null);
  assert.equal(g.allow("member_d"), null);
  assert.equal(g.takeDropped("member"), 2, "丢弃条数用于写一条汇总");
  assert.equal(g.takeDropped("member"), 0, "取完清零");
  t = 60_000;
  assert.equal(g.allow("member_e"), "member", "新窗口重新计数");
});

test("截断：超长字段只留 maxChars 并标注原长", () => {
  const g = new LogGate(() => ({ maxChars: 10 }));
  const out = g.trim({ args: "x".repeat(30), ok: false });
  assert.equal(out.args, "xxxxxxxxxx…(30)");
  assert.equal(out.ok, false);
});

test("内核：member_tool 落进 agent.log；关掉 tool 类后不再增长", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "lynn-log-"));
  const kernel = new Kernel(root);
  const file = path.join(root, "logs", "agent.log");

  kernel.log("member_tool", {
    taskId: "task-a",
    member: "文档撰写员",
    tool: "office_write_docx",
    ok: false,
    args: "x".repeat(900),
  });
  const lines = fs
    .readFileSync(file, "utf-8")
    .trim()
    .split("\n")
    .map((l) => JSON.parse(l));
  const last = lines[lines.length - 1];
  assert.equal(last.kind, "member_tool");
  assert.ok(String(last.args).length <= 410, "长参数被截断，不让一条日志撑爆文件");
  assert.equal(last.tool, "office_write_docx");

  kernel.settings.savePrefs({ log: { categories: { tool: false } } });
  const before = fs.statSync(file).size;
  kernel.log("member_tool", { taskId: "task-a", tool: "read_file" });
  assert.equal(fs.statSync(file).size, before, "tool 类关闭后一条都不写");
  kernel.dispose();
});
