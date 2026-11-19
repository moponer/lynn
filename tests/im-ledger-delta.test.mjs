/**
 * IM 正文账本回归测试（2026-11-19）。
 *
 * 事故：手机飞书同一条消息里，同一段正文反复出现、甚至插进句子中间。
 * 根因：KernelEvent.delta.text 是「本轮到目前为止的完整正文」（内核每帧
 * 发 liveCard.text，~80ms 一帧），而 im-ledger.recordEvent 用 += 累加了
 * 这些全文帧，于是第 N 帧把从头到尾的全文再拼一遍。
 *
 * 本文件守住「覆盖不累加」这条契约。
 */
import test from "node:test";
import assert from "node:assert/strict";

const { recordEvent, resetLedger, beginTurn, endTurn, historyEvents } =
  await import("../dist/main/im-ledger.js");

const SESSION = "s-delta-dedup";

function finalText(events) {
  const msg = events.find((e) => e.event.type === "assistant/message");
  return msg?.event?.data?.message?.content?.[0]?.text ?? null;
}

test("多帧累积全文 delta：定稿正文只出现一次（重复回归）", () => {
  resetLedger();
  beginTurn(SESSION, "rpc-1", "帮我清 C 盘");

  // 模拟内核 80ms 节流的多帧，每帧都是「到目前为止的完整正文」
  const frames = [
    "已全部停掉",
    "已全部停掉，两个单都关了单",
    "已全部停掉，两个单都关了单，没有产物落盘",
    "已全部停掉，两个单都关了单，没有产物落盘。一个字节都没删过。",
  ];
  for (const text of frames) recordEvent({ type: "delta", text }, SESSION);
  endTurn(SESSION);

  const got = finalText(historyEvents(SESSION));
  assert.equal(got, frames.at(-1), "正文必须等于最后一帧全文，不能是各帧累加拼接");
});

test("重复拦截裁剪后的短全文覆盖旧长全文", () => {
  resetLedger();
  beginTurn(SESSION, "rpc-2", "写一段长文");

  recordEvent({ type: "delta", text: "甲乙丙丁甲乙丙丁甲乙丙丁" }, SESSION);
  // guardRepetition 拦截后发出裁剪过的全文（比上一帧短）
  recordEvent({ type: "delta", text: "甲乙丙丁" }, SESSION);
  endTurn(SESSION);

  assert.equal(finalText(historyEvents(SESSION)), "甲乙丙丁", "裁剪回退必须生效");
});

test("纯思考帧（text 为空）不清空已收到的正文", () => {
  resetLedger();
  beginTurn(SESSION, "rpc-3", "思考问题");

  recordEvent({ type: "delta", text: "正文" }, SESSION);
  recordEvent({ type: "delta", thinking: "思考" }, SESSION);
  endTurn(SESSION);

  assert.equal(finalText(historyEvents(SESSION)), "正文");
});

test("不同轮次互不串正文", () => {
  resetLedger();

  beginTurn(SESSION, "rpc-a", "第一轮");
  recordEvent({ type: "delta", text: "答案甲" }, SESSION);
  endTurn(SESSION);

  beginTurn(SESSION, "rpc-b", "第二轮");
  recordEvent({ type: "delta", text: "答案乙" }, SESSION);
  endTurn(SESSION);

  const texts = historyEvents(SESSION)
    .filter((e) => e.event.type === "assistant/message")
    .map((e) => e.event.data.message.content[0].text);
  assert.deepEqual(texts, ["答案甲", "答案乙"]);
});
