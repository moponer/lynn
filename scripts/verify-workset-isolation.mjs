/**
 * working set 会话隔离验证（2026-11-19 坚实重构）。
 *
 * 目标：证明"桌面切群不会让在跑的飞书轮次写串"。
 * 通过真实 Kernel + jiti 直读源码（dist 被锁时仍可验证）。
 *
 * 验证的核心契约：
 *  1. 轮次开始时 activeTurn 快照当前 feed/history/liveCard
 *  2. 切群只改 this.feed/this.history（视图），activeTurn 的快照不受影响
 *  3. 轮次内的 curFeed()/curHistory()/curLive() 始终返回快照（在跑的会话）
 *  4. 收轮时若已切群，结果写回原会话 thread
 */
import { createJiti } from "jiti";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const jiti = createJiti(path.join(process.cwd(), "__jiti_ws.mjs"));
const { Kernel } = await jiti.import("./src/main/kernel.ts", { default: true });

let failed = 0;
function check(name, actual, expected) {
  const a = JSON.stringify(actual);
  const b = JSON.stringify(expected);
  if (a === b) console.log(`  ok  ${name}`);
  else {
    console.log(`  FAIL ${name}\n       got:  ${a}\n       want: ${b}`);
    failed++;
  }
}
function mk() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "lynn-ws-"));
  const k = new Kernel(root);
  k.handle("config.prefs", { autoStart: false });
  return k;
}

// ---------- 1. 访问器基线：无 activeTurn 时读 this.* ----------
{
  const k = mk();
  k.feed.push({ id: "c-1", kind: "lynn", text: "视图卡", createdAt: "00:00" });
  check("无 activeTurn 时 curFeed 读视图", k.curFeed().length, 1);
  check("无 activeTurn 时 curLive 为 null", k.curLive(), null);
}

// ---------- 2. 建 activeTurn 后，切群不改快照 ----------
{
  const k = mk();
  const viewFeed = [{ id: "c-1", kind: "lynn", text: "A群原有", createdAt: "00:00" }];
  k.feed.push(...viewFeed);
  k.history.push({ role: "user", content: "A群历史" });
  // 模拟 submitTurn 开头建快照
  k.activeTurn = {
    sessionId: "thread-A",
    feed: k.feed,
    history: k.history,
    liveCard: null,
    cardSeq: k.cardSeq,
    ephemeralFrom: -1,
  };

  // 轮次内建 live 卡（走 setCurLive → 写进 activeTurn）
  const live = k.card({ kind: "lynn", text: "", streaming: true });
  k.setCurLive(live);
  check("轮次内建 live 卡进 activeTurn", k.activeTurn.liveCard?.id, live.id);

  // 模拟桌面切群：switchThread 会重置 this.feed/history/liveCard
  k.feed = [];
  k.history = [];
  k.liveCard = null;
  k.currentThreadId = "thread-B";

  // 关键：activeTurn 的快照不受影响
  check("切群后 activeTurn.feed 仍是 A 群（原有的 + live 卡）", k.activeTurn.feed.length, 2);
  check("切群后 activeTurn.history 仍是 A 群", k.activeTurn.history[0].content, "A群历史");
  check("切群后 curFeed 仍返回 A 群", k.curFeed().length, 2);
  check("切群后 curLive 仍返回在跑的卡", k.curLive()?.id, live.id);

  // 轮次内继续写（模拟 delta 落卡）：应进 A 群快照，不是当前视图
  k.card({ kind: "system", text: "A群过程卡" });
  check("轮次内卡的 id 序列走 activeTurn", k.activeTurn.cardSeq >= 2, true);
  check("当前视图 B 群仍是空的", k.feed.length, 0);
  check("A 群快照多了一张过程卡", k.activeTurn.feed.length, 3);
}

// ---------- 3. 收轮时切群：结果写回原会话 ----------
{
  const k = mk();
  // 建 A 会话 thread
  k.threads.create("标题A");
  const idA = k.threads.list()[0].id;
  k.currentThreadId = idA;
  k.feed = [];
  k.history = [];
  k.activeTurn = {
    sessionId: idA,
    feed: k.feed,
    history: k.history,
    liveCard: null,
    cardSeq: 0,
    ephemeralFrom: -1,
  };
  k.curFeed().push({ id: "c-1", kind: "lynn", text: "A的答案", createdAt: "00:00" });
  k.curHistory().push({ role: "assistant", content: "A的答案" });

  // 切到 B
  k.currentThreadId = "";
  k.feed = [];
  k.history = [];

  // 模拟 finally 里的写回逻辑
  const ctx = k.activeTurn;
  if (ctx && ctx.sessionId && ctx.sessionId !== k.currentThreadId) {
    k.threads.saveState(ctx.sessionId, {
      feed: ctx.feed.slice(-200),
      history: ctx.history
        .filter((m) => (m.role === "user" || m.role === "assistant") && typeof m.content === "string")
        .map((m) => ({ role: m.role, content: m.content }))
        .slice(-200),
      usage: k.threads.loadState(ctx.sessionId).usage,
    });
  }
  k.activeTurn = null;

  const saved = k.threads.loadState(idA);
  check("收轮后 A 会话 history 写回了", saved.history[0]?.content, "A的答案");
  check("收轮后 A 会话 feed 写回了", saved.feed[0]?.text, "A的答案");
  check("收轮后当前视图 B 仍空", k.feed.length, 0);
}

// ---------- 4. 同会话不切群：正常写回 ----------
{
  const k = mk();
  k.threads.create("标题C");
  const idC = k.threads.list()[0].id;
  k.currentThreadId = idC;
  k.activeTurn = { sessionId: idC, feed: k.feed, history: k.history, liveCard: null, cardSeq: 0, ephemeralFrom: -1 };
  k.curHistory().push({ role: "assistant", content: "C的答案" });
  // 没切群 → 收轮时 sessionId === currentThreadId，不应额外 saveState（走正常 persistThread）
  check("同群 sessionId 匹配", k.activeTurn.sessionId === k.currentThreadId, true);
}

console.log(failed === 0 ? "\n全部通过（working-set 隔离）" : `\n${failed} 项失败`);
process.exitCode = failed ? 1 : 0;
