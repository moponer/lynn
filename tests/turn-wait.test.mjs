/**
 * 等一轮对话结束（P13-4）。
 *
 * 这个模块只有一个难点，但它是致命的：
 * **必须见过 `busy: true` 之后才认 `busy: false` 为"结束"**。
 *
 * 原因：`submitTurn` 是同步返回的，它之后的事件里 `busy` 还可能是 `false`
 * （内核还没置起来）。如果直接等 `busy === false`，会在启动的瞬间就 resolve，
 * 调用方拿到"已完成"但实际什么都没做。
 *
 * 这组测试的重点就是这条判断，外加超时行为。
 */
import test from "node:test";
import assert from "node:assert/strict";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const { runTurnAndWait } = await jiti.import("../src/main/turn-wait.ts", { default: true });

/** 造一个可控的事件源 */
function makeSource() {
  const listeners = new Set();
  return {
    subscribe(cb) {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    emit(ev) {
      for (const cb of [...listeners]) cb(ev);
    },
    get count() {
      return listeners.size;
    },
  };
}

const turn = (busy, phase = "working") => ({ type: "turn", turn: { busy, phase } });

test("正常一轮：busy → idle 后 resolve", async () => {
  const src = makeSource();
  const p = runTurnAndWait({
    subscribe: (cb) => src.subscribe(cb),
    start: () => {
      // 模拟真实时序：start 之后才有 busy
      setTimeout(() => src.emit(turn(true)), 0);
      setTimeout(() => src.emit(turn(false, "done")), 10);
    },
  });
  await p;
  assert.equal(src.count, 0, "结束后要退订，否则监听器泄漏");
});

test("关键：启动时若先来 idle，不能误判为完成", async () => {
  const src = makeSource();
  let resolved = false;
  const p = runTurnAndWait({
    subscribe: (cb) => src.subscribe(cb),
    start: () => {
      // 先来一个 idle（模拟 submitTurn 之后、busy 置起之前的窗口）
      setTimeout(() => src.emit(turn(false)), 0);
      // 再来 busy
      setTimeout(() => src.emit(turn(true)), 10);
      // 最后才真的结束
      setTimeout(() => {
        src.emit(turn(false, "done"));
      }, 20);
    },
  });
  void p.then(() => {
    resolved = true;
  });
  // 在 idle 刚发出、busy 还没来的时候检查
  await new Promise((r) => setTimeout(r, 5));
  assert.equal(resolved, false, "只见过 idle 就 resolve 了——这是致命 bug（调用方会以为已完成）");
  await p;
  assert.equal(resolved, true, "见过 busy 之后再 idle，才该 resolve");
});

test("非 turn 事件被忽略（不干扰判断）", async () => {
  const src = makeSource();
  const p = runTurnAndWait({
    subscribe: (cb) => src.subscribe(cb),
    start: () => {
      setTimeout(() => src.emit({ type: "delta", text: "x" }), 0);
      setTimeout(() => src.emit({ type: "card" }), 2);
      setTimeout(() => src.emit(turn(true)), 5);
      setTimeout(() => src.emit(turn(false)), 10);
    },
  });
  await p; // 不该因为 delta/card 提前 resolve，也不该卡住
});

test("缺 turn 字段的事件被忽略", async () => {
  const src = makeSource();
  const p = runTurnAndWait({
    subscribe: (cb) => src.subscribe(cb),
    start: () => {
      setTimeout(() => src.emit({ type: "turn" }), 0);
      setTimeout(() => src.emit(turn(true)), 5);
      setTimeout(() => src.emit(turn(false)), 10);
    },
  });
  await p;
});

test("超时：reject 并调 onTimeout，且错误信息说清「可能还在跑」", async () => {
  const src = makeSource();
  let cleaned = false;
  const p = runTurnAndWait({
    timeoutMs: 30,
    subscribe: (cb) => src.subscribe(cb),
    start: () => {
      src.emit(turn(true)); // 一直 busy，永不结束
    },
    onTimeout: () => {
      cleaned = true;
    },
  });
  await assert.rejects(() => p, (err) => {
    assert.match(err.message, /超时/);
    assert.match(err.message, /可能还在跑/, "必须说清它不是失败，是还没完——否则调用方会重发");
    return true;
  });
  assert.equal(cleaned, true, "超时要调 onTimeout 做清理");
  assert.equal(src.count, 0, "超时后也要退订");
});

test("start 抛错：直接 reject，不进入等待", async () => {
  const src = makeSource();
  await assert.rejects(
    () =>
      runTurnAndWait({
        subscribe: (cb) => src.subscribe(cb),
        start: () => {
          throw new Error("模型没配置");
        },
      }),
    /模型没配置/,
  );
  assert.equal(src.count, 0, "start 失败也要退订");
});

test("超时后即使事件再来也不再 resolve（已 settled）", async () => {
  const src = makeSource();
  const p = runTurnAndWait({
    timeoutMs: 20,
    subscribe: (cb) => src.subscribe(cb),
    start: () => {
      src.emit(turn(true));
    },
  });
  await assert.rejects(() => p);
  // 超时之后再来 idle，不该有任何影响（也不该抛"未处理的 rejection"）
  src.emit(turn(false));
});

test("onTimeout 自己抛错不影响 reject 的结果", async () => {
  const src = makeSource();
  const p = runTurnAndWait({
    timeoutMs: 20,
    subscribe: (cb) => src.subscribe(cb),
    start: () => src.emit(turn(true)),
    onTimeout: () => {
      throw new Error("清理也炸了");
    },
  });
  await assert.rejects(() => p, /超时/);
});

test("subscribe 返回的取消函数抛错不影响结果", async () => {
  const p = runTurnAndWait({
    subscribe: () => () => {
      throw new Error("取消失败");
    },
    start: () => {
      // 立刻走完一轮
      setTimeout(() => {
        /* 拿不到 emit 了，改用直接 resolve 路径：靠超时兜底不现实 */
      }, 0);
    },
    timeoutMs: 20,
  });
  await assert.rejects(() => p, /超时/); // 只验证不因取消失败而崩
});