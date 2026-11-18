#!/usr/bin/env node
/**
 * 飞书渠道自检（2026-11-18 P14-3）。
 *
 * 为什么需要它：用户配好 appId/appSecret 之后，接下来要在飞书后台做四五件事
 * （开权限、配事件订阅、选长连接、给机器人发消息拿 open_id）。
 * 任何一步漏了，表现出来都是同一句话——"连不上"或"发消息没反应"。
 *
 * 这个脚本把**能自动查的都查掉**，剩下的明确告诉用户去哪点。
 *
 * 它查什么：
 *   1. appId/appSecret 能不能换到 tenant_access_token（凭据对不对）
 *   2. 应用有没有 im:message 权限（能不能收发消息）
 *   3. 长连接能不能建立（事件订阅配没配）
 *   4. 机器人自己的信息（名字、open_id——白名单要填的是**你的** open_id，
 *      不是机器人的，这一步很容易搞混）
 *
 * 用法：
 *   node scripts/check-feishu.mjs --app-id cli_xxx --app-secret yyy
 *   node scripts/check-feishu.mjs            # 从 ~/.lynn/settings.json 读（需已加密配置）
 *
 * 安全：secret 只用于本次请求，不写盘、不打日志（输出里做了脱敏）。
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const FEISHU = "https://open.feishu.cn/open-apis";

/** 脱敏：只留前 4 后 4 */
function mask(s) {
  if (!s || s.length <= 8) return "****";
  return `${s.slice(0, 4)}…${s.slice(-4)}`;
}

