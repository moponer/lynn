/**
 * 沙箱执行信息在界面可见（2026-11-19 用户要求："前端要显示沙箱执行命令的信息，
 * 在合适的位置"）。
 *
 * 不测像素，测**数据契约**：成员跑命令时，进度卡（badge=进度）必须带
 * `sandbox` 字段（mode + cwd），这样 Feed 才能在 tool 卡上渲染"沙箱·降权"徽章。
 * 非命令卡（回报/审查等）不该带，免得满屏徽章。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Kernel } from "../dist/main/kernel.js";

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "lynn-sbxf-"));

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
  const kernel = new Kernel(root);
  kernel.handle("config.prefs", { autoStart: false });
  return { root, kernel };
}

test("成员进度卡（命令执行）带 sandbox 字段：mode 与 cwd", async () => {
  const { root, kernel } = setup();
  try {
    await kernel.init();
    // 造一张工单（工作区钉在 root）
    kernel.taskStore.create({
      id: "task-sbx",
      title: "沙箱展示测试",
      teamId: "t1",
      threadId: kernel.ensureThreadId(),
      workspaceRoot: root,
    });
    // 直接调 appendProgress（成员跑命令时走的就是它）
    kernel.appendProgress(kernel.currentThreadId, "task-sbx", "林工", "第 1 步 · run_command", "第 1 步 · 0s", "进度", "append");
    const feed = kernel.handle("session.snapshot").feed;
    const progressCards = feed.filter((c) => c.badge === "进度" && c.jobId === "task-sbx");
    assert.ok(progressCards.length >= 1, "应有进度卡");
    const card = progressCards[progressCards.length - 1];
    assert.ok(card.sandbox, `进度卡应带 sandbox 字段，实际：${JSON.stringify(card)}`);
    assert.ok(["appcontainer", "restricted", "jobonly"].includes(card.sandbox.mode), `mode 应是有效档位，实际 ${card.sandbox.mode}`);
    assert.equal(card.sandbox.cwd, root, "cwd 应是工单工作区");
  } finally {
    await kernel.dispose();
  }
});

test("非命令卡（回报）不带 sandbox 字段（避免满屏徽章）", async () => {
  const { kernel } = setup();
  try {
    await kernel.init();
    kernel.taskStore.create({
      id: "task-r",
      title: "回报卡",
      teamId: "t1",
      threadId: kernel.ensureThreadId(),
      workspaceRoot: kernel.dataRoot,
    });
    kernel.appendProgress(kernel.currentThreadId, "task-r", "林工", "回报正文", "第 3 步 · 10s", "回报", "append");
    const feed = kernel.handle("session.snapshot").feed;
    const reportCards = feed.filter((c) => c.badge === "回报" && c.jobId === "task-r");
    assert.ok(reportCards.length >= 1, "应有回报卡");
    assert.equal(reportCards[reportCards.length - 1].sandbox, undefined, "回报卡不该带 sandbox");
  } finally {
    await kernel.dispose();
  }
});