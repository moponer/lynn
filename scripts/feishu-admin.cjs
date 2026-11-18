/**
 * 飞书管理 CLI（2026-11-18 P18-1）。
 *
 * ## 为什么需要 Electron 才能跑
 *
 * 你的 appSecret 是用 Electron 的 `safeStorage` 加密存在
 * `~/.lynn/settings.json` 里的。那是 **DPAPI**（Windows）/ Keychain（macOS）
 * 级别的加密，只有**同一个用户 + Electron 主进程**能解。
 *
 * 所以这个脚本必须在 Electron 里跑，而不是普通 node：
 *  - 普通 node 解不开 → 只能要求你把 secret 贴进对话（可能泄漏到聊天记录）
 *  - Electron 里解 → **复用你已配好的凭据，secret 一个字符都不外传**
 *
 * ## 用法
 *
 * ```bash
 * npx electron scripts/feishu-admin.cjs whoami      # 机器人信息
 * npx electron scripts/feishu-admin.cjs chats       # 机器人所在的会话
 * npx electron scripts/feishu-admin.cjs members     # 所有会话的成员（含 open_id）
 * npx electron scripts/feishu-admin.cjs send oc_xxx "测试消息"
 * ```
 *
 * ## 安全
 *
 * - secret 只在内存里，**不打印**（只打前 4 后 4）
 * - 只读命令（whoami/chats/members）不动任何数据
 * - `send` 会**真的以机器人身份发消息**，要显式指定 chat_id
 */
const { app, safeStorage } = require("electron");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const API = "https://open.feishu.cn/open-apis";

function mask(s) {
  if (!s || s.length <= 8) return "****";
  return `${s.slice(0, 4)}…${s.slice(-4)}`;
}

/** 从 ~/.lynn/settings.json 读出并解密飞书凭据 */
function readCredentials() {
  const file = path.join(os.homedir(), ".lynn", "settings.json");
  if (!fs.existsSync(file)) throw new Error(`没有设置文件：${file}`);
  const s = JSON.parse(fs.readFileSync(file, "utf-8"));
  const f = s?.im?.feishu;
  if (!f?.appId) throw new Error("设置里没有飞书 appId——先在应用里配一次");
  if (!f.appSecret?.data) throw new Error("设置里没有飞书 appSecret");

  let secret = "";
  if (f.appSecret.encrypted) {
    if (!safeStorage.isEncryptionAvailable()) {
      throw new Error("当前环境取不到系统凭据库（safeStorage 不可用），无法解密");
    }
    secret = safeStorage.decryptString(Buffer.from(f.appSecret.data, "base64"));
  } else {
    secret = f.appSecret.data;
  }
  return { appId: f.appId, appSecret: secret, allowOpenIds: f.allowOpenIds ?? [] };
}

