// 成员工具面 ↔ 提示词一致性（2026-11-16）。
//
// 现场数据（本机 audit.jsonl / agent.log，781 条成员命令）：`Get-ChildItem -Recurse`
// 这类递归扫盘 99 次（12.7%），而成员提示词明明写着「按模式找文件用 glob」。
// 根因不是模型不听话，是 glob / grep 从来没进过 MEMBER_EXEC_TOOLS：
//   memberToolSchemas = TOOLKIT_SCHEMAS ∩ 白名单，白名单又只能填 MEMBER_EXEC_TOOLS 里的名字
//   → 两个工具根本发不到成员手上，它只剩命令可走。
// 这组测试把「提示词说得到」与「工具面拿不到」锁在一起，防止再漂移。
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  MEMBER_EXEC_TOOLS,
  memberSystemPrompt,
  memberToolSchemas,
  runMemberTask,
} from "../dist/main/member-runner.js";
import { Toolkit } from "../dist/main/toolkit.js";
import { Kernel } from "../dist/main/kernel.js";

const tmp = (p = "lynn-tooling-") => fs.mkdtempSync(path.join(os.tmpdir(), p));

const profile = (over = {}) => ({
  name: "资料员",
  role: "文件清点与内容提取",
  goal: "把给定目录盘点成清单",
  boundaries: ["只读材料"],
  tools: ["read_file", "list_dir", "glob", "grep"],
  model: "deepseek-chat",
  limits: { maxTurns: 8, budgetTokens: 100000, wallClockMin: 20 },
  outputContract: { deliverable: "清单", evidence: ["清单原文"], acceptance: ["条目与实际一致"] },
  escalateWhen: "目录不可读",
  body: "",
  ...over,
});

const inputOf = (over = {}) => ({
  profile: profile(),
  brief: "盘点目录并出清单",
  deadline: "今天 18:00",
  tools: ["read_file", "list_dir", "glob", "grep"],
  workdir: tmp(),
  model: { baseUrl: "http://x", apiKey: "k", model: "m" },
  ...over,
});

const tc = (id, name, args) => ({ id, name, arguments: JSON.stringify(args) });

test("提示词点名的工具，必须真在成员执行面里（说得到 = 拿得到）", () => {
  const sys = memberSystemPrompt(inputOf());
  const named = new Set(
    sys.match(/\b(?:read_file|write_file|list_dir|glob|grep|run_command|office_\w+|browser_\w+|app_api|ssh_run|kb_add|submit_report)\b/g) ?? [],
  );
  // 这条断言本身也要有意义：确认提示词确实在教 glob/grep
  assert.ok(named.has("glob") && named.has("grep"), "找文件的指引里必须有 glob / grep");
  for (const n of named) {
    assert.ok(
      n === "submit_report" || MEMBER_EXEC_TOOLS.includes(n),
      `提示词点名了 ${n}，但它不在成员执行面里——成员会被工具层以「未知工具」拒掉`,
    );
  }
});

test("glob / grep：可授权、能发下来、在工作区里真能跑", async () => {
  for (const t of ["glob", "grep"]) {
    assert.ok(MEMBER_EXEC_TOOLS.includes(t), `${t} 必须在 MEMBER_EXEC_TOOLS 里（否则风铃填了也会被过滤）`);
  }
  const names = memberToolSchemas(["glob", "grep"]).map((s) => s.function.name);
  assert.deepEqual(names.sort(), ["glob", "grep", "submit_report"], "白名单授权即发放，回报通道不可剥");

  const root = tmp();
  fs.mkdirSync(path.join(root, "src", "deep"), { recursive: true });
  fs.writeFileSync(path.join(root, "src", "a.ts"), "const needle = 1;\n", "utf-8");
  fs.writeFileSync(path.join(root, "src", "deep", "b.ts"), "没有命中\n", "utf-8");
  const tk = new Toolkit(root);
  assert.match(tk.glob({ pattern: "**/*.ts" }), /src\/a\.ts/, "glob 能按模式找文件");
  assert.match(tk.grep({ pattern: "needle", include: "**/*.ts" }), /src\/a\.ts:1:/, "grep 能按类型搜内容");
  assert.doesNotMatch(tk.grep({ pattern: "needle", include: "**/*.md" }), /a\.ts/, "include 真的在收窄范围");
});

test("成员循环里真的调得到 glob：结果回到模型，不会被判未知工具", async () => {
  const wd = tmp();
  fs.mkdirSync(path.join(wd, "src"), { recursive: true });
  fs.writeFileSync(path.join(wd, "src", "orders.csv"), "id,amount\n1,10\n", "utf-8");

  let seen = "";
  let i = 0;
  const chat = async (input) => {
    const script = [
      { toolCalls: [tc("1", "glob", { pattern: "**/*.csv" })] },
      { toolCalls: [tc("2", "submit_report", { text: "【完成】找到 1 个表格文件", evidence: ["src/orders.csv"] })] },
    ];
    if (i === 1) seen = input.messages.map((m) => String(m.content ?? "")).join("\n");
    const step = script[Math.min(i++, script.length - 1)];
    input.messages.push({ role: "assistant", content: null, tool_calls: step.toolCalls });
    for (const call of step.toolCalls) input.messages.push({ role: "tool", tool_call_id: call.id, name: call.name, content: "（占位）" });
    return { content: "", toolCalls: step.toolCalls, promptTokens: 10, completionTokens: 5 };
  };

  const r = await runMemberTask({
    ...inputOf({ workdir: wd }),
    tools: ["read_file", "list_dir", "glob"],
    chatFn: chat,
  });
  assert.equal(r.status, "reported");
  assert.match(seen, /src[\\/]orders\.csv/, "glob 的输出必须真的回到模型上下文里");
  assert.doesNotMatch(seen, /未知工具/, "glob 是本次分配的工具，不该被判未知");
});

test("read_file 漏填 path：报「path 必填」，不再含糊地说「是目录」", async () => {
  const tk = new Toolkit(tmp());
  await assert.rejects(() => tk.readFile({}), /path 必填/);
  await assert.rejects(() => tk.readFile({ path: "   " }), /path 必填/);
  await assert.rejects(() => tk.readFile({ path: "." }), /列目录请用 list_dir/);
});

test("create_member 的工具清单描述由 MEMBER_EXEC_TOOLS 生成（不再各写一份）", async () => {
  const kernel = new Kernel(tmp());
  try {
    await kernel.init();
    const schema = kernel.allTools().find((t) => t.function.name === "create_member");
    assert.ok(schema, "create_member 必须在工具面里");
    const desc = String(schema.function.parameters.properties.tools.description ?? "");
    for (const t of MEMBER_EXEC_TOOLS) {
      assert.ok(desc.includes(t), `create_member 的 tools 说明漏了 ${t}——她就不会分配它`);
    }
  } finally {
    await kernel.dispose();
  }
});
