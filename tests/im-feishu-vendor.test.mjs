/**
 * 飞书渠道适配层（vendored 版，P16-2）。
 *
 * 手写版 `im-feishu.ts` 已被取代（它只有"收文本→跑一轮→回文本"，
 * 而 vendored 版有卡片、流式、斜杠命令、群历史、语音、审批）。
 *
 * 这个文件守的是**适配层自己的责任**——渠道逻辑在 vendor 里，
 * 不需要我们测；我们测的是"接线对不对、闸门在不在"：
 *
 *  1. 白名单为空 → **拒绝启动**（不是"启动了但谁都不理"）
 *  2. open_id 格式不对 → 拒绝，并说清怎么改
 *  3. 缺 SDK → 给出可照做的安装命令
 *  4. 构造成功后 `status()` 真的能读（它是 getter，不是方法）
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const { startBridge } = await import("../dist/main/im-bridge.js");
const { buildChannelHandlers } = await import("../dist/main/im-dsh-shapes.js");
const { createFeishuVendorChannel } = await import("../dist/main/im-feishu-vendor.js");
const { isValidOpenId } = await import("../dist/main/im-openid.js");

const GOOD_ID = "ou_7d8a6e6df7621556ce0d21922b676706";

/** 起一个最小桥 + 临时数据目录 */
async function setup() {
  const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), "lynn-fsv-"));
  const deps = {
    listThreads: () => [],
    currentThreadId: () => "s1",
    createThread: () => "s1",
    switchThread: () => {},
    renameThread: () => {},
    threadHistory: () => [],
    submitTurn: () => {},
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
  return { bridge, dataRoot };
}

// ---------- open_id 校验 ----------

test("isValidOpenId：标准格式通过", () => {
  assert.equal(isValidOpenId(GOOD_ID), true);
  assert.equal(isValidOpenId("ou_0123456789abcdef0123456789abcdef"), true);
  assert.equal(isValidOpenId(`  ${GOOD_ID}  `), true, "粘贴常带空白，要容忍");
});

test("isValidOpenId：多复制字符 → 拒绝（真实事故形态）", () => {
  // 用户实际配的就是这个：38 字符
  assert.equal(isValidOpenId("ou_7d8a6e6df7621556ce0d21922b676706ccs"), false);
  assert.equal(isValidOpenId(GOOD_ID + "c"), false, "末尾多 1 个字符也要拒");
});

test("isValidOpenId：少字符 / 前缀错 / 非十六进制 → 拒绝", () => {
  assert.equal(isValidOpenId("ou_7d8a6e6df7621556ce0d21922b67670"), false);
  assert.equal(isValidOpenId("7d8a6e6df7621556ce0d21922b676706"), false);
  assert.equal(isValidOpenId("oc_7d8a6e6df7621556ce0d21922b676706"), false, "oc_ 是 chat_id 不是 open_id");
  assert.equal(isValidOpenId("ou_7d8a6e6df7621556ce0d21922b67670z"), false);
  assert.equal(isValidOpenId(""), false);
});

// ---------- 适配层闸门 ----------

test("白名单为空 → 拒绝启动（不是启动了却谁都不理）", async () => {
  const { bridge, dataRoot } = await setup();
  try {
    await assert.rejects(
      () =>
        createFeishuVendorChannel({
          config: { appId: "cli_x", appSecret: "y", allowOpenIds: [] },
          bridgeBaseUrl: bridge.baseUrl,
          bridgeToken: bridge.token,
          dataRoot,
          log: () => {},
        }),
      (err) => {
        assert.match(err.message, /白名单为空/);
        assert.match(err.message, /任何人都能驱动/, "要说明风险，不是只说不能");
        return true;
      },
    );
  } finally {
    await bridge.close();
  }
});

test("open_id 格式不对 → 拒绝，并说清正确格式", async () => {
  const { bridge, dataRoot } = await setup();
  try {
    await assert.rejects(
      () =>
        createFeishuVendorChannel({
          config: { appId: "cli_x", appSecret: "y", allowOpenIds: ["ou_7d8a6e6df7621556ce0d21922b676706ccs"] },
          bridgeBaseUrl: bridge.baseUrl,
          bridgeToken: bridge.token,
          dataRoot,
          log: () => {},
        }),
      (err) => {
        assert.match(err.message, /格式不对/);
        assert.match(err.message, /35 字符/, "要说清正确长度");
        return true;
      },
    );
  } finally {
    await bridge.close();
  }
});

test("缺 appId / appSecret → 拒绝", async () => {
  const { bridge, dataRoot } = await setup();
  try {
    await assert.rejects(
      () =>
        createFeishuVendorChannel({
          config: { appId: "", appSecret: "", allowOpenIds: [GOOD_ID] },
          bridgeBaseUrl: bridge.baseUrl,
          bridgeToken: bridge.token,
          dataRoot,
          log: () => {},
        }),
      /appId/,
    );
  } finally {
    await bridge.close();
  }
});

test("合法配置 → 能构造，且 status 是 getter（能读到真实状态）", async () => {
  const { bridge, dataRoot } = await setup();
  try {
    const ch = await createFeishuVendorChannel({
      config: { appId: "cli_aa77ef13a53a9ccf", appSecret: "fake-secret", allowOpenIds: [GOOD_ID], allowGroup: false },
      bridgeBaseUrl: bridge.baseUrl,
      bridgeToken: bridge.token,
      dataRoot,
      log: () => {},
    });
    assert.equal(typeof ch.start, "function");
    assert.equal(typeof ch.stop, "function");

    /**
     * `status` 在 vendor 里是 **getter**（`get status()`），
     * 写成方法调用会报 "runtime.status is not a function"。
     */
    const st = ch.status();
    assert.equal(typeof st, "object", "status 要能返回值，不是 undefined");
    assert.ok(st !== null);
    // 这些字段来自 vendored runtime 的真实状态
    assert.equal(typeof st.ready, "boolean", `缺 ready 字段：${Object.keys(st ?? {}).join(",")}`);
    assert.equal(typeof st.feishuLongConnectionState, "string");
    assert.equal(typeof st.messagesReceived, "number");
    // 未 start 时应是空闲
    assert.equal(st.ready, false, "没 start 就说 ready 是撒谎");
    assert.equal(st.feishuLongConnectionState, "idle");
  } finally {
    await bridge.close();
  }
});

test("构造时不在白名单里的人不会被加进 allowedSenderCount", async () => {
  const { bridge, dataRoot } = await setup();
  try {
    const ch = await createFeishuVendorChannel({
      config: { appId: "cli_x", appSecret: "y", allowOpenIds: [GOOD_ID] },
      bridgeBaseUrl: bridge.baseUrl,
      bridgeToken: bridge.token,
      dataRoot,
      log: () => {},
    });
    const st = ch.status();
    assert.equal(st.allowedSenderCount, 1, `白名单 1 人，但状态报 ${st.allowedSenderCount}`);
  } finally {
    await bridge.close();
  }
});