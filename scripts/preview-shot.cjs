// 把构建后的渲染层用 Electron 打开、截图，供设计走查。
// 用法：npx electron scripts/preview-shot.cjs [输出路径]
const { app, BrowserWindow } = require("electron");
const path = require("node:path");
const fs = require("node:fs");

const out = process.argv[2] || path.join(__dirname, "..", "shots", "desk.png");

app.disableHardwareAcceleration();
app.whenReady().then(async () => {
  const isPet = process.argv[3] === "pet";
  const win = new BrowserWindow({
    width: isPet ? 240 : 1600,
    height: isPet ? 300 : 1000,
    show: false,
    frame: !isPet,
    transparent: isPet,
    backgroundColor: isPet ? "#00000000" : "#0d1116",
    webPreferences: {
      preload: path.join(__dirname, "preview-preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  // 渲染层报错必须可见：截图全黑时靠这条日志定位（而不是盯着黑图猜）
  win.webContents.on("console-message", (_e, level, message, line, sourceId) => {
    console.log(`[renderer:${level}] ${message} (${sourceId}:${line})`);
  });
  win.webContents.on("render-process-gone", (_e, details) => console.log("RENDER GONE", details));

  await win.loadFile(
    path.join(__dirname, "..", "dist", "renderer", "index.html"),
    isPet ? { query: { pet: "1" } } : undefined,
  );
  await new Promise((r) => setTimeout(r, 1200));

  if (isPet) {
    await new Promise((r) => setTimeout(r, 800));
    win.showInactive();
    await new Promise((r) => setTimeout(r, 400));
    win.webContents.invalidate();
    await new Promise((r) => setTimeout(r, 200));
    const img0 = await win.webContents.capturePage();
    fs.mkdirSync(path.dirname(out), { recursive: true });
    fs.writeFileSync(out, img0.toPNG());
    console.log("SHOT", out, img0.getSize());
    app.quit();
    return;
  }

  // 造铃向导：默认跳过（否则每张截图都被首启向导挡住）；要截向导就传 wizard
  const wantWizard = process.argv[3] === "wizard";
  await win.webContents.executeJavaScript(
    wantWizard
      ? `localStorage.removeItem('lynn.onboarded'); location.reload();`
      : `localStorage.setItem('lynn.onboarded','1'); location.reload();`,
  );
  await new Promise((r) => setTimeout(r, 2000));

  // 可选：打开「我的风铃」面板
  if (process.argv[3] === "settings") {
    const ok = await win.webContents.executeJavaScript(
      `(() => { const b=[...document.querySelectorAll('.ghost-btn')].find(x=>x.textContent.includes('我的风铃')); if (b) b.click(); return !!b; })()`,
    );
    await new Promise((r) => setTimeout(r, 1500));
    const overlay = await win.webContents.executeJavaScript(`!!document.querySelector('.sf-overlay')`);
    console.log("SETTINGS", ok, overlay);
  }

  // 可选：进待机（Ctrl+.）
  if (process.argv[3] === "standby") {
    await win.webContents.executeJavaScript(
      `window.dispatchEvent(new KeyboardEvent('keydown', { key: '.', ctrlKey: true, bubbles: true }))`,
    );
    await new Promise((r) => setTimeout(r, 900));
    console.log("STANDBY", await win.webContents.executeJavaScript(`!!document.querySelector('.standby')`));
  }

  // 可选：进入审查台（点右栏印章区的"打回重做"）
  if (process.argv[3] === "review") {
    const ok = await win.webContents.executeJavaScript(
      `(() => { const b=document.querySelector('.sealcard .btn-reject'); if (b) b.click(); return !!b; })()`,
    );
    await new Promise((r) => setTimeout(r, 900));
    const rev = await win.webContents.executeJavaScript(`!!document.querySelector('.rev-pair')`);
    console.log("REVIEW", ok, rev);
  }

  // 可选：切主题，参数形如 night:light / paper:dark / celadon:dark
  const themeArg = process.argv[4];
  if (themeArg) {
    const [id, mode] = themeArg.split(":");
    await win.webContents.executeJavaScript(
      `localStorage.setItem('lynn.theme', ${JSON.stringify(id)}); localStorage.setItem('lynn.mode', ${JSON.stringify(mode)}); location.reload();`,
    );
    await new Promise((r) => setTimeout(r, 1500));
  }

  // 隐藏窗口在部分合成器上只保留首帧：截图前短暂显示并重绘一次
  win.showInactive();
  await new Promise((r) => setTimeout(r, 400));
  win.webContents.invalidate();
  await new Promise((r) => setTimeout(r, 200));

  const img = await win.webContents.capturePage();
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, img.toPNG());
  console.log("SHOT", out, img.getSize());
  app.quit();
});
