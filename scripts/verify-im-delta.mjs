/**
 * 不依赖 dist 的 IM 账本验证（jiti 直读 TS 源码）。
 * 覆盖：delta 覆盖修复 + 切群 silent idle 不误判 + IM 归属记账。
 */
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const {
  recordEvent,
  resetLedger,
  beginTurn,
  endTurn,
  historyEvents,
  setImTurnSession,
  clearImTurnSession,
} = await jiti.import("../src/main/im-ledger.ts", { default: true });
const { runTurnAndWait } = await jiti.import("../src/main/turn-wait.ts", { default: true });

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
function finalText(events) {
  const msg = events.find((e) => e.event.type === "assistant/message");
  return msg?.event?.data?.message?.content?.[0]?.text ?? null;
}

// 1) 多帧累积全文：定稿只留最后一帧
resetLedger();
beginTurn("s", "r1", "q");
const frames = ["已停掉", "已停掉，已关单", "已停掉，已关单，没产物"];
for (const t of frames) recordEvent({ type: "delta", text: t }, "s");
endTurn("s");
check("多帧全文不累加", finalText(historyEvents("s")), frames.at(-1));

// 2) 裁剪回退
resetLedger();
beginTurn("s", "r2", "q");
recordEvent({ type: "delta", text: "甲乙丙丁甲乙丙丁" }, "s");
recordEvent({ type: "delta", text: "甲乙丙丁" }, "s");
endTurn("s");
check("裁剪后的短全文覆盖", finalText(historyEvents("s")), "甲乙丙丁");

// 3) 切群 silent idle 不结束账本轮次
resetLedger();
beginTurn("s", "r3", "q");
recordEvent({ type: "delta", text: "第一段" }, "s");
// 桌面切群：busy=false 但 silent=true
const consumed = recordEvent({ type: "turn", turn: { busy: false, silent: true } }, "s");
check("silent idle 不消费", consumed, false);
recordEvent({ type: "delta", text: "第一段第二段" }, "s");
// 真正收轮：done
recordEvent({ type: "done", tokens: 1 }, "s");
check("silent idle 后正文继续累积", finalText(historyEvents("s")), "第一段第二段");

// 4) IM 归属记账：currentThreadId 变了，正文仍记到发起会话
resetLedger();
beginTurn("feishu-session", "r4", "q");
setImTurnSession("feishu-session");
recordEvent({ type: "delta", text: "飞书正文" }, "desktop-group"); // 切群后传的是新群
check("IM 归属记账不跟当前群", finalText(historyEvents("feishu-session")), "飞书正文");
check("切群后新群账本为空", finalText(historyEvents("desktop-group")), null);
clearImTurnSession("feishu-session");

// 5) waitTurn 忽略 silent idle
{
  const events = [
    { type: "turn", turn: { busy: true } },
    { type: "turn", turn: { busy: false, silent: true } }, // 切群假 idle
  ];
  let resolved = false;
  const p = runTurnAndWait({
    subscribe: (cb) => {
      for (const e of events) cb(e);
      return () => {};
    },
    start: () => {},
    timeoutMs: 100,
  });
  p.catch(() => {}); // 超时 reject 预期，吞掉
  await new Promise((r) => setTimeout(r, 30));
  check("waitTurn 不被 silent idle 提前 resolve", resolved, false);
  await p.catch(() => {}); // 等它超时收尾
}

console.log(failed === 0 ? "\n全部通过（5/5）" : `\n${failed} 项失败`);
process.exitCode = failed ? 1 : 0;
