/**
 * IM 渠道配置（P14-2）。
 *
 * 这一层的风险是**凭据泄露**：
 * `im.status` 如果把 appSecret 明文回传给界面，它会出现在渲染进程的内存、
 * React DevTools、甚至错误堆栈里。项目既有约定是"凭据只经内核注入，不下发渲染层"。
 *
 * 所以测试的重点是**返回体里绝不能有 secret**，而不是"配置能存"。
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const { Kernel } = await import("../dist/main/kernel.js");

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "lynn-im-"));

/** 起一个内核，并注入"假加密"（把明文反转，能看出是不是真的过了加密） */
async function makeKernel() {
  const root = tmp();
  fs.writeFileSync(
    path.join(root, "settings.json"),
    JSON.stringify({
      model: {
        provider: "t",
        baseUrl: "http://127.0.0.1:9/v1",
        model: "m",
        apiKey: { encrypted: false, data: "k" },
        updatedAt: new Date().toISOString(),
      },
    }),
    "utf-8",
  );
  const k = new Kernel(root);
  k.setEncryptors(
    (plain) => Buffer.from([...plain].reverse().join(""), "utf-8"),
    () => true,
    (blob) => [...blob.toString("utf-8")].reverse().join(""),
  );
  await k.init();
  return { k, root };
}

test("im.status：没配置时返回 null，不炸", async () => {
  const { k } = await makeKernel();
  try {
    const status = await k.handle("im.status", undefined);
    assert.equal(status.bridgeEnabled, false);
    assert.equal(status.feishu, null);
  } finally {
    await k.dispose();
  }
});

test("im.saveFeishu：白名单为空 → 拒绝保存（并说清为什么）", async () => {
  const { k } = await makeKernel();
  try {
    const r = await k.handle("im.saveFeishu", {
      appId: "cli_test",
      appSecret: "secret-123",
      allowOpenIds: [],
      enabled: true,
    });
    assert.equal(r.ok, false);
    assert.match(r.error, /白名单不能为空/);
    assert.match(r.error, /文件与命令权限/, "要说明风险，不是只说不能");
  } finally {
    await k.dispose();
  }
});

test("im.saveFeishu：appId 为空 → 拒绝", async () => {
  const { k } = await makeKernel();
  try {
    const r = await k.handle("im.saveFeishu", { appId: "", appSecret: "s", allowOpenIds: ["ou_0123456789abcdef0123456789abcdef"] });
    assert.equal(r.ok, false);
    assert.match(r.error, /appId/);
  } finally {
    await k.dispose();
  }
});

test("im.saveFeishu：没填 secret 且之前也没存 → 拒绝", async () => {
  const { k } = await makeKernel();
  try {
    const r = await k.handle("im.saveFeishu", { appId: "cli_test", allowOpenIds: ["ou_0123456789abcdef0123456789abcdef"] });
    assert.equal(r.ok, false);
    assert.match(r.error, /appSecret/);
  } finally {
    await k.dispose();
  }
});

test("im.status：**绝不回传 secret 明文**（这是本组的核心）", async () => {
  const { k, root } = await makeKernel();
  try {
    const saved = await k.handle("im.saveFeishu", {
      appId: "cli_test",
      appSecret: "my-very-secret",
      allowOpenIds: ["ou_0123456789abcdef0123456789abcdef"],
      enabled: true,
    });
    assert.equal(saved.ok, true);

    const status = await k.handle("im.status", undefined);
    const text = JSON.stringify(status);
    assert.equal(status.feishu.secretSet, true, "要告诉界面「配过」");
    assert.doesNotMatch(text, /my-very-secret/, "返回体里出现了 secret 明文——这是凭据泄露");
    assert.equal(status.feishu.appSecret, undefined, "不该有 appSecret 字段");

    // 但磁盘上确实是加密过的（假加密 = 反转，再 base64；所以不会是原文）
    const raw = fs.readFileSync(path.join(root, "settings.json"), "utf-8");
    assert.doesNotMatch(raw, /my-very-secret/, "落盘的是明文——加密没生效");
    // base64("terces-yrev-ym") = dGVyY2VzLXlyZXYteW0=
    assert.match(raw, /dGVyY2VzLXlyZXYteW0=/, "落盘的应是加密后再 base64 的形态");
  } finally {
    await k.dispose();
  }
});

