/**
 * 会话工作区隔离 & 切群不断流（2026-11-19 坚实重构）回归测试。
 *
 * 事故背景：内核是单例（一个风铃管所有群），原本 feed/history/liveCard 是
 * "当前视图"。飞书轮次在跑时桌面切群，整组被换掉 → 飞书正文写串到新群、
 * 被静默截断。修复引入 activeTurn 快照 + 访问器（curFeed/curHistory/curLive），
 * 切群只改视图、不动在跑轮次的快照；切群不杀正在用的 agent 进程。
 *
 * 本文件直读 src（jiti），不依赖 dist 构建，CI 与本地都能跑。
 */
import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const { Kernel } = await jiti.import("../src/main/kernel.ts", { default: true });

function mk() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "lynn-ws-"));
  const k = new Kernel(root);
  k.handle("config.prefs", { autoStart: false });
  k.ensureThreadId();
  return k;
}

test("无 activeTurn 时访问器读当前视图", () => {
  const k = mk();
  k.feed.push({ id: "c-1", kind: "lynn", text: "视图卡", createdAt: "00:00" });
  assert.equal(k.curFeed().length, 1);
  assert.equal(k.curLive(), null);
});

test("建 activeTurn 后切群：快照不变、curFeed/curLive 仍返回原会话", () => {
  const k = mk();
  const idA = k.currentThreadId;
  k.feed.push({ id: "c-1", kind: "lynn", text: "A群原有", createdAt: "00:00" });
  k.history.push({ role: "user", content: "A群历史" });
  k.activeTurn = {
    sessionId: idA, feed: k.feed, history: k.history,
    liveCard: null, cardSeq: k.cardSeq, ephemeralFrom: -1,
  };
  const live = k.card({ kind: "lynn", text: "", streaming: true });
  k.setCurLive(live);

  const idB = k.threads.create("B群").id;
  k.switchThread(idB); // 桌面切群

  assert.equal(k.currentThreadId, idB);
  assert.equal(k.activeTurn.feed.length, 2, "A 群快照仍是原有的 + live 卡");
  assert.equal(k.activeTurn.history[0].content, "A群历史");
  assert.equal(k.curFeed().length, 2);
  assert.equal(k.curLive().id, live.id, "在跑的卡还在");
  assert.equal(k.feed.length, 0, "B 群视图是空的，没被 A 的卡污染");
});

test("切群时有在跑轮次：不杀 agent 进程（只清 hostStamp 待重建）", () => {
  const k = mk();
  k.activeTurn = {
    sessionId: k.currentThreadId, feed: k.feed, history: k.history,
    liveCard: null, cardSeq: 0, ephemeralFrom: -1,
  };
  let stopped = false;
  k.host = { stop: async () => { stopped = true; }, isRunning: () => true };
  k.hostStamp = "x";
  const idB = k.threads.create("B群").id;
  k.switchThread(idB);
  assert.equal(stopped, false, "在跑轮次的 host 不能被切群杀掉");
  assert.equal(k.hostStamp, "", "hostStamp 清空，下一轮会重建");
});

test("无在跑轮次时切群：保持原行为（立即 reset host）", async () => {
  const k = mk();
  let stopped = false;
  k.host = { stop: async () => { stopped = true; }, isRunning: () => true };
  k.hostStamp = "y";
  const idB = k.threads.create("B群").id;
  k.switchThread(idB);
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(stopped, true, "纯界面切换应立即重建 host");
});

test("收轮后当前视图不串：activeTurn 快照独立于 this.feed", () => {
  const k = mk();
  const idA = k.currentThreadId;
  k.activeTurn = {
    sessionId: idA, feed: k.feed, history: k.history,
    liveCard: null, cardSeq: 0, ephemeralFrom: -1,
  };
  k.curFeed().push({ id: "c-1", kind: "lynn", text: "A的答案", createdAt: "00:00" });
  const viewFeed = k.feed; // 与 activeTurn.feed 同一引用（切群前）
  k.feed = [];
  k.history = [];
  assert.equal(k.activeTurn.feed.length, 1, "A 快照保留");
  assert.equal(viewFeed.length, 1, "引用同一份，A 的卡还在原处");
  assert.equal(k.feed.length, 0, "新视图干净");
});
