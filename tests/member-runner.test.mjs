import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  resolveWithin,
  memberToolSchemas,
  runMemberTask,
  MEMBER_EXEC_TOOLS,
  memberSystemPrompt,
} from "../dist/main/member-runner.js";
import { MANAGEMENT_ONLY_TOOLS } from "../dist/main/management-tools.js";

function tmpWorkdir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "lynn-member-"));
}

function profile(overrides = {}) {
  return {
    name: "林工",
    role: "数据整理员",
    goal: "把数据整理干净",
    boundaries: ["只动工作区", "不装依赖"],
    tools: ["read_file", "write_file", "run_command"],
    model: "deepseek-chat",
    limits: { maxTurns: 6, budgetTokens: 300000, wallClockMin: 20 },
    outputContract: {
      deliverable: "report.md",
      evidence: ["报告文件"],
      acceptance: ["数字可对账"],
    },
    escalateWhen: "卡住",
    body: "",
    ...overrides,
  };
}

/** 假模型：按脚本逐轮返回（模拟 streamChat 契约） */
function scriptedChat(script) {
  let i = 0;
  return async (input) => {
    const step = script[Math.min(i++, script.length - 1)];
    input.messages.push({ role: "assistant", content: step.content ?? null, tool_calls: step.toolCalls ?? [] });
    for (const tc of step.toolCalls ?? []) {
      input.messages.push({ role: "tool", tool_call_id: tc.id, name: tc.name, content: "（工具结果占位）" });
    }
    return { content: step.content ?? "", toolCalls: step.toolCalls ?? [], promptTokens: 10, completionTokens: 5 };
  };
}

const tc = (id, name, args) => ({ id, name, arguments: JSON.stringify(args) });

// ---------- resolveWithin：工作区逃逸在工具层拒绝 ----------

test("resolveWithin：工作区内路径放行，逃逸与绝对路径越界拒绝", () => {
  const wd = tmpWorkdir();
  const inside = resolveWithin(wd, "report.md");
  assert.ok(inside.startsWith(path.resolve(wd)));
  assert.ok(inside.includes("report.md"));
  // 子目录 + ..
  assert.ok(resolveWithin(wd, "sub/../report.md").startsWith(path.resolve(wd) + path.sep));
  assert.throws(() => resolveWithin(wd, "../escape.txt"), /路径越界/);
  assert.throws(() => resolveWithin(wd, "a/../../escape.txt"), /路径越界/);
  // 绝对路径指到工作区外
  assert.throws(() => resolveWithin(wd, path.join(os.tmpdir(), "outside.txt")), /路径越界/);
  // 工作区本身（空串）合法
  assert.equal(resolveWithin(wd, "."), path.resolve(wd));
});

// ---------- 工具面：白名单只放行执行工具，submit_report 永远在 ----------

test("memberToolSchemas：白名单过滤 + submit_report 不可剥 + 管理型工具永远进不来", () => {
  const schemas = memberToolSchemas(["read_file", "write_file", "bash_不存在", "assign_task"]);
  const names = schemas.map((s) => s.function.name);
  assert.ok(names.includes("read_file") && names.includes("write_file"));
  assert.ok(!names.includes("bash_不存在"));
  // 就算档案被污染写进了管理型工具，成员工具面也不可能有它（§4.10.3）
  for (const m of MANAGEMENT_ONLY_TOOLS) {
    assert.ok(!names.includes(m), `成员工具面出现管理型工具 ${m}`);
    assert.ok(!MEMBER_EXEC_TOOLS.includes(m));
  }
  assert.deepEqual(names.filter((n) => n === "submit_report"), ["submit_report"]);
  // 空白名单也能回报
  assert.deepEqual(memberToolSchemas([]).map((s) => s.function.name), ["submit_report"]);
});

// ---------- 系统提示词：档案全字段编译进提示词 ----------

test("memberSystemPrompt：goal/边界/工具/产出契约/截止时间全部编译进提示词", () => {
  const wd = tmpWorkdir();
  const input = {
    profile: profile(),
    brief: "整理 Q3 流水并出月报",
    deadline: "周五 18:00",
    tools: ["read_file", "write_file"],
    workdir: wd,
    model: { baseUrl: "http://x", apiKey: "k", model: "m" },
  };
  const sys = memberSystemPrompt(input);
  assert.ok(sys.includes("林工"));
  assert.ok(sys.includes("数据整理员"));
  assert.ok(sys.includes("把数据整理干净"));
  assert.ok(sys.includes("只动工作区"));
  assert.ok(sys.includes("周五 18:00"));
  assert.ok(sys.includes("整理 Q3 流水并出月报"));
  assert.ok(sys.includes("report.md"));
  assert.ok(sys.includes("read_file、write_file"));
  assert.ok(sys.includes("submit_report"));
  assert.ok(!sys.includes("run_command")); // 未分配的工具不出现在提示词里
});

