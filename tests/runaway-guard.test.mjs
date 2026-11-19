// 2026-11-16 五小时额度耗尽的四道护栏（日志复盘后的回归）：
//  1) 单轮超时拆成 idle/total，额度类 429 判定为终态、不再退避重试
//  2) 成员单轮失败在同一单内续跑（此前一次 120s 超时就把整单 20 轮成果作废）
//  3) token 预算到额强制收尾（此前 budgetTokens 只用于界面显示，从不校验）
//  4) 同一实例重复读同一文件不再重复粘贴（实机同一张单把同一文件读了 23 次）
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as http from "node:http";
import {
  streamChat,
  streamChatWithRetry,
  LlmError,
  StreamTimeoutError,
  isQuotaError,
  isQuotaMessage,
} from "../dist/main/llm.js";
import { runMemberTask } from "../dist/main/member-runner.js";
import { Toolkit } from "../dist/main/toolkit.js";
import { Kernel } from "../dist/main/kernel.js";
import {
  compactThreshold,
  compactToolHistory,
  compactKeepRecent,
  countUnfoldedTools,
  FOLD_MARK,
} from "../dist/main/history-compact.js";

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "lynn-runaway-"));

// ---------- 1. 额度错误的判定 ----------

test("额度类 429 与瞬时限流必须分开：前者终态、后者可退避", () => {
  const quota = new LlmError(
    '模型请求失败 HTTP 429：{"error":{"message":"已达到 Token Plan 用量上限：请升级 Token Plan 套餐或购买积分补充用量。(2056)"}}',
    429,
  );
  const throttled = new LlmError("模型请求失败 HTTP 429：rate limit exceeded, retry later", 429);
  assert.equal(isQuotaError(quota), true);
  assert.equal(isQuotaError(throttled), false, "普通限流不能当额度用尽——它等一会儿就能过");
  assert.equal(isQuotaError(new LlmError("payment required", 402)), true);
  assert.equal(isQuotaMessage("账户余额不足，请充值"), true);
  assert.equal(isQuotaMessage("everything is fine"), false);
});

// ---------- 2. 额度 429 不重试 + idle 超时可辨 ----------

function mockServer(handler) {
  const server = http.createServer(handler);
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      resolve({
        baseUrl: `http://127.0.0.1:${server.address().port}/v1`,
        close: () => new Promise((r) => server.close(() => r())),
      });
    });
  });
}

const input = (baseUrl, extra = {}) => ({
  baseUrl,
  apiKey: "k",
  model: "m",
  messages: [{ role: "user", content: "hi" }],
  onDelta: () => undefined,
  ...extra,
});

test("额度用尽（429 + Token Plan 上限）一次就放弃，不浪费两次重试", async () => {
  let calls = 0;
  const srv = await mockServer((req, res) => {
    calls += 1;
    res.writeHead(429, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: { message: "已达到 Token Plan 用量上限：请升级或购买积分" } }));
  });
  try {
    await assert.rejects(
      () => streamChatWithRetry(input(srv.baseUrl), { maxAttempts: 3 }),
      (err) => err instanceof LlmError && err.status === 429,
    );
    assert.equal(calls, 1, "额度用尽是终态：重试只会把请求配额也烧掉");
  } finally {
    await srv.close();
  }
});

