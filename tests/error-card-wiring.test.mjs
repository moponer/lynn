/**
 * 错误卡接线（P6-6 / F7）：纯函数对了不等于内核真的用了它。
 *
 * 这条测的是**接线**：调用内核的 failTurn，看落下来的卡是不是按新口径来的
 * （额度用尽 → settings、不刷屏、合并计数）。
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const { Kernel } = await import("../dist/main/kernel.js");

function tmp() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "lynn-errcard-"));
}

function seed(root) {
  fs.writeFileSync(
    path.join(root, "settings.json"),
    JSON.stringify({
      model: {
        provider: "t",
        baseUrl: "http://127.0.0.1:9/v1",
        model: "m",
        apiKey: { encrypted: false, data: "k" },
        updatedAt: new Date().toISOString(),
      },
    }),
    "utf-8",
  );
}

test("额度用尽落卡：action=settings，且文案说清暂停多久与怎么恢复", async () => {
  const root = tmp();
  seed(root);
  const kernel = new Kernel(root);
  try {
    await kernel.init();
    // 直接走内核的失败路径（private 在运行时可达）
    kernel.failTurn("rate_429", "429 You exceeded your current quota, please check your plan", "retry");
    const feed = kernel.handle("session.snapshot").feed;
    const card = feed.find((c) => c.code === "rate_429");
    assert.ok(card, "应当落一张错误卡");
    assert.equal(card.action, "settings", "额度用尽必须给「去设置」而不是「重试」");
    assert.match(String(card.text ?? ""), /发一条消息/, "要给出恢复路径");
    // 熔断也要真的开了
    assert.equal(kernel.quotaCoolingDown(), true, "额度用尽应触发熔断");
  } finally {
    await kernel.dispose();
  }
});

test("同一类错误连发：5 分钟内合并成一张，不刷屏", async () => {
  const root = tmp();
  seed(root);
  const kernel = new Kernel(root);
  try {
    await kernel.init();
    kernel.failTurn("timeout", "模型 90s 无输出", "retry");
    kernel.failTurn("timeout", "模型 90s 无输出", "retry");
    kernel.failTurn("timeout", "模型 90s 无输出", "retry");
    const feed = kernel.handle("session.snapshot").feed;
    const errs = feed.filter((c) => c.code === "timeout");
    assert.equal(errs.length, 1, `同类错误应合并成 1 张，实际 ${errs.length} 张`);
    assert.match(String(errs[0].text ?? ""), /第 3 次/, "合并后要能看出重复了几次");
  } finally {
    await kernel.dispose();
  }
});

test("不同类错误不合并（超时与网络是两回事）", async () => {
  const root = tmp();
  seed(root);
  const kernel = new Kernel(root);
  try {
    await kernel.init();
    kernel.failTurn("timeout", "超时", "retry");
    kernel.failTurn("network", "连不上", "retry");
    const feed = kernel.handle("session.snapshot").feed;
    assert.equal(feed.filter((c) => c.code === "timeout").length, 1);
    assert.equal(feed.filter((c) => c.code === "network").length, 1, "不同 code 不该被合并掉");
  } finally {
    await kernel.dispose();
  }
});

test("没有模型配置：给「去设置」，不是「重试」", async () => {
  const root = tmp();
  // 故意不写 settings.json
  const kernel = new Kernel(root);
  try {
    await kernel.init();
    kernel.failTurn("no_model", "还没有可用的模型配置", "settings");
    const card = kernel.handle("session.snapshot").feed.find((c) => c.code === "no_model");
    assert.ok(card);
    assert.equal(card.action, "settings");
  } finally {
    await kernel.dispose();
  }
});