// 真模型端到端自检（需要已配置模型；会用一次极短对话，产生可忽略的费用）
// 用法：npm run live-check
const { app, safeStorage } = require("electron");
const path = require("node:path");

// 必须与打包/开发时一致的 userData：safeStorage 的密钥存在这里的 Local State，
// 用默认 Electron 目录解密会直接失败（DPAPI 的 OSCrypt key 不同）。
app.setPath("userData", path.join(app.getPath("appData"), "lynn"));

const TIMEOUT_MS = 120_000;

app.whenReady().then(async () => {
  const { Kernel } = require("../dist/main/kernel.js");
  const kernel = new Kernel();
  kernel.setEncryptors(
    (plain) => safeStorage.encryptString(plain),
    () => safeStorage.isEncryptionAvailable(),
    (blob) => safeStorage.decryptString(blob),
  );

  const snapshot = () => kernel.handle("session.snapshot");
  await kernel.init();
  if (!snapshot().model.configured) {
    console.log("LIVE-CHECK: NO_MODEL（还没配置模型，跳过）");
    app.exit(2);
    return;
  }

  let settled = false;
  let text = "";
  const finish = (code, note) => {
    if (settled) return;
    settled = true;
    console.log(`LIVE-CHECK: ${note}`);
    if (text) console.log("LIVE-CHECK-TEXT:", text.slice(0, 200).replace(/\n/g, " "));
    app.exit(code);
  };

  const timer = setTimeout(() => finish(3, "TIMEOUT"), TIMEOUT_MS);
  kernel.onEvent((ev) => {
    if (ev.type === "delta") text = ev.text;
    if (ev.type === "error") finish(4, `ERROR ${ev.message}`);
    if (ev.type === "done") {
      clearTimeout(timer);
      const answer = snapshot().feed.filter((c) => c.kind === "lynn").at(-1)?.text ?? text;
      const meta = kernel.handle("session.snapshot").usage;
      console.log("LIVE-CHECK-SESSION:", JSON.stringify(meta));
      if (!answer.trim()) finish(5, "EMPTY_REPLY");
      else finish(0, "OK");
    }
  });

  kernel.handle("feed.send", { text: "只回复两个字：收到" });
});

setTimeout(() => {
  console.log("LIVE-CHECK: HARD_TIMEOUT");
  app.exit(9);
}, TIMEOUT_MS + 20_000);