/** 带 token 的请求 */
async function call(pathname, { method = "GET", body, token } = {}) {
  const headers = { "content-type": "application/json; charset=utf-8" };
  if (token) headers.authorization = `Bearer ${token}`;
  const res = await fetch(`${API}${pathname}`, {
    method,
    headers,
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const text = await res.text();
  try {
    return JSON.parse(text);
  } catch {
    return { code: -1, msg: text.slice(0, 200) };
  }
}

async function run() {
  const argv = process.argv.slice(2);
  const cmd = argv[0] ?? "whoami";
  const cred = readCredentials();
  console.log(`飞书：appId=${cred.appId} appSecret=${mask(cred.appSecret)}`);
  console.log(`白名单：${cred.allowOpenIds.length ? cred.allowOpenIds.join(", ") : "（空）"}\n`);

  // 1) 换 token
  const tk = await call("/auth/v3/tenant_access_token/internal", {
    method: "POST",
    body: { app_id: cred.appId, app_secret: cred.appSecret },
  });
  if (tk.code !== 0 || !tk.tenant_access_token) {
    console.error(`✖ 换 token 失败：code=${tk.code} ${tk.msg ?? ""}`);
    if (tk.code === 10014) console.error("  → appSecret 不对：去开放平台「凭证与基础信息」重置");
    if (tk.code === 10003) console.error("  → appId 不存在");
    return 1;
  }
  const token = tk.tenant_access_token;
  console.log(`✅ token 有效（${tk.expire ?? "?"} 秒）\n`);

  if (cmd === "whoami") {
    const bot = await call("/bot/v3/info", { token });
    if (bot.code === 0) {
      console.log(`机器人：${bot.bot?.app_name}`);
      console.log(`  自身 open_id: ${bot.bot?.open_id}`);
      console.log(`  ⚠ 白名单要填的是**你**的 open_id，不是这个`);
    } else {
      console.log(`✖ 读不到机器人信息：code=${bot.code} ${bot.msg ?? ""}`);
      console.log("  → 大概率「应用功能 → 机器人」没启用");
    }
    return 0;
  }

  if (cmd === "chats") {
    const chats = await call("/im/v1/chats?page_size=20", { token });
    if (chats.code !== 0) {
      console.log(`✖ code=${chats.code} ${chats.msg ?? ""}`);
      if (chats.code === 99991672 || chats.code === 99991679) {
        console.log("  → 缺 im:chat:readonly 权限；开完必须**重新发布版本**");
      }
      return 1;
    }
    const items = chats.data?.items ?? [];
    if (!items.length) {
      console.log("机器人还没加入任何会话。在飞书里给它发一条消息（私聊会自成一个会话）。");
      return 0;
    }
    for (const c of items) {
      const kind = c.chat_mode === "p2p" ? "私聊" : "群";
      console.log(`  ${kind}  ${c.chat_id}  「${c.name || "-"}」  成员 ${c.member_count ?? "?"}`);
    }
    return 0;
  }

  if (cmd === "members" || cmd === "candidates") {
    const bot = await call("/bot/v3/info", { token });
    const botOpenId = bot.code === 0 ? bot.bot?.open_id : undefined;
    const chats = await call("/im/v1/chats?page_size=20", { token });
    if (chats.code !== 0) {
      console.log(`✖ 读不到会话（code=${chats.code}）→ 需要 im:chat:readonly，开完要重新发布版本`);
      return 1;
    }
    const items = chats.data?.items ?? [];
    if (!items.length) {
      console.log("机器人还没加入任何会话 —— 先在飞书里给它发一条消息，再跑一次。");
      return 0;
    }
    const seen = new Set();
    for (const c of items) {
      const label = c.chat_mode === "p2p" ? "私聊" : `群「${c.name || c.chat_id}」`;
      const mem = await call(`/im/v1/chats/${encodeURIComponent(c.chat_id)}/members?member_id_type=open_id&page_size=50`, { token });
      if (mem.code !== 0) {
        console.log(`  ⚠ ${label}：读不到成员（code=${mem.code} ${mem.msg ?? ""}）`);
        continue;
      }
      for (const m of mem.data?.items ?? []) {
        const id = String(m.member_id ?? "");
        if (!id.startsWith("ou_") || seen.has(id)) continue;
        seen.add(id);
        const isBot = botOpenId && id === botOpenId;
        console.log(`  ${isBot ? "🤖" : "👤"} ${id}   ←  ${label}${m.name ? `（${m.name}）` : ""}${isBot ? " 机器人自己" : ""}`);
      }
    }
    if (!seen.size) console.log("  ⚠ 没查到成员 id");
    else console.log(`\n  👤 就是你。当前白名单：${cred.allowOpenIds.join(", ") || "（空）"}`);
    return 0;
  }

  if (cmd === "send") {
    const chatId = argv[1];
    const text = argv.slice(2).join(" ");
    if (!chatId || !text) {
      console.log("用法：npx electron scripts/feishu-admin.cjs send <chat_id> <文本>");
      return 2;
    }
    const r = await call("/im/v1/messages?receive_id_type=chat_id", {
      method: "POST",
      token,
      body: { receive_id: chatId, msg_type: "text", content: JSON.stringify({ text }) },
    });
    if (r.code === 0) {
      console.log(`✅ 已发送，message_id=${r.data?.message_id}`);
      return 0;
    }
    console.log(`✖ 发送失败：code=${r.code} ${r.msg ?? ""}`);
    if (r.code === 99991672 || r.code === 99991679) console.log("  → 缺 im:message:send_as_bot 或 im:message 权限");
    return 1;
  }

  console.log(`未知命令：${cmd}`);
  console.log("可用：whoami | chats | members | send <chat_id> <文本>");
  return 2;
}

app.disableHardwareAcceleration();
/**
 * **必须先设 userData 与 app 身份**，再 whenReady。
 *
 * 新版 Electron 的 `safeStorage` 密钥与应用身份相关：密钥材料由
 * userData 路径派生。脚本用默认身份（`Electron`）时，解的虽是同一个
 * 用户的 DPAPI blob，也会报 "Error while decrypting the ciphertext"。
 *
 * 应用本身是 `lynn` → `%APPDATA%\lynn`。这里对齐它。
 */
app.setName("lynn");
const appData = process.env.APPDATA || path.join(os.homedir(), "AppData", "Roaming");
app.setPath("userData", path.join(appData, "lynn"));

app.whenReady().then(async () => {
  let code = 0;
  try {
    code = await run();
  } catch (err) {
    console.error("✖", err instanceof Error ? err.message : String(err));
    code = 1;
  }
  app.exit(code);
});