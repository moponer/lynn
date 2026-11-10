import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Kernel, AGENT_TOOL_NAMES } from "../dist/main/kernel.js";
import { ManagementTools, MANAGEMENT_ONLY_TOOLS } from "../dist/main/management-tools.js";
import { TeamStore } from "../dist/main/team-store.js";

/**
 * 工具面断言（计划书 §3.1 / §4.10.3 / M0 验收）。
 *
 * 这三条不是"提示词叮嘱"，而是可执行的事实：
 *  1. 风铃只有管理工具（含 check_roster 花名册，M2-14），没有任何执行类工具；
 *  2. 她调用执行类工具名一律是"未知工具"，不会被静默执行；
 *  3. 成员白名单不得包含管理型工具（成员没有 ask_user，也不能再招募）。
 */

const LYNN_TOOLS = [
  "accept_or_reject",
  "ask_user",
  "assign_task",
  "check_progress",
  "check_roster",
  "create_member",
  "create_plugin_draft",
  "create_team",
  "dissolve_team",
  // 2026-11-04：指挥者要能"管"——催办在跑的成员、停掉明显做不到的单
  "nudge_member",
  "report_to_user",
  "review_result",
  "save_memory",
  "ship_plugin",
  "stop_task",
];

/** 执行类工具：这些只发给成员，永远不该出现在她的工具面里 */
const EXEC_TOOLS = [
  "bash",
  "write",
  "edit",
  "read",
  "glob",
  "grep",
  "browser",
  "office",
  "mcp__github__search",
];

function tmpRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "lynn-surface-"));
}

const member = (over = {}) => ({
  name: "林工",
  role: "后端工程师",
  goal: "清洗对账",
  boundaries: ["只改数据目录"],
  tools: ["read_file"],
  model: "deepseek-chat",
  limits: { maxTurns: 40, budgetTokens: 300000, wallClockMin: 30 },
  outputContract: { deliverable: "diff", evidence: ["测试输出"], acceptance: ["test 全绿"] },
  escalateWhen: "需要新依赖",
  body: "岗位说明",
  ...over,
});

test("风铃的工具面恰好是 15 件管理工具", () => {
  assert.deepEqual([...AGENT_TOOL_NAMES].sort(), LYNN_TOOLS);
});

test("风铃没有执行类工具：执行工具名一个都不出现", () => {
  for (const tool of EXEC_TOOLS) {
    assert.ok(
      !AGENT_TOOL_NAMES.includes(tool),
      `${tool} 不得出现在她的工具面（§3.1：她不执行，执行工具只发给成员）`,
    );
  }
});

test("她调用执行类工具 → 未知工具，不会被静默执行", () => {
  const kernel = new Kernel(tmpRoot());
  for (const tool of ["bash", "write", "browser"]) {
    assert.match(kernel.runTool(tool, { command: "rm -rf /" }), /^未知工具/);
  }
});

test("成员白名单不得包含管理型工具（没有 ask_user、不能再招募）", () => {
  const root = tmpRoot();
  const store = new TeamStore(root);
  const tools = new ManagementTools(store, root);
  store.createTeam("t1", "测评组");

  assert.throws(
    () => tools.createMember("t1", member({ tools: ["read", "ask_user"] })),
    /管理型工具/,
    "成员不能直接问用户（§4.7 审批归集到风铃）",
  );
  assert.throws(
    () => tools.createMember("t1", member({ name: "副指挥", tools: ["create_member"] })),
    /管理型工具/,
    "成员不得再招募成员（§4.10.3 单层指挥）",
  );
  assert.throws(
    () => tools.createMember("t1", member({ name: "自审", tools: ["accept_or_reject"] })),
    /管理型工具/,
    "成员不得自己验收（§4.10.5 审查归风铃）",
  );

  const file = tools.createMember("t1", member({ name: "正牌", tools: ["read_file", "write_file"] }));
  assert.ok(fs.existsSync(file), "纯执行类工具白名单应当放行");
});

test("白名单写了不存在的工具名 → 当场拒绝，不静默过滤（否则成员带空工具集空跑）", () => {
  const root = tmpRoot();
  const store = new TeamStore(root);
  const tools = new ManagementTools(store, root);
  store.createTeam("t1", "测评组");

  // 旧 schema 的示例名（read/write/edit/bash/browser）全都不存在，必须报错并给真实清单
  assert.throws(
    () => tools.createMember("t1", member({ tools: ["read", "write", "browser"] })),
    /未知工具.*read、write、browser/,
  );
  // 报错里要给出可直接照抄的真实名字
  assert.throws(
    () => tools.createMember("t1", member({ name: "网页操作员", tools: ["browser"] })),
    /browser_navigate/,
  );
});

test("管理型工具名单 = 风铃工具面（成员禁入名单与她的工具面同源）", () => {
  assert.deepEqual([...MANAGEMENT_ONLY_TOOLS].sort(), LYNN_TOOLS);
});
