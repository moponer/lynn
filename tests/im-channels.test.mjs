/**
 * 其余国内渠道适配层（P19-2）。
 *
 * 钉钉 / QQ / 企业微信 / 微信共用同一个工厂。这组测试守的是：
 *
 *  1. 四个渠道都能把 vendor 的 runtime 组装起来（构造成功 = 接线正确）
 *  2. 配置不全时**早失败并说清缺什么**（不是"启动了但收不到消息"）
 *  3. 微信的 ownerUserId 是**必需**的（不给就等于谁都能驱动 Agent）
 *  4. `status()` 能读到真实状态（vendor 里是 getter，不是方法）
 *
 * 不测"能不能连上平台"——那需要真凭据，属于手工验证的范畴。
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const { startBridge } = await import("../dist/main/im-bridge.js");
const { buildChannelHandlers } = await import("../dist/main/im-dsh-shapes.js");
const { createSimpleChannel, deriveBotId } = await import("../dist/main/im-channels.js");

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

async function setup() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "lynn-ch-"));
  const bridge = await startBridge({ handlers: buildChannelHandlers(deps) });
  return { bridge, root };
}

const CASES = [
  { channel: "dingtalk", primary: "dingtest", secret: "s", label: "钉钉" },
  { channel: "qq", primary: "12345678", secret: "s", label: "QQ" },
  { channel: "wecom", primary: "wecom-bot", secret: "s", label: "企业微信" },
  { channel: "weixin", primary: "wx-acc", secret: "tok", ownerUserId: "u_1", label: "微信" },
];

for (const c of CASES) {
  test(`${c.label}：能构造（接线正确）`, async () => {
    const { bridge, root } = await setup();
    try {
      const h = await createSimpleChannel({
        config: { ...c, botId: deriveBotId(c.channel, c.primary) },
        bridgeBaseUrl: bridge.baseUrl,
        bridgeToken: bridge.token,
        dataRoot: root,
        log: () => {},
      });
      assert.equal(typeof h.start, "function");
      assert.equal(typeof h.stop, "function");
      const st = h.status();
      assert.equal(typeof st, "object", `${c.label} 的 status 应有返回值`);
      assert.ok(st !== null);
      assert.ok(Object.keys(st).length > 0, `${c.label} 的 status 不该是空对象`);
    } finally {
      await bridge.close();
      fs.rmSync(root, { recursive: true, force: true, maxRetries: 3 });
    }
  });
}

test("缺 secret → 早失败并说清是哪个渠道", async () => {
  const { bridge, root } = await setup();
  try {
    for (const c of CASES) {
      await assert.rejects(
        () =>
          createSimpleChannel({
            config: { ...c, secret: "", botId: "b" },
            bridgeBaseUrl: bridge.baseUrl,
            bridgeToken: bridge.token,
            dataRoot: root,
            log: () => {},
          }),
        (err) => {
          assert.match(err.message, /secret/, `${c.label} 的错误应按说 secret：${err.message}`);
          return true;
        },
      );
    }
  } finally {
    await bridge.close();
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 3 });
  }
});

test("缺主标识 → 早失败", async () => {
  const { bridge, root } = await setup();
  try {
    await assert.rejects(
      () =>
        createSimpleChannel({
          config: { channel: "qq", primary: "", secret: "s", botId: "b" },
          bridgeBaseUrl: bridge.baseUrl,
          bridgeToken: bridge.token,
          dataRoot: root,
          log: () => {},
        }),
      /主标识/,
    );
  } finally {
    await bridge.close();
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 3 });
  }
});

test("微信缺 ownerUserId → 拒绝（不给就等于谁都能驱动 Agent）", async () => {
  const { bridge, root } = await setup();
  try {
    await assert.rejects(
      () =>
        createSimpleChannel({
          config: { channel: "weixin", primary: "a", secret: "t", botId: "b" },
          bridgeBaseUrl: bridge.baseUrl,
          bridgeToken: bridge.token,
          dataRoot: root,
          log: () => {},
        }),
      (err) => {
        assert.match(err.message, /ownerUserId/);
        assert.match(err.message, /驱动 Agent/, "要说明风险，不是只说不能");
        return true;
      },
    );
  } finally {
    await bridge.close();
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 3 });
  }
});

test("未知渠道 → 拒绝并报出名字", async () => {
  const { bridge, root } = await setup();
  try {
    await assert.rejects(
      () =>
        createSimpleChannel({
          config: { channel: "telegram", primary: "a", secret: "s", botId: "b" },
          bridgeBaseUrl: bridge.baseUrl,
          bridgeToken: bridge.token,
          dataRoot: root,
          log: () => {},
        }),
      /未知渠道/,
    );
  } finally {
    await bridge.close();
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 3 });
  }
});

test("deriveBotId：稳定且按渠道区分（同 id 不同渠道不撞）", () => {
  assert.equal(deriveBotId("qq", "123"), "qq:123");
  assert.equal(deriveBotId("dingtalk", "123"), "dingtalk:123");
  assert.equal(deriveBotId("wecom", "123"), "wecom:123");
  assert.equal(deriveBotId("weixin", "123"), "weixin:123");
  assert.notEqual(deriveBotId("qq", "123"), deriveBotId("dingtalk", "123"));
});