test("im.saveFeishu：留空 secret 时保留已存的那个", async () => {
  const { k } = await makeKernel();
  try {
    await k.handle("im.saveFeishu", { appId: "cli_a", appSecret: "s1", allowOpenIds: ["ou_0123456789abcdef0123456789abcdef"], enabled: true });
    // 只改白名单，不重输 secret
    const r = await k.handle("im.saveFeishu", { appId: "cli_a", allowOpenIds: ["ou_0123456789abcdef0123456789abcdef", "ou_fedcba9876543210fedcba9876543210"], enabled: true });
    assert.equal(r.ok, true);
    const status = await k.handle("im.status", undefined);
    assert.equal(status.feishu.secretSet, true, "secret 应保留");
    assert.deepEqual(status.feishu.allowOpenIds, ["ou_0123456789abcdef0123456789abcdef", "ou_fedcba9876543210fedcba9876543210"]);
  } finally {
    await k.dispose();
  }
});

test("im.saveFeishu：白名单里的空白项被过滤掉", async () => {
  const { k } = await makeKernel();
  try {
    const r = await k.handle("im.saveFeishu", {
      appId: "cli_a",
      appSecret: "s",
      allowOpenIds: ["ou_0123456789abcdef0123456789abcdef", "  ", "", "ou_fedcba9876543210fedcba9876543210"],
      enabled: true,
    });
    assert.equal(r.ok, true);
    const status = await k.handle("im.status", undefined);
    assert.deepEqual(status.feishu.allowOpenIds, ["ou_0123456789abcdef0123456789abcdef", "ou_fedcba9876543210fedcba9876543210"], "空项不该进白名单");
  } finally {
    await k.dispose();
  }
});

test("imChannels：解密后的形态只给内核内部用（壳层启动渠道时才调）", async () => {
  const { k } = await makeKernel();
  try {
    await k.handle("im.saveFeishu", { appId: "cli_a", appSecret: "real-secret", allowOpenIds: ["ou_0123456789abcdef0123456789abcdef"], enabled: true });
    const ch = k.imChannels();
    assert.equal(ch.feishu.appSecret, "real-secret", "内核内部要拿到明文才能连飞书");
    assert.equal(ch.feishu.enabled, true);
    assert.equal(ch.feishu.allowGroup, false, "群聊默认关");
  } finally {
    await k.dispose();
  }
});

/**
 * 只有一个开关（2026-11-18 P14-4）。
 *
 * 真实事故：第一版只认环境变量，用户在设置页勾了「启用」却没反应；
 * 第二版改成"环境变量 **或** 设置页"，用户问得好——"两个不一样信谁的？"
 *
 * 答案是不该有两个。这条测试守的是**结构上只有一个**：
 * 主进程里不许再出现 LYNN_IM_BRIDGE 的**判断**（注释里的历史记录不算）。
 */
test("启动判断只看设置页的 enabled，不看环境变量", async () => {
  const fs = await import("node:fs");
  const path = await import("node:path");
  const { fileURLToPath } = await import("node:url");
  const here = path.dirname(fileURLToPath(import.meta.url));
  const src = fs.readFileSync(path.join(here, "..", "src/main/main.ts"), "utf8");

  // 去掉注释后不该有 process.env.LYNN_IM_BRIDGE
  const noComments = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
  assert.doesNotMatch(
    noComments,
    /process\.env\.LYNN_IM_BRIDGE/,
    "主进程里还有环境变量判断——会出现「两个开关信谁」的问题",
  );
  // 必须看设置
  assert.match(noComments, /imChannels\(\)/, "启动判断应当读 kernel.imChannels()");
  assert.match(noComments, /feishu\?\.enabled === true/, "应当只看 feishu.enabled");
});