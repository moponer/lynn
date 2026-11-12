// 派单方法论（2026-11-12，借 leader skill）：
// 禁区（法）与取舍口径要一路带到成员眼前——不然风铃定了法，成员看不到就等于没定。
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Kernel } from "../dist/main/kernel.js";
import { TeamStore } from "../dist/main/team-store.js";
import { memberSystemPrompt } from "../dist/main/member-runner.js";

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "lynn-brief-"));

function seedModel(root) {
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
}

function seedTeam(root) {
  const teams = new TeamStore(root);
  teams.createTeam("t1", "月报突击队");
  teams.writeMember("t1", {
    name: "林工",
    role: "数据整理员",
    goal: "把源数据整理成可核对的月报",
    boundaries: ["只动工作区"],
    tools: ["read_file", "write_file"],
    model: "test-model",
    limits: { maxTurns: 6, budgetTokens: 100000, wallClockMin: 10 },
    outputContract: { deliverable: "report.md", evidence: ["报告文件"], acceptance: ["数字可对账"] },
    escalateWhen: "卡住",
    body: "",
  });
}

function setup() {
  const root = tmp();
  seedModel(root);
  seedTeam(root);
  const kernel = new Kernel(root);
  kernel.handle("config.prefs", { autoStart: false });
  return { root, kernel };
}

const BRIEF =
  "【目标】把 9 月材料整理成月报\n【完成标准】产出月报文件，数字与源材料核对一致\n【材料与位置】材料文件在工作区\n【限制】只做 9 月，不要改源材料";

test("成员提示词：禁区是法、取舍口径、探索型都进成员眼前", () => {
  const prompt = memberSystemPrompt({
    profile: {
      name: "林工",
      role: "数据整理员",
      goal: "把源数据整理成可核对的月报",
      boundaries: ["只动工作区"],
      tools: ["read_file", "write_file"],
      model: "test-model",
      limits: { maxTurns: 6, budgetTokens: 100000, wallClockMin: 10 },
      outputContract: { deliverable: "report.md", evidence: ["报告文件"], acceptance: ["数字可对账"] },
      escalateWhen: "卡住",
      body: "",
    },
    brief: BRIEF,
    deadline: "30 分钟",
    tools: ["read_file", "write_file"],
    workdir: "F:/tmp/work",
    forbidden: ["不许把测试 skip 掉", "不许 mock 被测对象"],
    priority: "算得对 > 做得全 > 做得快",
    mode: "explore",
    model: { baseUrl: "http://127.0.0.1:9/v1", apiKey: "k", model: "m" },
  });
  assert.match(prompt, /不许把测试 skip 掉/, "禁区要进成员提示词");
  assert.match(prompt, /不许 mock 被测对象/);
  assert.match(prompt, /违反即不合格/, "禁区是法，不是建议");
  assert.match(prompt, /算得对 > 做得全 > 做得快/, "取舍口径要明确");
  assert.match(prompt, /探索型/, "探索型任务另给一套要求");
  assert.match(prompt, /别硬凑文件|别为了交差硬凑/, "探索型不强压产物");
});

test("派单：禁区/取舍/型态落进工单与契约卡", async () => {
  const { kernel } = setup();
  try {
    await kernel.init();
    const r = kernel.runTool("assign_task", {
      teamId: "t1",
      taskId: "task-1",
      member: "林工",
      brief: BRIEF,
      deadline: "30 分钟",
      acceptance: ["数字可对账"],
      forbidden: ["不许把测试 skip 掉", "不许 mock 被测对象"],
      priority: "算得对 > 做得全 > 做得快",
      mode: "explore",
    });
    assert.doesNotMatch(r, /简报不合格|已退回/, "可选参数不该把简报退回");

    const rec = kernel.taskStore.get("task-1");
    assert.deepEqual(rec.forbidden, ["不许把测试 skip 掉", "不许 mock 被测对象"], "禁区随单落盘");
    assert.equal(rec.priority, "算得对 > 做得全 > 做得快");
    assert.equal(rec.mode, "explore");

    // 契约卡上要看得见（用户点「开始」前就该知道这次的红线）
    const plan = kernel.handle("session.snapshot").board.decisions.find((d) => d.kind === "plan" && d.jobId === "task-1");
    assert.ok(plan, "应有任务契约");
    assert.match(plan.detail, /禁区（不许做）/);
    assert.match(plan.detail, /算得对 > 做得全/);
    assert.match(plan.detail, /探索型/);
  } finally {
    await kernel.dispose();
  }
});
