/**
 * 工作区兜底（P21-3）——这是一次真实事故的回归测试。
 *
 * ## 事故链
 *
 * 用户在飞书里发消息，机器人回复：
 *
 * ```
 * 错误码 INTERNAL_UNKNOWN  参考号 MF-64DB2263
 * 任务未完成，暂时无法确定原因。
 * ```
 *
 * 查了整条链：
 *  1. `INTERNAL_UNKNOWN` 是 vendor 的**兜底码**（message-failure.mjs:189 的 default）
 *  2. 落到兜底，说明错误的 `code` 不在它认识的那张表里
 *  3. 我们的桥返回的是**裸字符串**，vendor 的 `HarnessRpcError.code` 因此变成 `'internal'`
 *  4. 真正抛错的是 `workspace.create`：它以 `path: undefined` 进来
 *  5. 而 `workspace: undefined` 的原因是我们**没给 HarnessClient 传 workspace**
 *
 * ## 教训
 *
 * 一个"可选参数"忘了传，用户看到的是一句和原因毫无关系的兜底文案。
 * 所以这里把两件事都钉住：
 *  - `listWorkspaces()` **永不返回空数组**
 *  - `workspace.create` 收到空 path 时**兜底**而不是抛错
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { Kernel } = require("../dist/main/kernel.js");
const { buildChannelHandlers } = require("../dist/main/im-dsh-shapes.js");

/**
 * 清理临时目录。
 *
 * Windows 上内核 dispose 后仍可能短暂持有句柄，`rmSync` 会报 `EPERM`。
 * 这**不是测试失败**——目录在 %TEMP% 里，留给系统回收即可。
 * 所以这里把清理错误吞掉，保持断言只反映被测行为。
 */
function cleanup(root) {
  try {
    cleanup(root);
  } catch {
    /* 留待系统回收 */
  }
}

/** 起一个真内核（临时目录），并注入假加密 */
async function makeKernel() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "lynn-ws-"));
  fs.writeFileSync(
    path.join(root, "settings.json"),
    JSON.stringify({ prefs: {} }),
    "utf-8",
  );
  const k = new Kernel(root);
  k.setEncryptors(
    (plain) => Buffer.from(plain, "utf-8"),
    () => true,
    (blob) => blob.toString("utf-8"),
  );
  await k.init();
  return { k, root };
}

test("listWorkspaces 永不返回空数组（空 = 会触发 INTERNAL_UNKNOWN）", async () => {
  const { k, root } = await makeKernel();
  try {
    const list = k.imHost().listWorkspaces();
    assert.ok(Array.isArray(list), "必须是数组");
    assert.ok(list.length > 0, `空数组会让 vendor 用 path: undefined 去建工作区`);
    assert.equal(typeof list[0].path, "string");
    assert.ok(list[0].path.length > 0, "path 不能是空串");
    // 兜底目录必须真的存在，否则后续读写会失败
    assert.ok(fs.existsSync(list[0].path), `兜底目录不存在：${list[0].path}`);
  } finally {
    await k.dispose();
    cleanup(root);
  }
});

test("workspace.create 空 path → 兜底到第一个已知工作区，不抛错", async () => {
  const { k, root } = await makeKernel();
  try {
    const h = buildChannelHandlers(k.imHost());
    /**
     * 这正是 vendor 在 `workspaceId()` 里找不到匹配时会发的东西：
     * `{ path: undefined }` 经 JSON 序列化后 path 键消失，等价于空。
     */
    const created = h["workspace.create"]({});
    assert.ok(created?.workspace?.workspaceId, `应返回 workspaceId，实际：${JSON.stringify(created)}`);
    assert.equal(typeof created.workspace.workspaceId, "string");
    assert.ok(created.workspace.workspaceId.length > 0);
  } finally {
    await k.dispose();
    cleanup(root);
  }
});

test("workspace.list 返回的 items 带 workspaceId（vendor 先查它，避免创建）", async () => {
  const { k, root } = await makeKernel();
  try {
    const h = buildChannelHandlers(k.imHost());
    const list = h["workspace.list"]({});
    assert.ok(Array.isArray(list.items) && list.items.length > 0);
    for (const item of list.items) {
      assert.equal(typeof item.workspaceId, "string");
      assert.ok(item.workspaceId.length > 0, "缺 workspaceId 会逼 vendor 去走 workspace.create");
      assert.equal(typeof item.path, "string");
      assert.ok(Array.isArray(item.sessionIds));
    }
    assert.ok(Array.isArray(list.archivedSessionIds), "缺 archivedSessionIds 会被判 invalid");
  } finally {
    await k.dispose();
    cleanup(root);
  }
});

test("适配层真的会把 workspace 传给 Harness（源码级断言）", () => {
  const read = (p) => fs.readFileSync(path.join(process.cwd(), p), "utf8");
  const harness = read("src/main/im-harness.ts");
  assert.match(harness, /workspace\?: string/, "createVendorHarness 应接受 workspace");
  assert.match(harness, /\.\.\.\(workspace \? \{ workspace \} : \{\}\)/, "应把它传给 HarnessClient");

  const feishu = read("src/main/im-feishu-vendor.ts");
  assert.match(feishu, /createVendorHarness\(bridgeBaseUrl, bridgeToken, "feishu", workspace\)/, "飞书必须传 workspace");

  const simple = read("src/main/im-channels.ts");
  assert.match(simple, /createVendorHarness\(bridgeBaseUrl, bridgeToken, config\.channel, workspace\)/, "四渠道必须传 workspace");

  const main = read("src/main/main.ts");
  assert.match(main, /workspace: channelWorkspace/, "壳层必须给出 channelWorkspace");
});