/**
 * 一次性抓取飞书发送者 open_id（2026-11-18 P18-3）。
 *
 * ## 为什么需要
 *
 * 用户不知道自己的 open_id，而：
 *  - `GET /im/v1/chats` **只返回群，不返回私聊** —— 查不到"只私聊过"
 *  - 应用内的观察器要**重启应用**才生效
 *
 * 这个脚本直接起一个长连接，等第一条消息，打印发送者 id 后退出。
 * 目的是让"拿到自己的 open_id"这件事**当场完成**，不用来回折腾。
 *
 * ## 与正在运行的 app 的关系
 *
 * 飞书对同一个应用的多个长连接是允许的（事件可能被分摊）。
 * 所以这个脚本可能"抢"到本该给 app 的事件——调试期间可以接受，
 * 抓到一个就退出，连接随即释放。
 *
 * 用法：npx electron scripts/feishu-watch-identity.cjs [超时秒数]
 */
/**
 * 保护：如果 ELECTRON_RUN_AS_NODE=1，electron 会按**纯 node** 运行，
 * `require("electron").app` 是 undefined，后面全崩。与其让人看天书般的
 * "Cannot read properties of undefined"，不如当场说清怎么改。
 */
if (typeof require("electron").app === "undefined") {
  console.error(
    [
      "✖ 检测到 ELECTRON_RUN_AS_NODE 被设置，Electron 退化成纯 Node，拿不到 safeStorage。",
      "",
      "  PowerShell:  Remove-Item Env:\ELECTRON_RUN_AS_NODE",
      "  bash/zsh :  unset ELECTRON_RUN_AS_NODE",
      "",
      "然后重跑本命令。",
    ].join("\n"),
  );
  process.exit(2);
}
const { app, safeStorage } = require("electron");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const TIMEOUT_S = Number(process.argv[2] || 60);

app.disableHardwareAcceleration();
// 与 app 同身份，否则 safeStorage 解不开（实测过：只有这一项不同，解密一成一败）
app.setName("lynn");
const appData = process.env.APPDATA || path.join(os.homedir(), "AppData", "Roaming");
app.setPath("userData", path.join(appData, "lynn"));

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

app.whenReady().then(async () => {
  let code = 0;
  try {
    const cred = readCredentials();
    const sdk = await import("@larksuiteoapi/node-sdk");
    const S = sdk.default ?? sdk;

    // 机器人自身 id：用来排除"自己发的消息"
    const tkRes = await fetch("https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ app_id: cred.appId, app_secret: cred.appSecret }),
    });
    const tk = await tkRes.json();
    let botOpenId;
    if (tk.code === 0) {
      const botRes = await fetch("https://open.feishu.cn/open-apis/bot/v3/info", {
        headers: { authorization: `Bearer ${tk.tenant_access_token}` },
      });
      botOpenId = (await botRes.json())?.bot?.open_id;
    }

    console.log(`appId=${cred.appId}`);
    console.log(`机器人自己的 open_id=${botOpenId ?? "?"}（要排除的）`);
    console.log(`当前白名单=${cred.allowOpenIds.join(", ") || "（空）"}`);
    console.log(`\n等待一条消息（最多 ${TIMEOUT_S} 秒）… 现在用手机给机器人发一条。\n`);

    const dispatcher = new S.EventDispatcher({});
    let done = false;

    dispatcher.register({
      "im.message.receive_v1": async (data) => {
        if (done) return;
        const senderId = data?.sender?.sender_id?.open_id ?? data?.sender?.sender_id?.user_id ?? "";
        const chatType = data?.message?.chat_type ?? "";
        const chatId = data?.message?.chat_id ?? "";
        const isBot = botOpenId && senderId === botOpenId;
        const inList = cred.allowOpenIds.includes(senderId);

        console.log(`✅ 收到消息`);
        console.log(`   发送者 open_id : ${senderId}${isBot ? "  ← 机器人自己" : ""}`);
        console.log(`   会话类型       : ${chatType || "?"}`);
        console.log(`   会话 id        : ${chatId || "?"}`);
        console.log(`   已在白名单     : ${inList ? "是" : "否 ← 这就是你为什么收不到回复"}`);
        if (!isBot && senderId) {
          /**
           * `--apply`：直接把它写进 settings.json 的白名单。
           *
           * 为什么允许自动写：这是**用户主动运行、主动发消息**触发的，
           * 一次只加一个 id，且加了格式校验。省掉「抄 35 个字符」这一步
           * ——那一步出过错（多复制 3 个字符，表现为"发消息没反应"）。
           *
           * 不自动加也是可以的：不加就只打印，用户自己在设置页填。
           */
          const APPLY = process.argv.includes("--apply");
          if (APPLY && /^ou_[0-9a-f]{32}$/i.test(senderId)) {
            const file = path.join(os.homedir(), ".lynn", "settings.json");
            const all = JSON.parse(fs.readFileSync(file, "utf-8"));
            const f2 = all?.im?.feishu;
            if (f2) {
              const list = Array.isArray(f2.allowOpenIds) ? f2.allowOpenIds : [];
              if (!list.includes(senderId)) list.push(senderId);
              f2.allowOpenIds = list;
              fs.writeFileSync(file, JSON.stringify(all, null, 2) + "\n", "utf8");
              console.log(`\n✅ 已写入白名单：${senderId}`);
              console.log("   现在重启应用，它会在启动时读到新白名单。");
            } else {
              console.log("\n⚠ 设置里没有飞书配置，没能写入");
            }
          } else if (APPLY) {
            console.log(`\n⚠ id 格式不像标准 open_id（${senderId}），没有自动写入`);
            console.log(`   如果不确定，手动填进设置页。`);
          } else {
            console.log(`\n👉 把这一串填进「允许的用户 open_id」：\n   ${senderId}`);
            console.log(`   或加 --apply 让它自动写入：npm run feishu:watch -- 120 --apply`);
          }
        }
        done = true;
        setTimeout(() => app.exit(0), 200);
      },
    });

    const ws = new S.WSClient({ appId: cred.appId, appSecret: cred.appSecret, loggerLevel: 0 });
    await ws.start({ eventDispatcher: dispatcher });

    setTimeout(() => {
      if (done) return;
      console.log(`\n⏱ 超时（${TIMEOUT_S}s）——没收到消息。检查：`);
      console.log("  · 飞书后台「事件订阅」是否选了**长连接**并订阅了 im.message.receive_v1");
      console.log("  · 应用是否已**发布**（版本管理与发布）");
      console.log("  · 消息是否发给了这个应用（appId 对应）的机器人");
      try {
        ws.close();
      } catch {
        /* 忽略 */
      }
      app.exit(1);
    }, TIMEOUT_S * 1000);
  } catch (err) {
    console.error("✖", err instanceof Error ? err.message : String(err));
    code = 1;
    app.exit(code);
  }
});