test("普通 429 仍然退避重试（与额度用尽区分开）", async () => {
  let calls = 0;
  const srv = await mockServer((req, res) => {
    calls += 1;
    if (calls === 1) {
      res.writeHead(429, { "Retry-After": "0.05", "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: { message: "rate limit" } }));
      return;
    }
    res.writeHead(200, { "Content-Type": "text/event-stream" });
    res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: "好了" } }] })}\n\n`);
    res.write("data: [DONE]\n\n");
    res.end();
  });
  try {
    const r = await streamChatWithRetry(input(srv.baseUrl), { maxAttempts: 3 });
    assert.equal(r.content, "好了");
    assert.equal(calls, 2);
  } finally {
    await srv.close();
  }
});

test("idle 超时：端点一个 chunk 都不回就断开，且能与用户停止区分", async () => {
  const srv = await mockServer(() => {
    /* 故意不写任何响应：模拟端点排队卡死 */
  });
  try {
    await assert.rejects(
      () => streamChat(input(srv.baseUrl, { idleTimeoutMs: 300, totalTimeoutMs: 3000 })),
      (err) => err instanceof StreamTimeoutError && err.kind === "idle",
    );
  } finally {
    await srv.close();
  }
});

// ---------- 3. 成员单轮失败续跑 ----------

const profile = () => ({
  name: "林工",
  role: "整理员",
  goal: "整理干净",
  boundaries: [],
  tools: ["read_file", "write_file"],
  model: "m",
  limits: { maxTurns: 6, budgetTokens: 300000, wallClockMin: 20 },
  outputContract: { deliverable: "report.md", evidence: [], acceptance: ["可对账"] },
  escalateWhen: "卡住",
  body: "",
});

function memberInput(workdir, overrides = {}) {
  return {
    profile: profile(),
    brief: "把材料整理成 report.md，完成标准：可对账。材料在 report.md 同目录。限制：不许装依赖。",
    deadline: "2026-11-17 12:00",
    tools: ["read_file", "write_file"],
    model: { baseUrl: "http://127.0.0.1:9/v1", apiKey: "k", model: "m" },
    workdir,
    chatFn: undefined,
    ...overrides,
  };
}

const tc = (name, args) => ({ id: `t-${name}`, name, arguments: JSON.stringify(args) });

test("成员单轮模型失败 → 同一单内续跑，不把已读的成果作废", async () => {
  const wd = tmp();
  const notes = [];
  let calls = 0;
  const chatFn = async () => {
    calls += 1;
    if (calls === 1) throw new Error("模型 120s 没有任何输出（idle 超时），已断开");
    return { content: "", toolCalls: [tc("submit_report", { text: "已完成", evidence: [] })], promptTokens: 10, completionTokens: 5 };
  };
  const res = await runMemberTask(
    memberInput(wd, { chatFn, onEvent: (e) => { if (e.kind === "note") notes.push(e.text); } }),
  );
  assert.equal(res.status, "reported", "一次超时不该让整单报废");
  assert.equal(calls, 2);
  assert.ok(notes.some((n) => /续跑/.test(n)), "续跑要留痕，别静默重来");
});

test("连续失败超过上限才如实结束（并保留已消耗的 token 记录）", async () => {
  const wd = tmp();
  let calls = 0;
  const chatFn = async () => {
    calls += 1;
    throw new Error("网络错误");
  };
  const res = await runMemberTask(memberInput(wd, { chatFn }));
  assert.equal(res.status, "error");
  assert.equal(calls, 3, "最多续跑两次（共 3 次尝试），之后如实报错");
});

test("额度用尽不再续跑：直接如实结束（续跑也只会再撞 429）", async () => {
  const wd = tmp();
  let calls = 0;
  const chatFn = async () => {
    calls += 1;
    throw new LlmError("模型请求失败 HTTP 429：已达到 Token Plan 用量上限", 429);
  };
  const res = await runMemberTask(memberInput(wd, { chatFn }));
  assert.equal(res.status, "error");
  assert.equal(calls, 1);
});

test("token 预算到额：强制收尾，不丢成果（口述也收下，不再空转勘察）", async () => {
  const wd = tmp();
  fs.writeFileSync(path.join(wd, "memo.md"), "材料\n", "utf-8");
  let calls = 0;
  let sawBudgetNote = false;
  const chatFn = async (inp) => {
    calls += 1;
    const last = inp.messages[inp.messages.length - 1]?.content ?? "";
    if (/token 预算已用尽/.test(last)) sawBudgetNote = true;
    if (calls === 1) {
      return { content: "", toolCalls: [tc("read_file", { path: "memo.md" })], promptTokens: 500, completionTokens: 100 };
    }
    // 收尾轮：模型直接口述结论（不调工具）——2026-11-19 C5 后应把它当回报收下，不丢
    return { content: "已看完材料，结论是 X", toolCalls: [], promptTokens: 500, completionTokens: 100 };
  };
  const p = profile();
  p.limits.budgetTokens = 100; // 第一轮就超
  const res = await runMemberTask(memberInput(wd, { chatFn, profile: p }));
  assert.equal(sawBudgetNote, true, "到额必须明确要求收尾");
  // C5：收尾轮的口述结论要收下（不丢成 turn_limit）
  assert.equal(res.status, "reported", "到额收尾轮的口述应当作回报收下，不再判 turn_limit 丢掉");
  assert.match(res.report, /结论是 X/, "口述内容要保留");
});

// ---------- 4. 重复读抑制 ----------

test("同一实例重复读同一段落：文件没改就只回一句，不再重复粘贴", async () => {
  const root = tmp();
  const t = new Toolkit(root);
  fs.writeFileSync(path.join(root, "long.md"), "第一行\n第二行\n第三行\n", "utf-8");
  const first = await t.readFile({ path: "long.md" });
  assert.match(first, /第一行/);
  const second = await t.readFile({ path: "long.md" });
  assert.match(second, /内容未变/);
  assert.ok(!second.includes("第一行"), "正文不该重复粘贴");
  // 自己改过之后必须重新给全文，不能拿旧记忆糊弄
  await t.writeFile({ path: "long.md", content: "改过了\n" });
  const third = await t.readFile({ path: "long.md" });
  assert.match(third, /改过了/);
});

test("读不同段落不算重复（offset 不同照常返回）", async () => {
  const root = tmp();
  const t = new Toolkit(root);
  const body = Array.from({ length: 900 }, (_, i) => `第 ${i + 1} 行`).join("\n");
  fs.writeFileSync(path.join(root, "big.txt"), body, "utf-8");
  const a = await t.readFile({ path: "big.txt", offset: 1, limit: 10 });
  const b = await t.readFile({ path: "big.txt", offset: 11, limit: 10 });
  assert.match(a, /第 1 行/);
  assert.match(b, /第 11 行/);
});

// ---------- 5. 工具历史折叠（上下文二次成本） ----------

/** 造 n 条工具往返：assistant(tool_calls) + tool 结果 */
function toolTurns(n, size = 3000) {
  const msgs = [{ role: "system", content: "s" }];
  for (let i = 0; i < n; i += 1) {
    msgs.push({
      role: "assistant",
      content: null,
      tool_calls: [{ id: `c${i}`, type: "function", function: { name: "read_file", arguments: "{}" } }],
    });
    msgs.push({ role: "tool", tool_call_id: `c${i}`, name: "read_file", content: `第${i}条\n` + "x".repeat(size) });
  }
  return msgs;
}

test("折叠：只折窗口外的早期结果，保留最近 N 条原文", () => {
  const msgs = toolTurns(10);
  const r = compactToolHistory(msgs, { keepRecent: 6 });
  assert.equal(r.folded, 4);
  assert.ok(r.savedChars > 0);
  // 前 4 条被折，后 6 条原样
  const tools = r.messages.filter((m) => m.role === "tool");
  for (let i = 0; i < 4; i += 1) {
    assert.ok(tools[i].content.startsWith(FOLD_MARK), `第 ${i} 条应折叠`);
  }
  for (let i = 4; i < 10; i += 1) {
    assert.ok(tools[i].content.startsWith(`第${i}条`), `第 ${i} 条必须原样`);
  }
  // 协议字段不能被破坏：tool_call_id 还在、content 非空
  assert.equal(tools[0].tool_call_id, "c0");
  assert.ok(tools[0].content.length > 0);
  // 原数组不被修改
  assert.ok(msgs.filter((m) => m.role === "tool")[0].content.startsWith("第0条"));
});

test("折叠必须确定性：同一输入两次产出完全一致（否则前缀缓存逐轮失效）", () => {
  const a = compactToolHistory(toolTurns(10), { keepRecent: 6 });
  const b = compactToolHistory(toolTurns(10), { keepRecent: 6 });
  assert.deepEqual(
    a.messages.map((m) => m.content),
    b.messages.map((m) => m.content),
  );
  // 幂等：折过的再折一次不该再动
  const again = compactToolHistory(a.messages, { keepRecent: 6 });
  assert.equal(again.folded, 0);
});

test("短结果不折（本身就是结论）；fromIndex 之外的历史不动", () => {
  const short = compactToolHistory(toolTurns(10, 50), { keepRecent: 2 });
  assert.equal(short.folded, 0, "短结果折叠只剩噪音");

  const msgs = toolTurns(10);
  // 第 i 轮的 tool 消息在 index 2+2i：fromIndex=14 表示只算第 6 轮及之后（共 4 条，留最近 2 条）
  const r = compactToolHistory(msgs, { keepRecent: 2, fromIndex: 14 });
  assert.equal(r.folded, 2);
  assert.ok(msgs.filter((m) => m.role === "tool")[0].content.startsWith("第0条"));
  assert.ok(r.messages.filter((m) => m.role === "tool")[0].content.startsWith("第0条"));
});

test("成员跑多轮后折叠早期工具结果；折叠后重读能拿到全文而不是「内容未变」", async () => {
  const wd = tmp();
  const files = [];
  // 16 条：超过分代折叠阈值（默认 12），第 13 轮起才折
  for (let i = 1; i <= 16; i += 1) {
    const name = `f${i}.md`;
    fs.writeFileSync(path.join(wd, name), `文件${i}的首行\n` + "填充内容\n".repeat(300), "utf-8");
    files.push(name);
  }
  let call = 0;
  let sawFold = false;
  let rereadFull = false;
  const chatFn = async (inp) => {
    call += 1;
    if (inp.messages.some((m) => m.role === "tool" && String(m.content).startsWith(FOLD_MARK))) sawFold = true;
    if (call <= 16) {
      return { content: "", toolCalls: [tc("read_file", { path: files[call - 1] })], promptTokens: 10, completionTokens: 5 };
    }
    if (call === 17) {
      // 重读第 1 个文件：它已在前面被折叠，且已读记忆被清空 → 必须重新给全文
      return { content: "", toolCalls: [tc("read_file", { path: files[0] })], promptTokens: 10, completionTokens: 5 };
    }
    const lastTool = [...inp.messages].reverse().find((m) => m.role === "tool");
    if (lastTool && String(lastTool.content).includes("文件1的首行")) rereadFull = true;
    return { content: "", toolCalls: [tc("submit_report", { text: "完成", evidence: [] })], promptTokens: 10, completionTokens: 5 };
  };
  const p = profile();
  p.limits.maxTurns = 24;
  p.limits.budgetTokens = 10_000_000;
  const res = await runMemberTask(memberInput(wd, { chatFn, profile: p, tools: ["read_file"] }));
  assert.equal(res.status, "reported");
  assert.equal(sawFold, true, "超过阈值的早期工具结果应被折叠");
  assert.equal(rereadFull, true, "折叠后重读必须能拿到全文");
});

test("折叠窗口可由 LYNN_COMPACT_KEEP 调参，非法/过小回默认", () => {
  assert.equal(compactKeepRecent({}), 6);
  assert.equal(compactKeepRecent({ LYNN_COMPACT_KEEP: "3" }), 3);
  assert.equal(compactKeepRecent({ LYNN_COMPACT_KEEP: "1" }), 6, "窗口太小会让成员忘掉刚读的内容，反而不省");
  assert.equal(compactKeepRecent({ LYNN_COMPACT_KEEP: "999" }), 20);
  assert.equal(compactKeepRecent({ LYNN_COMPACT_KEEP: "abc" }), 6);
});

test("巡检回合的工具轮次上限低于主会话：默认 10、有界、可调", () => {
  const k = seedKernel(tmp());
  const saved = process.env.LYNN_PATROL_ROUNDS;
  try {
    delete process.env.LYNN_PATROL_ROUNDS;
    assert.equal(k.patrolRounds(), 10);
    process.env.LYNN_PATROL_ROUNDS = "4";
    assert.equal(k.patrolRounds(), 4);
    process.env.LYNN_PATROL_ROUNDS = "99";
    assert.equal(k.patrolRounds(), 24);
    process.env.LYNN_PATROL_ROUNDS = "3";
    assert.equal(k.patrolRounds(), 10, "低于 4 视为非法，回默认");
    assert.ok(k.patrolRounds() <= k.agentRounds(), "巡检上限不能超过主会话上限");
  } finally {
    if (saved === undefined) delete process.env.LYNN_PATROL_ROUNDS;
    else process.env.LYNN_PATROL_ROUNDS = saved;
  }
});

test("countUnfoldedTools 只数未折叠的；阈值默认 12", () => {
  const msgs = toolTurns(3);
  assert.equal(countUnfoldedTools(msgs), 3);
  const folded = compactToolHistory(msgs, { keepRecent: 0 });
  assert.equal(countUnfoldedTools(folded.messages), 0);
  assert.equal(compactThreshold({}), 12);
  assert.equal(compactThreshold({ LYNN_COMPACT_KEEP: "3" }), 6);
});

test("分代折叠：未满阈值不折（每轮折会把缓存命中率打穿）", async () => {
  const wd = tmp();
  const files = [];
  for (let i = 1; i <= 16; i += 1) {
    const name = `g${i}.md`;
    // 每条 2000+ 字符：低于 minChars(1200) 的结果不会被折叠，测不到阈值行为
    fs.writeFileSync(path.join(wd, name), `文件${i}\n` + "内容内容内容\n".repeat(400), "utf-8");
    files.push(name);
  }
  let call = 0;
  let firstFoldAt = 0;
  const chatFn = async (inp) => {
    call += 1;
    const hasFold = inp.messages.some((m) => m.role === "tool" && String(m.content).startsWith(FOLD_MARK));
    if (hasFold && !firstFoldAt) firstFoldAt = call;
    if (call <= 16) {
      return { content: "", toolCalls: [tc("read_file", { path: files[call - 1] })], promptTokens: 10, completionTokens: 5 };
    }
    return { content: "", toolCalls: [tc("submit_report", { text: "完成", evidence: [] })], promptTokens: 10, completionTokens: 5 };
  };
  const p = profile();
  p.limits.maxTurns = 24;
  p.limits.budgetTokens = 10_000_000;
  const res = await runMemberTask(memberInput(wd, { chatFn, profile: p, tools: ["read_file"] }));
  assert.equal(res.status, "reported");
  const th = compactThreshold();
  assert.ok(firstFoldAt >= th + 1, `第一次折叠应在第 ${th + 1} 轮之后，实际第 ${firstFoldAt} 轮`);
});

// ---------- 6. kernel 额度熔断 ----------

function seedKernel(root) {
  fs.writeFileSync(
    path.join(root, "settings.json"),
    JSON.stringify({
      model: {
        provider: "t",
        baseUrl: "http://127.0.0.1:9/v1",
        model: "m",
        apiKey: { encrypted: false, data: "k" },
        updatedAt: new Date().toISOString(),
      },
      prefs: { heartbeat: true },
    }),
    "utf-8",
  );
  return new Kernel(root);
}

test("额度熔断：进入后拒派，成功后自动解除", () => {
  const k = seedKernel(tmp());
  assert.equal(k.quotaCoolingDown(), false);
  k.noteQuotaExhausted("已达到 Token Plan 用量上限");
  assert.equal(k.quotaCoolingDown(), true);
  const res = k.dispatchMember("t1", "task-q", "林工", "简报", "", ["read_file"]);
  assert.equal(res.ok, false);
  assert.match(res.message, /额度已用尽/);
  k.noteQuotaOk();
  assert.equal(k.quotaCoolingDown(), false);
});

test("撞额度的那一轮不会因为函数正常返回就顺手解除熔断", async () => {
  const srv = await mockServer((req, res) => {
    res.writeHead(429, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: { message: "已达到 Token Plan 用量上限：请升级或购买积分" } }));
  });
  const root = tmp();
  fs.writeFileSync(
    path.join(root, "settings.json"),
    JSON.stringify({
      model: {
        provider: "t",
        baseUrl: srv.baseUrl,
        model: "m",
        apiKey: { encrypted: false, data: "k" },
        updatedAt: new Date().toISOString(),
      },
      prefs: { heartbeat: false },
    }),
    "utf-8",
  );
  const k = new Kernel(root);
  try {
    await k.runChat("你好");
    assert.equal(k.quotaCoolingDown(), true, "这一轮撞了额度上限，熔断必须留着");
  } finally {
    await srv.close();
  }
});

test("同一张单连续失败 3 次后拒绝原地重派（重派雪球熔断）", () => {
  const k = seedKernel(tmp());
  assert.equal(k.taskRepickBlocked("task-r"), null);
  k.noteTaskFailure("task-r", "error");
  k.noteTaskFailure("task-r", "error");
  assert.equal(k.taskRepickBlocked("task-r"), null, "两次还只是运气不好，不该拦");
  k.noteTaskFailure("task-r", "turn_limit");
  assert.match(k.taskRepickBlocked("task-r"), /连续失败 3 次/);
  k.noteTaskFailure("task-r", "reported");
  assert.equal(k.taskRepickBlocked("task-r"), null, "跑通一次就清零");
});
