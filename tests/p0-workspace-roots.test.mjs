// 派单授权收口：原始绝对路径校验、敏感根拒绝、realpath 复检与历史授权过滤。
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Kernel } from "../dist/main/kernel.js";
import { forbiddenRootReason } from "../dist/main/roots.js";
import { TeamStore } from "../dist/main/team-store.js";
import { TaskStore } from "../dist/main/task-store.js";

process.env.NODE_TEST_CONTEXT ||= "p0-workspace-roots";

const GOOD =
  "【目标】把 9 月订单表整理成周报\n【完成标准】产出周报-09.md，数字与源表核对一致\n【材料与位置】材料文件在工作区 orders.csv\n【限制】只做 9 月，不要改源表口径";

function setup() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "lynn-p0-roots-"));
  const teams = new TeamStore(root);
  teams.createTeam("t1", "月报组");
  teams.writeMember("t1", {
    name: "林工",
    role: "数据整理员",
    goal: "整理数据",
    boundaries: ["只动工作区"],
    tools: ["read_file", "write_file"],
    model: "deepseek-chat",
    limits: { maxTurns: 8, budgetTokens: 100000, wallClockMin: 10 },
    outputContract: { deliverable: "报告", evidence: ["文件"], acceptance: ["可对账"] },
    escalateWhen: "卡住",
    body: "",
  });
  const kernel = new Kernel(root);
  kernel.handle("config.prefs", { autoStart: false });
  return { root, kernel, tasks: new TaskStore(root) };
}

function assign(kernel, extra = {}) {
  return kernel.runTool("assign_task", {
    teamId: "t1",
    member: "林工",
    brief: GOOD,
    deadline: "周五",
    ...extra,
  });
}

function dirLinkOrSkip(t, target, link) {
  try {
    fs.symlinkSync(target, link, "junction");
    return true;
  } catch (err) {
    t.skip(`当前环境无权创建目录符号链接：${String(err)}`);
    return false;
  }
}

test("敏感根：所有平台都拒绝整个家目录，但允许其具体子目录", () => {
  const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), "lynn-p0-home-data-"));
  assert.match(forbiddenRootReason(os.homedir(), dataRoot), /整个用户目录/);
  assert.equal(forbiddenRootReason(path.join(os.homedir(), "lynn-specific-project"), dataRoot), null);
});

test("workspace/readRoots：先验原始字符串，相对路径不能 resolve 后混过校验", async () => {
  const { kernel } = setup();
  try {
    assert.match(assign(kernel, { workspace: "relative-workspace" }), /workspace 必须是绝对路径/);
    assert.match(assign(kernel, { readRoots: ["relative-materials"] }), /readRoots 必须是绝对路径/);
    assert.match(assign(kernel, { workspace: "C:\\" }), /盘符根/);
  } finally {
    await kernel.dispose();
  }
});

test("workspace/readRoots：数据根、盘符根与家目录均在派单入口拒绝", async () => {
  const { root, kernel } = setup();
  try {
    assert.match(assign(kernel, { workspace: root }), /数据目录|盘符根/);
    assert.match(assign(kernel, { workspace: path.parse(path.resolve(root)).root }), /盘符根/);
    assert.match(assign(kernel, { workspace: os.homedir() }), /整个用户目录/);
    assert.match(assign(kernel, { readRoots: [root] }), /不允许授权.*数据目录/);
    assert.match(assign(kernel, { readRoots: [os.homedir()] }), /不允许授权.*整个用户目录/);
  } finally {
    await kernel.dispose();
  }
});

test("workspace/readRoots：符号链接指向数据根时 realpath 复检同样拒绝", async (t) => {
  const { root, kernel } = setup();
  const links = path.join(root, "links");
  fs.mkdirSync(links, { recursive: true });
  const workspaceLink = path.join(links, "workspace-link");
  const readLink = path.join(links, "read-link");
  if (!dirLinkOrSkip(t, root, workspaceLink)) return;
  if (!dirLinkOrSkip(t, root, readLink)) return;
  try {
    assert.match(assign(kernel, { workspace: workspaceLink }), /数据目录|不允许/);
    assert.match(assign(kernel, { readRoots: [readLink] }), /不允许授权.*数据目录/);
  } finally {
    await kernel.dispose();
  }
});

test("历史授权继承：沿用本会话已批准根，但敏感根与失效路径不会复活", async () => {
  const { root, kernel, tasks } = setup();
  const grant = fs.mkdtempSync(path.join(os.tmpdir(), "lynn-p0-valid-grant-"));
  try {
    const threadId = kernel.handle("session.snapshot").thread.id;
    tasks.create({ id: "task-history", title: "历史单", teamId: "t1", member: "林工", threadId });
    tasks.setReadRoots("task-history", [grant, root, os.homedir(), path.join(root, "not-exists")]);
    const out = assign(kernel);
    assert.match(out, /任务契约已呈给用户/);
    const pending = [...kernel.pendingPlans.values()].at(-1);
    assert.deepEqual(pending.readRoots, [path.resolve(grant)]);
  } finally {
    await kernel.dispose();
  }
});
