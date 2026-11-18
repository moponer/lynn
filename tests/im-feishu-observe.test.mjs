/**
 * 飞书发送者观察层（P18-2）。
 *
 * 解决的问题：用户不知道自己的 open_id，而
 *  - `GET /im/v1/chats` **只返回群，不返回私聊** → API 查不到"只私聊过"的情形
 *  - vendored 渠道拒收时只打一句**没有 id** 的警告
 *
 * 解法：包一层 SDK 的 `EventDispatcher`，`register` 时把每个 handler
 * 前置一个记账函数。**vendor 一行不改**，被拒的消息也会先被记下来。
 *
 * 这组测试守三件：
 *  1. 能从事件里取出发送者（含字段退化）
 *  2. 记账**不吞事件、不改事件**——原 handler 收到的对象必须完全一致
 *  3. 记账自己出错时**不影响**消息处理
 */
import test from "node:test";
import assert from "node:assert/strict";

const { extractSender, wrapEventDispatcher, observeFeishuSdk } = await import("../dist/main/im-feishu-observe.js");

/** 造一条飞书 im.message.receive_v1 事件 */
function ev({ openId = "ou_7d8a6e6df7621556ce0d21922b676706", userId, chatType = "p2p", chatId = "oc_1" } = {}) {
  return {
    sender: { sender_id: { ...(openId ? { open_id: openId } : {}), ...(userId ? { user_id: userId } : {}) } },
    message: { chat_id: chatId, chat_type: chatType },
  };
}

test("extractSender：取出 open_id 与会话信息", () => {
  const s = extractSender(ev());
  assert.equal(s.openId, "ou_7d8a6e6df7621556ce0d21922b676706");
  assert.equal(s.chatType, "p2p");
  assert.equal(s.chatId, "oc_1");
  assert.ok(s.at, "要有时间戳");
});

test("extractSender：没有 open_id 时退化到 user_id", () => {
  const s = extractSender(ev({ openId: "", userId: "u_123" }));
  assert.equal(s.openId, "u_123", "vendored 的 senderOpenId 也是这个退化顺序");
});

test("extractSender：取不到发送者返回 null（不抛）", () => {
  assert.equal(extractSender({}), null);
  assert.equal(extractSender(null), null);
  assert.equal(extractSender(undefined), null);
});

test("wrapEventDispatcher：原 handler 收到的对象**完全一致**", () => {
  /** 假 Dispatcher：记录 register 进来的 handler，供测试手动触发 */
  class FakeDispatcher {
    constructor() {
      this.handles = {};
    }
    register(handles) {
      Object.assign(this.handles, handles);
      return this;
    }
  }
  const seen = [];
  const Wrapped = wrapEventDispatcher(FakeDispatcher, (s) => seen.push(s));
  const d = new Wrapped({});

  const received = [];
  const payload = ev({ chatType: "group", chatId: "oc_g" });
  d.register({ "im.message.receive_v1": (data) => received.push(data) });

  // 模拟 SDK 分发
  d.handles["im.message.receive_v1"](payload);

  assert.equal(received.length, 1, "原 handler 必须被调用");
  assert.equal(received[0], payload, "必须收到同一个对象引用（不是拷贝、不是包装）");
  assert.equal(seen.length, 1, "记账也必须发生");
  assert.equal(seen[0].openId, "ou_7d8a6e6df7621556ce0d21922b676706");
  assert.equal(seen[0].chatType, "group");
});

test("wrapEventDispatcher：多个事件类型都被包住", () => {
  class FakeDispatcher {
    constructor() {
      this.handles = {};
    }
    register(h) {
      Object.assign(this.handles, h);
      return this;
    }
  }
  const seen = [];
  const Wrapped = wrapEventDispatcher(FakeDispatcher, (s) => seen.push(s));
  const d = new Wrapped({});
  const hits = [];
  d.register({
    "im.message.receive_v1": () => hits.push("a"),
    "card.action.trigger": () => hits.push("b"),
  });
  d.handles["im.message.receive_v1"](ev({ openId: "ou_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" }));
  d.handles["card.action.trigger"]({});
  assert.deepEqual(hits, ["a", "b"], "两个 handler 都要被调用");
  assert.equal(seen.length, 1, "只有带发送者的事件才记账");
});

test("wrapEventDispatcher：记账抛错**不影响**消息处理", () => {
  class FakeDispatcher {
    constructor() {
      this.handles = {};
    }
    register(h) {
      Object.assign(this.handles, h);
      return this;
    }
  }
  const Wrapped = wrapEventDispatcher(FakeDispatcher, () => {
    throw new Error("记账炸了");
  });
  const d = new Wrapped({});
  let called = false;
  d.register({ "im.message.receive_v1": () => (called = true) });
  assert.doesNotThrow(() => d.handles["im.message.receive_v1"](ev()));
  assert.equal(called, true, "观察者出错不能挡住消息——它是观察者不是拦截器");
});

test("observeFeishuSdk：只替换 EventDispatcher，其余原样透传", () => {
  class FakeDispatcher {
    constructor() {
      this.handles = {};
    }
    register(h) {
      Object.assign(this.handles, h);
    }
  }
  const Domain = { Feishu: 0, Lark: 1 };
  const Client = class {
    constructor() {
      this.kind = "client";
    }
  };
  const sdk = { EventDispatcher: FakeDispatcher, Client, Domain };
  const seen = [];
  const wrapped = observeFeishuSdk(sdk, (s) => seen.push(s));

  assert.notEqual(wrapped.EventDispatcher, FakeDispatcher, "EventDispatcher 应被替换");
  assert.equal(wrapped.Client, Client, "Client 必须原样透传（runtime 要 new 它）");
  assert.equal(wrapped.Domain, Domain, "Domain 必须原样透传（runtime 要读 lark.Domain.Feishu）");

  const d = new wrapped.EventDispatcher({});
  d.register({ "im.message.receive_v1": () => {} });
  d.handles["im.message.receive_v1"](ev({ openId: "ou_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb" }));
  assert.equal(seen.length, 1);
  assert.equal(seen[0].openId, "ou_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb");
});

test("observeFeishuSdk：SDK 没有 EventDispatcher 时原样返回（不冒险）", () => {
  const sdk = { Client: class {} };
  assert.equal(observeFeishuSdk(sdk, () => {}), sdk);
});