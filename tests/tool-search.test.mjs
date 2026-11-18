/**
 * 工具二级加载（P4-2 / 10 章 §4，D7）。
 *
 * 这项跟别的优化不一样：它**省 token 但可能多一轮**。所以测试要证明的不只是"能搜到"，
 * 还有它的两条边界条件——什么时候启用、什么时候根本不该启用：
 *  1. 工具面小（≤8）时全量发送，连 tool_search 都不发：那点 token 不值得拿多一轮去换；
 *  2. 工具面大时才启用，且热路径（read/write/edit/list_dir/glob/grep/run_command）永远常驻——
 *     基线里 list_dir 被调了 418 次，藏到搜索后面等于让"看目录"每次多花一轮；
 *  3. 搜到的工具**下一轮才可调**（这一轮模型还没见过它的参数 schema）；
 *  4. 搜不到要如实说还剩哪些没加载，别让成员以为"没有这个工具"。
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { memberSurface, searchTools, HOT_TOOLS, LAZY_THRESHOLD, TOOL_SEARCH_SCHEMA } from "../dist/main/tool-search.js";
import { memberToolSchemas, runMemberTask } from "../dist/main/member-runner.js";
import { TOOLKIT_SCHEMAS } from "../dist/main/toolkit.js";

const BIG_SET = [
  "read_file",
  "write_file",
  "edit_file",
  "list_dir",
  "glob",
  "grep",
  "run_command",
  "office_write_docx",
  "office_write_table",
  "browser_navigate",
];

function tmpWorkdir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "lynn-lazy-"));
}
const tc = (id, name, args) => ({ id, name, arguments: JSON.stringify(args) });

function profile() {
  return {
    name: "林工",
    role: "数据整理员",
    roleId: "analyst",
    goal: "把表整理干净",
    boundaries: ["只动工作区"],
    tools: BIG_SET,
    model: "m",
    limits: { maxTurns: 8, budgetTokens: 300000, wallClockMin: 20 },
    outputContract: { deliverable: "out.csv", evidence: ["表"], acceptance: ["对账"] },
    escalateWhen: "卡住",
    body: "先读再写。",
  };
}

test("热路径常驻集里没有长尾工具（office/browser/符号）", () => {
  for (const t of HOT_TOOLS) {
    assert.ok(!/^office_|^browser_|^app_|^ssh_|^kb_/.test(t), `${t} 不该在热路径常驻`);
  }
  // 基线实测里被调得最多的几件都必须在：否则省 token 换来的是多一轮
  for (const t of ["read_file", "grep", "list_dir", "glob", "run_command"]) {
    assert.ok(HOT_TOOLS.includes(t), `${t} 是热路径，必须常驻`);
  }
});

test("工具面小的时候不启用二级加载（省不了多少，却要赌模型会不会去搜）", () => {
  const small = ["read_file", "write_file", "office_write_docx"];
  const s = memberSurface(small, new Set(), true);
  assert.equal(s.lazy, false);
  assert.deepEqual(s.hidden, []);
  assert.deepEqual(s.names.slice().sort(), small.slice().sort(), "小工具面要把全部发下去");
});

test("工具面大才启用：热路径留下，长尾进 hidden", () => {
  assert.ok(BIG_SET.length > LAZY_THRESHOLD, "夹具本身要超过阈值，否则这条测试测不到东西");
  const s = memberSurface(BIG_SET, new Set(), true);
  assert.equal(s.lazy, true);
  assert.ok(s.names.includes("read_file") && s.names.includes("grep"), "热路径要在常驻里");
  assert.ok(s.hidden.includes("office_write_docx"), "长尾工具要进 hidden");
  assert.ok(!s.names.includes("office_write_docx"));
  assert.equal(s.names.length + s.hidden.length, BIG_SET.length, "工具要么常驻要么待加载，不许凭空消失");
});

test("开关关掉就全量发送（回退路径）", () => {
  const s = memberSurface(BIG_SET, new Set(), false);
  assert.equal(s.lazy, false);
  assert.deepEqual(s.hidden, []);
  assert.equal(s.names.length, BIG_SET.length);
});

test("已解锁的工具留在常驻里，不会下一轮又被藏回去", () => {
  const others = BIG_SET.filter((n) => !HOT_TOOLS.includes(n));
  const s = memberSurface(BIG_SET, new Set([others[0]]), true);
  assert.ok(s.names.includes(others[0]), "解锁过的要一直可见");
  assert.ok(!s.hidden.includes(others[0]));
});

test("searchTools：按「你要做什么」搜到对的长尾工具，并给出为什么", () => {
  const hidden = TOOLKIT_SCHEMAS.filter((t) => BIG_SET.includes(t.function.name) && !HOT_TOOLS.includes(t.function.name));
  assert.ok(hidden.length >= 3, "夹具里的长尾工具太少，测不出排序");

  const hits = searchTools("写一个 Word 文档", hidden);
  assert.ok(hits.length > 0, "这都搜不到，等于这个功能没法用");
  assert.equal(hits[0].name, "office_write_docx", `排在第一位的是 ${hits[0].name}，不是写 Word 的那件`);
  assert.match(hits[0].why, /名字|描述/, "要能解释为什么是它");

  const table = searchTools("表格", hidden);
  assert.ok(table.some((h) => h.name === "office_write_table"));
});

test("searchTools：搜不到就返回空（由调用方如实告诉成员还剩哪些）", () => {
  const hidden = TOOLKIT_SCHEMAS.filter((t) => t.function.name === "office_write_docx");
  assert.deepEqual(searchTools("量子纠缠", hidden), []);
});

test("二级加载时 tool_search 必须一起发下去；不启用时不该出现", () => {
  const withLazy = memberToolSchemas(["read_file"], { lazy: true }).map((s) => s.function.name);
  assert.ok(withLazy.includes("tool_search"), "没有 tool_search，模型无从发现长尾工具");
  assert.ok(withLazy.includes("submit_report") && withLazy.includes("post_message"), "通道永远在");
  const withoutLazy = memberToolSchemas(["read_file"]).map((s) => s.function.name);
  assert.ok(!withoutLazy.includes("tool_search"), "不启用时别多发一件工具");
  assert.deepEqual(TOOL_SEARCH_SCHEMA.function.name, "tool_search");
});

test("运行期：搜到的工具下一轮出现在工具面里，且这一轮就能用它", async () => {
  let round = 0;
  const seenTools = [];
  const wd = tmpWorkdir();
  const chat = async (input) => {
    round += 1;
    seenTools.push(input.tools.map((t) => t.function.name));
    const step =
      round === 1
        ? { toolCalls: [tc("1", "tool_search", { query: "表格" })] }
        : round === 2
          ? { toolCalls: [tc("2", "office_write_table", { path: "out.csv", rows: [["a", "1"]] })] }
          : { toolCalls: [tc("3", "submit_report", { text: "【完成】表已写", evidence: [], deliverables: [] })] };
    input.messages.push({ role: "assistant", content: null, tool_calls: step.toolCalls });
    for (const c of step.toolCalls) input.messages.push({ role: "tool", tool_call_id: c.id, name: c.name, content: "（占位）" });
    return { content: "", toolCalls: step.toolCalls, promptTokens: 10, completionTokens: 5 };
  };
  const r = await runMemberTask({
    profile: profile(),
    brief: "【目标】出表\n【完成标准】能对账\n【材料与位置】工作区\n【限制】只读",
    deadline: "30 分钟",
    tools: BIG_SET,
    workdir: wd,
    model: { baseUrl: "http://x", apiKey: "k", model: "m" },
    chatFn: chat,
    lazyTools: true,
  });
  assert.equal(r.status, "reported");
  assert.ok(!seenTools[0].includes("office_write_table"), "第一轮还不该看见它（模型没见过参数 schema）");
  assert.ok(seenTools[0].includes("tool_search"), "第一轮要有 tool_search");
  assert.ok(seenTools[1].includes("office_write_table"), "搜到之后下一轮要出现在工具面里");
  assert.ok(seenTools[1].includes("tool_search"), "tool_search 要留着，后面还可能用");
});

test("运行期：工具面本来就小时，模型调 tool_search 会被明确劝退（不白花一轮）", async () => {
  const wd = tmpWorkdir();
  const small = ["read_file", "write_file"];
  let round = 0;
  const chat = async (input) => {
    round += 1;
    const step =
      round === 1
        ? { toolCalls: [tc("1", "tool_search", { query: "表格" })] }
        : { toolCalls: [tc("2", "submit_report", { text: "【完成】没工具也能干完", evidence: [], deliverables: [] })] };
    input.messages.push({ role: "assistant", content: null, tool_calls: step.toolCalls });
    for (const c of step.toolCalls) input.messages.push({ role: "tool", tool_call_id: c.id, name: c.name, content: "（占位）" });
    return { content: "", toolCalls: step.toolCalls, promptTokens: 10, completionTokens: 5 };
  };
  const r = await runMemberTask({
    profile: { ...profile(), tools: small },
    brief: "【目标】x\n【完成标准】y\n【材料与位置】z\n【限制】w",
    deadline: "30 分钟",
    tools: small,
    workdir: wd,
    model: { baseUrl: "http://x", apiKey: "k", model: "m" },
    chatFn: chat,
    lazyTools: true,
  });
  assert.equal(r.status, "reported", "劝退不该把单搞挂");
});