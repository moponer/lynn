// M2-16：消息平台 —— 合规口径、官方 API 发送（mock HTTP）、凭据加密落盘
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  COMPLIANCE_NOTE,
  feishuToken,
  feishuSend,
  qqToken,
  qqSend,
  loadMessaging,
  saveMessaging,
  configureChannel,
  resolveEnabledChannel,
} from "../dist/main/messaging.js";

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "lynn-msg-"));

/** mock fetch：按 URL 路由 */
function mockFetch(routes) {
  const calls = [];
  const fn = async (url, init) => {
    calls.push({ url, init });
    const route = routes.find((r) => url.includes(r.match));
    if (!route) return { ok: false, status: 404, json: async () => ({}) };
    return { ok: route.status !== 400, status: route.status ?? 200, json: async () => route.body };
  };
  return { fn, calls };
}

test("合规口径写死在代码里（R8）", () => {
  assert.ok(COMPLIANCE_NOTE.includes("官方 API"));
  assert.ok(COMPLIANCE_NOTE.includes("用户自建"));
  assert.ok(COMPLIANCE_NOTE.includes("收消息"), "收消息未实现要如实说");
});

test("飞书：token 获取+缓存；发送走官方 API；凭据错如实报", async () => {
  const { fn, calls } = mockFetch([
    { match: "tenant_access_token", body: { code: 0, tenant_access_token: "t-1", expire: 3600 } },
    { match: "/im/v1/messages", body: { code: 0 } },
  ]);
  const cache = {};
  const t1 = await feishuToken("app", "sec", fn, cache);
  assert.equal(t1, "t-1");
  await feishuToken("app", "sec", fn, cache);
  assert.equal(calls.filter((c) => c.url.includes("token")).length, 1, "token 缓存不重复取");

  const r = await feishuSend({ appId: "app", appSecret: "sec" }, "chat-1", "你好", fn, cache);
  assert.equal(r.ok, true);
  const sendCall = calls.find((c) => c.url.includes("/im/v1/messages"));
  assert.equal(sendCall.init.headers.authorization, "Bearer t-1");
  assert.ok(sendCall.init.body.includes("chat-1"));

  const bad = mockFetch([{ match: "tenant_access_token", status: 400, body: { code: 99991663, msg: "app secret invalid" } }]);
  await assert.rejects(() => feishuToken("app", "wrong", bad.fn, {}), /凭据无效|权限未开通/, "凭据错如实报");
});

test("QQ：token+发送官方端点；失败如实报", async () => {
  const { fn, calls } = mockFetch([
    { match: "getAppAccessToken", body: { access_token: "q-1", expires_in: "3600" } },
    { match: "/v2/users/", body: {} },
  ]);
  const r = await qqSend({ appId: "app", appSecret: "sec" }, "openid-1", "hi", fn);
  assert.equal(r.ok, true);
  const sendCall = calls.find((c) => c.url.includes("/v2/users/openid-1"));
  assert.equal(sendCall.init.headers.authorization, "QQBot q-1");

  const bad = mockFetch([{ match: "getAppAccessToken", status: 400, body: { message: "invalid secret" } }]);
  await assert.rejects(() => qqToken("app", "wrong", bad.fn, {}), /凭据无效/);
});

test("configureChannel：凭据加密后落盘（明文不进文件）；未配置渠道发送如实拒", async () => {
  const root = tmp();
  const encrypt = (plain) => ({ encrypted: true, data: Buffer.from(`enc:${plain}`).toString("base64") });

  const noSecret = configureChannel(loadMessaging(root), "feishu", { appId: "app" }, encrypt);
  assert.equal(noSecret.ok, false, "首次必须给 Secret");

  const r = configureChannel(loadMessaging(root), "feishu", { appId: "cli_1", appSecret: "s3cret", enable: true }, encrypt);
  assert.equal(r.ok, true);
  saveMessaging(root, r.next);
  const raw = fs.readFileSync(path.join(root, "messaging.json"), "utf-8");
  assert.ok(!raw.includes("s3cret"), "明文 Secret 不落盘");
  const stored = loadMessaging(root).feishu;
  assert.equal(stored.secret.encrypted, true, "加密标记落盘");
  assert.ok(stored.secret.data.length > 0);

  const bad = configureChannel(loadMessaging(root), "wx", { appId: "x" }, encrypt);
  assert.equal(bad.ok, false, "未知渠道拒");

  const guard = resolveEnabledChannel(loadMessaging(root), "qq");
  assert.equal(guard.ok, false, "未配置的渠道发送如实拒");
  assert.ok(guard.error.includes("未配置"));
});
