// 启动页走查截图：真渲染层 + 假桥，?boot=1 让 C 方案启动页常驻（进度停在 90% 等快照）。
// 用法：npx electron scripts/shot-boot.cjs [输出png]
const { app, BrowserWindow } = require("electron");
const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.join(__dirname, "..");
const OUT = process.argv[2] || path.join(ROOT, "shots", "boot-c.png");

app.whenReady().then(async () => {
  try {
    const win = new BrowserWindow({
      width: 1200,
      height: 760,
      show: false,
      backgroundColor: "#0a0d0f",
      webPreferences: {
        preload: path.join(__dirname, "preview-preload.cjs"),
        contextIsolation: true,
        sandbox: true,
        nodeIntegration: false,
      },
    });
    await win.loadFile(path.join(ROOT, "dist", "renderer", "index.html"), { query: { boot: "1" } });
    await new Promise((r) => setTimeout(r, 1300)); // 字距收拢 680ms + 进度走到 ~90%
    const info = await win.webContents.executeJavaScript(`(() => {
      const w = document.querySelector('.boot-wordmark');
      const bar = document.querySelector('.boot-progress i');
      if (!w) return { found: false };
      const cs = getComputedStyle(w);
      return {
        found: true,
        text: w.textContent,
        font: cs.fontFamily,
        fontSize: cs.fontSize,
        letterSpacing: cs.letterSpacing,
        progressWidth: bar?.style.width ?? null,
        bootReady: !!document.querySelector('.boot-ready'),
      };
    })()`);
    console.log("BOOT", JSON.stringify(info));
    const img = await win.webContents.capturePage();
    fs.writeFileSync(OUT, img.toPNG());
    console.log("SHOT", OUT);
  } catch (err) {
    console.error("启动页走查失败：", err?.stack ?? err);
  } finally {
    setTimeout(() => app.exit(0), 200);
  }
});
