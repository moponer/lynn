/**
 * 前缀指纹（P1-5）：用来回答"命中率为什么掉了"——同输入必须同指纹，
 * 消息或工具变了必须能区分。
 */
import test from "node:test";
import assert from "node:assert/strict";
import { prefixFingerprint } from "../dist/main/prefix-hash.js";

const tools = [{ type: "function", function: { name: "a", description: "", parameters: {} } }];
const base = [
  { role: "system", content: "s" },
  { role: "user", content: "hi" },
];

test("同输入同输出（确定性）", () => {
  const a = prefixFingerprint({ messages: base, tools });
  assert.equal(prefixFingerprint({ messages: base, tools }), a);
  assert.match(a, /^[0-9a-z]{7,10}$/);
});

test("消息变化、工具变化都要能识别", () => {
  const a = prefixFingerprint({ messages: base, tools });
  const withReply = prefixFingerprint({ messages: [...base, { role: "assistant", content: "ok" }], tools });
  assert.notEqual(withReply, a, "追加消息应改变指纹");
  const otherTool = prefixFingerprint({
    messages: base,
    tools: [{ type: "function", function: { name: "b", description: "", parameters: {} } }],
  });
  assert.notEqual(otherTool, a, "工具面变化应改变指纹");
  const edited = prefixFingerprint({ messages: [{ role: "system", content: "s" }, { role: "user", content: "hi!" }], tools });
  assert.notEqual(edited, a, "同长度但内容不同也要能识别");
});

test("messageLimit 之外的追加不影响（只看历史前缀）", () => {
  const a = prefixFingerprint({ messages: base, tools });
  const full = [...base, { role: "assistant", content: "x" }, { role: "user", content: "y" }];
  assert.equal(prefixFingerprint({ messages: full, tools, messageLimit: 2 }), a);
});
