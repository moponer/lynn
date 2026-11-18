#!/usr/bin/env node
/**
 * 五个渠道的构造验证（P19-3）。
 *
 * 验证的是"适配层能不能把 vendor 的 runtime 组装起来"，**不是**"能不能连上平台"。
 * 后者需要真凭据，这里给的是假凭据——构造成功即证明接线正确，
 * `start()` 会因为凭据无效而失败，那是预期的。
 */
import { createRequire } from "node:module";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const require = createRequire(import.meta.url);
const { startBridge } = require("../dist/main/im-bridge.js");
const { buildChannelHandlers } = require("../dist/main/im-dsh-shapes.js");
const { createSimpleChannel } = require("../dist/main/im-channels.js");

const results = [];
const check = (label, ok, detail = "") => {
  results.push({ ok });
  console.log(`  ${ok ? "✅" : "✖ "} ${label}${detail ? `（${detail}）` : ""}`);
};

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
  version: () => "probe",
};

const bridge = await startBridge({ handlers: buildChannelHandlers(deps) });
const root = fs.mkdtempSync(path.join(os.tmpdir(), "lynn-ch-"));

const CASES = [
  { channel: "dingtalk", primary: "dingtest_client_id", secret: "fake-secret" },
  { channel: "qq", primary: "12345678", secret: "fake-secret" },
  { channel: "wecom", primary: "wecom-bot-1", secret: "fake-secret" },
  { channel: "weixin", primary: "wx-account-1", secret: "fake-token", ownerUserId: "u_owner" },
];

try {
  for (const c of CASES) {
    const label = { dingtalk: "钉钉", qq: "QQ", wecom: "企业微信", weixin: "微信" }[c.channel];
    try {
      const h = await createSimpleChannel({
        config: { ...c, botId: `${c.channel}:${c.primary}` },
        bridgeBaseUrl: bridge.baseUrl,
        bridgeToken: bridge.token,
        dataRoot: root,
        log: () => {},
      });
      const st = h.status();
      const keys = st && typeof st === "object" ? Object.keys(st).length : 0;
      check(`${label} 构造成功`, typeof h.start === "function" && keys > 0, `status 有 ${keys} 个字段`);
    } catch (e) {
      check(`${label} 构造成功`, false, String(e.message).slice(0, 110));
    }
  }

  // 缺字段要早失败
  console.log("\n=== 前置校验 ===");
  for (const [label, cfg] of [
    ["缺 secret", { channel: "qq", primary: "1", botId: "b", secret: "" }],
    ["缺主标识", { channel: "qq", primary: "", botId: "b", secret: "s" }],
    ["微信缺 owner", { channel: "weixin", primary: "1", botId: "b", secret: "s" }],
  ]) {
    try {
      await createSimpleChannel({
        config: cfg,
        bridgeBaseUrl: bridge.baseUrl,
        bridgeToken: bridge.token,
        dataRoot: root,
        log: () => {},
      });
      check(`${label} 被拒`, false, "竟然通过了");
    } catch (e) {
      check(`${label} 被拒`, true, String(e.message).slice(0, 60));
    }
  }
} finally {
  await bridge.close();
  fs.rmSync(root, { recursive: true, force: true, maxRetries: 3 });
}

const pass = results.filter((r) => r.ok).length;
console.log(`\n=== ${pass}/${results.length} 通过 ===`);
process.exit(pass === results.length ? 0 : 1);