// 成员档案规范（2026-11-11）：档案 = 岗位说明书，不是工单。
// 实机 31 份档案曾把路径/文件名/阶段/本次目标写进 name/goal/body/deliverable，
// 导致成员无法跨任务复雇、战绩按名字累积却每次换名归零。
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  MEMBER_PROFILE_RULES,
  MEMBER_WORK_STYLE_BODY,
  EXAMPLE_MEMBER_PROFILES,
  validateMemberProfile,
  memberProfileRejection,
} from "../dist/main/member-profile.js";
import { Kernel } from "../dist/main/kernel.js";
import { TeamStore } from "../dist/main/team-store.js";

const profileOf = (ex, over = {}) => ({
  name: ex.name,
  role: ex.role,
  goal: ex.goal,
  boundaries: [...ex.boundaries],
  tools: ["read_file", "list_dir"],
  model: "deepseek-chat",
  limits: { maxTurns: 8, budgetTokens: 100000, wallClockMin: 10 },
  outputContract: {
    deliverable: ex.deliverable,
    evidence: [...ex.evidence],
    acceptance: [...ex.acceptance],
  },
  escalateWhen: ex.escalateWhen,
  body: ex.body,
  ...over,
});

function setup() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "lynn-profile-"));
  const teams = new TeamStore(root);
  teams.createTeam("t1", "规范组");
  return { root, kernel: new Kernel(root), teams };
}

test("三个合规示例 + 内核默认正文都过闸", () => {
  for (const ex of EXAMPLE_MEMBER_PROFILES) {
    assert.deepEqual(validateMemberProfile(profileOf(ex)), [], `${ex.name} 应当合规`);
  }
  assert.deepEqual(validateMemberProfile(profileOf(EXAMPLE_MEMBER_PROFILES[0], { body: MEMBER_WORK_STYLE_BODY })), []);
});

test("任务信息逐类被点名：路径、文件名、任务 ID、阶段轮次、计数、复写正文、马甲名字", () => {
  const bad = profileOf(EXAMPLE_MEMBER_PROFILES[0], {
    name: "shutdown 分析员2",
    goal: "仅用 read_file/list_dir 分析 F:\\spiker\\hermix-desktop\\src-tauri\\src\\shutdown.rs 的职责与调用方",
    body: "岗位由风铃在任务中招募。目标：分析 shutdown.rs",
    outputContract: {
      deliverable: "阶段2 的报告，写入 tasks/task-mwbtxn13-6/workspace/report.md",
      evidence: ["HERMIX-4471 校验码"],
      acceptance: ["2 次调用内给出准确总数"],
    },
  });
  const issues = validateMemberProfile(bad);
  const rules = issues.map((i) => i.rule);
  for (const want of ["路径", "文件名", "ID", "阶段号", "复写", "马甲"]) {
    assert.ok(rules.some((r) => r.includes(want)), `应检出：${want}（实得 ${rules.join(" / ")}）`);
  }
  assert.ok(issues.every((i) => i.field && i.snippet));
});

test("退回说明带规范、命中字段与可照抄示例", () => {
  const bad = profileOf(EXAMPLE_MEMBER_PROFILES[0], {
    goal: "清点 G:\\实习相关文件 目录下的全部文件，报出文件数",
  });
  const text = memberProfileRejection(validateMemberProfile(bad));
  assert.match(text, /岗位说明书/);
  assert.match(text, /goal/);
  assert.match(text, /name: 代码审查员/);
  assert.match(text, /assign_task 简报/);
  assert.match(MEMBER_PROFILE_RULES, /战绩主键/);
});

test("招募入口：档案混入任务信息时当场退回，不建队不落人", () => {
  const { kernel, teams } = setup();
  const reply = kernel.runTool("create_member", {
    teamId: "t1",
    name: "shutdown 分析员",
    role: "代码阅读分析员",
    goal: "分析 F:\\spiker\\hermix-desktop\\src-tauri\\src\\shutdown.rs 的职责与调用方",
    tools: ["read_file", "list_dir"],
  });
  assert.match(reply, /成员档案不合格/);
  assert.equal(teams.listMembers("t1").length, 0, "退回时不该留下半个人");
});

test("招募入口：合规档案落盘，正文是通用做事风格而不是本次目标", () => {
  const { kernel, teams } = setup();
  const ex = EXAMPLE_MEMBER_PROFILES[0];
  const reply = kernel.runTool("create_member", {
    teamId: "t1",
    name: ex.name,
    role: ex.role,
    goal: ex.goal,
    boundaries: ex.boundaries,
    tools: ["read_file", "list_dir"],
    deliverable: ex.deliverable,
    acceptance: ex.acceptance,
  });
  assert.match(reply, /已招募/);
  const hired = teams.readMember("t1", ex.name);
  assert.equal(hired.body, MEMBER_WORK_STYLE_BODY);
  assert.doesNotMatch(hired.body, /目标：/);
  assert.deepEqual(validateMemberProfile(hired), [], "落盘后的完整档案也必须过闸");
});
