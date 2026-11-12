// 2026-11-12 用户实测反馈后的两项修复：
// ①成员交回报后必须**立刻**叫醒风铃验收（此前只能等心跳闸或用户主动问——闭环断了）
// ②群公告不必由用户写：风铃能起草（set_group_notice / thread.draftNotice）
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Kernel } from "../dist/main/kernel.js";
import { TeamStore } from "../dist/main/team-store.js";

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "lynn-notice-"));

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

test("成员回报后立刻叫醒风铃验收，不等心跳", async () => {
  const { kernel } = setup();
  try {
    await kernel.init();
    kernel.wakeLynnForReview("task-1", "林工", "月报完成，数字对得上");
    assert.equal(kernel.busy, true, "成员一交回报，风铃就该立刻起一轮去验收");
    assert.equal(kernel.reviewPending.length, 0, "这一条应被立刻消费");
  } finally {
    await kernel.dispose();
  }
});

test("风铃正忙时，回报先挂着不打断它；忙完再叫", async () => {
  const { kernel } = setup();
  try {
    await kernel.init();
    kernel.busy = true; // 模拟正在跑
    kernel.wakeLynnForReview("task-1", "林工", "月报完成");
    assert.equal(kernel.reviewPending.length, 1, "忙时先挂着，别打断正在跑的活");
    assert.equal(kernel.busy, true, "不能因为回报就插队");

    kernel.busy = false;
    kernel.drainReviewPending();
    assert.equal(kernel.reviewPending.length, 0, "闲下来就把它叫起来");
    assert.equal(kernel.busy, true, "叫起来后是一轮新的验收");
  } finally {
    await kernel.dispose();
  }
});

test("群公告由风铃起草：工具能写、能落盘、群里看得见", async () => {
  const { kernel } = setup();
  try {
    await kernel.init();
    const id = kernel.handle("session.snapshot").thread.id;
    const r = kernel.runTool("set_group_notice", {
      text: "整体：核 Q3 订单\n林工：清洗源表\n接缝：清洗结果交给小林\n共享写入点：q3/ 归小林",
    });
    assert.match(String(r), /写好/, "风铃要能写公告");
    const ann = kernel.handle("session.snapshot").threads.find((t) => t.id === id)?.announcement ?? "";
    assert.match(ann, /接缝/, "公告要落进会话索引");
    assert.ok(
      kernel.handle("session.snapshot").feed.some((c) => (c.text ?? "").includes("群公告写好了")),
      "群里要看得见是谁写的",
    );
  } finally {
    await kernel.dispose();
  }
});

test("「让风铃起草」这个动作会起一轮（不是让用户自己写）", async () => {
  const { kernel } = setup();
  try {
    await kernel.init();
    const id = kernel.handle("session.snapshot").thread.id;
    const r = kernel.handle("thread.draftNotice", { id });
    assert.equal(r.ok, true);
    assert.equal(kernel.busy, true, "要真起一轮，让风铃去写");
  } finally {
    await kernel.dispose();
  }
});