// ---------- 执行循环 ----------

test("runMemberTask：写文件→带证据回报，全程走通", async () => {
  const wd = tmpWorkdir();
  const chat = scriptedChat([
    { toolCalls: [tc("1", "write_file", { path: "report.md", content: "# 月报\nGMV 100.00" })] },
    { toolCalls: [tc("2", "submit_report", { text: "月报完成", evidence: ["report.md"] })] },
  ]);
  const events = [];
  const r = await runMemberTask({
    profile: profile(),
    brief: "出月报",
    deadline: "周五",
    tools: ["read_file", "write_file"],
    workdir: wd,
    model: { baseUrl: "http://x", apiKey: "k", model: "m" },
    chatFn: chat,
    onEvent: (e) => events.push(e),
  });
  assert.equal(r.status, "reported");
  assert.deepEqual(r.evidence, ["report.md"]);
  assert.ok(fs.existsSync(path.join(wd, "report.md")));
  assert.equal(fs.readFileSync(path.join(wd, "report.md"), "utf-8").includes("月报"), true);
  assert.equal(r.turns, 2);
  assert.equal(r.promptTokens, 20);
  assert.ok(events.some((e) => e.kind === "tool"));
});

test("runMemberTask：假证据在成员侧就被拒（证据原则前置），补真证据后可回报", async () => {
  const wd = tmpWorkdir();
  const chat = scriptedChat([
    { toolCalls: [tc("1", "submit_report", { text: "做完了", evidence: ["不存在的文件.csv"] })] },
    { toolCalls: [tc("2", "write_file", { path: "out.txt", content: "结果" })] },
    { toolCalls: [tc("3", "submit_report", { text: "做完了", evidence: ["out.txt"] })] },
  ]);
  const r = await runMemberTask({
    profile: profile(),
    brief: "算个数",
    deadline: "今天",
    tools: ["write_file"],
    workdir: wd,
    model: { baseUrl: "http://x", apiKey: "k", model: "m" },
    chatFn: chat,
  });
  assert.equal(r.status, "reported");
  assert.deepEqual(r.evidence, ["out.txt"]);
  // 空证据同样被拒（走到这一步说明前一轮拒绝了假证据后模型还在继续）
  assert.ok(r.turns >= 3);
});

test("runMemberTask：未分配的工具在代码层被拒，白名单只能收窄", async () => {
  const wd = tmpWorkdir();
  const chat = scriptedChat([
    { toolCalls: [tc("1", "run_command", { command: "echo hi" })] }, // 档案有但本次没分配
    { toolCalls: [tc("2", "submit_report", { text: "没有命令权限，口径如下…", evidence: [] })] },
    { toolCalls: [tc("3", "write_file", { path: "note.md", content: "说明" })] },
    { toolCalls: [tc("4", "submit_report", { text: "说明完成", evidence: ["note.md"] })] },
  ]);
  const r = await runMemberTask({
    profile: profile(),
    brief: "任务",
    deadline: "今天",
    tools: ["write_file"], // run_command 被收窄掉
    workdir: wd,
    model: { baseUrl: "http://x", apiKey: "k", model: "m" },
    chatFn: chat,
  });
  assert.equal(r.status, "reported");
});

test("runMemberTask：轮次上限如实报未完成，不硬造回报", async () => {
  const wd = tmpWorkdir();
  const chat = scriptedChat([{ toolCalls: [tc("x", "list_dir", {})] }]); // 永远只列目录
  const r = await runMemberTask({
    profile: profile({ limits: { maxTurns: 3, budgetTokens: 1000, wallClockMin: 5 } }),
    brief: "大任务",
    deadline: "今天",
    tools: ["list_dir"],
    workdir: wd,
    model: { baseUrl: "http://x", apiKey: "k", model: "m" },
    chatFn: chat,
  });
  assert.equal(r.status, "turn_limit");
  assert.equal(r.evidence.length, 0);
  assert.ok(r.report.includes("没有提交回报"));
});

test("runMemberTask：模型光说话不调工具会被要求走 submit_report，不吞轮次", async () => {
  const wd = tmpWorkdir();
  const chat = scriptedChat([
    { content: "我觉得做完了。" }, // 不调工具
    { toolCalls: [tc("1", "write_file", { path: "a.txt", content: "x" })] },
    { toolCalls: [tc("2", "submit_report", { text: "完成", evidence: ["a.txt"] })] },
  ]);
  const r = await runMemberTask({
    profile: profile(),
    brief: "任务",
    deadline: "今天",
    tools: ["write_file"],
    workdir: wd,
    model: { baseUrl: "http://x", apiKey: "k", model: "m" },
    chatFn: chat,
  });
  assert.equal(r.status, "reported");
  assert.equal(r.turns, 3);
});