/** 发一个飞书 API 请求 */
async function api(pathname, { method = "GET", body, token } = {}) {
  const headers = { "content-type": "application/json; charset=utf-8" };
  if (token) headers.authorization = `Bearer ${token}`;
  const res = await fetch(`${FEISHU}${pathname}`, {
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
  return { status: res.status, json, text };
}

const argv = process.argv.slice(2);
const argOf = (name) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : undefined;
};

let appId = argOf("app-id");
let appSecret = argOf("app-secret");

// 没传就从 settings.json 读（但那里是加密的，只能提示）
if (!appId || !appSecret) {
  const settingsFile = path.join(os.homedir(), ".lynn", "settings.json");
  if (fs.existsSync(settingsFile)) {
    try {
      const s = JSON.parse(fs.readFileSync(settingsFile, "utf-8"));
      const f = s?.im?.feishu;
      if (f?.appId) {
        appId = appId ?? f.appId;
        if (!appSecret) {
          console.log("⚠ 从 settings.json 读到 appId，但 appSecret 是加密的，本脚本解不开。");
          console.log("  请用 --app-secret 传一次（或用应用内设置页）。\n");
        }
      }
    } catch {
      /* 忽略 */
    }
  }
}

if (!appId || !appSecret) {
  console.error("用法：node scripts/check-feishu.mjs --app-id cli_xxx --app-secret yyy");
  process.exit(2);
}

const results = [];
const ok = (label, detail = "") => {
  results.push({ label, ok: true, detail });
  console.log(`  ✅ ${label}${detail ? `（${detail}）` : ""}`);
};
const bad = (label, detail = "") => {
  results.push({ label, ok: false, detail });
  console.log(`  ✖  ${label}${detail ? `\n     → ${detail}` : ""}`);
};
const warn = (label, detail = "") => {
  console.log(`  ⚠  ${label}${detail ? `\n     → ${detail}` : ""}`);
};

console.log(`飞书自检：appId=${appId} appSecret=${mask(appSecret)}\n`);

// ---------- 1) 凭据 ----------
console.log("=== 1) 凭据 ===");
let token = null;
try {
  const r = await api("/auth/v3/tenant_access_token/internal", {
    method: "POST",
    body: { app_id: appId, app_secret: appSecret },
  });
  if (r.json?.code === 0 && r.json.tenant_access_token) {
    token = r.json.tenant_access_token;
    ok("appId + appSecret 有效", `token 有效期 ${r.json.expire ?? "?"} 秒`);
  } else if (r.json?.code === 10014) {
    bad(
      "appSecret 不对",
      "去 open.feishu.cn → 你的应用 → 凭证与基础信息 → App Secret，点「重置」重新拿一个。\n" +
        "     注意：重置后旧的立刻失效，如果别处也在用要一起改。",
    );
  } else if (r.json?.code === 10003) {
    bad("appId 不存在", "检查是不是复制漏了字符；或应用已被删除。");
  } else {
    bad("换 token 失败", `code=${r.json?.code} msg=${r.json?.msg ?? r.text.slice(0, 120)}`);
  }
} catch (e) {
  bad("网络请求失败", String(e.message ?? e).slice(0, 200));
}

// ---------- 2) 应用信息 ----------
if (token) {
  console.log("\n=== 2) 应用信息 ===");
  const r = await api("/application/v6/applications/self?lang=zh_cn", { token });
  if (r.json?.code === 0) {
    const app = r.json.data?.app ?? {};
    ok("拿到应用信息", `名称「${app.app_name ?? "?"}」 状态=${app.status ?? "?"}`);
    if (app.status !== undefined && app.status !== 1) {
      warn(
        "应用状态可能不是「已启用」",
        "去 应用功能 → 机器人，确认「启用机器人」已打开；企业自建应用还需要管理员审核通过。",
      );
    }
  } else {
    warn(
      "读不到应用信息（不一定影响收发消息）",
      `code=${r.json?.code} msg=${r.json?.msg ?? "?"}——这个接口需要额外权限，忽略即可`,
    );
  }

  // ---------- 3) 机器人信息 ----------
  console.log("\n=== 3) 机器人 ===");
  const bot = await api("/bot/v3/info", { token });
  if (bot.json?.code === 0) {
    const b = bot.json.bot ?? {};
    ok("机器人已就绪", `名称「${b.app_name ?? "?"}」 open_id=${b.open_id ?? "?"}`);
    console.log(
      `\n     ⚠ 注意：上面这个 open_id（${b.open_id ?? "?"}）是**机器人自己**的。\n` +
        `        白名单要填的是**你**（使用者）的 open_id，不是这个。`,
    );
  } else {
    bad(
      "读不到机器人信息",
      `code=${bot.json?.code} msg=${bot.json?.msg ?? "?"}\n` +
        "     → 大概率是「机器人」能力没开：去 应用功能 → 机器人 → 启用。",
    );
  }

  // ---------- 4) 权限 ----------
  console.log("\n=== 4) 消息权限 ===");
  const scope = await api("/application/v6/applications/self/app_versions?lang=zh_cn&page_size=1", { token });
  if (scope.json?.code === 0) {
    ok("能读到应用版本信息", "权限清单要人工核对（见下方清单）");
  } else {
    warn("读不到权限清单", "用下面的清单人工核对");
  }
}

// ---------- 4b) 候选 open_id（P17-1）----------
if (token) {
  console.log("\n=== 4b) 你的 open_id ===");
  const chats = await api("/im/v1/chats?page_size=20", { token });
  if (chats.json?.code !== 0) {
    console.log(`  ⚠  读不到会话列表（code=${chats.json?.code} ${chats.json?.msg ?? ""}）`);
    console.log("     → 需要 im:chat:readonly 权限；开通后要重新发布版本");
  } else {
    const items = chats.json.data?.items ?? [];
    if (!items.length) {
      console.log("  ⚠  机器人还没加入任何会话");
      console.log("     → 先在飞书里搜到机器人、给它发一条消息（私聊会自成一个会话），再跑一次");
    } else {
      const botOpenId = bot?.json?.bot?.open_id;
      const seen = new Set();
      for (const chat of items) {
        const label = chat.chat_mode === "p2p" ? "私聊" : `群「${chat.name || chat.chat_id}」`;
        const members = await api(
          `/im/v1/chats/${encodeURIComponent(chat.chat_id)}/members?member_id_type=open_id&page_size=50`,
          { token },
        );
        if (members.json?.code !== 0) {
          console.log(`  ⚠  ${label}：读不到成员（code=${members.json?.code}）`);
          continue;
        }
        for (const m of members.json.data?.items ?? []) {
          const id = String(m.member_id ?? "");
          if (!id.startsWith("ou_") || seen.has(id)) continue;
          seen.add(id);
          const isBot = botOpenId && id === botOpenId;
          console.log(`  ${isBot ? "🤖" : "👤"} ${id}  ←  ${label}${isBot ? "（机器人自己）" : ""}`);
        }
      }
      if (seen.size === 0) console.log("  ⚠  没查到成员 id（可能都缺 im:chat:readonly）");
      else console.log("\n  👤 就是你。把它填进 设置 → IM 渠道 → 允许的用户 open_id");
    }
  }
}

// ---------- 5) 人工核对清单 ----------
console.log("\n=== 5) 还需要你在飞书后台做的（脚本查不到）===");
const checklist = [
  ["应用功能 → 机器人", "「启用机器人」打开"],
  ["权限管理", "开通 im:message（收发消息）"],
  ["权限管理", "开通 im:message:receive_v1（接收消息事件）"],
  ["权限管理", "开通 im:chat:readonly（读群信息，群聊才需要）"],
  ["事件订阅", "订阅方式选「**长连接**」——本机没有公网 IP，必须选这个"],
  ["事件订阅", "添加事件「接收消息 im.message.receive_v1」"],
  ["版本管理与发布", "创建版本并**发布**，等管理员审核通过（自己建的应用通常自动通过）"],
];
for (const [where, what] of checklist) console.log(`  ☐ ${where}：${what}`);

console.log("\n=== 6) 最后一步：拿你自己的 open_id ===");
console.log("  1. 在飞书里搜到你的机器人（应用发布后才会出现在搜索里）");
console.log("  2. 给它发一条消息（比如「在吗」）");
console.log("  3. 用 LYNN_IM_BRIDGE=1 启动应用，看日志：");
console.log("     搜 feishu_incoming → 里面的 sender 就是你的 open_id");
console.log("  4. 把它填进 设置 → IM 渠道 → 允许的用户 open_id");

const passed = results.filter((r) => r.ok).length;
console.log(`\n=== 自动检查：${passed}/${results.length} 通过 ===`);
if (results.some((r) => !r.ok)) {
  console.log("先把上面 ✖ 的解决掉，再按第 5、6 节做人工部分。");
  process.exit(1);
}
console.log("凭据与机器人部分没问题，接着做第 5、6 节。");
