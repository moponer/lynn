/**
 * 消息#12（2026-11-19）：持久化截断不许丢掉"必须活着"的卡。
 *
 * 原来一律 `feed.slice(-200)`，截断点可能正好切掉：
 *  - 正在流式的 live 卡（她的话）→ 切回会话就没了；
 *  - 可行动的错误卡（action 非空，界面钉在顶部让你重试）→ 消失，没法重试；
 *  - 进度卡（progressCards 记着 id）→ 丢了之后 appendProgress 会新建一张，
 *    表现为"每次切群多一张进度卡"。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Kernel } from "../dist/main/kernel.js";

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "lynn-trim-"));

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

/** 直接调 private 方法（JS 无真正 private） */
const trim = (k, feed) => k.trimFeedForPersist(feed);

const card = (over) => ({
  id: "c",
  kind: "tool",
  createdAt: "10:00",
  ...over,
});

test("消息#12：≤200 条原样返回", () => {
  const { kernel } = setup();
  try {
    const feed = Array.from({ length: 50 }, (_, i) => card({ id: `c${i}` }));
    assert.equal(trim(kernel, feed).length, 50);
  } finally {
    void kernel.dispose();
  }
});

test("消息#12：>200 条时保留末尾 200，且不丢流式卡", () => {
  const { kernel } = setup();
  try {
    const feed = Array.from({ length: 300 }, (_, i) => card({ id: `c${i}` }));
    // 第 5 条是正在流式的卡（远在截断点之前）
    feed[5] = card({ id: "c5", kind: "lynn", streaming: true, text: "正在生成" });
    const out = trim(kernel, feed);
    assert.ok(out.length >= 200, "至少保留 200 条");
    assert.ok(out.some((c) => c.id === "c5"), "流式卡必须保留——否则切回会话就没了她的话");
    assert.equal(out[out.length - 1].id, "c299", "末尾顺序不变");
  } finally {
    void kernel.dispose();
  }
});

test("消息#12：>200 条时保留可行动错误卡（用户要能点重试）", () => {
  const { kernel } = setup();
  try {
    const feed = Array.from({ length: 300 }, (_, i) => card({ id: `c${i}` }));
    feed[3] = card({ id: "err", kind: "system", action: "retry", code: "x", text: "失败了" });
    const out = trim(kernel, feed);
    assert.ok(out.some((c) => c.id === "err"), "可行动错误卡必须保留");
  } finally {
    void kernel.dispose();
  }
});

test("消息#12：>200 条时保留进度卡（否则切群后进度卡会重复新建）", () => {
  const { kernel } = setup();
  try {
    const feed = Array.from({ length: 300 }, (_, i) => card({ id: `c${i}` }));
    feed[10] = card({ id: "prog", badge: "进度", jobId: "t1" });
    // 模拟 progressCards 里记着这张卡
    kernel.progressCards.set("x::t1::进度", "prog");
    const out = trim(kernel, feed);
    assert.ok(out.some((c) => c.id === "prog"), "进度卡必须保留");
  } finally {
    void kernel.dispose();
  }
});
