// 授权口径（2026-11-15 用户拍板）：
//  - 成员权限由风铃授予：她判断风险，用户只管风铃的档位；
//  - 放手档下全权由风铃负责，但成员**永远不继承放手级**（删除免审批不往下传）；
//  - 群终止后挂着等用户的审批卡必须撤掉（实机：终止后「等你拍板」还赖着不走）。
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Kernel } from "../dist/main/kernel.js";
import { TeamStore } from "../dist/main/team-store.js";
import { TaskStore } from "../dist/main/task-store.js";
import { TaskCase } from "../dist/main/task-case.js";
import { memberSystemPrompt } from "../dist/main/member-runner.js";

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "lynn-auth-"));

const MEMBER = {
  name: "阿计",
  role: "整理员",
  goal: "整理材料",
  boundaries: ["只动工作区"],
  tools: ["read_file", "write_file"],
  model: "test-model",
  limits: { maxTurns: 6, budgetTokens: 100000, wallClockMin: 10 },
  outputContract: { deliverable: "报告", evidence: ["文件"], acceptance: ["可核对"] },
  escalateWhen: "卡住",
  body: "",
};

function setup() {
  const root = tmp();
  fs.writeFileSync(
    path.join(root, "settings.json"),
    JSON.stringify({
      model: {
        provider: "test",
        baseUrl: "http://127.0.0.1:9/v1",
        model: "test-model",
        apiKey: { encrypted: false, data: "test-key" },
        updatedAt: new Date().toISOString(),
      },
    }),
    "utf-8",
  );
  const teams = new TeamStore(root);
  teams.createTeam("t1", "整理组");
  teams.writeMember("t1", MEMBER);
  const kernel = new Kernel(root);
  kernel.memberChatFn = async () => ({ content: "", toolCalls: [], promptTokens: 1, completionTokens: 1 });
  return { root, kernel, tasks: new TaskStore(root), cases: new TaskCase(root) };
}

const BRIEF =
  "【目标】把 9 月订单整理成周报\n【完成标准】周报数字与源表一致\n【材料与位置】工作区 orders.csv\n【限制】不改源表口径";

test("放手档：成员不继承放手级，删除由风铃代批并留痕，不打扰用户", async () => {
  const { root, kernel, cases } = setup();
  try {
    kernel.handle("permission.set", { mode: "full" });
    const r = await kernel.awaitCommandApproval("阿计", "task-1", "del report.md");
    assert.equal(r.ok, true, "放手档下不该把这种事丢回给用户");
    const notes = cases.readTimeline("task-1").filter((e) => /风铃代批删除/.test(e.text));
    assert.equal(notes.length, 1, "谁批的、凭什么批必须留痕");
    assert.match(notes[0].text, /成员不继承放手级/);
    const decisions = kernel.handle("session.snapshot").board.decisions;
    assert.equal(decisions.some((d) => d.kind === "approval"), false, "放手档不该弹审批卡");
  } finally {
    await kernel.dispose();
  }
});

test("自动档：默认档也不逐个点删除——风铃代批留痕，不占「等你拍板」", async () => {
  const { kernel, cases } = setup();
  try {
    kernel.handle("permission.set", { mode: "auto" });
    const r = await kernel.awaitCommandApproval("阿计", "task-2", "del report.md");
    assert.equal(r.ok, true);
    assert.match(cases.readTimeline("task-2").map((e) => e.text).join("\n"), /自动档：风铃代批删除/);
    assert.equal(
      kernel.handle("session.snapshot").board.decisions.some((d) => d.kind === "approval"),
      false,
      "默认档（自动）不该把执行细节逐条丢回给用户",
    );
  } finally {
    await kernel.dispose();
  }
});

test("询问档：唯一会逐次问用户的档位（用户自己选的细粒度控制）", async () => {
  const { kernel } = setup();
  try {
    kernel.handle("permission.set", { mode: "ask" });
    const waiting = kernel.awaitCommandApproval("阿计", "task-4", "del report.md");
    const card = kernel.handle("session.snapshot").board.decisions.find((d) => d.kind === "approval");
    assert.ok(card, "询问档：删除必须挂一张审批卡");
    assert.match(card.title, /阿计 要删除文件/);
    assert.equal(kernel.handle("decision.resolve", { id: card.id, action: "start" }).ok, true);
    assert.equal((await waiting).ok, true, "用户点头后成员才继续");
  } finally {
    await kernel.dispose();
  }
});

test("自动档：只读授权由风铃授予即生效，不再标成「等用户批准」", async () => {
  const { root, kernel, tasks, cases } = setup();
  try {
    kernel.handle("permission.set", { mode: "auto" });
    kernel.handle("config.prefs", { autoStart: true });
    const grant = fs.mkdtempSync(path.join(os.tmpdir(), "lynn-auth-grant-"));
    kernel.runTool("assign_task", {
      teamId: "t1",
      taskId: "task-3",
      member: "阿计",
      brief: BRIEF,
      deadline: "30 分钟",
      acceptance: ["周报存在", "数字一致", "无占位符"],
      readRoots: [grant],
    });
    assert.deepEqual(tasks.get("task-3").readRoots, [path.resolve(grant)], "她授予的只读要真的落权");
    const notes = cases.readTimeline("task-3").map((e) => e.text);
    assert.ok(
      notes.some((t) => /风铃授予只读授权/.test(t)),
      `授权归属要写清是谁给的（实际：${notes.join(" | ")}）`,
    );
    assert.equal(notes.some((t) => /用户批准只读授权/.test(t)), false, "自动档不该记成用户批准");
  } finally {
    await kernel.dispose();
  }
});

test("群终止：挂着等用户的审批卡立刻撤掉，成员那侧按拒绝收口", async () => {
  const { kernel } = setup();
  try {
    const tid = kernel.handle("session.snapshot").thread.id;
    const resolved = [];
    kernel.pendingApprovals.set("ap-test", { kind: "delete", resolve: (ok) => resolved.push(ok) });
    kernel.decisions.push({
      id: "ap-test",
      from: "阿计",
      title: "阿计 要删除文件（task-9）",
      detail: "命令：del x",
      kind: "approval",
      jobId: "task-9",
      threadId: tid,
      at: new Date().toISOString(),
    });
    assert.equal(kernel.handle("thread.halt", {}).ok, true);
    const left = kernel.handle("session.snapshot").board.decisions.filter((d) => d.threadId === tid);
    assert.equal(left.length, 0, "终止之后没人会来点，审批卡不能留着");
    assert.deepEqual(resolved, [false], "等审批的成员要按拒绝收口，不能干等 5 分钟超时");
  } finally {
    await kernel.dispose();
  }
});

test("成员提示词：授权归风铃、无放手级、读不到就停手", () => {
  const prompt = memberSystemPrompt({
    profile: MEMBER,
    brief: BRIEF,
    deadline: "30 分钟",
    tools: ["read_file", "write_file"],
    workdir: "C:\\work",
  });
  assert.match(prompt, /授权归风铃/);
  assert.match(prompt, /没有「放手」级权限/);
  assert.match(prompt, /需要授权：<绝对路径>/);
  assert.match(prompt, /最多试两种写法/);
});
