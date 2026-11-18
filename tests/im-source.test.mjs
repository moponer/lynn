/**
 * 消息来源标识（P20-1）。
 *
 * ## 为什么需要
 *
 * 飞书/QQ 来的消息和本地输入**看起来一模一样**（都标「你」）。
 * 用户回到电脑上看同一个会话，分不清哪句是自己手打的、哪句是手机上问的。
 *
 * ## 链路（这正是要测的）
 *
 * ```
 * 适配层 fetchImpl 加头 x-lynn-channel: feishu
 *   → 桥 channelOf(req) 白名单校验
 *   → 作为 meta.channel 传给 handler
 *   → session.prompt 用 channelLabel() 翻成「飞书」
 *   → deps.submitTurn(text, sessionId, "飞书")
 *   → 内核消息卡 author.source = "飞书"
 *   → Feed 显示「你（飞书）」
 * ```
 *
 * 六个渠道共用一个桥，payload 由 vendor 生成、插不进字段，
 * 所以只能走传输层（头）。这条链路任何一环断了，界面上就分不出来。
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const { startBridge } = await import("../dist/main/im-bridge.js");
const { buildChannelHandlers } = await import("../dist/main/im-dsh-shapes.js");

/** 起桥 + 记录 submitTurn 收到的 source */
async function setup() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "lynn-src-"));
  const calls = [];
  const deps = {
    listThreads: () => [{ id: "s1", title: "T" }],
    currentThreadId: () => "s1",
    createThread: () => "s1",
    switchThread: () => {},
    renameThread: () => {},
    threadHistory: () => [],
    submitTurn: (text, threadId, source) => {
      calls.push({ text, threadId, source });
    },
    waitTurn: async () => {},
    abortTurn: () => {},
    listModels: () => [],
    currentModelId: () => "",
    selectModel: () => {},
    listWorkspaces: () => [],
    createWorkspace: () => {},
    version: () => "test",
  };
  const bridge = await startBridge({ handlers: buildChannelHandlers(deps) });
  return { bridge, calls, root };
}

/** 发一个带渠道头的 session.prompt */
async function prompt(bridge, channel, rpcId = "r1") {
  const headers = {
    "content-type": "application/json",
    authorization: `Bearer ${bridge.token}`,
    ...(channel ? { "x-lynn-channel": channel } : {}),
  };
  const res = await fetch(`${bridge.baseUrl}/api/session.prompt`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      type: "client-request",
      rpcId,
      method: "session.prompt",
      payload: { sessionId: "s1", content: [{ type: "text", text: "来自手机" }] },
    }),
  });
  return res.json();
}

test("带 x-lynn-channel: feishu → submitTurn 收到来源「飞书」", async () => {
  const { bridge, calls, root } = await setup();
  try {
    const r = await prompt(bridge, "feishu");
    assert.equal(r.result.ok, true, `prompt 失败：${JSON.stringify(r).slice(0, 120)}`);
    assert.equal(calls.length, 1, "没触发 submitTurn");
    assert.equal(calls[0].source, "飞书", `来源没传到内核：${calls[0].source}`);
  } finally {
    await bridge.close();
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 3 });
  }
});

test("四个渠道各自映射到中文名", async () => {
  const expect = { dingtalk: "钉钉", qq: "QQ", wecom: "企业微信", weixin: "微信" };
  for (const [id, label] of Object.entries(expect)) {
    const { bridge, calls, root } = await setup();
    try {
      await prompt(bridge, id);
      assert.equal(calls[0]?.source, label, `${id} 应映射成「${label}」，实际「${calls[0]?.source}」`);
    } finally {
      await bridge.close();
      fs.rmSync(root, { recursive: true, force: true, maxRetries: 3 });
    }
  }
});

test("不带渠道头（本地输入）→ source 为空，界面不显示后缀", async () => {
  const { bridge, calls, root } = await setup();
  try {
    await prompt(bridge, "");
    assert.equal(calls.length, 1);
    assert.equal(calls[0].source, undefined, "本地输入不该有来源标记");
  } finally {
    await bridge.close();
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 3 });
  }
});

test("伪造的渠道头被忽略（白名单校验）", async () => {
  const { bridge, calls, root } = await setup();
  try {
    /**
     * 任意字符串都能进 header。这个值会进日志与消息卡，
     * 所以桥侧必须白名单化——不能让它变成"用户可控的显示文本"。
     */
    await prompt(bridge, "../evil<script>");
    assert.equal(calls.length, 1);
    assert.equal(calls[0].source, undefined, `伪造的渠道名不该被采纳：${calls[0].source}`);
  } finally {
    await bridge.close();
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 3 });
  }
});

test("适配层真的会带这个头（源码级断言，防止将来漏传）", async () => {
  /**
   * 上面几条测的是"桥能处理"，但真正容易漏的是**适配层忘了带头**。
   * 这里直接读源码断言：飞书与四渠道工厂都传了第三个参数。
   */
  const read = (p) => fs.readFileSync(path.join(process.cwd(), p), "utf8");
  const feishu = read("src/main/im-feishu-vendor.ts");
  assert.match(
    feishu,
    /createVendorHarness\(bridgeBaseUrl,\s*bridgeToken,\s*"feishu"\)/,
    "飞书适配层必须把渠道标识传给 Harness",
  );
  const simple = read("src/main/im-channels.ts");
  assert.match(
    simple,
    /createVendorHarness\(bridgeBaseUrl,\s*bridgeToken,\s*config\.channel\)/,
    "四渠道工厂必须把 config.channel 传给 Harness",
  );
  const bridge = read("src/main/im-bridge.ts");
  assert.match(bridge, /CHANNEL_IDS/, "桥必须有渠道白名单");
});