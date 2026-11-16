// 2026-11-16 实机反馈：新建的群右栏居然顶着一张「等你拍板」，卡片上的任务早已不存在
// （群删了、卷宗也删了，只剩 team/<队>/assignments/*.jsonl 的账本残留）。
//
// 两件事分别锁住：
// ① 只有派单账本、没有权威工单卷宗 = 这张单已经不存在 → 不进台账（更不会跨群冒出待拍板）；
// ② 有卷宗但没记 threadId 的老单 → 归属按团队绑定的群兜，别让新群把别群的活当本群。
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Kernel } from "../dist/main/kernel.js";
import { TeamStore } from "../dist/main/team-store.js";

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "lynn-ghost-"));

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

function setup() {
  const root = tmp();
  seedModel(root);
  const kernel = new Kernel(root);
  kernel.handle("config.prefs", { autoStart: false });
  return { root, kernel, teams: new TeamStore(root) };
}

test("只有派单账本、没有卷宗的记录不进台账（新群不会冒出已删任务的待拍板）", async () => {
  const { kernel, teams } = setup();
  try {
    await kernel.init();
    teams.createTeam("t-ghost", "遗留队");
    // 账本里还留着一条"成员交过回报"的记录，但任务卷宗（tasks/<id>/task.json）从来没有/已被删
    teams.appendAssignment("t-ghost", {
      taskId: "task-ghost-1",
      at: new Date().toISOString(),
      kind: "report",
      member: "音频运行诊断员",
      text: "做完了",
      evidence: ["out.md"],
    });
    const board = kernel.handle("session.snapshot").board;
    assert.equal(
      board.track.some((t) => t.id === "task-ghost-1"),
      false,
      "卷宗没了这张单就不存在：不能靠账本派生成一张待验收的单",
    );
  } finally {
    await kernel.dispose();
  }
});

test("老单没记 threadId 时按团队绑定的群兜，不串到别的群", async () => {
  const { kernel, teams } = setup();
  try {
    await kernel.init();
    const threadId = kernel.handle("session.snapshot").thread.id;
    teams.createTeam("t-bind", "本群班底", 1_000_000, threadId);
    kernel.taskStore.create({ id: "task-old-1", title: "老单", teamId: "t-bind" });
    const track = kernel.handle("session.snapshot").board.track.find((t) => t.id === "task-old-1");
    assert.ok(track, "有卷宗的单必须在台账上");
    assert.equal(track.threadId, threadId, "没记 threadId 的老单要跟团队绑定的群走");
  } finally {
    await kernel.dispose();
  }
});

