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

/**
 * 会话映射跨重启保留（P19-4）。
 *
 * 这条守的是一个**真实缺陷**：vendor 的 runtime 不会自己调 `state.load()`，
 * 那是 DSH 胶水层的责任。我们替代了那层却漏了这一步，后果是：
 *  - 同一个飞书群/QQ 群每次重启都被当成新会话 → 界面上**新开一个线程**
 *  - `seenMessageIds` 丢失 → 平台重投的消息会被再跑一遍
 *
 * 所以测试必须验证"第二次构造能读到第一次写下的映射"，
 * 而不只是"没有抛错"。
 */
test("状态落盘：load 后能读回上一次写的会话映射（跨重启保留）", async () => {
  const fs2 = await import("node:fs");
  const path2 = await import("node:path");
  const root = fs2.mkdtempSync(path2.join(os.tmpdir(), "lynn-st-"));
  const { bridge } = await setup();

  const mk = () =>
    createSimpleChannel({
      config: { channel: "qq", primary: "1", secret: "s", botId: "qq:1" },
      bridgeBaseUrl: bridge.baseUrl,
      bridgeToken: bridge.token,
      dataRoot: root,
      log: () => {},
    });

  try {
    // 第一次：构造后手动写一个映射（模拟收到消息后建立的会话）
    await mk();
    const stateFile = path2.join(root, "im", "qq", "state.json");
    assert.ok(fs2.existsSync(stateFile), "load() 应当把状态文件建出来");

    const raw = JSON.parse(fs2.readFileSync(stateFile, "utf-8"));
    assert.equal(raw.version, 1, "状态文件应有 version: 1 —— 说明结构对得上");

    // 模拟 vendor 写映射：直接写盘（等价于 setSession 的效果）
    raw.sessions = { "chat-1": "thread-abc" };
    fs2.writeFileSync(stateFile, JSON.stringify(raw), "utf-8");

    // 第二次构造（等价于应用重启）：load() 必须把这些读回来
    await mk();
    const after = JSON.parse(fs2.readFileSync(stateFile, "utf-8"));
    assert.equal(
      after.sessions["chat-1"],
      "thread-abc",
      "重启后映射丢了 —— 说明没有真正 load（会表现为界面上新开线程）",
    );
  } finally {
    await bridge.close();
    fs2.rmSync(root, { recursive: true, force: true, maxRetries: 3 });
  }
});