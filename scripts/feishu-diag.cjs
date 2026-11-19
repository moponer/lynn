/**
 * 飞书 API 逐步探测（2026-11-19 P21-1）。
 *
 * 目的：用户遇到 `INTERNAL_UNKOWN` + 参考号 `MF-xxxx`，但错误详情被日志里的
 * `[object Object]` 吃掉了。与其等下次复现，不如**逐个 API 试一遍**，
 * 看是哪一个在报。
 *
 * 入站处理里会调的飞书 API（按 vendored bridge 的顺序）：
 *   1. 给消息加「处理中」表情（reaction）—— `#beginReaction`
 *   2. 读消息内容 / 资源（有图片/文件时才调）
 *   3. 回复消息（reply）
 *   4. 改表情 / 撤表情
 *
 * 用法：
 *   npx electron scripts/feishu-diag.cjs <message_id> [chat_id]
 */
const { app, safeStorage } = require("electron");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

app.disableHardwareAcceleration();
// 与 app 同身份，否则 safeStorage 解不开（实测：只有这一项不同，解密一成一败）
app.setName("lynn");
const appData = process.env.APPDATA || path.join(os.homedir(), "AppData", "Roaming");
app.setPath("userData", path.join(appData, "lynn"));

const API = "https://open.feishu.cn/open-apis";

function readCredentials() {
  const file = path.join(os.homedir(), ".lynn", "settings.json");
  const s = JSON.parse(fs.readFileSync(file, "utf-8"));
  const f = s?.im?.feishu;
  if (!f?.appId || !f?.appSecret?.data) throw new Error("设置里没有飞书凭据");
  const secret = f.appSecret.encrypted
    ? safeStorage.decryptString(Buffer.from(f.appSecret.data, "base64"))
    : f.appSecret.data;
  return { appId: f.appId, appSecret: secret, allowOpenIds: f.allowOpenIds ?? [] };
}

async function call(pathname, { method = "GET", body, token } = {}) {
  const headers = { "content-type": "application/json; charset=utf-8" };
  if (token) headers.authorization = `Bearer ${token}`;
  const res = await fetch(`${API}${pathname}`, {
    method,
    headers,
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    /* 非 JSON */
  }
  return { status: res.status, json, text: text.slice(0, 300) };
}

/** 打印一步结果；失败时把 code/msg/log_id 全摊开 */
function report(label, r) {
  const code = r.json?.code;
  const msg = r.json?.msg;
  const logId = r.json?.error?.log_id ?? r.json?.log_id;
  if (code === 0) {
    console.log(`  ✅ ${label}`);
    return true;
  }
  console.log(`  ✖ ${label}`);
  console.log(`     HTTP ${r.status}  code=${code ?? "?"}  msg=${msg ?? "?"}`);
  if (logId) console.log(`     log_id=${logId}`);
  if (r.text && !r.json) console.log(`     body=${r.text.slice(0, 160)}`);
  return false;
}

app.whenReady().then(async () => {
  let code = 1;
  try {
    const messageId = process.argv[2];
    const chatId = process.argv[3];
    const cred = readCredentials();

    const tk = await call("/auth/v3/tenant_access_token/internal", {
      method: "POST",
      body: { app_id: cred.appId, app_secret: cred.appSecret },
    });
    if (!report("换 tenant_access_token", tk)) {
      app.exit(1);
      return;
    }
    const token = tk.json.tenant_access_token;
    console.log(`\nappId=${cred.appId}\n`);

    if (!messageId) {
      console.log("用法：npx electron scripts/feishu-diag.cjs <message_id> [chat_id]");
      console.log("提示：message_id 在日志里搜「processing p2p message」后面的那个 om_…");
      app.exit(2);
      return;
    }

    console.log(`探测对象 message_id=${messageId}\n`);

    // 1) 读这条消息 —— 顺带验证 im:message 读权限
    report("读消息 GET /im/v1/messages/:id", await call(`/im/v1/messages/${encodeURIComponent(messageId)}`, { token }));

    // 2) 加「处理中」表情（入站处理的第一件事，最可疑）
    report(
      "加表情 POST /im/v1/messages/:id/reactions (THUMBSUP)",
      await call(`/im/v1/messages/${encodeURIComponent(messageId)}/reactions`, {
        method: "POST",
        token,
        body: { reaction_type: { emoji_type: "THUMBSUP" } },
      }),
    );

    // 3) 列表情（看机器人能不能读自己的表情）
    report("列表情 GET /im/v1/messages/:id/reactions", await call(`/im/v1/messages/${encodeURIComponent(messageId)}/reactions`, { token }));

    // 4) 回复这条消息 —— 入站处理的最后一步
    report(
      "回复消息 POST /im/v1/messages/:id/reply",
      await call(`/im/v1/messages/${encodeURIComponent(messageId)}/reply`, {
        method: "POST",
        token,
        body: { msg_type: "text", content: JSON.stringify({ text: "（诊断消息，可忽略）" }) },
      }),
    );

    // 5) 如果有 chat_id，直接发一条（对照：chat 发送 vs reply）
    if (chatId) {
      report(
        "按 chat_id 发送 POST /im/v1/messages",
        await call("/im/v1/messages?receive_id_type=chat_id", {
          method: "POST",
          token,
          body: { receive_id: chatId, msg_type: "text", content: JSON.stringify({ text: "（诊断消息 2，可忽略）" }) },
        }),
      );
    }

    code = 0;
  } catch (err) {
    console.error("✖", err instanceof Error ? err.message : String(err));
  } finally {
    app.exit(code);
  }
});