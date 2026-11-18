/**
 * 飞书渠道（P14-1）。
 *
 * 这个模块的风险不在"收不到消息"，而在**收到了不该收的消息**：
 * 飞书消息来自陌生人，而 Lynn 的成员有文件与命令权限。
 *
 * 所以测试的重点是三道闸：
 *  1. 白名单为空 → **拒绝启动**（不是"启动了但谁都不理"）；
 *  2. 发送者不在白名单 → 忽略；
 *  3. 群聊默认不响应。
 *
 * 另外验证消息解析的边界：非文本消息、@ 前缀、空内容。
 */
import test from "node:test";
import assert from "node:assert/strict";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const { parseIncoming, shouldHandle } = await jiti.import("../src/main/im-feishu.ts", { default: true });

/** 造一条飞书事件 */
function ev({
  messageId = "om_1",
  chatId = "oc_1",
  chatType = "p2p",
  msgType = "text",
  text = "你好",
  senderId = "ou_owner",
  mentions = [],
} = {}) {
  return {
    message: {
      message_id: messageId,
      chat_id: chatId,
      chat_type: chatType,
      message_type: msgType,
      content: JSON.stringify({ text }),
      mentions,
    },
    sender: { sender_id: { open_id: senderId }, sender_type: "user" },
  };
}

test("解析文本消息：取出 id / 发送者 / 会话 / 文本", () => {
  const m = parseIncoming(ev({ text: "帮我看看这个" }));
  assert.equal(m.messageId, "om_1");
  assert.equal(m.senderId, "ou_owner");
  assert.equal(m.chatId, "oc_1");
  assert.equal(m.text, "帮我看看这个");
  assert.equal(m.isGroup, false);
});

test("解析：群聊被识别为 group", () => {
  assert.equal(parseIncoming(ev({ chatType: "group" })).isGroup, true);
  assert.equal(parseIncoming(ev({ chatType: "topic" })).isGroup, true);
  assert.equal(parseIncoming(ev({ chatType: "p2p" })).isGroup, false);
});

test("解析：去掉 @机器人 的占位符（否则 Lynn 会看到 @_user_1）", () => {
  const m = parseIncoming(ev({ text: "@_user_1 帮我写个周报", mentions: [{ key: "@_user_1", name: "风铃" }] }));
  assert.equal(m.text, "帮我写个周报", `实际：${m.text}`);
});

test("解析：非文本消息返回 null（本轮只支持文本）", () => {
  assert.equal(parseIncoming(ev({ msgType: "image" })), null);
  assert.equal(parseIncoming(ev({ msgType: "file" })), null);
  assert.equal(parseIncoming(ev({ msgType: "post" })), null);
});

test("解析：空文本返回 null（不把空消息交给 Agent）", () => {
  assert.equal(parseIncoming(ev({ text: "   " })), null);
});

test("解析：缺 message_id 或 chat_id 返回 null", () => {
  const bad = ev();
  delete bad.message.message_id;
  assert.equal(parseIncoming(bad), null);
});

test("解析：content 不是合法 JSON 返回 null（不抛）", () => {
  const bad = ev();
  bad.message.content = "不是 JSON";
  assert.equal(parseIncoming(bad), null);
});

// ---------- 安全闸门 ----------

test("安全：白名单为空 → 拒绝所有人", () => {
  const m = parseIncoming(ev());
  const v = shouldHandle(m, { appId: "a", appSecret: "s", allowOpenIds: [] });
  assert.equal(v.ok, false);
  assert.match(v.reason, /白名单为空/);
});

test("安全：发送者不在白名单 → 忽略", () => {
  const m = parseIncoming(ev({ senderId: "ou_stranger" }));
  const v = shouldHandle(m, { appId: "a", appSecret: "s", allowOpenIds: ["ou_owner"] });
  assert.equal(v.ok, false);
  assert.match(v.reason, /不在白名单/);
});

test("安全：发送者在白名单 → 放行", () => {
  const m = parseIncoming(ev({ senderId: "ou_owner" }));
  assert.deepEqual(shouldHandle(m, { appId: "a", appSecret: "s", allowOpenIds: ["ou_owner"] }), { ok: true });
});

test("安全：群聊默认不响应（allowGroup 缺省为 false）", () => {
  const m = parseIncoming(ev({ chatType: "group", senderId: "ou_owner" }));
  const v = shouldHandle(m, { appId: "a", appSecret: "s", allowOpenIds: ["ou_owner"] });
  assert.equal(v.ok, false);
  assert.match(v.reason, /群聊未开启/);
});

test("安全：显式 allowGroup=true 才响应群聊", () => {
  const m = parseIncoming(ev({ chatType: "group", senderId: "ou_owner" }));
  assert.deepEqual(shouldHandle(m, { appId: "a", appSecret: "s", allowOpenIds: ["ou_owner"], allowGroup: true }), {
    ok: true,
  });
});

test("安全：没有发送者 open_id → 忽略（可能是机器人自己）", () => {
  const m = parseIncoming(ev({ senderId: "" }));
  const v = shouldHandle(m, { appId: "a", appSecret: "s", allowOpenIds: [""] });
  assert.equal(v.ok, false);
  assert.match(v.reason, /没有发送者/);
});

test("安全：白名单是精确匹配，不做前缀/子串匹配", () => {
  const m = parseIncoming(ev({ senderId: "ou_owner_evil" }));
  const v = shouldHandle(m, { appId: "a", appSecret: "s", allowOpenIds: ["ou_owner"] });
  assert.equal(v.ok, false, "ou_owner_evil 不该因为以 ou_owner 开头就放行");
});