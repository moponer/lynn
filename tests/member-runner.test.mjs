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
  memberTaskIntro,
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
  // 空白名单也能回报 + 在群里说话（2026-11-16：发言不是执行工具，不该被白名单剥掉）
  assert.deepEqual(memberToolSchemas([]).map((s) => s.function.name), ["submit_report", "post_message"]);
});

// ---------- 系统提示词：岗位内容进 system，任务内容进首条 user ----------

test("memberSystemPrompt：岗位字段进 system，任务内容不进（P3-1b 05 章关键改动）", () => {
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
  assert.ok(sys.includes("report.md"));
  // C2（2026-11-19）：工具清单挪到首条 user，system 里不再逐条列工具（保缓存前缀稳定）
  assert.ok(!sys.includes("执行工具：read_file、write_file"), "工具清单不该留在 system（C2 缓存）");
  assert.ok(sys.includes("submit_report"));
  // 群内中途发言（2026-11-16）：成员要能被教会在群里说话，而不是只交终局回报
  assert.ok(sys.includes("post_message"));
  assert.match(sys, /【群内发言/);
  // 首条 user 的【本次授权】里必须有工具清单
  const intro0 = memberTaskIntro(input);
  assert.ok(!sys.includes("run_command")); // 未分配的工具不出现在提示词里
  // 死字段修复回归：escalateWhen / body 必须编译进成员提示词（2026-11-09 实锤此前从未注入）
  assert.match(sys, /何时必须停手升级.*卡住/);
  assert.ok(!sys.includes("岗位工作方式"), "body 为空时不出现空段");
  const withBody = memberSystemPrompt({
    ...input,
    profile: profile({ body: "先列目录再逐个核对；产出前用眼睛检查一遍数字。" }),
  });
  assert.match(withBody, /岗位工作方式】\n先列目录再逐个核对/);

  /**
   * P3-1b / 05 章「关键：简报从 system 移到首条 user」：
   * 截止时间与简报**必须离开 system**——它们每单都不一样，留在 system 里等于
   * 同一岗位的第二个任务要把整段提示词按全价重发一遍。
   */
  assert.ok(!sys.includes("整理 Q3 流水并出月报"), "简报不许留在 system prompt");
  assert.ok(!sys.includes("周五 18:00"), "截止时间不许留在 system prompt");
  const intro = memberTaskIntro(input);
  assert.ok(intro.includes("整理 Q3 流水并出月报"), "简报要出现在首条 user 的任务段里");
  assert.ok(intro.includes("周五 18:00"), "截止时间要出现在任务段里");
});

test("同 role×domain 的两次不同任务：system 逐字节相同（跨任务前缀可共享）", () => {
  const wd = tmpWorkdir();
  const base = {
    profile: profile(),
    tools: ["read_file", "write_file"],
    workdir: wd,
    model: { baseUrl: "http://x", apiKey: "k", model: "m" },
  };
  const a = memberSystemPrompt({ ...base, brief: "整理 Q3 流水并出月报", deadline: "周五", forbidden: ["不许改原始数据"] });
  const b = memberSystemPrompt({ ...base, brief: "把去年台账并进来做对账", deadline: "下周一", priority: "算得对>做得全" });
  assert.equal(a, b, "换了任务简报，system 居然变了——那跨任务缓存就无从谈起");

  // 而任务级内容确实进了各自的 user 段
  assert.notEqual(
    memberTaskIntro({ ...base, brief: "A 任务", deadline: "周五" }),
    memberTaskIntro({ ...base, brief: "B 任务", deadline: "下周一" }),
  );
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

test("runMemberTask：缓存 token 按轮累计（成员命中率不再是黑盒）", async () => {
  const wd = tmpWorkdir();
  let i = 0;
  const chat = async (input) => {
    const script = [
      { toolCalls: [tc("1", "write_file", { path: "out.md", content: "结果" })] },
      { toolCalls: [tc("2", "submit_report", { text: "完成", evidence: ["out.md"] })] },
    ];
    const step = script[Math.min(i++, script.length - 1)];
    input.messages.push({ role: "assistant", content: step.content ?? null, tool_calls: step.toolCalls ?? [] });
    for (const call of step.toolCalls ?? []) {
      input.messages.push({ role: "tool", tool_call_id: call.id, name: call.name, content: "（工具结果占位）" });
    }
    // 模拟 DeepSeek 口径：promptTokens 含命中部分，cacheRead 单独报
    return { content: "", toolCalls: step.toolCalls ?? [], promptTokens: 100, completionTokens: 5, cacheRead: 80, cacheWrite: 0 };
  };
  const r = await runMemberTask({
    profile: profile(),
    brief: "出报告",
    deadline: "今天",
    tools: ["write_file"],
    workdir: wd,
    model: { baseUrl: "http://x", apiKey: "k", model: "m" },
    chatFn: chat,
  });
  assert.equal(r.status, "reported");
  assert.equal(r.cacheReadTokens, 160, "两轮各命中 80");
  assert.equal(r.cacheWriteTokens, 0);
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

// ---------- 2026-11-10：只读根证据 + 交付物 ----------

test("runMemberTask：只读根里的文件可以作为证据（审查项目不再交不出证据）", async () => {
  const wd = tmpWorkdir();
  const ro = fs.mkdtempSync(path.join(os.tmpdir(), "lynn-readroot-"));
  const target = path.join(ro, "audit.csv");
  fs.writeFileSync(target, "科目,金额\n收入,100\n", "utf-8");
  const chat = scriptedChat([
    { toolCalls: [tc("1", "submit_report", { text: "审查完成，见附件", evidence: [target] })] },
  ]);
  const r = await runMemberTask({
    profile: profile(),
    brief: "审查外部项目",
    deadline: "今天",
    tools: ["read_file"],
    workdir: wd,
    readRoots: [ro],
    model: { baseUrl: "http://x", apiKey: "k", model: "m" },
    chatFn: chat,
  });
  assert.equal(r.status, "reported", "只读根里的真实文件应被接受");
  assert.deepEqual(r.evidence, [target]);
});

test("runMemberTask：交付物与证据分开；交付物不存在同样拒收", async () => {
  const wd = tmpWorkdir();
  const chat = scriptedChat([
    { toolCalls: [tc("1", "submit_report", { text: "完成", evidence: ["report.md"], deliverables: ["没有的表.xlsx"] })] },
    { toolCalls: [tc("2", "write_file", { path: "report.md", content: "# 报告" })] },
    { toolCalls: [tc("3", "write_file", { path: "交付/汇总.xlsx", content: "fake-xlsx" })] },
    { toolCalls: [tc("4", "submit_report", { text: "完成", evidence: ["report.md"], deliverables: ["交付/汇总.xlsx"] })] },
  ]);
  const r = await runMemberTask({
    profile: profile(),
    brief: "出报告和表格",
    deadline: "今天",
    tools: ["write_file"],
    workdir: wd,
    model: { baseUrl: "http://x", apiKey: "k", model: "m" },
    chatFn: chat,
  });
  assert.equal(r.status, "reported");
  assert.deepEqual(r.evidence, ["report.md"]);
  assert.deepEqual(r.deliverables, ["交付/汇总.xlsx"], "交付物单独返回，交给卷宗固化");
});
